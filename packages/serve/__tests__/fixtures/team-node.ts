/**
 * 两进程 E2E fixture：启动 gateway + LoopbackTransport + 极简 inbox。
 *
 * 环境变量：VESSEL_TEST_NODE_ID / VESSEL_TEST_PEERS_DIR / VESSEL_TEST_TOKEN
 * stdout 输出一行 `READY {json}`，供父进程解析。
 */

import { randomUUID } from 'node:crypto';
import type { AgentMessage, AgentStatus, InboxPage } from '@vessel/core';
import { MemoryEventStream } from '@vessel/core';
import { startGateway } from '../../src/index';
import type { TeamHostLike } from '../../src/team';
import { createLoopbackTransport } from '../../src/transport/index';

const nodeId = process.env.VESSEL_TEST_NODE_ID;
const peersDir = process.env.VESSEL_TEST_PEERS_DIR;
const token = process.env.VESSEL_TEST_TOKEN;
if (!nodeId || !peersDir || !token) {
  console.error('missing VESSEL_TEST_NODE_ID / VESSEL_TEST_PEERS_DIR / VESSEL_TEST_TOKEN');
  process.exit(1);
}

const events = new MemoryEventStream();
const gateway = startGateway({ events, port: 0, nodeId, token, nodeName: nodeId });

const ownerId = 'owner';
const workerId = 'worker';
const inboxes = new Map<string, AgentMessage[]>();
const statuses = new Map<string, AgentStatus>([
  [ownerId, { id: ownerId, state: 'idle', toolNames: [] }],
  [workerId, { id: workerId, state: 'idle', toolNames: [] }],
]);

const transport = await createLoopbackTransport({
  nodeId,
  endpoint: gateway.url,
  token,
  peersDir,
  heartbeatMs: 100,
  peerTtlMs: 500,
  agents: () => [...statuses.values()],
});

const host: TeamHostLike = {
  list: () => [...statuses.values()],
  get: (id) => {
    const status = statuses.get(id);
    if (!status) return undefined;
    return {
      status: () => status,
      close: async () => {
        statuses.delete(id);
      },
    };
  },
  inbox: async (id, cursor = '0'): Promise<InboxPage> => {
    const all = inboxes.get(id) ?? [];
    const start = Math.max(0, Number.parseInt(cursor, 10) || 0);
    return { messages: all.slice(start), cursor: String(all.length) };
  },
  cancel: (id) => {
    const status = statuses.get(id);
    if (status) statuses.set(id, { ...status, state: 'cancelled' });
  },
};

/** 收件箱 + 收到 task 时回 result（父进程据此断言跨进程往返） */
const deliver = async (message: AgentMessage): Promise<void> => {
  const list = inboxes.get(message.to) ?? [];
  list.push(message);
  inboxes.set(message.to, list);

  if (message.kind === 'task') {
    await transport.send({
      id: randomUUID(),
      from: `${nodeId}:${message.to}`,
      to: message.from,
      kind: 'result',
      content: `echo:${message.content}`,
      replyTo: message.id,
      ts: Date.now(),
    });
  }
};

gateway.attachTeam({ nodeId, transport, host, deliver });

console.log(`READY ${JSON.stringify({ node_id: nodeId, endpoint: gateway.url, token })}`);

async function shutdown(): Promise<void> {
  await transport.close();
  gateway.stop();
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});

// 保持进程存活
setInterval(() => {}, 60_000);
