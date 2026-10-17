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
});
