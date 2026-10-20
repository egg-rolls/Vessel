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
} from '@vessel-agent/core';
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

interface RecordedRequest {
  nodeId: string;
  request: { requestId?: string; method: string; params?: unknown };
}

/** 带 request 能力的 fake transport（0.6 跨节点控制） */
class RequestFakeTransport extends FakeTransport {
  readonly calls: RecordedRequest[] = [];
  responder: (nodeId: string, request: RecordedRequest['request']) => Promise<unknown> =
    async () => {
      throw new Error('no responder');
    };

  async request<T>(nodeId: string, request: RecordedRequest['request']): Promise<T> {
    this.calls.push({ nodeId, request });
    return (await this.responder(nodeId, request)) as T;
  }
}

interface NodeFixture {
  coreHost: CoreInProcessRuntimeHost;
  local: CoreHostAdapter;
  transport: FakeTransport;
  routing: RoutingTeamHost;
}

/** 创建一个节点：core Host + CoreHostAdapter + RoutingTeamHost */
function createNode(nodeId: string, transport: FakeTransport = new FakeTransport()): NodeFixture {
  const coreHost = new CoreInProcessRuntimeHost();
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

/** gateway wire status */
function wireStatus(id: string, state = 'idle'): Record<string, unknown> {
  return { id, state, tool_names: [] };
}

/** gateway wire message */
function wireMessage(id: string, content = 'hi'): Record<string, unknown> {
  return {
    id,
    from: 'owner',
    to: 'worker',
    kind: 'message',
    content,
    ts: Date.now(),
  };
}

/** 构造可本地 spawn 的 spec */
function spec(overrides: Partial<Parameters<RoutingTeamHost['spawn']>[0]> = {}) {
  return {
    name: 'worker',
    provider: new MemoryLLMProvider(),
    model: 'test-model',
    pluginHost: new MemoryPluginHost(),
    ...overrides,
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

  it('transport 无 request 时远端 inbox/status/spawn 返回 remote_unsupported', async () => {
    const node = createNode('nodeA');
    await expect(node.routing.inbox('nodeB:worker')).rejects.toThrow(/remote_unsupported/);
    await expect(node.routing.status('nodeB:worker')).rejects.toThrow(/remote_unsupported/);
    await expect(node.routing.spawn(spec(), 'nodeB')).rejects.toThrow(/remote_unsupported/);
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

describe('RoutingTeamHost 远端控制（0.6）', () => {
  it('远端 spawn 走 team.spawn；本机 spawn 不发 request', async () => {
    const transport = new RequestFakeTransport();
    transport.responder = async () => ({ protocol: 1, agent: wireStatus('worker') });
    const node = createNode('nodeA', transport);

    await node.routing.spawn(spec());
    expect(transport.calls).toHaveLength(0);

    const status = await node.routing.spawn(spec({ systemPrompt: 'be brief' }), 'nodeB');
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({
      nodeId: 'nodeB',
      request: {
        method: 'team.spawn',
        params: { name: 'worker', model: 'test-model', systemPrompt: 'be brief' },
      },
    });
    expect(status).toMatchObject({
      id: 'worker',
      state: 'idle',
      toolNames: [],
      nodeId: 'nodeB',
    });
  });

  it('远端 inbox 分页映射 wire 消息并带 nodeId', async () => {
    const transport = new RequestFakeTransport();
    transport.responder = async () => ({
      protocol: 1,
      agent_id: 'worker',
      messages: [wireMessage('m1')],
      cursor: 'c2',
    });
    const node = createNode('nodeA', transport);

    const page = await node.routing.inbox('nodeB:worker', 'c1');
    expect(transport.calls[0]).toMatchObject({
      nodeId: 'nodeB',
      request: { method: 'team.inbox', params: { agentId: 'worker', cursor: 'c1' } },
    });
    expect(page.cursor).toBe('c2');
    expect(page.messages[0]).toMatchObject({ id: 'm1', content: 'hi', nodeId: 'nodeB' });
  });

  it('远端单成员与整节点 status', async () => {
    const transport = new RequestFakeTransport();
    let response: unknown = { protocol: 1, agent: wireStatus('worker', 'running') };
    transport.responder = async () => response;
    const node = createNode('nodeA', transport);

    const one = await node.routing.status('nodeB:worker');
    expect(one).toMatchObject({ id: 'worker', state: 'running', nodeId: 'nodeB' });
    expect(transport.calls[0]?.request).toMatchObject({
      method: 'team.status',
      params: { agentId: 'worker' },
    });

    response = { protocol: 1, agents: [wireStatus('worker'), wireStatus('other')] };
    const all = (await node.routing.status(undefined, 'nodeB')) as Array<{
      id: string;
      nodeId?: string;
    }>;
    expect(all.map((item) => item.id)).toEqual(['worker', 'other']);
    expect(all.every((item) => item.nodeId === 'nodeB')).toBe(true);
    expect(transport.calls[1]?.request).toMatchObject({ method: 'team.status.list' });
  });

  it('status/inbox 超时重试一次并复用 requestId；spawn 不重试', async () => {
    const transport = new RequestFakeTransport();
    let calls = 0;
    transport.responder = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('slow'), { code: 'timeout' });
      return { protocol: 1, agents: [] };
    };
    const node = createNode('nodeA', transport);
    expect(await node.routing.status(undefined, 'nodeB')).toEqual([]);
    expect(calls).toBe(2);
    expect(transport.calls[0]?.request.requestId).toBe(transport.calls[1]?.request.requestId);

    calls = 0;
    transport.responder = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('slow'), { code: 'timeout' });
      return { protocol: 1, agent_id: 'worker', messages: [], cursor: '' };
    };
    await node.routing.inbox('nodeB:worker');
    expect(calls).toBe(2);

    calls = 0;
    transport.responder = async () => {
      calls += 1;
      throw Object.assign(new Error('slow'), { code: 'timeout' });
    };
    await expect(node.routing.spawn(spec(), 'nodeB')).rejects.toThrow(/timeout/);
    expect(calls).toBe(1);
  });

  it('错误码归一：已知码保留，未知码按 peer_unreachable', async () => {
    const transport = new RequestFakeTransport();
    const node = createNode('nodeA', transport);
    let code: string | undefined;

    transport.responder = async () => {
      throw Object.assign(new Error('denied'), { code: 'unauthorized' });
    };
    try {
      await node.routing.status('nodeB:worker');
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('unauthorized');

    transport.responder = async () => {
      throw Object.assign(new Error('weird'), { code: 'something_else' });
    };
    try {
      await node.routing.inbox('nodeB:worker');
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('peer_unreachable');
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
