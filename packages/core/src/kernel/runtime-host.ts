/**
 * InProcessRuntimeHost —— 0.2 R1/R2
 *
 * 单进程多 agent 宿主：成员注册、生命周期、消息投递与 run 句柄。
 * - `AgentRuntime` 仍是单 agent loop；Host 只负责包在外面（不重写 loop）。
 * - 成员 context 独占；共享 SessionBackend 按 agentId 命名空间隔离（D3）。
 * - 每成员独立 EventStream，Host 聚合转发并补 `agentId`（D4/A7）。
 * - run 统一经 Scheduler（并发/队列/同成员串行在 R2 Scheduler）。
 * - Transport 只保留注入点；实现归 R3a-core。
 *
 * @module @vessel-agent/core/kernel
 */

import { randomUUID } from 'node:crypto';
import { MemoryContextManager } from '../context/context-manager.js';
import { MemoryEventStream } from '../events/event-stream.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { MemoryPluginHost } from '../runtime/plugin-host.js';
import type { ContextManager } from '../types/context.js';
import type { EventStream, RunEvent, Unsubscribe } from '../types/event.js';
import type { Logger } from '../types/logging.js';
import type { AgentRuntimeOptions, PluginHost, RuntimePermissionConfig } from '../types/plugin.js';
import type { Message, Usage } from '../types/provider.js';
import type { RunInterruptReason, RunOptions } from '../types/run.js';
import type { RunStore } from '../types/run-store.js';
import { RunResumeError } from '../types/run-store.js';
import type { SessionBackend } from '../types/session.js';
import { MemoryEventBus } from './event-bus.js';
import {
  type InternalAgentHandle,
  type InternalScheduler,
  kCancelAgentRuns,
  kExecuteAgentRun,
} from './internal.js';
import { InProcessScheduler } from './scheduler.js';
import { AgentSessionScope } from './session-scope.js';
import type {
  AgentHandle,
  AgentMessage,
  AgentSnapshot,
  AgentSpec,
  AgentState,
  AgentStatus,
  EventBus,
  HostSnapshot,
  InboxPage,
  Limits,
  RunHandle,
  RunnableAgent,
  RunSnapshot,
  RunStatus,
  RuntimeHost,
  ScheduledTask,
  Scheduler,
  SchedulerOptions,
  SchedulerSnapshot,
  Transport,
  WaitReason,
} from './types.js';

/** Host 构造选项 */
export interface InProcessRuntimeHostOptions {
  /** 成员默认能力集；spec.pluginHost 优先 */
  pluginHost?: PluginHost;
  /** 成员独占上下文工厂；缺省 MemoryContextManager */
  contextFactory?: () => ContextManager;
  /** 共享 session 后端；成员按 agentId 命名空间隔离 */
  session?: SessionBackend;
  /** 聚合事件总线；缺省新建 MemoryEventBus */
  events?: EventBus;
  /** 默认限额；成员 spec.limits 优先 */
  limits?: Limits;
  /** 调度器；缺省 InProcessScheduler */
  scheduler?: Scheduler;
  /** 缺省调度器的选项（自定义 scheduler 注入时忽略） */
  schedulerOptions?: SchedulerOptions;
  /** 成员缺省规格（id 不继承）；spec 优先 */
  defaults?: Partial<AgentSpec>;
  /** 成员缺省权限策略；spec.permission 优先 */
  permission?: RuntimePermissionConfig;
  /** R3a 注入点：Transport 实例；R2 只保存，不消费 */
  transport?: Transport;
  /** F5：覆盖默认 AgentRuntime（默认 AgentRuntime.create） */
  runtimeFactory?: (options: AgentRuntimeOptions) => Promise<RunnableAgent>;
  /** F5：覆盖成员事件流实现（默认 MemoryEventStream） */
  eventStreamFactory?: () => EventStream;
  /** 成员上限，默认 8 */
  maxMembers?: number;
  /** 0.5：Host 级 tenant；成员 spec.tenantId 优先 */
  tenantId?: string;
  /**
   * 可选：durable run store。Host 把它注入每个成员 runtime（Host 优先），
   * `Host.resume` 也用它加载 checkpoint。Host 自身不写 checkpoint。
   */
  runStore?: RunStore;
  /** 0.14.1：透传给每个成员 runtime 的插件安装配置 */
  pluginConfigs?: Record<string, Record<string, unknown>>;
  /** 0.14.1：透传给每个成员 runtime 的诊断 logger */
  logger?: Logger;
  /** 0.14.1：透传给每个成员 runtime 的 reasoning 开关 */
  includeReasoning?: boolean;
}

/** Agent id 合法字符集（A11） */
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface MemberRecord {
  id: string;
  name?: string;
  spec: AgentSpec;
  runtime: RunnableAgent;
  events: EventStream;
  /** 成员独占上下文（快照 context_used / context_max 使用） */
  context: ContextManager;
  state: AgentState;
  inbox: AgentMessage[];
  active?: InProcessRunHandle;
  unsubscribeEvents: Unsubscribe;
  lastError?: string;
  /** 最近活动时间（Unix ms；0.15 E3） */
  lastSeen: number;
  closed: boolean;
}

/** 队列快照里与成员相关的字段 */
interface QueueInfo {
  position?: number;
  waitReason?: WaitReason;
}

/** 成员默认 session id（空串按 default） */
function defaultSessionId(spec: AgentSpec): string {
  return spec.sessionId || 'default';
}

/** 把 agentId 合入事件 data（不修改原对象） */
function withAgentId(data: unknown, agentId: string): Record<string, unknown> {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), agentId };
  }
  return { value: data, agentId };
}

/** 从 abort reason 提取可序列化的取消原因；非字符串（如 DOMException）不写入事件 */
function cancelReasonFields(signal: AbortSignal): Record<string, unknown> {
  return typeof signal.reason === 'string' ? { reason: signal.reason } : {};
}

/** 解析收件箱游标；非法值按 0 */
function parseCursor(cursor?: string): number {
  const value = Number.parseInt(cursor ?? '0', 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 从事件 data 读取 requestId（交互暂停事件约定字段） */
function readRequestId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as Record<string, unknown>).requestId;
  return typeof value === 'string' ? value : undefined;
}

/** 从 spec.metadata.task 读取任务摘要（Ext 约定；形状不符则忽略） */
function readTask(metadata: Record<string, unknown> | undefined): AgentSnapshot['task'] {
  const value = metadata?.task;
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return undefined;
  return {
    id: record.id,
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
  };
}

/** 从 run.completed 事件读取 usage（A9） */
function readUsage(data: unknown): Usage | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as Record<string, unknown>).usage;
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Usage;
}

/** 进程内多 agent 宿主 */
export class InProcessRuntimeHost implements RuntimeHost {
  readonly events: EventBus;

  private readonly members = new Map<string, MemberRecord>();
  private readonly handles = new Map<string, AgentHandle>();
  /** 已通过 spawn 检查、尚未完成异步构造的成员 id（名额预留） */
  private readonly spawning = new Set<string>();
  /** 非成员邮箱（owner / 外部地址）；send 时按需创建（Q2） */
  private readonly extraInboxes = new Map<string, AgentMessage[]>();
  /** 子成员交互请求 → 其事件流；用于把 owner 的应答路由回去（B4） */
  private readonly pendingInteractions = new Map<
    string,
    { memberId: string; runId: string; events: EventStream }
  >();
  private readonly responseUnsubscribe: Unsubscribe;
  private readonly pluginHost?: PluginHost;
  private readonly contextFactory?: () => ContextManager;
  private readonly session?: SessionBackend;
  private readonly limits?: Limits;
  private readonly defaults?: Partial<AgentSpec>;
  private readonly permission?: RuntimePermissionConfig;
  private readonly runtimeFactory: (options: AgentRuntimeOptions) => Promise<RunnableAgent>;
  private readonly eventStreamFactory: () => EventStream;
  private readonly maxMembers: number;
  readonly scheduler: Scheduler;
  /** R3a 注入点：当前只保存，不参与消息路由 */
  readonly transport?: Transport;
  private readonly runStore?: RunStore;
  private readonly tenantId?: string;
  private readonly pluginConfigs?: Record<string, Record<string, unknown>>;
  private readonly logger?: Logger;
  private readonly includeReasoning?: boolean;
  /** 同一 run 的并发 resume 锁（进程内） */
  private readonly resuming = new Set<string>();
  private closed = false;

  constructor(options: InProcessRuntimeHostOptions = {}) {
    this.events = options.events ?? new MemoryEventBus();
    this.pluginHost = options.pluginHost;
    this.contextFactory = options.contextFactory;
    this.session = options.session;
    this.limits = options.limits;
    this.defaults = options.defaults;
    this.permission = options.permission;
    this.transport = options.transport;
    this.runStore = options.runStore;
    this.tenantId = options.tenantId;
    this.pluginConfigs = options.pluginConfigs;
    this.logger = options.logger;
    this.includeReasoning = options.includeReasoning;
    this.runtimeFactory =
      options.runtimeFactory ?? ((runtimeOptions) => AgentRuntime.create(runtimeOptions));
    this.eventStreamFactory = options.eventStreamFactory ?? (() => new MemoryEventStream());
    // 0.15 E4：默认 Scheduler 复用 Host 事件总线发布队列事件（自定义 Scheduler 自行决定）
    this.scheduler =
      options.scheduler ??
      new InProcessScheduler({
        ...options.schedulerOptions,
        events: options.schedulerOptions?.events ?? this.events,
        ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
      });
    this.maxMembers = Math.max(1, options.maxMembers ?? 8);

    // B4：Host 聚合子成员事件（含 tool.permission.request / ask.user.requested），
    // owner 在聚合流上应答；这里把应答路由回发起请求的成员事件流。
    this.responseUnsubscribe = this.events.subscribe((event) => {
      if (event.type === 'tool.permission.response' || event.type === 'ask.user.answered') {
        this.routeInteractionResponse(event);
      }
    });
  }

  async spawn(spec: AgentSpec): Promise<AgentHandle> {
    if (this.closed) throw new Error('runtime host is closed');

    // 成员缺省规格继承（id 不继承，避免多个成员拿到同一个默认 id）
    const resolved = { ...(this.defaults ?? {}), ...spec } as AgentSpec;
    resolved.id = spec.id;

    if (!resolved.provider) throw new Error('AgentSpec.provider is required');
    if (!resolved.model) throw new Error('AgentSpec.model is required');

    const id = resolved.id ?? randomUUID();
    if (!AGENT_ID_PATTERN.test(id)) {
      throw new Error(`invalid agent id "${id}": must match [A-Za-z0-9_-]{1,64}`);
    }
    // 同步预留名额：runtimeFactory 是异步的，若只检查 members.size，并发 spawn
    // 会全部通过检查；spawning 记录「已通过检查、尚未注册」的 id。
    if (this.members.has(id) || this.spawning.has(id)) {
      throw new Error(`agent already exists: ${id}`);
    }
    if (this.members.size + this.spawning.size >= this.maxMembers) {
      throw new Error(`agent limit reached (max ${this.maxMembers})`);
    }
    this.spawning.add(id);

    let runtime: RunnableAgent | undefined;
    let unsubscribeEvents: Unsubscribe | undefined;
    try {
      const memberEvents = this.eventStreamFactory();
      const context = resolved.context ?? this.contextFactory?.() ?? new MemoryContextManager();
      const session =
        resolved.session ?? (this.session ? new AgentSessionScope(this.session, id) : undefined);
      const limits = resolved.limits ?? this.limits ?? {};
      // 0.2 R1/R2：run/agent 同源；host 预算与更细作用域后续接
      const runLimits = limits.run ?? limits.agent ?? {};
      const termination = limits.termination ??
        resolved.termination ?? { maxIterations: 10, maxRuntimeSeconds: 60 };
      const permission = resolved.permission ?? this.permission;
      const tenantId = resolved.tenantId ?? this.tenantId;

      runtime = await this.runtimeFactory({
        provider: resolved.provider,
        model: resolved.model,
        context,
        events: memberEvents,
        pluginHost: resolved.pluginHost ?? this.pluginHost ?? new MemoryPluginHost(),
        ...(session ? { session } : {}),
        limits: runLimits,
        termination,
        ...(resolved.systemPrompt !== undefined ? { systemPrompt: resolved.systemPrompt } : {}),
        ...(permission !== undefined ? { permission } : {}),
        // 0.3：Host 的 store 优先；checkpoint 单写者是成员 runtime
        ...(this.runStore ? { runStore: this.runStore } : {}),
        ...(tenantId !== undefined ? { tenantId } : {}),
        // 0.14.1：Host 级配置透传（成员可覆写的更细粒度留后）
        ...(this.pluginConfigs !== undefined ? { pluginConfigs: this.pluginConfigs } : {}),
        ...(this.logger !== undefined ? { logger: this.logger } : {}),
        ...(this.includeReasoning !== undefined ? { includeReasoning: this.includeReasoning } : {}),
        ...(resolved.selfCard !== undefined ? { selfCard: resolved.selfCard } : {}),
        agentId: id,
      });

      // spawn 等待期间 Host 可能已关闭：不要往已关闭的 Host 里注册成员
      if (this.closed) throw new Error('runtime host is closed');

      const record: MemberRecord = {
        id,
        ...(resolved.name !== undefined ? { name: resolved.name } : {}),
        spec: resolved,
        runtime,
        events: memberEvents,
        context,
        state: 'idle',
        inbox: [],
        unsubscribeEvents: () => {},
        lastSeen: Date.now(),
        closed: false,
      };

      unsubscribeEvents = memberEvents.subscribe((event) => {
        // B4：记录交互请求的归属；请求本身继续转发到 Host 聚合流（owner 可见）
        if (event.type === 'tool.permission.request' || event.type === 'ask.user.requested') {
          const requestId = readRequestId(event.data);
          if (requestId) {
            this.pendingInteractions.set(requestId, {
              memberId: id,
              runId: event.run_id,
              events: memberEvents,
            });
          }
        }
        // 0.3 加固：run 结束后清理未应答的交互请求，避免长生命周期进程泄漏
        if (
          event.type === 'run.completed' ||
          event.type === 'run.failed' ||
          event.type === 'run.cancelled'
        ) {
          this.clearRunInteractions(id, event.run_id);
        }
        // Host 路由回来的应答不再转发，避免 host.events ↔ member.events 回环
        if (event.type === 'tool.permission.response' || event.type === 'ask.user.answered') {
          return;
        }
        // A9：从 run.completed 捕获本次 run 的 usage
        if (event.type === 'run.completed') {
          const usage = readUsage(event.data);
          if (usage) record.active?.setUsage(usage);
        }
        this.events.publish({
          ...event,
          ...(this.tenantId !== undefined && event.tenant_id === undefined
            ? { tenant_id: this.tenantId }
            : {}),
          data: withAgentId(event.data, id),
        });
      });
      record.unsubscribeEvents = unsubscribeEvents;

      const handle = new InProcessAgentHandle(this, record);
      this.members.set(id, record);
      this.handles.set(id, handle);
      this.publish('agent.spawned', {
        agentId: id,
        ...(resolved.name !== undefined ? { name: resolved.name } : {}),
      });

      return handle;
    } catch (error) {
      // 失败路径：释放已创建的 runtime 与订阅，避免名额/资源泄漏
      this.members.delete(id);
      this.handles.delete(id);
      unsubscribeEvents?.();
      await runtime?.dispose();
      throw error;
    } finally {
      this.spawning.delete(id);
    }
  }

  get(id: string): AgentHandle | undefined {
    return this.handles.get(id);
  }

  list(): AgentStatus[] {
    return [...this.members.values()].map((record) => this.toStatus(record));
  }

  async send(message: AgentMessage): Promise<void> {
    if (this.closed) throw new Error('runtime host is closed');
    if (!message.to) throw new Error('message.to is required');

    if (message.to === '*') {
      for (const record of this.members.values()) {
        if (record.id !== message.from) this.deliverLocal(record, message);
      }
      return;
    }

    const target = this.members.get(message.to);
    if (target) {
      this.deliverLocal(target, message);
      return;
    }

    // 非成员邮箱（owner / 外部地址）：按需创建；core 不解析地址（Q2/A12）
    this.deliverExternal(message);
  }

  async inbox(id: string, cursor?: string): Promise<InboxPage> {
    const record = this.members.get(id);
    if (record) return this.readPage(record.inbox, cursor);
    // 非成员邮箱：可读任意 mailbox（Q2）；未创建时返回空页
    return this.readPage(this.extraInboxes.get(id) ?? [], cursor);
  }

  cancel(id: string, runId?: string, reason?: RunInterruptReason): void {
    const handle = this.handles.get(id);
    if (!handle) throw new Error(`unknown agent: ${id}`);
    handle.cancel(runId, reason);
  }

  /** 0.14.1：agent / run / queue 的只读快照（纯 JSON） */
  snapshot(): HostSnapshot {
    const schedulerSnapshot = this.scheduler.snapshot?.();
    const asOf = schedulerSnapshot?.asOf ?? Date.now();
    const queued = schedulerSnapshot?.queued ?? [];
    const running = schedulerSnapshot?.running ?? [];

    const queueInfo = new Map<string, QueueInfo>();
    for (const entry of queued) {
      if (queueInfo.has(entry.agentId)) continue;
      queueInfo.set(entry.agentId, {
        ...(entry.queuePosition !== undefined ? { position: entry.queuePosition } : {}),
        ...(entry.waitReason !== undefined ? { waitReason: entry.waitReason } : {}),
      });
    }

    const agents: AgentSnapshot[] = [...this.members.values()].map((record) =>
      this.toAgentSnapshot(record, queueInfo.get(record.id) ?? {}),
    );

    // 自定义 Scheduler 不提供 snapshot 时，降级为成员 active run 摘要
    const runs: RunSnapshot[] = schedulerSnapshot
      ? [...running, ...queued]
      : [...this.members.values()].flatMap((record): RunSnapshot[] => {
          const active = record.active;
          if (!active) return [];
          return [
            {
              runId: active.id,
              agentId: record.id,
              sessionId: active.sessionId,
              state: active.status(),
              startedAt: active.startedAt,
            },
          ];
        });

    const scheduler: SchedulerSnapshot = schedulerSnapshot ?? {
      asOf,
      queued: [],
      running: [],
      stats: this.scheduler.stats(),
    };

    return { asOf, agents, runs, scheduler };
  }

  /** 单个成员的快照视图（与 toStatus 同源，额外补 session / 时间） */
  private toAgentSnapshot(record: MemberRecord, queue: QueueInfo): AgentSnapshot {
    const snapshot: AgentSnapshot = {
      id: record.id,
      state: record.state,
      sessionId: record.active?.sessionId ?? defaultSessionId(record.spec),
      toolNames: record.runtime.pluginHost.listTools().map((tool) => tool.name),
      lastSeen: record.lastSeen,
      contextUsed: record.context.tokenCount,
    };
    if (record.name !== undefined) snapshot.name = record.name;
    if (record.active) {
      snapshot.currentRunId = record.active.id;
      snapshot.startedAt = record.active.startedAt;
    }
    if (record.lastError !== undefined) snapshot.lastError = record.lastError;
    if (queue.position !== undefined) snapshot.queuePosition = queue.position;
    if (queue.waitReason !== undefined) snapshot.waitReason = queue.waitReason;
    if (this.transport?.nodeId !== undefined) snapshot.nodeId = this.transport.nodeId;
    if (record.context.maxTokens !== undefined) snapshot.contextMax = record.context.maxTokens;
    const task = readTask(record.spec.metadata);
    if (task !== undefined) snapshot.task = task;
    return snapshot;
  }

  /**
   * 从 durable checkpoint 恢复一次 run。
   * - 0.14.1：经 Scheduler 排队，受 `maxConcurrency` / `perAgentSerial` 约束；
   *   用 `ScheduledTask.runId` 保持 run id 不变（DECISION-008 Addendum B §9.2 C）；
   * - 成员必须先已 spawn，且当前没有 active run；
   * - checkpoint 由成员 runtime 继续写，Host 自身不写。
   */
  async resume(runId: string, opts?: RunOptions): Promise<RunHandle> {
    if (this.closed) throw new Error('runtime host is closed');
    if (!this.runStore) throw new RunResumeError('run_store_required', runId);
    if (this.resuming.has(runId)) throw new RunResumeError('run_already_running', runId);

    // 同步占锁，保证并发调用只有一个能通过校验
    this.resuming.add(runId);
    try {
      const checkpoint = await this.runStore.load(runId);
      if (!checkpoint) throw new RunResumeError('run_not_found', runId);
      if (checkpoint.status !== 'running' && checkpoint.status !== 'interrupted') {
        throw new RunResumeError('run_not_resumable', runId, checkpoint.status);
      }
      if (checkpoint.messages.length === 0) {
        throw new RunResumeError('run_not_resumable', runId, 'empty checkpoint');
      }
      if (!checkpoint.agent_id) {
        throw new RunResumeError('agent_not_found', runId, 'checkpoint has no agent_id');
      }

      const record = this.members.get(checkpoint.agent_id);
      if (!record || record.closed) {
        throw new RunResumeError('agent_not_found', runId, checkpoint.agent_id);
      }
      if (record.active) {
        throw new RunResumeError('run_already_running', runId, 'agent busy');
      }

      const resume = record.runtime.resume?.bind(record.runtime);
      if (!resume) {
        throw new RunResumeError('run_not_resumable', runId, 'runtime does not support resume');
      }

      const handle = this.handles.get(record.id);
      if (!handle) throw new RunResumeError('agent_not_found', runId, record.id);

      const task: ScheduledTask = {
        agent: handle,
        sessionId: checkpoint.session_id,
        input: '',
        ...(opts !== undefined ? { opts } : {}),
        runId,
        executor: (scheduledRunId) =>
          this.startResumeInternal(record, scheduledRunId, checkpoint.session_id, resume, opts),
      };

      const run = await this.scheduler.submit(task);
      const release = (): void => {
        this.resuming.delete(runId);
      };
      void run.result.then(release, release);
      return run;
    } catch (error) {
      this.resuming.delete(runId);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const record of [...this.members.values()]) {
      await this.closeMember(record);
    }
    this.responseUnsubscribe();
    await this.scheduler.close();
    this.pendingInteractions.clear();
    this.extraInboxes.clear();
    this.resuming.clear();
    // 在途 spawn 在 finally 中会安全删除自己；这里清空是为了让 close 后的
    // 重复检查和名额计算立即反映 Host 已关闭，而不是等待异步构造结束。
    this.spawning.clear();
  }

  /** @internal 由 AgentHandle.status() 调用 */
  statusOf(record: MemberRecord): AgentStatus {
    return this.toStatus(record);
  }

  /** @internal AgentHandle.run 的调度入口：进入 Scheduler 队列 */
  enqueueRun(record: MemberRecord, input: string | Message, opts?: RunOptions): Promise<RunHandle> {
    if (record.closed) return Promise.reject(new Error(`agent is closed: ${record.id}`));
    const handle = this.handles.get(record.id);
    if (!handle) return Promise.reject(new Error(`unknown agent: ${record.id}`));

    // 0.14.1：per-run session 覆盖成员默认 session（Scheduler 仍可改写 task.sessionId）
    const task: ScheduledTask = {
      agent: handle,
      sessionId: opts?.sessionId ?? defaultSessionId(record.spec),
      input,
      opts,
    };
    // F9：执行时读取 task.sessionId（自定义 Scheduler 可改写），而不是捕获默认值
    task.executor = (runId) =>
      this.startRunInternal(record, input, { ...opts, runId }, task.sessionId);

    return this.scheduler.submit(task);
  }

  /** @internal Scheduler 直执行入口（不经过队列） */
  async startRunInternal(
    record: MemberRecord,
    input: string | Message,
    opts?: RunOptions,
    sessionId?: string,
  ): Promise<RunHandle> {
    if (record.closed) throw new Error(`agent is closed: ${record.id}`);
    if (record.active) {
      throw new Error(`agent "${record.id}" already has a running run`);
    }

    // F6：Scheduler 传入 runId；F9：Scheduler 传入 sessionId
    const run = new InProcessRunHandle(
      opts?.runId ?? randomUUID(),
      record.id,
      sessionId ?? defaultSessionId(record.spec),
    );
    record.active = run;
    record.state = 'running';
    record.lastError = undefined;
    record.lastSeen = Date.now();

    const removeAbortListener = this.bindRunSignal(run, opts?.signal);

    this.publish('agent.run.started', {
      agentId: record.id,
      runId: run.id,
      sessionId: run.sessionId,
      mirror_of_run_id: run.id,
    });

    void this.executeRun(record, run, input, opts, removeAbortListener);
    return run;
  }

  /**
   * 0.14.1：把调用方 signal 桥接到本次 run。
   * 长会话/网关可能复用同一个 AbortController；run 结束后必须移除监听，
   * 否则监听器随 run 数量线性累积。
   */
  private bindRunSignal(run: InProcessRunHandle, signal?: AbortSignal): (() => void) | undefined {
    if (!signal) return undefined;
    if (signal.aborted) {
      run.cancel(signal.reason);
      return undefined;
    }
    const onAbort = (): void => run.cancel(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  /**
   * 0.14.1：resume 的 Scheduler 执行入口。
   * 与原 startRunInternal 相同地占住 `record.active`，但调用 runtime.resume。
   */
  private async startResumeInternal(
    record: MemberRecord,
    runId: string,
    sessionId: string,
    resume: (runId: string, opts?: RunOptions) => Promise<string>,
    opts?: RunOptions,
  ): Promise<RunHandle> {
    if (record.closed) throw new Error(`agent is closed: ${record.id}`);
    if (record.active) {
      throw new Error(`agent "${record.id}" already has a running run`);
    }

    const run = new InProcessRunHandle(runId, record.id, sessionId);
    record.active = run;
    record.state = 'running';
    record.lastError = undefined;
    record.lastSeen = Date.now();

    const removeAbortListener = this.bindRunSignal(run, opts?.signal);
    void this.executeResume(record, run, resume, opts, removeAbortListener);
    return run;
  }

  /** @internal 由 AgentHandle.cancel() / Host.cancel() 调用 */
  cancelRun(record: MemberRecord, runId?: string, reason?: RunInterruptReason): void {
    if (runId !== undefined) {
      if (record.active?.id === runId) {
        record.active.cancel(reason);
        return;
      }
      // 排队中的 run 由 Scheduler 持有
      if (this.scheduler.cancel(runId, reason)) return;
      throw new Error(`run "${runId}" is not active for agent "${record.id}"`);
    }

    // 未指定 runId：取消该成员排队 + 运行中的 run
    const internal = this.scheduler as Partial<InternalScheduler>;
    const cancelAgent = internal[kCancelAgentRuns];
    if (typeof cancelAgent === 'function') {
      cancelAgent.call(this.scheduler, record.id, reason ?? 'agent cancelled');
    }
    record.active?.cancel(reason);
  }

  /** @internal 由 AgentHandle.close() 调用 */
  async closeMember(record: MemberRecord): Promise<void> {
    if (record.closed) return;
    record.closed = true;

    const internal = this.scheduler as Partial<InternalScheduler>;
    const cancelAgent = internal[kCancelAgentRuns];
    if (typeof cancelAgent === 'function') {
      cancelAgent.call(this.scheduler, record.id, 'agent closed');
    }
    record.active?.cancel('agent closed');
    record.unsubscribeEvents();
    await record.runtime.dispose();
    record.state = 'closed';
    this.members.delete(record.id);
    this.handles.delete(record.id);
    for (const [requestId, pending] of this.pendingInteractions) {
      if (pending.memberId === record.id) this.pendingInteractions.delete(requestId);
    }
    this.publish('agent.closed', { agentId: record.id });
  }

  /** 本地投递：写收件箱 + 发布 message 事件 */
  private deliverLocal(
    record: MemberRecord,
    message: AgentMessage,
    eventType = 'agent.message.sent',
  ): void {
    record.inbox.push(message);
    record.lastSeen = Date.now();
    this.publish(eventType, {
      agentId: record.id,
      messageId: message.id,
      from: message.from,
      to: record.id,
      kind: message.kind,
    });
  }

  /** 非成员邮箱投递：owner / 外部地址（Q2） */
  private deliverExternal(message: AgentMessage): void {
    const inbox = this.extraInboxes.get(message.to) ?? [];
    inbox.push(message);
    this.extraInboxes.set(message.to, inbox);
    this.publish('agent.message.sent', {
      agentId: message.to,
      messageId: message.id,
      from: message.from,
      to: message.to,
      kind: message.kind,
    });
  }

  /** 读取收件箱分页（游标为不透明字符串） */
  private readPage(inbox: AgentMessage[], cursor?: string): InboxPage {
    const start = Math.min(parseCursor(cursor), inbox.length);
    return { messages: inbox.slice(start), cursor: String(inbox.length) };
  }

  /** 清理某成员某 run 的未应答交互请求（run 进入终态时） */
  private clearRunInteractions(memberId: string, runId: string): void {
    for (const [requestId, pending] of this.pendingInteractions) {
      if (pending.memberId === memberId && pending.runId === runId) {
        this.pendingInteractions.delete(requestId);
      }
    }
  }

  /** B4：把 owner 在聚合流上的应答路由回发起请求的成员 */
  private routeInteractionResponse(event: RunEvent): void {
    const requestId = readRequestId(event.data);
    if (!requestId) return;
    const pending = this.pendingInteractions.get(requestId);
    if (!pending) return;
    this.pendingInteractions.delete(requestId);
    pending.events.publish(event);
  }

  /** 执行一次 resume（与 executeRun 相同的终态处理；不重新入队） */
  private async executeResume(
    record: MemberRecord,
    run: InProcessRunHandle,
    resume: (runId: string, opts?: RunOptions) => Promise<string>,
    opts?: RunOptions,
    removeAbortListener?: () => void,
  ): Promise<void> {
    try {
      const text = await resume(run.id, { ...opts, signal: run.signal });

      if (record.closed) {
        run.setStatus('cancelled');
        run.reject(new Error('agent closed'));
        return;
      }

      if (run.signal.aborted) {
        run.setStatus('cancelled');
        record.state = 'cancelled';
        this.publish('agent.run.cancelled', {
          agentId: record.id,
          runId: run.id,
          sessionId: run.sessionId,
          mirror_of_run_id: run.id,
          ...cancelReasonFields(run.signal),
        });
        run.reject(new Error('run cancelled'));
        return;
      }

      run.setStatus('completed');
      record.state = 'idle';
      this.publish('agent.run.completed', {
        agentId: record.id,
        runId: run.id,
        sessionId: run.sessionId,
        output: text,
        mirror_of_run_id: run.id,
      });
      run.resolve(text);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const cancelled = run.signal.aborted;
      run.setStatus(cancelled ? 'cancelled' : 'failed');
      if (!record.closed) {
        record.state = cancelled ? 'cancelled' : 'error';
        if (!cancelled) record.lastError = errorMessage;
      }
      this.publish(cancelled ? 'agent.run.cancelled' : 'agent.run.failed', {
        agentId: record.id,
        runId: run.id,
        sessionId: run.sessionId,
        mirror_of_run_id: run.id,
        ...(cancelled ? cancelReasonFields(run.signal) : { error: errorMessage }),
      });
      run.reject(error instanceof Error ? error : new Error(errorMessage));
    } finally {
      record.active = undefined;
      record.lastSeen = Date.now();
      this.resuming.delete(run.id);
      removeAbortListener?.();
    }
  }

  /** 执行一次 run（R1 无队列；R2 Scheduler 接管并发/排队） */
  private async executeRun(
    record: MemberRecord,
    run: InProcessRunHandle,
    input: string | Message,
    opts?: RunOptions,
    removeAbortListener?: () => void,
  ): Promise<void> {
    try {
      const text = await record.runtime.run(input, run.sessionId, {
        ...opts,
        runId: run.id,
        signal: run.signal,
      });

      // 成员在 run 期间被关闭：保持 closed 状态，不把结果算作正常完成
      if (record.closed) {
        run.setStatus('cancelled');
        run.reject(new Error('agent closed'));
        return;
      }

      if (run.signal.aborted) {
        run.setStatus('cancelled');
        record.state = 'cancelled';
        this.publish('agent.run.cancelled', {
          agentId: record.id,
          runId: run.id,
          sessionId: run.sessionId,
          mirror_of_run_id: run.id,
          ...cancelReasonFields(run.signal),
        });
        run.reject(new Error('run cancelled'));
        return;
      }

      run.setStatus('completed');
      record.state = 'idle';
      this.publish('agent.run.completed', {
        agentId: record.id,
        runId: run.id,
        sessionId: run.sessionId,
        output: text,
        mirror_of_run_id: run.id,
      });
      run.resolve(text);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const cancelled = run.signal.aborted;
      run.setStatus(cancelled ? 'cancelled' : 'failed');
      if (!record.closed) {
        record.state = cancelled ? 'cancelled' : 'error';
        if (!cancelled) record.lastError = errorMessage;
      }
      this.publish(cancelled ? 'agent.run.cancelled' : 'agent.run.failed', {
        agentId: record.id,
        runId: run.id,
        sessionId: run.sessionId,
        mirror_of_run_id: run.id,
        ...(cancelled ? cancelReasonFields(run.signal) : { error: errorMessage }),
      });
      run.reject(error instanceof Error ? error : new Error(errorMessage));
    } finally {
      record.active = undefined;
      record.lastSeen = Date.now();
      removeAbortListener?.();
    }
  }

  /** 状态视图 */
  private toStatus(record: MemberRecord): AgentStatus {
    const status: AgentStatus = {
      id: record.id,
      state: record.state,
      toolNames: record.runtime.pluginHost.listTools().map((tool) => tool.name),
    };
    if (record.name !== undefined) status.name = record.name;
    if (record.active) status.currentRunId = record.active.id;
    if (record.lastError !== undefined) status.lastError = record.lastError;
    return status;
  }

  /** 发布 Host 级事件（开放字符串） */
  private publish(type: string, data: Record<string, unknown>): void {
    const runId =
      typeof data.runId === 'string'
        ? data.runId
        : typeof data.agentId === 'string'
          ? data.agentId
          : 'host';
    this.events.publish({
      type,
      run_id: runId,
      data,
      ts: Date.now(),
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    });
  }
}

/** AgentHandle 实现 */
class InProcessAgentHandle implements InternalAgentHandle {
  constructor(
    private readonly host: InProcessRuntimeHost,
    private readonly record: MemberRecord,
  ) {}

  get id(): string {
    return this.record.id;
  }

  get name(): string | undefined {
    return this.record.name;
  }

  status(): AgentStatus {
    return this.host.statusOf(this.record);
  }

  run(input: string | Message, opts?: RunOptions): Promise<RunHandle> {
    // 统一经 Scheduler；内部 executor 防止递归
    return this.host.enqueueRun(this.record, input, opts);
  }

  /** @internal Scheduler 直执行入口 */
  [kExecuteAgentRun](
    input: string | Message,
    opts?: RunOptions,
    sessionId?: string,
  ): Promise<RunHandle> {
    return this.host.startRunInternal(this.record, input, opts, sessionId);
  }

  send(message: AgentMessage): Promise<void> {
    return this.host.send(message);
  }

  inbox(cursor?: string): Promise<InboxPage> {
    return this.host.inbox(this.record.id, cursor);
  }

  cancel(runId?: string, reason?: RunInterruptReason): void {
    this.host.cancelRun(this.record, runId, reason);
  }

  close(): Promise<void> {
    return this.host.closeMember(this.record);
  }
}

/** RunHandle 实现 */
class InProcessRunHandle implements RunHandle {
  readonly result: Promise<string>;
  /** 开始执行时间（Unix ms）；handle 只在真正执行时创建 */
  readonly startedAt = Date.now();

  private current: RunStatus = 'running';
  private usageValue?: Usage;
  private readonly controller = new AbortController();
  private resolveResult!: (value: string) => void;
  private rejectResult!: (reason?: unknown) => void;

  constructor(
    readonly id: string,
    readonly agentId: string,
    readonly sessionId: string,
  ) {
    this.result = new Promise<string>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // 调用方可以不 await result；避免未处理拒绝告警
    void this.result.catch(() => {});
  }

  status(): RunStatus {
    return this.current;
  }

  usage(): Usage | undefined {
    return this.usageValue;
  }

  /** @internal A9：从 run.completed 事件捕获 */
  setUsage(usage: Usage): void {
    this.usageValue = usage;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(reason?: string): void {
    if (this.current === 'completed' || this.current === 'failed') return;
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason ?? 'run cancelled');
    }
    if (this.current !== 'cancelled') this.current = 'cancelled';
  }

  /** @internal */
  setStatus(status: RunStatus): void {
    this.current = status;
  }

  /** @internal */
  resolve(value: string): void {
    this.resolveResult(value);
  }

  /** @internal */
  reject(reason?: unknown): void {
    this.rejectResult(reason);
  }
}
