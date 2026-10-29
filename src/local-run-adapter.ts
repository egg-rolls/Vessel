/**
 * 本地裸跑 TUI 的 `RunnableAgent` 适配器（0.28 C3 / D10 / D12）。
 *
 * 目标：本地 TUI 的执行走 `runs.start → AgentService.admit`，与 Web / `--connect`
 * 同一条准入链，而不是直连 `bundle.runtime`（那样每个会话都绕过 admit）。
 *
 * 三件事在这里收口：
 * - **D10 的 agent 维度**：`run(..., { agentId })` 时把 `agent_id` 带进 `runs.start`；
 *   未给出时按 session 解析（`/resume` 等路径不受影响）。
 * - **终态等待**：复用 `waitForConnectedRun`（含 D11 修好的事件兜底），不自写一套。
 * - **D12 的上下文**：`ctx.context` 换成「当前 body 的镜像」——run 结束后从
 *   SessionBackend 读回该会话的消息。core 的 per-body context 在
 *   `InProcessMemberRuntime` 内部，不经 RPC 拿不到；SessionBackend 是同一份真相
 *   的持久化投影，且 `/resume` 正是靠它取历史，语义一致。
 *
 * 契约 §3 的两条禁止在这里落实：
 * - 不传固定名（同名 present 成员会被复用）→ 名字带随机后缀；
 * - 不「只传 session_id 省略 agent_id」→ 首次投递先建 agent 再 `runs.start{agent_id}`。
 *
 * @module vessel/local-run-adapter
 */

import { HUMAN_PRINCIPAL } from '@vessel-agent/agent';
import {
  type ContextManager,
  type EventStream,
  MemoryContextManager,
  type Message,
  type PluginHost,
  type RunnableAgent,
  type SessionBackend,
} from '../packages/core/src/index';
import type { AgentControlLike } from '../packages/serve/src/index';
import type { RunControlLike } from '../packages/serve/src/run-control.js';
import { type ConnectRunStart, waitForConnectedRun } from './connect-run-wait';

/** run 终态等待上限缺省值；与 `--connect` 保持一致（10 分钟）。 */
const DEFAULT_LOCAL_RUN_TIMEOUT_MS = 10 * 60_000;

/** 一次 run 需要的装配面（bootstrap 已持有，这里只取最小集）。 */
export interface LocalRunAdapterOptions {
  /** tenant 事件流：与本地 dispatcher 同一份，终态等待靠它收口 */
  events: EventStream;
  /** `ctx.pluginHost`：REPL 只读工具清单，保持与直连时一致 */
  pluginHost: PluginHost;
  /** 与本地 dispatcher 注入的同一个 run 控制面（`runs.start` / snapshot） */
  runControl: RunControlLike;
  /** 同一个 agent 控制面（建 agent 走 canonical `agents.create`） */
  agentControl: AgentControlLike;
  /** 会话后端：`/resume` 与 D12 的上下文镜像同源 */
  session: SessionBackend;
  /** run 终态等待上限；缺省 10 分钟（与 `--connect` 一致） */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** `ctx.context` 背后的取数面（TUI 只经 `ctx.context` 读，不需要知道它）。 */
export interface LocalRunAdapter extends RunnableAgent {
  /**
   * D12：把 `ctx.context` 切到某个会话的镜像。
   * `/resume` / `/new` / `/clear` 之后由装配层调用（bootstrap 的 onSessionChange）。
   */
  focusSession(sessionId: string): Promise<void>;
}

/** `service.create` 的成员名字形状（与 `MEMBER_NAME_RE` 一致）。 */
const MEMBER_NAME_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** 保留 principal：不能当成员名（`human` / `system`）。 */
const RESERVED_NAMES: ReadonlySet<string> = new Set(['human', 'system']);

/**
 * agent 名字：由 sessionId 确定性派生。
 *
 * 之所以不用随机后缀（0.28 复核发现的缺陷）：`service.create` 命中
 * `reusableByName` 时**先按 name 复用、忽略传入的 id**（`service.ts:727`），
 * 随机名一旦撞上，返回的就是**另一个 agent**，指定的 `id` 被静默丢弃，
 * 两条 TUI 会话会共用同一个 agent（契约 §3 明禁）。8 位 hex 只是把概率压低
 * （1 万会话约 1.16%），不是消除。
 *
 * 确定性派生的好处：`sessionId` 本身唯一 ⇒ 同名必然同 id，复用命中的
 * 恒是这个 agent，「概率问题」变成「结构上不可能」。
 *
 * 形状兜底：`sessionId` 正常是 `{YYYYMMDD}_{HHMMSS}_{6hex}`（合规），但
 * `--session` / `-r` 允许外部传入，因此不合规或撞保留名时改用哈希，仍保证
 * 「不同 session ⇒ 不同 name」。
 */
function agentNameFor(sessionId: string): string {
  const plain = `session-${sessionId}`;
  if (plain.length <= 64 && MEMBER_NAME_SHAPE.test(plain) && !RESERVED_NAMES.has(plain)) {
    return plain;
  }
  const digest = new Bun.CryptoHasher('sha256').update(sessionId).digest('hex').slice(0, 24);
  return `session-${digest}`;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `agents.create` 的结果里取第一条成功的 agent。 */
function createdAgentOf(raw: unknown): { id: string; sessionId: string } | undefined {
  if (!isRecordValue(raw) || !Array.isArray(raw.results)) return undefined;
  const first = raw.results[0];
  if (!isRecordValue(first) || first.ok !== true) return undefined;
  const agent = isRecordValue(first.agent) ? first.agent : undefined;
  if (agent === undefined) return undefined;
  const id = typeof agent.id === 'string' ? agent.id : undefined;
  if (id === undefined || id.length === 0) return undefined;
  const sessionId = typeof agent.session_id === 'string' ? agent.session_id : id;
  return { id, sessionId };
}

/** 建 agent 失败的稳定消息（保留 service 的原始原因，便于定位）。 */
function createFailureOf(raw: unknown): string {
  if (!isRecordValue(raw) || !Array.isArray(raw.results)) return 'agents.create returned no agent';
  const first = raw.results[0];
  if (isRecordValue(first) && typeof first.error === 'string') {
    return `agents.create failed: ${first.error}`;
  }
  return 'agents.create returned no agent';
}

/**
 * 构造本地 `ctx.runtime` 与它背后的 `ctx.context` 镜像。
 *
 * 返回 `runtime`（交给 `ctx.runtime`）与 `context`（交给 `ctx.context`）。
 * `context` 是一个 `MemoryContextManager`：`/new`、`/resume` 的 `clear()` 照常生效，
 * 每轮 run 结束后用 SessionBackend 的真实消息覆盖，于是 `/context`、`/compact`、
 * 状态栏用量都看得到内容（D12）。
 */
export function createLocalRunAdapter(options: LocalRunAdapterOptions): {
  runtime: LocalRunAdapter;
  context: ContextManager;
} {
  /** session → agent id（契约 §3：先建 agent，之后每轮都带 agent_id） */
  const agentBySession = new Map<string, string>();
  /** `ctx.context` 的实体：run 结束后由会话历史覆盖 */
  const mirror = new MemoryContextManager();
  /** 当前镜像指向哪个会话 */
  let focused: string | undefined;

  /** 用会话历史重置镜像；读失败按空处理（不打断 run）。 */
  const refresh = async (sessionId: string): Promise<void> => {
    let messages: Message[] = [];
    try {
      const state = await options.session.load(sessionId);
      messages = state?.messages ?? [];
    } catch {
      // 会话尚未落盘（新会话首轮 / 读失败）：保持空，不抛。
    }
    mirror.clear();
    mirror.setSessionId(sessionId);
    for (const message of messages) mirror.add(message);
    focused = sessionId;
  };

  const focusSession = async (sessionId: string): Promise<void> => {
    await refresh(sessionId);
  };

  /** 首次投递时建 agent；`opts.agentId` 显式给出时直接采信（D10）。 */
  const ensureAgent = async (sessionId: string, agentId?: string): Promise<string> => {
    if (agentId !== undefined && agentId.length > 0) {
      agentBySession.set(sessionId, agentId);
      return agentId;
    }
    const known = agentBySession.get(sessionId);
    if (known !== undefined) return known;

    // 重启 / `--session` 续接时 agent 已存在（id 就是会话 id，见下）：直接复用，
    // 否则 `create` 会以 `duplicate member id` 拒绝，续接路径直接不可用。
    // 与 `createOrRestoreOwner` 同一套「先建、重名则回读」的语义。
    const existing = await options.agentControl.get(sessionId).catch(() => undefined);
    if (existing !== undefined) {
      agentBySession.set(sessionId, existing.id ?? sessionId);
      return existing.id ?? sessionId;
    }

    const created = await options.agentControl.create([
      // `id` 取会话 id：`create` 生成的唯一 body 因此恰好是这个会话，
      // 不会出现「agent 自带一具 body + 会话再建一具」的双 body（契约 §1）。
      // 不传 kind ⇒ role = temporary（契约 §3 ①）。
      // `owner` 必须显式给成本地 admit 的发送者（人类）：service 缺省把 temporary
      // 归到 `main` 名下，而 admit 缺省 from = human；private 成员的 canView 要求
      // viewer === owner，两者不一致会让首次投递直接 `member_not_visible`。
      // gateway 的 owner 传输同样用 principal 覆盖 owner，这里与它同源。
      { id: sessionId, name: agentNameFor(sessionId), owner: HUMAN_PRINCIPAL },
    ]);
    const agent = createdAgentOf(created);
    if (agent === undefined) throw new Error(createFailureOf(created));
    // 防静默串号：`service.create` 会先按 name 复用 present 成员，再看 id。
    // 万一我们的名字已被别的 agent 占用，返回的 id 就不再是 sessionId ——
    // 那会让两条 TUI 会话共用同一个 agent（契约 §3 禁止）。宁可显式失败。
    if (agent.id !== sessionId) {
      throw new Error(
        `agents.create returned ${agent.id} for session ${sessionId} (name "${agentNameFor(sessionId)}" already taken)`,
      );
    }
    agentBySession.set(sessionId, agent.id);
    return agent.id;
  };

  const runtime: LocalRunAdapter = {
    events: options.events,
    pluginHost: options.pluginHost,
    focusSession,

    async run(inputValue, sessionId, opts) {
      const prompt = typeof inputValue === 'string' ? inputValue : inputValue.content;
      const targetSession = sessionId ?? focused ?? '';
      if (targetSession === '') throw new Error('run() requires a session');

      const agentId = await ensureAgent(targetSession, opts?.agentId);

      try {
        return await waitForConnectedRun({
          events: options.events,
          prompt,
          sessionId: targetSession,
          timeoutMs: options.timeoutMs ?? DEFAULT_LOCAL_RUN_TIMEOUT_MS,
          ...(options.pollIntervalMs !== undefined
            ? { pollIntervalMs: options.pollIntervalMs }
            : {}),
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
          start: async (): Promise<ConnectRunStart> => {
            const result = await options.runControl.start({
              input: prompt,
              // 契约 §3：必须带 agent_id，否则会落到 main 上长第二具 body。
              agent_id: agentId,
              session_id: targetSession,
            });
            if (typeof result.run_id !== 'string' || result.run_id === '') {
              throw new Error('runs.start returned no run_id');
            }
            return { kind: 'job', jobId: result.run_id };
          },
          getRun: async (jobId) => {
            // 本地没有 durable checkpoint：只报当前 live 状态，查不到就抛，
            // 让 waitForConnectedRun 走事件兜底（D11 已让「查不到」等同「不可用」）。
            const snapshot = options.runControl.snapshot();
            const live = [...snapshot.running, ...snapshot.queued].find(
              (run) => run.run_id === jobId,
            );
            if (live === undefined) {
              throw Object.assign(new Error(`run not found: ${jobId}`), {
                code: 'not_found',
              });
            }
            return {
              run: {
                run_id: live.run_id,
                session_id: live.session_id,
                agent_id: live.agent_id,
                status: live.status,
              },
            };
          },
        });
      } finally {
        // D12：每轮结束把该会话的真实历史同步进 `ctx.context`。
        await refresh(targetSession);
      }
    },

    dispose() {
      // 不持有需要关闭的资源：agent 生命周期归 AgentService，
      // dispatcher / eventHub 由 bootstrap 的 shutdown 收口。
    },
  };

  return { runtime, context: mirror };
}
