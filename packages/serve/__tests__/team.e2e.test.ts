import { afterEach, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir, removeTempDir, sleep, waitUntil } from './helpers';

interface ReadyInfo {
  node_id: string;
  endpoint: string;
  token: string;
}

interface SpawnedNode {
  proc: Bun.Subprocess;
}

const FIXTURE = join(import.meta.dir, 'fixtures', 'team-node.ts');

async function readReady(proc: Bun.Subprocess, timeoutMs = 15_000): Promise<ReadyInfo> {
  const stream = proc.stdout as ReadableStream<Uint8Array> | undefined;
  const reader = stream?.getReader();
  if (!reader) throw new Error('no stdout');
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      sleep(timeoutMs).then(() => ({ done: true as const, value: undefined })),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value);
    const line = buffer.split('\n').find((item) => item.startsWith('READY '));
    if (line) {
      await reader.cancel().catch(() => {});
      return JSON.parse(line.slice('READY '.length)) as ReadyInfo;
    }
  }
  const stderrStream = proc.stderr as ReadableStream<Uint8Array> | undefined;
  const stderr = stderrStream ? await new Response(stderrStream).text().catch(() => '') : '';
  throw new Error(`node did not become ready: ${stderr}`);
}

async function readPid(peersDir: string, nodeId: string): Promise<number> {
  const record = JSON.parse(await readFile(join(peersDir, `${nodeId}.json`), 'utf8')) as {
    pid: number;
  };
  return record.pid;
}

function spawnNode(nodeId: string, peersDir: string, token: string): SpawnedNode {
  // 直接执行 TS，避免 Windows 上 `bun run` 包装进程导致 kill 只杀父进程。
  const proc = Bun.spawn(['bun', FIXTURE], {
    env: {
      ...process.env,
      VESSEL_TEST_NODE_ID: nodeId,
      VESSEL_TEST_PEERS_DIR: peersDir,
      VESSEL_TEST_TOKEN: token,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { proc };
}

describe('two-process loopback E2E', () => {
  const dirs: string[] = [];
  const procs: Bun.Subprocess[] = [];
  const childPids: number[] = [];

  afterEach(async () => {
    for (const pid of childPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    for (const proc of procs.splice(0)) {
      proc.kill('SIGKILL');
      await proc.exited.catch(() => {});
    }
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  it('discovers peers, sends a task and receives a result across processes', async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const token = 'e2e-token';

    const procA = spawnNode('A', dir, token);
    const procB = spawnNode('B', dir, token);
    procs.push(procA.proc, procB.proc);

    const [readyA, readyB] = await Promise.all([readReady(procA.proc), readReady(procB.proc)]);
    expect(readyA.endpoint).toContain('http://127.0.0.1:');
    expect(readyB.endpoint).toContain('http://127.0.0.1:');

    const pidA = await readPid(dir, 'A');
    const pidB = await readPid(dir, 'B');
    childPids.push(pidA, pidB);

    const headers = { Authorization: `Bearer ${token}` };

    // 双向发现（P1-2：避免只有 A 看到 B 就发送）
    await waitUntil(async () => {
      const res = await fetch(`${readyA.endpoint}/v1/team/peers`, { headers });
      if (!res.ok) return false;
      const body = (await res.json()) as {
        peers: Array<{ node_id: string; agents: Array<{ id: string }> }>;
      };
      return body.peers.some((peer) => peer.node_id === 'B');
    }, 10_000);
    await waitUntil(async () => {
      const res = await fetch(`${readyB.endpoint}/v1/team/peers`, { headers });
      if (!res.ok) return false;
      const body = (await res.json()) as { peers: Array<{ node_id: string }> };
      return body.peers.some((peer) => peer.node_id === 'A');
    }, 10_000);

    // P1-1：peer 列表应带成员，支持短 id 解析
    const peersA = (await (
      await fetch(`${readyA.endpoint}/v1/team/peers`, { headers })
    ).json()) as {
      peers: Array<{ node_id: string; agents: Array<{ id: string }> }>;
    };
    expect(
      peersA.peers
        .find((peer) => peer.node_id === 'B')
        ?.agents.some((agent) => agent.id === 'worker'),
    ).toBe(true);

    // A -> B task
    const send = await fetch(`${readyA.endpoint}/v1/team/send`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: 1,
        message: {
          id: 'e2e-task-1',
          from: 'A:owner',
          to: 'B:worker',
          kind: 'task',
          content: 'ping',
          ts: Date.now(),
        },
      }),
    });
    expect(send.status).toBe(202);

    // B 自动回 result，A 的 owner inbox 应收到
    await waitUntil(async () => {
      const res = await fetch(`${readyA.endpoint}/v1/team/inbox?agent_id=owner`, { headers });
      if (!res.ok) return false;
      const body = (await res.json()) as {
        messages: Array<{ kind: string; content: string; reply_to?: string }>;
      };
      return body.messages.some(
        (message) => message.kind === 'result' && message.content === 'echo:ping',
      );
    }, 10_000);

    // 杀掉 B 后，A 的 peer 表在 TTL 内移除 B；A 自身仍健康
    // 用注册表里的真实 PID 杀进程：Windows 上 bun 启动器与脚本可能不是同一个进程。
    process.kill(pidB, 'SIGKILL');
    procB.proc.kill('SIGKILL');
    await waitUntil(async () => {
      const res = await fetch(`${readyA.endpoint}/v1/team/peers`, { headers });
      if (!res.ok) return false;
      const body = (await res.json()) as { peers: Array<{ node_id: string }> };
      return !body.peers.some((peer) => peer.node_id === 'B');
    }, 10_000);
    expect((await fetch(`${readyA.endpoint}/v1/health`)).status).toBe(200);
  }, 40_000);
});
