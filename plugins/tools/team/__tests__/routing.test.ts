/**
 * R4-4 跨进程路由测试：FakeTransport 内存双节点，不联网。
 */

import { describe, expect, it } from 'bun:test';
import {
  type AgentMessage,
  type AgentStatus,
  InProcessRuntimeHost as CoreInProcessRuntimeHost,
  type LLMProvider,
  MemoryLLMProvider,
  MemoryPluginHost,
  type PeerInfo,
  type Transport,
  type Unsubscribe,
} from '@vessel/core';
import { CoreHostAdapter } from '../src/core-adapter';
import type { TeamMessage } from '../src/host';
import { parseAgentAddress, RoutingTeamHost } from '../src/routing';

/** 内存 Transport：可直投到对端节点，可注入 peers/send 失败 */
class FakeTransport implements Transport {
  readonly kind = 'in-process' as const;
  readonly sent: AgentMessage[] = [];
  peersList: PeerInfo[] = [];
  peersFailure?: Error;
  sendFailure?: Error;
  peerWire?: FakeTransport;

  private readonly handlers = new Set<(message: AgentMessage) => void | Promise<void>>();

  async send(message: AgentMessage): Promise<void> {
    if (this.sendFailure) throw this.sendFailure;
    this.sent.push(message);
    if (this.peerWire) await this.deliverTo(this.peerWire, message);
  }

  receive(handler: (message: AgentMessage) => void | Promise<void>): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async peers(): Promise<PeerInfo[]> {
    if (this.peersFailure) throw this.peersFailure;
    return this.peersList;
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }

  /** 测试辅助：把消息投给本节点 */
  async deliver(message: AgentMessage): Promise<void> {
    await this.deliverTo(this, message);
  }

  private async deliverTo(target: FakeTransport, message: AgentMessage): Promise<void> {
    for (const handler of [...target.handlers]) await handler(message);
  }
}

interface NodeFixture {
  coreHost: CoreInProcessRuntimeHost;
  local: CoreHostAdapter;
  transport: FakeTransport;
  routing: RoutingTeamHost;
}

/** 创建一个节点：core Host + CoreHostAdapter + RoutingTeamHost */
function createNode(nodeId: string): NodeFixture {
  const coreHost = new CoreInProcessRuntimeHost();
  const transport = new FakeTransport();
  const holder: { routing?: RoutingTeamHost } = {};
  const local = new CoreHostAdapter(coreHost, {
    deliverResult: (message) => holder.routing?.deliverResult(message) ?? Promise.resolve(),
  });
  const routing = new RoutingTeamHost({
    local,
    transport,
    nodeId,
    ownerId: 'owner',
  });
  holder.routing = routing;
  return { coreHost, local, transport, routing };
}

/** 构造消息 */
function message(
  from: string,
  to: string,
  kind: TeamMessage['kind'],
  content: string,
): TeamMessage {
  return { id: `msg-${from}-${to}-${content}`, from, to, kind, content, ts: Date.now() };
}

/** 等条件成立 */
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 拖住直到被 abort 的 provider */
const abortableProvider: LLMProvider = {
  chat(req) {
    return new Promise((_resolve, reject) => {
      if (req.signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  },
};

/** spawn 一个本地成员 */
async function spawnWorker(
  node: NodeFixture,
  id: string,
  provider: LLMProvider = new MemoryLLMProvider(),
): Promise<AgentStatus> {
  return node.routing.spawn({
    id,
    provider,
    model: 'test-model',
    pluginHost: new MemoryPluginHost(),
  });
}

/** 一个声明了指定 agent 的 peer */
function peer(nodeId: string, agentIds: string[]): PeerInfo {
  return {
    nodeId,
    agents: agentIds.map((id) => ({ id, state: 'idle', toolNames: [] })),
    protocol: 1,
  };
}

describe('地址解析', () => {
  it('本机简写与 canonical 地址', () => {
    expect(parseAgentAddress('worker')).toEqual({ agentId: 'worker', canonical: false });
    expect(parseAgentAddress('nodeA:worker')).toEqual({
      nodeId: 'nodeA',
      agentId: 'worker',
      canonical: true,
    });
  });

  it('非法地址报稳定错误', () => {
    for (const value of ['a:b:c', ':worker', 'node:', 'no de:worker', `${'x'.repeat(65)}`]) {
      expect(() => parseAgentAddress(value)).toThrow(/invalid agent address/);
    }
  });
});

describe('RoutingTeamHost 本机路径', () => {
  it('本机简写优先，即使远端有同名成员', async () => {
    const node = createNode('nodeA');
    await spawnWorker(node, 'worker');
    node.transport.peersList = [peer('nodeB', ['worker'])];

    const task = message('owner', 'worker', 'task', 'hello');
    await node.routing.send(task);

    const inbox = await waitFor(async () => {
      const page = await node.routing.inbox('owner');
      return page.messages.length > 0 ? page : undefined;
    });
    expect(inbox.messages[0]?.content).toBe('Echo: hello');
    expect(node.transport.sent).toHaveLength(0);
  });

  it('canonical 本机地址走 local', async () => {
    const node = createNode('nodeA');
    await spawnWorker(node, 'worker');
    await node.routing.send(message('owner', 'nodeA:worker', 'message', 'hi'));
    expect(node.transport.sent).toHaveLength(0);
    expect((await node.routing.inbox('nodeA:worker')).messages).toHaveLength(1);
  });

  it('本机广播 `*` 不经过 transport', async () => {
    const node = createNode('nodeA');
    await spawnWorker(node, 'worker');
    node.transport.peersList = [peer('nodeB', ['other'])];
    await node.routing.send(message('owner', '*', 'message', 'all'));
    expect(node.transport.sent).toHaveLength(0);
    expect((await node.routing.inbox('worker')).messages).toHaveLength(1);
  });
});

describe('RoutingTeamHost 远端路径', () => {
  it('简写通过 peers 发现远端并补 canonical 地址', async () => {
    const node = createNode('nodeA');
    node.transport.peersList = [peer('nodeB', ['worker'])];

    await node.routing.send(message('owner', 'worker', 'message', 'hi'));

    expect(node.transport.sent).toHaveLength(1);
    expect(node.transport.sent[0]).toMatchObject({
      to: 'nodeB:worker',
      from: 'nodeA:owner',
      kind: 'message',
      content: 'hi',
    });
  });

  it('显式 canonical 远端地址直接发送', async () => {
    const node = createNode('nodeA');
    await node.routing.send(message('owner', 'nodeB:worker', 'task', 'hello'));
    expect(node.transport.sent[0]?.to).toBe('nodeB:worker');
  });

  it('未知与歧义返回稳定错误', async () => {
    const node = createNode('nodeA');
    await expect(node.routing.send(message('owner', 'missing', 'message', 'x'))).rejects.toThrow(
      /unknown team member: missing/,
    );

    node.transport.peersList = [peer('nodeB', ['dup']), peer('nodeC', ['dup'])];
    await expect(node.routing.send(message('owner', 'dup', 'message', 'x'))).rejects.toThrow(
      /ambiguous team member: dup \(nodes: nodeB, nodeC\)/,
    );
  });

  it('远端 inbox/status 在 0.2 返回稳定错误', async () => {
    const node = createNode('nodeA');
    await expect(node.routing.inbox('nodeB:worker')).rejects.toThrow(
      /remote inbox is not supported in 0.2/,
    );
    await expect(node.routing.status('nodeB:worker')).rejects.toThrow(
      /remote status is not supported in 0.2/,
    );
  });

  it('失败隔离：peers 失败不影响本机；transport 失败返回稳定错误', async () => {
    const node = createNode('nodeA');
    await spawnWorker(node, 'worker');
    node.transport.peersFailure = new Error('peers down');

    // 本机路径不受影响
    await node.routing.send(message('owner', 'worker', 'task', 'hello'));
    const inbox = await waitFor(async () => {
      const page = await node.routing.inbox('owner');
      return page.messages.length > 0 ? page : undefined;
    });
    expect(inbox.messages[0]?.content).toBe('Echo: hello');

    // 远端发现失败 = 未知
    await expect(
      node.routing.send(message('owner', 'remote-only', 'message', 'x')),
    ).rejects.toThrow(/unknown team member/);

    node.transport.sendFailure = new Error('wire down');
    await expect(
      node.routing.send(message('owner', 'nodeB:worker', 'message', 'x')),
    ).rejects.toThrow(/transport send failed: wire down/);
  });
});

describe('双节点端到端', () => {
  /** 建两个互相直投的节点 */
  function createPair(): { a: NodeFixture; b: NodeFixture } {
    const a = createNode('nodeA');
    const b = createNode('nodeB');
    a.transport.peerWire = b.transport;
    b.transport.peerWire = a.transport;
    a.transport.peersList = [peer('nodeB', ['worker', 'slow'])];
    b.transport.peersList = [peer('nodeA', [])];
    return { a, b };
  }

  it('远端 task 在 B 执行，result 回投 A 的 owner 收件箱', async () => {
    const { a, b } = createPair();
    await spawnWorker(b, 'worker');

    const task = message('owner', 'worker', 'task', 'hello');
    await a.routing.send(task);

    const inbox = await waitFor(async () => {
      const page = await a.routing.inbox('owner');
      return page.messages.length > 0 ? page : undefined;
    });
    expect(inbox.messages[0]).toMatchObject({
      kind: 'result',
      from: 'nodeB:worker',
      // 入站后剥离本机 nodeId，保持 0.1 收件箱形状
      to: 'owner',
      content: 'Echo: hello',
      reply_to: task.id,
    });
  });

  it('跨进程 cancel 为尽力取消', async () => {
    const { a, b } = createPair();
    await spawnWorker(b, 'slow', abortableProvider);
    await a.routing.send(message('owner', 'nodeB:slow', 'task', 'never finish'));

    await waitFor(async () => {
      const status = (await b.routing.status('slow')) as { state: string };
      return status.state === 'running' ? true : undefined;
    });
    await a.routing.cancel('nodeB:slow');

    const cancelled = await waitFor(async () => {
      const status = (await b.routing.status('slow')) as { state: string };
      return status.state === 'cancelled' ? status : undefined;
    });
    expect(cancelled.state).toBe('cancelled');
    expect(a.transport.sent.some((item) => item.kind === 'cancel')).toBe(true);
  });
});
