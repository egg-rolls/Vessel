/**
 * gateway 测试基建：runtime 构造、脚本化 provider、WS 测试客户端。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentRuntime,
  type AgentStatus,
  type ChatRequest,
  type ContextManager,
  type EventStream,
  type LLMProvider,
  type LLMResponse,
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  type PluginHost,
  type RuntimePermissionConfig,
  type SessionBackend,
} from '@vessel/core';
import { type Gateway, type GatewayOptions, startGateway } from '../src/gateway';
import type { ServerFrame } from '../src/protocol';
import type { TeamGatewayOptions } from '../src/team';
import { createLoopbackTransport, type LoopbackTransport } from '../src/transport/index';

/** 创建一个 echo 式 runtime（MemoryLLMProvider 回显输入） */
export async function createRuntime(opts: {
  events: EventStream;
  provider?: LLMProvider;
  pluginHost?: PluginHost;
  context?: ContextManager;
  session?: SessionBackend;
  permission?: RuntimePermissionConfig;
}): Promise<AgentRuntime> {
  return AgentRuntime.create({
    provider: opts.provider ?? new MemoryLLMProvider(),
    model: 'test-model',
    pluginHost: opts.pluginHost ?? new MemoryPluginHost(),
    context: opts.context ?? new MemoryContextManager(),
    events: opts.events,
    limits: { requestLimit: 20, toolCallsLimit: 10 },
    termination: { maxIterations: 10 },
    ...(opts.session ? { session: opts.session } : {}),
    ...(opts.permission ? { permission: opts.permission } : {}),
  });
}

/** 启动一个测试 gateway（port: 0） */
export function createGateway(
  overrides: Partial<GatewayOptions> & { events: EventStream },
): Gateway {
  return startGateway({
    port: 0,
    ...overrides,
  });
}

/** 记录每次 chat 请求消息的 provider（用于会话隔离断言） */
export class RecordingProvider implements LLMProvider {
  readonly requests: ChatRequest[] = [];

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    const user = [...req.messages].reverse().find((m) => m.role === 'user');
    return {
      content: `Echo: ${user?.content ?? ''}`,
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
}

/** 慢 provider：支持 AbortSignal，用于取消与队列测试 */
export class SlowProvider implements LLMProvider {
  constructor(private readonly delayMs = 500) {}

  async chat(req: ChatRequest): Promise<LLMResponse> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      if (req.signal?.aborted) {
        onAbort();
        return;
      }
      req.signal?.addEventListener('abort', onAbort, { once: true });
    });
    return {
      content: 'slow-done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
}

/** 最后一条不是 tool 结果时返回 tool_call，否则返回最终文本（支持多轮 run） */
export class ToolCallingProvider implements LLMProvider {
  constructor(
    private readonly toolName: string,
    private readonly args = '{}',
  ) {}

  async chat(req: ChatRequest): Promise<LLMResponse> {
    const last = req.messages[req.messages.length - 1];
    if (last?.role !== 'tool') {
      return {
        content: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: this.toolName, arguments: this.args },
          },
        ],
      };
    }
    return { content: 'tool-finished', finish_reason: 'stop' };
  }
}

/** WS 测试客户端：首帧鉴权、按 kind/type 等待帧、记录已收帧 */
export class TestWs {
  private readonly frames: ServerFrame[] = [];
  private readonly waiters: Array<{
    match: (frame: ServerFrame) => boolean;
    resolve: (frame: ServerFrame) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private closeCode: number | null = null;
  private closeWaiters: Array<{
    resolve: (code: number) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      this.push(frame);
    });
    ws.addEventListener('close', (event) => {
      this.closeCode = event.code;
      for (const waiter of this.closeWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(event.code);
      }
    });
  }

  /** 建立连接并发送首帧 auth */
  static async connect(
    gateway: Gateway,
    opts: { token?: string | null; since?: number } = {},
  ): Promise<TestWs> {
    const wsUrl = `${gateway.url.replace(/^http/, 'ws')}/v1/events?since=${opts.since ?? 0}`;
    const ws = new WebSocket(wsUrl);
    const client = new TestWs(ws);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`WS connect failed: ${wsUrl}`)), {
        once: true,
      });
    });
    const token = opts.token === undefined ? gateway.token : opts.token;
    if (token !== null) {
      ws.send(JSON.stringify({ v: 1, kind: 'auth', token }));
    }
    return client;
  }

  private push(frame: ServerFrame): void {
    const index = this.waiters.findIndex((waiter) => waiter.match(frame));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      if (!waiter) {
        this.frames.push(frame);
        return;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    this.frames.push(frame);
  }

  /** 等待首个匹配帧 */
  next(match: (frame: ServerFrame) => boolean, timeoutMs = 3000): Promise<ServerFrame> {
    const index = this.frames.findIndex(match);
    if (index >= 0) {
      const [frame] = this.frames.splice(index, 1);
      if (frame) return Promise.resolve(frame);
    }
    return new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new Error('Timed out waiting for WS frame'));
      }, timeoutMs);
      this.waiters.push({ match, resolve, timer });
    });
  }

  /** 等待指定类型的事件帧，返回其 data */
  async nextEvent(type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const frame = await this.next(
      (candidate) => candidate.kind === 'event' && candidate.event.type === type,
      timeoutMs,
    );
    if (frame.kind !== 'event') throw new Error('Unexpected frame kind');
    return frame.event.data as Record<string, unknown>;
  }

  /** 发送 req 并等待同 id 的 res */
  async request(method: string, params?: unknown, timeoutMs = 3000): Promise<unknown> {
    const id = crypto.randomUUID();
    this.ws.send(JSON.stringify({ v: 1, kind: 'req', id, method, params }));
    const frame = await this.next(
      (candidate) => candidate.kind === 'res' && candidate.id === id,
      timeoutMs,
    );
    if (frame.kind !== 'res') throw new Error('Unexpected frame kind');
    if (!frame.ok) throw new Error(`${frame.error.code}: ${frame.error.message}`);
    return frame.result;
  }

  /** 等待连接关闭，返回 close code */
  closed(timeoutMs = 3000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeoutMs);
      this.closeWaiters.push({ resolve, timer });
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** 等待一个短时间（轮询用） */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到 predicate 为真或超时 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error('waitUntil timed out');
}

/** 共享 MemoryEventStream 的快捷构造 */
export function newEvents(): MemoryEventStream {
  return new MemoryEventStream();
}

/** 创建临时目录（调用方负责 rm） */
export function makeTempDir(prefix = 'vessel-serve-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** 清理临时目录 */
export function removeTempDir(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true });
}

export interface TeamNodeOptions {
  nodeId: string;
  peersDir: string;
  token?: string;
  heartbeatMs?: number;
  peerTtlMs?: number;
  host?: TeamGatewayOptions['host'];
  spawn?: TeamGatewayOptions['spawn'];
  deliver?: TeamGatewayOptions['deliver'];
  /** 本节点成员快照（写入注册表） */
  agents?: () => AgentStatus[];
}

/** 启动一个带 LoopbackTransport 的 gateway 节点 */
export async function createTeamNode(options: TeamNodeOptions): Promise<{
  gateway: Gateway;
  transport: LoopbackTransport;
  events: MemoryEventStream;
}> {
  const events = new MemoryEventStream();
  const gateway = startGateway({
    events,
    port: 0,
    nodeId: options.nodeId,
    ...(options.token ? { token: options.token } : {}),
  });
  const transport = await createLoopbackTransport({
    nodeId: options.nodeId,
    endpoint: gateway.url,
    token: gateway.token,
    peersDir: options.peersDir,
    heartbeatMs: options.heartbeatMs ?? 100,
    peerTtlMs: options.peerTtlMs ?? 500,
    ...(options.agents ? { agents: options.agents } : {}),
  });
  gateway.attachTeam({
    nodeId: options.nodeId,
    transport,
    ...(options.host ? { host: options.host } : {}),
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.deliver ? { deliver: options.deliver } : {}),
  });
  return { gateway, transport, events };
}
