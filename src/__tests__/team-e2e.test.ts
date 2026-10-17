/**
 * 两进程 loopback smoke（asm A4/A5）。
 *
 * 用真实 CLI 起两个节点（host + team + loopback），验证：
 * - peer 注册表互相发现；
 * - 跨节点消息经 gateway → transport.deliver → receive → Host inbox；
 * - 消息只投递一次（不因同时提供 deliver 与 receive 而重复）。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InProcessRuntimeHost } from '../../packages/core/src/index';
import { createLoopbackTransport } from '../../packages/serve/src/transport/loopback';
import { CoreHostAdapter } from '../../plugins/tools/team/src/core-adapter';
import { RoutingTeamHost } from '../../plugins/tools/team/src/routing';

const cliPath = path.resolve(import.meta.dir, '..', 'cli.ts');

interface SpawnedNode {
  proc: Bun.Subprocess;
  dir: string;
}

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function configFor(nodeId: string, peersDir: string, token: string): string {
  return [
    'host:',
    '  enabled: true',
    `  node_id: ${nodeId}`,
    'team:',
    '  enabled: true',
    'transport:',
    '  kind: loopback',
    `  token: ${token}`,
    `  peers_dir: ${peersDir}`,
    '  heartbeat_ms: 500',
    '  peer_ttl_ms: 3000',
    '',
  ].join('\n');
}

function spawnNode(nodeId: string, peersDir: string, token: string): SpawnedNode {
  const dir = makeDir(`vessel-e2e-${nodeId}-`);
  fs.writeFileSync(path.join(dir, 'vessel.yaml'), configFor(nodeId, peersDir, token));
  const proc = Bun.spawn([process.execPath, cliPath, '--serve', '0'], {
    cwd: dir,
    env: { ...process.env, VESSEL_MOCK: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { proc, dir };
}

/** 从 gateway banner 解析实际地址与 token */
async function readBanner(
  proc: Bun.Subprocess,
  timeoutMs = 15_000,
): Promise<{ endpoint: string; token: string }> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
    ]);
    if (chunk === null || chunk.done) break;
    buffer += decoder.decode(chunk.value);
    const endpoint = buffer.match(/Gateway\s+(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    const token = buffer.match(/Token\s+([A-Za-z0-9_-]+)/)?.[1];
    if (endpoint && token) {
      await reader.cancel().catch(() => {});
      return { endpoint, token };
    }
  }
  throw new Error('gateway banner timeout');
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('waitUntil timeout');
}

async function readPid(peersDir: string, nodeId: string): Promise<number> {
  const record = (await Bun.file(path.join(peersDir, `${nodeId}.json`)).json()) as {
    pid: number;
  };
  return record.pid;
}

describe('two-process loopback smoke', () => {
  const dirs: string[] = [];
  const procs: Bun.Subprocess[] = [];
  const pids: number[] = [];

  afterEach(async () => {
    for (const pid of pids.splice(0)) {
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
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers peers and delivers a cross-node message exactly once', async () => {
    const root = makeDir('vessel-e2e-root-');
    dirs.push(root);
    const peersDir = path.join(root, 'peers');
    const token = 'e2e-token';

    const nodeA = spawnNode('A', peersDir, token);
    const nodeB = spawnNode('B', peersDir, token);
    procs.push(nodeA.proc, nodeB.proc);
    dirs.push(nodeA.dir, nodeB.dir);

    const [bannerA, bannerB] = await Promise.all([readBanner(nodeA.proc), readBanner(nodeB.proc)]);
    pids.push(await readPid(peersDir, 'A'), await readPid(peersDir, 'B'));

    const headers = { Authorization: `Bearer ${token}` };

    await waitUntil(async () => {
      const res = await fetch(`${bannerA.endpoint}/v1/team/peers`, { headers });
      if (!res.ok) return false;
      const body = (await res.json()) as { peers: Array<{ node_id: string }> };
      return body.peers.some((peer) => peer.node_id === 'B');
    }, 10_000);

    // 在 B 上 spawn 一个 worker，供跨节点 task 执行
    const spawned = await fetch(`${bannerB.endpoint}/v1/team/agents`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'worker' }),
    });
    expect(spawned.status).toBe(201);
    const spawnedBody = (await spawned.json()) as { agent: { id: string } };
    const workerId = spawnedBody.agent.id;

    // P1-1：A 的 peer 列表应带 B 的成员，短 id 才能解析到 B
    await waitUntil(async () => {
      const res = await fetch(`${bannerA.endpoint}/v1/team/peers`, { headers });
      if (!res.ok) return false;
      const body = (await res.json()) as {
        peers: Array<{ node_id: string; agents: Array<{ id: string }> }>;
      };
      return body.peers.some(
        (peer) => peer.node_id === 'B' && peer.agents.some((agent) => agent.id === workerId),
      );
    }, 10_000);

    // 跨节点 task：A → B:worker，B 执行后 result 回到 A:owner
    const task = await fetch(`${bannerA.endpoint}/v1/team/send`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: 1,
        message: {
          id: 'asm-e2e-task-1',
          from: 'A:owner',
          to: `B:${workerId}`,
          kind: 'task',
          content: 'ping',
          ts: Date.now(),
        },
      }),
    });
    expect(task.status).toBe(202);

    await waitUntil(async () => {
      const res = await fetch(`${bannerA.endpoint}/v1/team/inbox?agent_id=owner`, { headers });
      if (!res.ok) return false;
      const body = (await res.json()) as {
        messages: Array<{ kind: string; content: string }>;
      };
      return body.messages.some(
        (message) => message.kind === 'result' && message.content === 'Echo: ping',
      );
    }, 10_000);

    const ownerInbox = await fetch(`${bannerA.endpoint}/v1/team/inbox?agent_id=owner`, {
      headers,
    });
    const ownerBody = (await ownerInbox.json()) as {
      messages: Array<{ kind: string; content: string }>;
    };
    expect(
      ownerBody.messages.filter(
        (message) => message.kind === 'result' && message.content === 'Echo: ping',
      ),
    ).toHaveLength(1);

    // /v1/team/send 走 transport.send（跨节点 POST）；/v1/team/messages 只接受本机入站。
    const send = await fetch(`${bannerA.endpoint}/v1/team/send`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: 1,
        message: {
          id: 'asm-e2e-1',
          from: 'A:owner',
          to: 'B:owner',
          kind: 'message',
          content: 'ping',
          ts: Date.now(),
        },
      }),
    });
    expect(send.status).toBe(202);

    await waitUntil(async () => {
      const res = await fetch(`${bannerB.endpoint}/v1/team/inbox?agent_id=owner`, { headers });
      if (!res.ok) return false;
      const body = (await res.json()) as { messages: Array<{ id: string }> };
      return body.messages.some((message) => message.id === 'asm-e2e-1');
    }, 10_000);

    const inbox = await fetch(`${bannerB.endpoint}/v1/team/inbox?agent_id=owner`, { headers });
    const body = (await inbox.json()) as { messages: Array<{ id: string; content: string }> };
    const matches = body.messages.filter((message) => message.id === 'asm-e2e-1');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.content).toBe('ping');
    expect((await fetch(`${bannerB.endpoint}/v1/health`)).status).toBe(200);
  }, 40_000);

  it('resolves a remote member by short id through the real registry (P1-1)', async () => {
    const root = makeDir('vessel-e2e-root-');
    dirs.push(root);
    const peersDir = path.join(root, 'peers');
    const token = 'e2e-token';

    const nodeB = spawnNode('B', peersDir, token);
    procs.push(nodeB.proc);
    dirs.push(nodeB.dir);

    const bannerB = await readBanner(nodeB.proc);
    pids.push(await readPid(peersDir, 'B'));
    const headers = { Authorization: `Bearer ${token}` };

    // B 上有一个 worker；成员状态必须写进注册表，远端才能按短 id 找到它。
    const spawned = await fetch(`${bannerB.endpoint}/v1/team/agents`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'worker' }),
    });
    expect(spawned.status).toBe(201);
    const workerId = ((await spawned.json()) as { agent: { id: string } }).agent.id;

    // A 在测试进程里用真实 loopback + RoutingTeamHost 扮演另一节点。
    // 这就是 team_send 的投递路径：本机找不到 → transport.peers() → 远端短 id。
    const transport = await createLoopbackTransport({
      nodeId: 'A',
      endpoint: 'http://127.0.0.1:1',
      token,
      peersDir,
      heartbeatMs: 200,
      peerTtlMs: 3000,
      agents: () => [{ id: 'sender', state: 'idle', toolNames: [] }],
    });
    const coreHost = new InProcessRuntimeHost();
    const local = new CoreHostAdapter(coreHost, {
      deliverResult: async () => {},
    });
    const routing = new RoutingTeamHost({ local, transport, nodeId: 'A', ownerId: 'owner' });
    try {
      // B 的注册表条目带上 worker 后，短 id 才可解析。
      await waitUntil(async () => {
        const peers = await transport.peers();
        return peers.some(
          (peer) => peer.nodeId === 'B' && peer.agents.some((agent) => agent.id === workerId),
        );
      }, 15_000);

      // 反向也成立：B 能看到 A 发布的成员。
      await waitUntil(async () => {
        const res = await fetch(`${bannerB.endpoint}/v1/team/peers`, { headers });
        if (!res.ok) return false;
        const body = (await res.json()) as {
          peers: Array<{ node_id: string; agents: Array<{ id: string }> }>;
        };
        return body.peers.some(
          (peer) => peer.node_id === 'A' && peer.agents.some((agent) => agent.id === 'sender'),
        );
      }, 15_000);

      const id = 'asm-e2e-short-id-1';
      await routing.send({
        id,
        from: 'owner',
        to: workerId,
        kind: 'message',
        content: 'short-id-probe',
        ts: Date.now(),
      });

      await waitUntil(async () => {
        const res = await fetch(
          `${bannerB.endpoint}/v1/team/inbox?agent_id=${encodeURIComponent(workerId)}`,
          { headers },
        );
        if (!res.ok) return false;
        const body = (await res.json()) as { messages: Array<{ id: string }> };
        return body.messages.some((message) => message.id === id);
      }, 10_000);

      const inbox = await fetch(
        `${bannerB.endpoint}/v1/team/inbox?agent_id=${encodeURIComponent(workerId)}`,
        { headers },
      );
      const inboxBody = (await inbox.json()) as {
        messages: Array<{ id: string; content: string }>;
      };
      const matches = inboxBody.messages.filter((message) => message.id === id);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.content).toBe('short-id-probe');
    } finally {
      await routing.close();
      await transport.close();
    }
  }, 45_000);
});
