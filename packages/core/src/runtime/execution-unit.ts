/**
 * ExecutionUnit 实现
 * @module @vessel-agent/core/runtime
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  estimateTokens,
  shouldPublishSystemContext,
  systemContextChangesFromFingerprint,
  withClearedToolResults,
  withReadSideMask,
} from '../context/index.js';
import {
  evaluateLimitWarnings,
  evaluateTermination,
  evaluateUsageLimits,
  LIMIT_WARNING_THRESHOLD,
  MemoryLimitChecker,
} from '../limits/index.js';
import { createStderrLogger, noopLogger } from '../logging.js';
// D2：跨模块只允许从 barrel 导入（不得直接引用 session 的内部文件）。
import {
  deriveSessionMeta,
  mergeHistoryProjection,
  projectMessages,
  withRunIdentity,
} from '../session/index.js';
import {
  type ContextCompactedReason,
  DEFAULT_COMPACT_THRESHOLD,
  type PromptContextFingerprint,
  type WorkingContext,
} from '../types/context.js';
import type { ErrorEnvelope } from '../types/error.js';
import type {
  EventStream,
  RunEvent,
  SessionEventLogPort,
  SessionEventRecord,
  Unsubscribe,
} from '../types/event.js';
import { GuardrailStage } from '../types/guardrail.js';
import { HookType } from '../types/hook.js';
import { LeaseExpiredError, type LeaseGrant, type LeaseServicePort } from '../types/lease.js';
import type {
  LimitChecker,
  TerminationPolicy,
  UsageLimits,
  UsagePricing,
  UsageStats,
} from '../types/limits.js';
import type { Logger } from '../types/logging.js';
import type {
  ExecutionUnitOptions,
  PluginHost,
  RuntimePermissionConfig,
  SelfCardOptions,
} from '../types/plugin.js';
import type {
  ChatRequest,
  LLMProvider,
  LLMResponse,
  Message,
  MessageRef,
  ProviderRetryPolicy,
  StreamChunk,
} from '../types/provider.js';
import type { Run, RunInterruptReason, RunOptions, StreamSegmentState } from '../types/run.js';
import type { RunRecord, RunUsage } from '../types/run-record-store.js';
import {
  RUN_INTERRUPT_REASONS,
  RunAlreadyRunningError,
  RunResumeError,
} from '../types/run-record-store.js';
import type {
  LegacyRunSnapshot,
  ResumeAfterRestart,
  SessionState,
  SessionStatus,
  SessionStore,
} from '../types/session.js';

export type { RunOptions } from '../types/run.js';

import { toErrorEnvelope } from './error-envelope.js';
import { GuardrailRunner } from './guardrail-runner.js';
import { HookRunner } from './hook-runner.js';
import {
  PermissionAbortedError,
  PermissionPolicy,
  PermissionTimeoutError,
} from './permission-policy.js';
import { MemoryPluginHost } from './plugin-host.js';
import { type InstalledPlugins, installPluginsIntoHost } from './plugin-install.js';
import { type PrefixChangeReason, PromptPrefixGuard } from './prompt-prefix-guard.js';
import {
  classifyProviderRetry,
  normalizeRetryPolicy,
  retryBackoffMs,
  sleepWithAbort,
} from './provider-retry.js';
import type { RunJournal, RunJournalFactory } from './run-journal.js';
import {
  type LoopContext,
  type PreparedToolCall,
  runToolCallingLoop,
  type ToolExecutionOutcome,
} from './tool-calling-loop.js';
import { createToolPipeline, type ToolPipeline } from './tool-pipeline.js';

/**
 * Context pressure warning ratio：达到该比例但未到自动压缩阈值时，
 * 只提示模型/用户考虑 `agent(rotate)`，不主动压缩。
 */
export const CONTEXT_PRESSURE_WARN_RATIO = 0.9;

/** finalizeRun 的终态输入（C1） */
type RunTerminalOutcome =
  | { status: 'completed'; output: string }
  | { status: 'failed'; error: unknown; signal?: AbortSignal };

/** loadStoredHistory 的结果：消息窗口 + 已覆盖的事件游标 + 会话壳。 */
interface StoredHistory {
  messages: Message[];
  /** 消息窗口已覆盖到的事件 seq（无持久游标时 undefined） */
  cursor?: number;
  sessionState: SessionState | null;
  /** 读到的会话事件条数；用于判定「会话是否存在（事件日志）」 */
  eventCount: number;
  /**
   * 最近一次 provider 请求的 `prompt_tokens + completion_tokens`。
   * 来自已落盘的 `llm.response` 事实（per-request），不是 RunRecord 的累计 usage。
   */
  lastRequestTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从会话事件里取最近一次 `llm.response.usage` 的 per-request token 数。 */
function lastRequestTokensFromEvents(events: readonly SessionEventRecord[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== 'llm.response') continue;
    if (!isRecord(event.data)) continue;
    const usage = event.data.usage;
    if (!isRecord(usage)) continue;
    const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
    const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
    const total = prompt + completion;
    if (total > 0) return total;
  }
  return undefined;
}

/** 新建一次 run 的 usage 统计 */
function createUsageStats(startTime: number): UsageStats {
  return {
    requestCount: 0,
    toolCallsCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    startTime,
  };
}

/** 新建一次 run 的持久记录；之后各安全点原地更新。 */
function createRunRecord(args: {
  runId: string;
  sessionId: string;
  createdAt: number;
  agentId?: string;
  branch?: string;
}): RunRecord {
  return {
    run_id: args.runId,
    session_id: args.sessionId,
    status: 'running',
    created_at: args.createdAt,
    updated_at: args.createdAt,
    metadata: { tool_calls_count: 0 },
    ...(args.agentId !== undefined ? { agent_id: args.agentId } : {}),
    ...(args.branch !== undefined ? { branch: args.branch } : {}),
  };
}

/**
 * Q4=b：SessionState 顶层 run 字段的一版镜像（旧 reader 兼容）。
 * 终态的 `completed_at` 由 RunRecord 的 `updated_at` 投影；running 不写。
 */
function legacyRunFromRecord(record: RunRecord): LegacyRunSnapshot | undefined {
  const completedAt = record.status === 'running' ? undefined : record.updated_at;
  const usage = record.usage;
  const error = record.error;
  if (completedAt === undefined && usage === undefined && error === undefined) return undefined;
  return {
    ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/** 错误文本（事件/持久化统一口径） */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * context-overflow 的通用文案 / 错误码（0.10 R2-17）。
 * 不绑定厂商名：只认状态码 400 + 可识别的描述。
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[_ ]length/i,
  /context window/i,
  /maximum context/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many tokens/i,
  /token limit/i,
  /request too large/i,
];

/** 从错误对象读取 HTTP 状态码（status / statusCode / httpStatus / response.status） */
function readHttpStatus(error: Record<string, unknown>): number | undefined {
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const value = error[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const response = error.response;
  if (typeof response === 'object' && response !== null) {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === 'number' && Number.isFinite(status)) return status;
  }
  return undefined;
}

/**
 * provider 报 context-overflow 时返回 true（0.10 R2-17）。
 * 判定条件：400（结构化状态或 message 中的状态）且 message / code 命中通用模式。
 */
function isContextOverflowError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  const message = error instanceof Error ? error.message : String(record.message ?? '');
  const code = typeof record.code === 'string' ? record.code : '';
  const has400 = readHttpStatus(record) === 400 || /(^|\D)400(\D|$)/.test(message);
  if (!has400) return false;
  const haystack = `${message}\n${code}`;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(haystack));
}

/** Self Card token 上限（0.15 E9） */
const SELF_CARD_TOKEN_LIMIT = 400;

/**
 * 流式增量归哪个段落 kind（`llm.stream.summary` 用）。
 *
 * 与 `apps/web/src/state/events.ts` 的 buildGroup 同口径：只有 `text_delta` /
 * `reasoning_delta` 带正文进段；`tool_call_delta` 与 `finish` 不是段落。
 */
function chunkKindOf(chunk: StreamChunk): 'text' | 'reasoning' | undefined {
  if (chunk.type === 'text_delta') return 'text';
  if (chunk.type === 'reasoning_delta') return 'reasoning';
  return undefined;
}

/**
 * 该增量是否已经「流出了 assistant 的可见输出」。
 *
 * 用于判定能不能自动重试同一个请求：正文 / 思考已流出，重发只会让父级看到两段
 * 重复内容；空 delta 不算（没有可见文本）。`tool_call_delta` 也算已流出——它带
 * id / 名字 / 参数片段，重发会在时间线上出现两份调用骨架。
 */
function streamsAssistantOutput(chunk: StreamChunk): boolean {
  if (chunk.type === 'tool_call_delta') return true;
  return (
    (chunk.type === 'text_delta' || chunk.type === 'reasoning_delta') &&
    typeof chunk.delta === 'string' &&
    chunk.delta.length > 0
  );
}

/**
 * 恢复历史时「补读最近一次 llm.response」的尾部窗口（按事件条数）。
 * `llm.response` 每个请求一条，真实会话里最后一条通常距 EOF 几 KB；
 * 窗口内找不到时回退全量读，行为与不设窗口等价。
 */
const LAST_REQUEST_PROBE_EVENTS = 200;

/**
 * BeforeLlm 注入消息的稳定键（0.16 E5）。
 * 有 `name` / `timestamp` 时按键去重；都缺失时返回 undefined，退回对象引用去重。
 */
function injectedMessageKey(message: Message): string | undefined {
  if (message.name === undefined && message.timestamp === undefined) return undefined;
  return [
    message.name ?? '',
    message.timestamp ?? '',
    message.role,
    message.tool_call_id ?? '',
    message.tool_calls?.map((call) => call.id).join(',') ?? '',
    message.content,
  ].join('\u0000');
}

/** 按估算 token 截断（Self Card 上限） */
function truncateToTokens(text: string, limit: number): string {
  if (estimateTokens(text) <= limit) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= limit) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

/** 有效限额渲染（run 开始时计数均为 0） */
function formatSelfCardLimits(limits: SelfCardOptions['limits']): string {
  const parts: string[] = [];
  if (limits.requestLimit !== undefined) parts.push(`requests 0/${limits.requestLimit}`);
  if (limits.inputTokensLimit !== undefined) {
    parts.push(`input tokens 0/${limits.inputTokensLimit}`);
  }
  if (limits.outputTokensLimit !== undefined) {
    parts.push(`output tokens 0/${limits.outputTokensLimit}`);
  }
  if (limits.totalCostLimit !== undefined) parts.push(`cost 0/${limits.totalCostLimit}`);
  if (limits.maxIterations !== undefined) parts.push(`iterations 0/${limits.maxIterations}`);
  if (limits.maxRuntimeSeconds !== undefined) {
    parts.push(`runtime 0s/${limits.maxRuntimeSeconds}s`);
  }
  return parts.join(', ');
}

/** 生成 Self Card 文本（≤400 tokens） */
function formatSelfCard(card: SelfCardOptions): string {
  const lines = ['[Self Card]', `role: ${card.role}`];
  if (card.parent_id !== undefined) lines.push(`parent: ${card.parent_id}`);
  if (card.team_id !== undefined && card.team_id.length > 0) lines.push(`team: ${card.team_id}`);
  lines.push(`depth: ${card.depth}`, `model: ${card.model}`);
  if (card.tools.length > 0) lines.push(`tools: ${card.tools.join(', ')}`);
  const limits = formatSelfCardLimits(card.limits);
  if (limits) lines.push(`limits: ${limits}`);
  // 只写预算、不写实时用量：Self Card 是 system 前缀的一部分，必须跨 run 稳定，
  // 否则每轮都会让整段提示词缓存失效（价格远大于几行上下文）。
  lines.push(`context: ${card.context.max} tokens (budget)`);
  if (card.how_to_ask !== undefined) lines.push(`how to ask for help: ${card.how_to_ask}`);
  return truncateToTokens(lines.join('\n'), SELF_CARD_TOKEN_LIMIT);
}

/**
 * 系统消息的稳定摘要（`prompt.system_context.hash`）：sha256 前 16 位。
 *
 * 覆盖两段原文（`system_prompt` + `self_card`），用 `\u0000` 分隔避免拼接歧义
 * （`a` + `bc` 与 `ab` + `c` 必须是两个 hash）。16 位十六进制＝64 bit：会话级去重足够，
 * 且短到能当卡头上的短号显示。
 */
function systemContextHash(system: string, selfCard: string): string {
  return createHash('sha256').update(`${system}\u0000${selfCard}`).digest('hex').slice(0, 16);
}

/**
 * 上一份发布过的系统消息快照里、`changed` 要对比的那几格。
 *
 * 只收「模型与环境有关的身份事实」：两段原文、模型 id、工具个数。**不收** message_count /
 * estimated_tokens / context_max —— 它们每轮都在动，写进 `changed` 等于把一张「环境变了」
 * 的卡变成计数器（而这些字段本来就不发事件，除非 hash 变）。
 */
interface SystemContextSnapshot {
  sessionId: string;
  hash: string;
  system: string;
  selfCard: string;
  model: string;
  toolsCount: number;
}

/**
 * 两份快照 → 「差在哪」（`changed` 词表）。
 *
 * 值都压在短句里（`model: A → B`），读侧按**键**本地化、值原样显示：这样两端不必共享
 * 一份 sentence 模板，也不会因为改了措辞就把历史卡读成不同意思。
 */
function systemContextChanges(
  previous: SystemContextSnapshot | undefined,
  current: SystemContextSnapshot,
): string[] {
  if (previous === undefined || previous.sessionId !== current.sessionId) return [];
  const changes: string[] = [];
  const presence = (value: string): string => (value.length > 0 ? 'added' : 'removed');
  if (previous.system !== current.system) {
    changes.push(
      `system_prompt: ${
        previous.system.length === 0
          ? presence(current.system)
          : current.system.length === 0
            ? 'removed'
            : 'replaced'
      }`,
    );
  }
  if (previous.selfCard !== current.selfCard) {
    changes.push(
      `self_card: ${
        previous.selfCard.length === 0
          ? presence(current.selfCard)
          : current.selfCard.length === 0
            ? 'removed'
            : 'replaced'
      }`,
    );
  }
  if (previous.model !== current.model) {
    changes.push(`model: ${previous.model} → ${current.model}`);
  }
  if (previous.toolsCount !== current.toolsCount) {
    changes.push(`tools: ${String(previous.toolsCount)} → ${String(current.toolsCount)}`);
  }
  return changes;
}

/**
 * `prompt.system_context` 需要的、只在这一刻才知道的请求侧事实。
 *
 * 不复用 `LlmRequestPayload`：那个形状的落盘副本是「刚才发了什么元信息」，
 * 这里要的是「这份系统消息对应的是哪次请求」（条数 / 工具 / 估算 token / 窗口上限），
 * 读侧拿它拼折叠态摘要。
 */
interface SystemContextRequestFacts {
  messageCount: number;
  toolsCount: number;
  estimatedTokens?: number;
  contextMax?: number;
}

/**
 * Execution Unit
 * 核心运行时，实现 tool-calling loop。
 * 协调 provider/context/events/limits/termination/session + 三个编排器（权限/guardrail/hook），
 * 自身不再内联编排逻辑（ADR-033）。
 */
export class ExecutionUnit {
  private provider: LLMProvider;
  private model: string;
  /** Stage 4：每次 Run 新建 WorkingContext；EU 不再持有跨 Run 窗口实例 */
  private readonly contextFactory: (init: { sessionId: string }) => WorkingContext;
  /** 事件流（公开只读——headless/外部可订阅事件，实现应答策略，ADR-029） */
  readonly events: EventStream;
  /** 插件宿主（公开只读——app/TUI 从这里读工具与插件，工具的唯一来源） */
  readonly pluginHost: PluginHost;
  private limits: UsageLimits;
  private termination: TerminationPolicy;
  private session?: SessionStore;
  private limitChecker: LimitChecker;
  private systemPrompt?: string;
  /** 0.15 E9：Self Card 选项；缺省不注入 */
  private readonly selfCard?: SelfCardOptions;
  /** 0.28：上下文压力提示的尾句文案；缺省用 `agent(rotate)` 原文案。可经 `applyContextPolicy` 热替换 */
  private contextPressureHint?: string;
  /**
   * 0.51：成员 cwd（每次工具调用注入 `ToolContext.cwd`）。
   *
   * 存成字段而不是只在构造时塞进闭包：工具面可以热刷新，但 cwd 与 EU 一起活到 dispose，
   * 没有热改路径（Team.workspace 创建后不可改），所以这里只读。
   */
  private readonly toolCwd?: string;
  /** 0.15 E9：本次 run 的 systemPrompt（含 Self Card）；run 结束后清空 */
  private runSystemPrompt?: string;
  /**
   * 上一份发出去的 `prompt.system_context`（hash 去重 + `changed` 对比）。
   *
   * 按 `sessionId` 记：同一个 EU 可能给多个会话干活（session_switch），换会话就是另一份
   * 落盘；只有「同一会话、同一份系统消息」才不再重发。首个 run 必发（初始 undefined，
   * 因此首份快照没有 `changed` / `previous_hash`）。
   */
  private lastSystemContext?: SystemContextSnapshot;
  /**
   * 0.52：环境快照的**持久指纹**（从  恢复 / 发布后回写）。
   *
   *  是纯内存去重，重启就没了 —— 于是每重启一次，下一条消息必然重发
   * 一张全量「上下文」卡（用户报的问题）。指纹跨进程活着，才能做到「没实质变化就不发」。
   */
  private promptContextFingerprint?: PromptContextFingerprint;
  /** 0.15 E2：本 run 已预警的 limit key（每个 key 只发一次） */
  private readonly warnedLimitKeys = new Set<string>();
  /** 0.16 E5：本 run 已注入的消息稳定键 / 对象引用（BeforeLlm 去重） */
  private readonly injectedMessageKeys = new Set<string>();
  private injectedMessageRefs = new WeakSet<Message>();
  /** CONTRACT-prefix-invariant：跨轮前缀守卫（每个 session 一份快照） */
  private readonly prefixGuard: PromptPrefixGuard;
  /** 调用点设置的显式失效原因；guard 消费后清空 */
  private pendingPrefixReason?: PrefixChangeReason;
  /** 本 run 是否已报告 hook 写 systemPrompt 被忽略（每 run 一次） */
  private systemPromptIgnoredReported = false;
  /** 本 run 是否已报告 additionalContext 弃用（每 run 一次） */
  private additionalContextDeprecatedReported = false;
  /** 本 run 已追加过的旧 additionalContext 内容（避免每个 LLM 迭代重复） */
  private readonly legacyAdditionalContextSeen = new Set<string>();
  /** 最近一次 run 的 session / branch / system，用于识别显式切换 */
  private lastSessionId?: string;
  /**
   * Stage 4 parity：上一 Run 终态落盘后窗口覆盖到的事件游标。
   * baseline 的 `canReuseWindow` 用它判断“下一 Run 无需重放”；per-Run 窗口
   * 仍会重建，但重建不应产生可观察的 `context.changed`，故只用于抑制事件。
   */
  private lastCoveredSessionId?: string;
  private lastCoveredCursor?: number;
  /**
   * 上一 Run 的 provider 真实 token 数。baseline 的 WorkingContext 跨 Run 存活，
   * `tokenCount` 会继续返回该值；per-Run 新实例在首次请求前用它保持同一口径。
   */
  private lastRealTokens?: number;
  private lastBranch?: string;
  private readonly lastRunSystemPrompts = new Map<string, string>();
  private permissionPolicy: PermissionPolicy;
  private guardrails: GuardrailRunner;
  private hooks: HookRunner;
  /** 统一工具执行管道（0.8.2 Wave 2B1）：permission + handler + ToolResult guardrail */
  private readonly toolPipeline: ToolPipeline;
  /** Stage 4：Run 写端口工厂（事件落盘 / RunRecord / SessionState） */
  private readonly journalFactory: RunJournalFactory;
  /** 当前 active Run 的 journal；随 begin/end 建立/释放 */
  private activeJournal?: RunJournal;
  /** 无 Run 的受控写（`manual` / `plugin`），按 runId+session 缓存以统一 flush */
  private readonly transientJournals = new Map<string, RunJournal>();
  /**
   * C2：每个 Run 已发布过的 `lastCompaction.id`（EU 上按 runId 记录）。
   * `add()` 内的同步压缩不经过 loop 的发布点，`addContext` 用它与已发布 id 比对补发；
   * 随 Run 释放。手动 / overflow / loop 自动压缩直发时由 `publishCompacted` 记入。
   */
  private readonly lastReportedCompactionId = new Map<string, number>();
  /** 上一 Run 结束时记录的上下文水位；无 active Run 时供成员 host 读取 */
  private lastContextRatioValue?: number;
  private readonly boundAgentId?: string;
  /** 0.5：tenant；事件 / SessionState / RunRecord 在缺失时补齐 */
  /** 0.11.1：是否发布 reasoning 流式增量（默认 false） */
  private readonly includeReasoning: boolean;
  /** 传输层 / 过载重试策略（默认 `DEFAULT_PROVIDER_RETRY_POLICY`） */
  private readonly retryPolicy: ProviderRetryPolicy;
  /** 成功安装的插件句柄（安装顺序；dispose 逆序，0.9） */
  private plugins?: InstalledPlugins;
  /** dispose 幂等：第二次调用复用同一个 Promise，不再调用插件（0.9） */
  private disposePromise?: Promise<void>;
  /** 同一 run 的并发 resume 锁（进程内；DECISION-008 Addendum A-2） */
  private readonly resuming = new Set<string>();
  /**
   * 当前 active run（0.8 C1）：run 级状态隔离 + 单 run 守卫。
   * 同步占位、`finally` 清空；已有值时新的 run()/resume() 立即 `run_already_running`。
   */
  private activeRun?: Run;
  /**
   * 当前 run 的中断控制（0.10 R2-18）：`interrupt()` 与调用方 `opts.signal`
   * 汇合到同一个内部 AbortController；随 active run 创建 / 释放。
   */
  private activeRunControl?: {
    execution: Run;
    controller: AbortController;
    cleanups: Array<() => void>;
  };
  /** 0.10 R2-14：诊断日志；缺省 noop（`VESSEL_DEBUG` 时兜底 stderr） */
  private readonly logger: Logger;
  /** 0.18：会话事件日志（Stage 4 只读句柄；写由 RunJournal 承担） */
  private readonly eventLog?: SessionEventLogPort;
  /** 0.18：观察 harness 直接发布的交互事件（permission/ask response） */
  private readonly eventLogUnsubscribe?: Unsubscribe;
  /** 0.51：opt-in 用量计价；缺省不注入 → `totalCost` 保持 0。 */
  private readonly pricing?: UsagePricing;
  /** ADR-098 C2：注入的租约服务；缺省 no-op（行为等同现状） */
  private readonly leaseService?: LeaseServicePort;
  /** ADR-098 C2：ControlPlane 在 spawn 时授予的 BindingLease（EU 续租/释放；续租后更新） */
  private bindingLease?: LeaseGrant;
  /** ADR-098 C2：本 EU 持有的 SessionLease（按 session 记录，用于 fencing token） */
  private readonly sessionLeases = new Map<string, LeaseGrant>();
  /** 后台续租定时器；`.unref()` 防止 smoke/CLI 被挂住 */
  private leaseRenewTimer?: ReturnType<typeof setInterval>;
  /** 续租去重：上一轮未完成时跳过 */
  private renewingLeases?: Promise<void>;
  /** 租约丢失后 EU 不再接受新 run（ControlPlane 下次惰性重建） */
  private leaseLost = false;

  private constructor(opts: ExecutionUnitOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.contextFactory = opts.contextFactory;
    this.journalFactory = opts.journalFactory;
    this.events = opts.events;
    this.limits = opts.limits;
    this.termination = opts.termination;
    this.session = opts.session;
    this.systemPrompt = opts.systemPrompt;
    this.selfCard = opts.selfCard;
    this.contextPressureHint = opts.contextPressureHint;
    this.toolCwd = opts.cwd;
    this.boundAgentId = opts.agentId;
    this.includeReasoning = opts.includeReasoning === true;
    this.retryPolicy = normalizeRetryPolicy(opts.retry);
    this.eventLog = opts.eventLog;
    this.pricing = opts.pricing;
    this.leaseService = opts.leaseService;
    this.bindingLease = opts.bindingLease;
    this.logger =
      opts.logger ??
      (process.env.VESSEL_DEBUG ? createStderrLogger({ level: 'debug' }) : noopLogger);
    // 空闲 EU 也必须续租 BindingLease：仅靠 acquireSessionLease/ensureSessionLease
    // 启动计时器会让“已 join、尚未跑过 run”的 body 在 TTL（默认 30s）后丢租约。
    if (this.leaseService !== undefined && this.bindingLease !== undefined) {
      this.startLeaseRenewTimer();
    }
    if (this.eventLog) {
      // 交互应答由 harness / 插件直接发布；runtime 只补落盘，不二次发布。
      this.eventLogUnsubscribe = this.events.subscribe((event) => this.persistObservedEvent(event));
    }
    // 依赖倒置（ADR-033）：LimitChecker / PluginHost 可注入，默认 Memory 实现
    this.limitChecker = opts.limitChecker ?? new MemoryLimitChecker();

    // 初始化 PluginHost（唯一工具来源与注册表）——插件在 install() 里 registerTool
    this.pluginHost = opts.pluginHost ?? new MemoryPluginHost();

    // 编排器（ADR-033）：权限策略 / guardrail / hook 各自独立，ExecutionUnit 只协调。
    // 0.18：权限请求经 runtime 的 publishEvent，才能保证先落盘再发布。
    this.permissionPolicy = new PermissionPolicy(this.events, opts.permission, (event) =>
      this.publishEvent(event),
    );
    this.guardrails = new GuardrailRunner(this.pluginHost, this.events);
    this.hooks = new HookRunner(this.pluginHost, this.events);
    this.prefixGuard = new PromptPrefixGuard(this.events);
    this.toolPipeline = createToolPipeline({
      pluginHost: this.pluginHost,
      events: this.events,
      permission: this.permissionPolicy,
      guardrails: this.guardrails,
      hooks: this.hooks,
    });
  }

  /** 创建并异步初始化 ExecutionUnit。用此替代 new ExecutionUnit()。 */
  static async create(opts: ExecutionUnitOptions): Promise<ExecutionUnit> {
    const runtime = new ExecutionUnit(opts);
    runtime.plugins = await installPluginsIntoHost({
      host: runtime.pluginHost,
      plugins: opts.plugins ?? [],
      publish: (event) => runtime.publishEvent(event),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
    return runtime;
  }

  /**
   * 执行一次 run
   * @param input 用户输入
   * @param sessionId 会话 ID（默认 'default'）
   * @param opts 可选的 Run 选项（signal 等）
   * @returns 最终响应文本
   */
  async run(input: string | Message, sessionId?: string, opts?: RunOptions): Promise<string> {
    if (this.leaseLost) throw new LeaseExpiredError('lease_expired');
    // F6：Host 可指定 runId，使 RunHandle.id 与事件流 run_id 一致；普通调用方缺省生成
    const runId = opts?.runId ?? randomUUID();
    const currentSessionId = sessionId || 'default';
    // 单 run 守卫必须在任何 await 之前同步占位，第二个并发调用立即失败。
    const execution = this.beginExecution(runId, currentSessionId, opts?.branch);
    // branch 实际变化才视为一次显式前缀失效；同一分支的常规多轮不设 reason。
    if (opts?.branch !== undefined && opts.branch !== this.lastBranch) {
      this.pendingPrefixReason ??= 'branch';
    }
    if (opts?.branch !== undefined) this.lastBranch = opts.branch;

    try {
      return await this.executeRun(execution, input, opts);
    } finally {
      await this.endExecution(execution);
      await this.releaseTransientSessionLease(currentSessionId);
    }
  }

  /**
   * 向当前上下文追加一条 `vessel:notice`（身份变更等运行时提示）。
   *
   * 只走 addContext：同步写上下文并发布 `context.changed`；**不入队、不启动 run**。
   * 下一轮请求（当前 run 的后续迭代或下一次 run）在尾部看到该消息。调用方需保证
   * 上下文已初始化（成员 runtime 在首次 runTurn 前改用 RunOptions.messages 注入）。
   */
  appendNotice(text: string): void {
    const message: Message = {
      role: 'user',
      name: 'vessel:notice',
      content: text,
      timestamp: Date.now(),
    };
    const execution = this.activeRun;
    if (execution !== undefined) {
      this.addContext(message, execution.runId);
      return;
    }
    // PLAN §4.3：无 active Run 时把 notice 追加到 SessionState.messages 快照，
    // 下一次 Run 重建窗口时可见；不新建窗口、不启动 run。
    void this.appendNoticeToSnapshot(message).catch((error: unknown) => {
      this.logger.warn('session notice snapshot append failed', {
        session_id: this.lastSessionId,
        error: errorText(error),
      });
    });
  }

  /** 无 active Run 的 notice：best-effort 写 SessionState 投影缓存。 */
  private async appendNoticeToSnapshot(message: Message): Promise<void> {
    if (!this.session) return;
    const sessionId = this.lastSessionId ?? 'default';
    const state = await this.session.load(sessionId);
    if (state === null) return;
    const messages = state.messages ?? [];
    messages.push(message);
    state.messages = messages;
    state.updated_at = Date.now();
    // 写 SessionState 也走 journal（EU 不持 session 写端口）。
    const journal = this.transientJournal('manual', sessionId);
    await journal.saveSessionState(state);
    journal.appendFact({
      type: 'context.changed',
      run_id: 'notice',
      data: {
        run_id: 'notice',
        session_id: sessionId,
        message,
        message_count: messages.length,
      },
      ts: Date.now(),
    });
  }

  /**
   * 确认/续租本 session 的 SessionLease（首个 run/resume 前调用）。
   * 同一 key 已有有效租约时续租；没有时 acquire。未注入 leaseService 时 no-op。
   */
  private async acquireSessionLease(sessionId: string): Promise<LeaseGrant | undefined> {
    const service = this.leaseService;
    if (!service) return undefined;
    if (this.leaseLost) throw new LeaseExpiredError('lease_expired');

    const existing = this.sessionLeases.get(sessionId);
    if (existing !== undefined) {
      try {
        const renewed = await service.renew(existing.leaseId);
        this.sessionLeases.set(sessionId, renewed);
        this.startLeaseRenewTimer();
        return renewed;
      } catch (error) {
        // 与后台续租同口径：真实过期 / stale_fence 才丢租约；普通 I/O 错误时
        // existing 尚未过期，继续用它开跑，下个 tick 再续，不毒化 EU。
        if (error instanceof LeaseExpiredError || existing.expiresAt <= Date.now()) {
          this.onLeaseLost(error);
          throw error;
        }
        this.logger.warn('session lease renew failed; using existing grant', {
          ...(this.boundAgentId !== undefined ? { agent_id: this.boundAgentId } : {}),
          lease_kind: existing.kind,
          lease_key: existing.key,
          error: errorText(error),
        });
        this.startLeaseRenewTimer();
        return existing;
      }
    }

    try {
      const grant = await service.acquire('session', sessionId);
      this.sessionLeases.set(sessionId, grant);
      this.startLeaseRenewTimer();
      return grant;
    } catch (error) {
      // 同 key 被其它持有者占用是正常冲突，不标记本 EU 失效。
      if (error instanceof LeaseExpiredError) this.onLeaseLost(error);
      throw error;
    }
  }

  /** 当前 session 有效 SessionLease 的 fencingToken；没有有效租约返回 undefined。 */
  sessionLeaseToken(sessionId: string): number | undefined {
    if (this.leaseLost) return undefined;
    const grant = this.sessionLeases.get(sessionId);
    if (grant === undefined || grant.expiresAt <= Date.now()) return undefined;
    return grant.fencingToken;
  }

  /**
   * ControlPlane 预取 / 提级 SessionLease（compactFork 用）。
   * 已有有效租约直接返回；否则 acquire，`minFence` 保证新 token 高于旧 primary。
   */
  async ensureSessionLease(sessionId: string, minFence?: number): Promise<LeaseGrant | undefined> {
    const service = this.leaseService;
    if (service === undefined || this.leaseLost) return undefined;
    const existing = this.sessionLeases.get(sessionId);
    if (existing !== undefined && existing.expiresAt > Date.now()) return existing;
    const grant =
      minFence !== undefined
        ? await service.acquire('session', sessionId, { minFence })
        : await service.acquire('session', sessionId);
    this.sessionLeases.set(sessionId, grant);
    this.startLeaseRenewTimer();
    return grant;
  }

  /** 按当前租约 TTL 的 1/3 启动后台续租；`.unref()` 不阻止进程退出。 */
  private startLeaseRenewTimer(): void {
    if (!this.leaseService || this.leaseRenewTimer !== undefined) return;
    const now = Date.now();
    let ttlMs = 30_000;
    for (const grant of this.sessionLeases.values()) {
      ttlMs = Math.min(ttlMs, grant.expiresAt - now);
    }
    if (this.bindingLease !== undefined) {
      ttlMs = Math.min(ttlMs, this.bindingLease.expiresAt - now);
    }
    // 续租间隔：优先 `lease.renewMs`，但不得超过最近一张租约剩余 TTL 的 1/3
    // （构造时 bindingLease 可能已消耗掉一部分 TTL，固定 10s 会来不及）。
    const configuredRenewMs = this.leaseService.renewMs;
    const ttlDerivedMs = Math.max(1_000, Math.floor(ttlMs / 3));
    const configuredMs =
      configuredRenewMs !== undefined && configuredRenewMs > 0
        ? Math.max(1_000, Math.floor(configuredRenewMs))
        : ttlDerivedMs;
    const intervalMs = Math.min(configuredMs, ttlDerivedMs);
    this.leaseRenewTimer = setInterval(() => {
      void this.renewLeases();
    }, intervalMs);
    (this.leaseRenewTimer as { unref?: () => void }).unref?.();
  }

  private clearLeaseRenewTimer(): void {
    if (this.leaseRenewTimer === undefined) return;
    clearInterval(this.leaseRenewTimer);
    this.leaseRenewTimer = undefined;
  }

  /**
   * 续租 SessionLease + BindingLease。
   *
   * 单次续租失败不等同租约丢失：只有 `LeaseExpiredError`（真实过期 / stale_fence）
   * 或租约时钟已过期才进入丢失流程；其它错误（瞬时 I/O 等）只记 warn，
   * 下个 tick 继续重试——一次抖动不应把整个 EU 毒化。
   */
  private async renewLeases(): Promise<void> {
    const service = this.leaseService;
    if (!service || this.leaseLost) return;
    if (this.renewingLeases !== undefined) return this.renewingLeases;

    const task = (async () => {
      for (const [sessionId, grant] of [...this.sessionLeases]) {
        const renewed = await this.renewGrant(grant);
        if (this.leaseLost) return;
        if (renewed !== undefined) this.sessionLeases.set(sessionId, renewed);
      }
      const binding = this.bindingLease;
      if (binding !== undefined) {
        const renewed = await this.renewGrant(binding);
        // 续租成功必须保存新 grant，否则 expiresAt 停留在 acquire 时刻。
        if (renewed !== undefined) this.bindingLease = renewed;
      }
    })();
    this.renewingLeases = task;
    try {
      await task;
    } finally {
      if (this.renewingLeases === task) this.renewingLeases = undefined;
    }
  }

  /**
   * 续租单个 grant；返回新 grant，失败返回 undefined。
   * 真实过期 / stale_fence 或租约时钟已过期 → `onLeaseLost`（停表，不再无限重试）。
   */
  private async renewGrant(grant: LeaseGrant): Promise<LeaseGrant | undefined> {
    const service = this.leaseService;
    if (service === undefined || this.leaseLost) return undefined;
    try {
      return await service.renew(grant.leaseId);
    } catch (error) {
      if (error instanceof LeaseExpiredError || grant.expiresAt <= Date.now()) {
        this.onLeaseLost(error);
        return undefined;
      }
      this.logger.warn('lease renew failed; will retry', {
        ...(this.boundAgentId !== undefined ? { agent_id: this.boundAgentId } : {}),
        lease_kind: grant.kind,
        lease_key: grant.key,
        error: errorText(error),
      });
      return undefined;
    }
  }

  /**
   * 租约丢失：停止接受新 run，abort 当前 activeRun。
   * `shutdown` abort reason 让终态 checkpoint 落 `interrupted`（可 resume）。
   */
  private onLeaseLost(error: unknown): void {
    if (this.leaseLost) return;
    this.leaseLost = true;
    this.clearLeaseRenewTimer();
    this.logger.warn('session lease lost', {
      ...(this.boundAgentId !== undefined ? { agent_id: this.boundAgentId } : {}),
      error: errorText(error),
    });
    const control = this.activeRunControl;
    if (control !== undefined && !control.controller.signal.aborted) {
      control.controller.abort('shutdown');
    }
  }

  /** 当前 session 已持有的 fencing token；未持有返回 undefined（读路径不受影响）。 */
  private fencingTokenFor(sessionId: string): number | undefined {
    return this.sessionLeases.get(sessionId)?.fencingToken;
  }

  /**
   * 非 per-session EU（tenant 根 EU，没有 BindingLease）在每次 run 结束后释放
   * SessionLease；成员 EU 持有到 dispose。否则根 EU 切换 session 后会一直占着旧
   * session 的跨进程写租约。
   */
  private async releaseTransientSessionLease(sessionId: string): Promise<void> {
    if (this.bindingLease !== undefined) return;
    const grant = this.sessionLeases.get(sessionId);
    if (grant === undefined) return;
    this.sessionLeases.delete(sessionId);
    try {
      await this.leaseService?.release(grant.leaseId);
    } catch {
      // best-effort；dispose 仍会兜底。
    }
    if (this.sessionLeases.size === 0) this.clearLeaseRenewTimer();
  }

  /** dispose：先 SessionLease 后 BindingLease，全部 best-effort。 */
  private async releaseLeases(): Promise<void> {
    const service = this.leaseService;
    if (!service) return;
    for (const grant of [...this.sessionLeases.values()]) {
      try {
        await service.release(grant.leaseId);
      } catch {
        // dispose 不因租约释放失败而阻塞。
      }
    }
    this.sessionLeases.clear();
    if (this.bindingLease !== undefined) {
      try {
        await service.release(this.bindingLease.leaseId);
      } catch {
        // 同上。
      }
    }
  }

  /** 同步预留 active run 槽位；已有 active run 时抛稳定错误 `run_already_running`。 */
  private beginExecution(runId: string, sessionId: string, branch?: string): Run {
    if (this.activeRun) {
      throw new RunAlreadyRunningError(runId);
    }
    const now = Date.now();
    const workingContext = this.contextFactory({ sessionId });
    // 工厂实现可能不切会话；播种前统一设到本次 run 的 session（clear 只清当前桶）。
    workingContext.setSessionId(sessionId);
    const execution: Run = {
      runId,
      sessionId,
      ...(branch !== undefined ? { branch } : {}),
      createdAt: now,
      startedAt: now,
      stats: createUsageStats(now),
      // Stage 4：每个 Run 新建窗口实例；从 SessionState 快照 + 事件日志播种。
      workingContext,
      record: createRunRecord({
        runId,
        sessionId,
        createdAt: now,
        ...(this.boundAgentId !== undefined ? { agentId: this.boundAgentId } : {}),
        ...(branch !== undefined ? { branch } : {}),
      }),
      // 0.14 P0：错误 envelope 的阶段来源；输入 guardrail / 进入 loop 后会被更新。
      phase: 'input',
    };
    // 新 run 不复用上一次的权限等待统计（PermissionPolicy 跨 run 存活）。
    this.permissionPolicy.resetPausedMs();
    this.activeRun = execution;
    this.activeRunControl = {
      execution,
      controller: new AbortController(),
      cleanups: [],
    };
    this.warnedLimitKeys.clear();
    // 0.16 E5：BeforeLlm 注入去重按 run 重置
    this.injectedMessageKeys.clear();
    this.injectedMessageRefs = new WeakSet();
    // CONTRACT-prefix-invariant：每 run 只报告一次的事件与旧 additionalContext 去重
    this.systemPromptIgnoredReported = false;
    this.additionalContextDeprecatedReported = false;
    this.legacyAdditionalContextSeen.clear();
    return execution;
  }

  private async endExecution(execution: Run): Promise<void> {
    // 记录本 Run 结束时的水位；下一 Run 重建窗口，无 active Run 时 host 读此值。
    const context = execution.workingContext;
    const max = context.maxTokens;
    this.lastContextRatioValue =
      typeof max === 'number' && Number.isFinite(max) && max > 0
        ? context.tokenCount / max
        : undefined;
    await this.flushJournalWrites();
    if (this.activeRun === execution) this.activeRun = undefined;
    // C2：已发布 id 是 Run 级状态；Run 结束即丢弃，避免跨 Run 复用 miss。
    this.lastReportedCompactionId.delete(execution.runId);
    if (this.activeJournal !== undefined) {
      await this.activeJournal.close();
      this.activeJournal = undefined;
    }
    if (this.activeRunControl?.execution === execution) {
      for (const cleanup of this.activeRunControl.cleanups) cleanup();
      this.activeRunControl = undefined;
    }
    this.runSystemPrompt = undefined;
  }

  /** 上一 Run 结束时的上下文水位；无 active Run 时供成员 host 读取。 */
  get lastContextRatio(): number | undefined {
    return this.lastContextRatioValue;
  }

  /** 成员 / owner 身份；Runtime 复用同 session 的 EU 时校验绑定一致。 */
  get agentId(): string | undefined {
    return this.boundAgentId;
  }

  /** ADR-098 C2：为一次 Run 建立 journal（fencing token 在租约获取后已知）。 */
  private beginJournal(execution: Run, fencingToken?: number): RunJournal {
    return this.journalFactory.begin({
      runId: execution.runId,
      sessionId: execution.sessionId,
      events: this.events,
      ...(this.boundAgentId !== undefined ? { agentId: this.boundAgentId } : {}),
      ...(execution.branch !== undefined ? { branch: execution.branch } : {}),
      ...(fencingToken !== undefined ? { fencingToken } : {}),
    });
  }

  /** 无 active Run 的写（manual/plugin）：按 runId+session 缓存，保证 pending 可统一 flush。 */
  private transientJournal(runId: 'manual' | 'plugin', sessionId?: string): RunJournal {
    const key = `${runId}\0${sessionId ?? ''}`;
    const existing = this.transientJournals.get(key);
    if (existing !== undefined) return existing;
    const fencingToken = sessionId !== undefined ? this.fencingTokenFor(sessionId) : undefined;
    const journal = this.journalFactory.transient({
      runId,
      events: this.events,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(fencingToken !== undefined ? { fencingToken } : {}),
    });
    this.transientJournals.set(key, journal);
    return journal;
  }

  /**
   * 0.52 S1a：把本执行面在途的会话状态 / 事件写入刷干净（退出序列最后一步用）。
   *
   * 只是等本地 journal 队列，不 await run / 模型流 / 后台进程。
   */
  async flushStateWrites(): Promise<void> {
    await this.flushJournalWrites();
  }

  /** 等待 active + transient journal 的所有在途写入。 */
  private async flushJournalWrites(): Promise<void> {
    const journals = [
      ...(this.activeJournal !== undefined ? [this.activeJournal] : []),
      ...this.transientJournals.values(),
    ];
    await Promise.all(journals.map((journal) => journal.flush()));
  }

  /**
   * 中止当前 active run（0.10 R2-18）。
   *
   * - `shutdown` / `timeout`：checkpoint 落 `interrupted`（可 `--resume-run`）；
   * - `user`：按用户取消处理，checkpoint 落 `cancelled`；
   * - 无 active run 或已中止：no-op（幂等）。
   *
   * 只负责发中断；调用方应 await 自己的 run()/resume() promise 确认终态。
   */
  interrupt(reason: RunInterruptReason = 'user'): void {
    const control = this.activeRunControl;
    if (!control || control.controller.signal.aborted) return;
    this.logger.info('run interrupt requested', {
      run_id: control.execution.runId,
      reason,
    });
    control.controller.abort(reason);
  }

  /**
   * 0.52 S1a：当前在跑 run 的只读快照。
   *
   * node 退出路径用它枚举「有在跑 run 的会话」。同步、不触碰任何流：
   * 无 active run ⇒ undefined ⇒ 该会话**不会**被写续跑标记。
   */
  activeRunSnapshot(): { run_id: string; session_id: string } | undefined {
    const run = this.activeRun;
    if (run === undefined) return undefined;
    return { run_id: run.runId, session_id: run.sessionId };
  }

  /**
   * 0.52 S1a：写入「下次启动续跑」标记。
   *
   * 只做两件事：读一次会话状态，置 resume_after_restart 后交给 RunJournal 单写口
   * （saveSessionState，与其它状态写入同一条路）。
   *
   * 退出路径的预算是 2s，所以这里**不** await run / 模型流 / 长工具 / 后台进程；
   * 有属于本会话的 active run 时，saveSessionState 的既有行为会顺带把 workingContext
   * 里的半截回复一起落盘（这正是「半截回复也要落地」要的）。
   *
   * 返回是否真的写了（没接 SessionStore / 读不到会话状态 ⇒ false，调用方只记日志）。
   */
  async armResumeAfterRestart(sessionId: string, marker: ResumeAfterRestart): Promise<boolean> {
    if (!this.session) return false;
    let sessionState: SessionState | null;
    try {
      sessionState = await this.session.load(sessionId);
    } catch (error) {
      this.logger.warn('resume marker skipped: session load failed', {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (sessionState === null) {
      this.logger.warn('resume marker skipped: no session state', { session_id: sessionId });
      return false;
    }
    sessionState.resume_after_restart = {
      ...marker,
      pending_input_ids: [...marker.pending_input_ids],
    };
    const active = this.activeRun;
    if (active !== undefined && active.sessionId !== sessionId) {
      // active run 属于别的会话：不能走 saveSessionState（它会用那段 workingContext
      // 重写本会话的 messages），只补标记。
      await this.flushJournalWrites();
      await this.transientJournal('manual', sessionId).saveSessionState(sessionState);
      return true;
    }
    await this.saveSessionState(sessionState);
    return true;
  }

  /**
   * 把调用方 signal 桥接到当前 run 的内部 controller（0.10 R2-18）。
   * 外部 reason 原样透传，保持既有 cancelled / interrupted 语义。
   */
  private executionSignal(execution: Run, external?: AbortSignal): AbortSignal | undefined {
    const control =
      this.activeRunControl?.execution === execution ? this.activeRunControl : undefined;
    if (!control) return external;

    const signal = control.controller.signal;
    if (!external) return signal;
    if (external.aborted) {
      if (!signal.aborted) control.controller.abort(external.reason);
      return signal;
    }

    const onAbort = (): void => control.controller.abort(external.reason);
    external.addEventListener('abort', onAbort, { once: true });
    control.cleanups.push(() => external.removeEventListener('abort', onAbort));
    return signal;
  }

  /** run() 的主体：调用方已持有 execution 槽位。 */
  private async executeRun(
    execution: Run,
    input: string | Message,
    opts?: RunOptions,
  ): Promise<string> {
    const { runId, sessionId } = execution;
    // ADR-098 C2：首个 run 前获取 SessionLease；同一 session 复用则续租。
    const lease = await this.acquireSessionLease(sessionId);
    if (lease !== undefined) execution.record.fencing_token = lease.fencingToken;
    // Stage 4：本 Run 的唯一写者。此后 EU 的 publishEvent / checkpoint / session save
    // 全部委托给它；fencing token 由租约获取后确定。
    this.activeJournal = this.beginJournal(execution, lease?.fencingToken);
    const workingContext = execution.workingContext;
    // 外部 signal 与 interrupt() 的内部 controller 统一成一个 signal（0.10 R2-18）
    const signal = this.executionSignal(execution, opts?.signal);

    // 显式 session 切换：允许上下文整体不同（session 快照本身按 session 隔离）。
    const previousSessionId = this.lastSessionId;
    if (previousSessionId !== undefined && previousSessionId !== sessionId) {
      this.pendingPrefixReason ??= 'session_switch';
    }
    this.lastSessionId = sessionId;

    // 0.15 E9：Self Card 在 run 开始时生成一次；无 selfCard 时等于原 systemPrompt
    this.runSystemPrompt = this.composeRunSystemPrompt();

    // Stage 4：本 Run 的新窗口不从上一 Run 对象复用；总是用 SessionState 快照
    // （derived_upto_seq == lastSeq 时 O(1)）或事件日志全量投影重新播种。
    // 0.18：这也保证 session 缓存之后的日志增量被重放，saveSessionState 不会
    // 把未进入上下文的事件标记成“已覆盖”（derived_upto_seq 超前）。
    const history = await this.loadStoredHistory(sessionId);
    const stored = history.sessionState;
    // Stage 4 parity：baseline 在同一 session + 窗口可复用时跳过播种（不发
    // context.changed）。per-Run 窗口必须重建，但“重建”不应变成可观察事件；
    // 只有 baseline 也会播种的场景（session 切换 / 有日志增量 / 空窗口）才发。
    const currentCursor = await this.activeJournal?.currentSeq(sessionId);
    const reuseLikeBaseline =
      previousSessionId === sessionId &&
      this.lastCoveredSessionId === sessionId &&
      currentCursor === this.lastCoveredCursor &&
      history.messages.length > 0;
    this.seedWorkingContext(execution, history, { emitEvents: !reuseLikeBaseline });
    // baseline 在窗口复用时不会 clear，`realTokens` 沿用上一 Run 的真实值；
    // per-Run 新实例 seed 会 clear，复用路径显式恢复同一口径。
    if (reuseLikeBaseline && this.lastRealTokens !== undefined) {
      execution.workingContext.updateRealTokens(this.lastRealTokens);
    } else {
      // V4 / G4：新进程续接（或进程内窗口重建）时用最近一次 provider 请求的
      // per-request usage 作为真实锚点（来自 `llm.response` 事件）。
      // 不能用 RunRecord 的 usage：那是整轮累计，多请求 run 会线性放大。
      this.seedRealTokensFromLastRequest(execution, history);
    }
    // 0.52 C：真实用量锚点（按会话落盘）。`realTokens` 归零期间（重启 / 新进程第一轮 /
    // 压缩后）用它把本地估算校正到 provider 口径；有真实值时锚点不抢（见 tokenCount）。
    // 必须在 seed 之后注入：播种会 setSessionId，切会话时会把锚点清掉。
    execution.workingContext.setContextAnchor?.(stored?.context_anchor, this.model);
    // 0.52：恢复「上次发布过的环境快照指纹」，让重启后的第一条消息能正确去重。
    this.restorePromptContextFingerprint(stored);

    // system 前缀只允许显式 revision：基底 system / Self Card 只在构造期变化，
    // 若同一 session 的基底确实不同（例如运行时重建），标记为一次 system_revision。
    const requestBaseSystem = this.runSystemPrompt ?? this.systemPrompt ?? '';
    const previousBaseSystem = this.lastRunSystemPrompts.get(sessionId);
    if (previousBaseSystem !== undefined && previousBaseSystem !== requestBaseSystem) {
      this.pendingPrefixReason ??= 'system_revision';
    }
    this.lastRunSystemPrompts.set(sessionId, requestBaseSystem);

    // 准备用户消息
    const userMessage: Message =
      typeof input === 'string' ? { role: 'user', content: input } : input;

    // 会话壳：run 启动即建立；title / preview / created_at 从既有 SessionState 保留。
    const sessionState = this.createSessionState(
      sessionId,
      runId,
      stored,
      execution.branch,
      Date.now(),
    );

    // 发布 Run 开始事件
    // `input_name` 是 additive 字段：把输入 Message 的 name（A2A 投递时是
    // `agent:<alias>`）在首帧就带出去。渲染层不必等 `user.message`（那要过完
    // Input guardrail 的 await）才知道这条输入不是坐在键盘前的人说的。
    // 缺省不写：普通人类输入的载荷与今天逐字节一致。
    this.publishEvent({
      type: 'run.started',
      run_id: runId,
      data: {
        run_id: runId,
        session_id: sessionId,
        input: userMessage.content,
        ...(userMessage.name !== undefined ? { input_name: userMessage.name } : {}),
      },
      ts: Date.now(),
    });

    try {
      // 注入消息（C5）：core 不解释其语义（skill / 附件 / 引用文件……），先于用户输入写入并持久化
      for (const injected of opts?.messages ?? []) {
        this.publishEvent({
          type: 'message.injected',
          run_id: runId,
          data: { run_id: runId, session_id: sessionId, message: injected },
          ts: Date.now(),
        });
        this.addContext(injected, runId);
      }

      // 应用输入 Guardrail（先于写上下文：replacement 要成为持久化的用户消息，C-05）
      const inputResult = await this.guardrails.apply(
        userMessage.content,
        GuardrailStage.Input,
        runId,
        sessionId,
      );
      if (!inputResult.allowed) {
        throw new Error(`Input blocked by guardrail: ${inputResult.reason}`);
      }
      const effectiveUser =
        typeof inputResult.replacement === 'string' &&
        inputResult.replacement !== userMessage.content
          ? { ...userMessage, content: inputResult.replacement }
          : userMessage;

      // 添加（可能被 guardrail 改写后的）用户消息到上下文
      this.addContext(effectiveUser, runId);

      // 0.18：用户输入是唯一真相源的一部分（run.started.input 是改写前文本，
      // 不能单独用于恢复）。记录实际写入上下文的消息原文。
      this.publishEvent({
        type: 'user.message',
        run_id: runId,
        data: { run_id: runId, session_id: sessionId, message: effectiveUser },
        ts: Date.now(),
      });

      // 初始保存：先 RunRecord（含 event_cursor），再 SessionState 投影（含 derived_upto_seq）。
      // 恢复历史 + 注入 + 用户输入都已进入上下文，运行中崩溃不再丢历史（C-02）。
      sessionState.messages = workingContext.messages;
      await this.writeRunRecord(execution, 'running');
      await this.saveSessionState(sessionState);
      await this.updateSessionIndexBestEffort(sessionState);

      // 执行 tool-calling loop（把本轮输入的引用透传给 BeforeLlm 的 hook 上下文）
      const response = await runToolCallingLoop(
        this.createLoopContext(execution, signal, userMessage.refs),
      );

      // 统一终态：status / OnError / session / checkpoint / 事件
      await this.finalizeRun(execution, sessionState, { status: 'completed', output: response });

      return response;
    } catch (error) {
      await this.finalizeFailure(execution, sessionState, error, signal);
      throw error;
    }
  }

  /**
   * 统一终态（C1）：run()/resume() 共用。
   *
   * 顺序：status 映射 → OnError hook（best-effort）→ writeRunRecord →
   * saveSessionState → 发布 run.completed / run.cancelled / run.failed。
   */
  private async finalizeRun(
    execution: Run,
    sessionState: SessionState,
    outcome: RunTerminalOutcome,
  ): Promise<void> {
    const { runId, sessionId, startedAt, stats } = execution;

    if (outcome.status === 'completed') {
      await this.writeRunRecord(execution, 'completed');
      this.finalizeSessionState(execution, sessionState, 'completed');
      await this.saveSessionState(sessionState);

      this.publishEvent({
        type: 'run.completed',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: sessionId,
          output: outcome.output,
          usage: execution.record.usage,
          duration_ms: Date.now() - startedAt,
          iterations: stats.requestCount,
        },
        ts: Date.now(),
      });
      await this.finishEventLog(sessionState);
      return;
    }

    const signal = outcome.signal;
    // 用户显式取消 → cancelled；Host 中断/普通错误 → failed（与事件口径一致）
    const cancelled = this.isUserCancelled(signal);
    const errorMessage = errorText(outcome.error);
    const terminalStatus = this.failureCheckpointStatus(signal);

    // OnError Hook best-effort（C2）：hook 故障不得替换原始错误，也不得跳过终态写入。
    try {
      await this.hooks.run(HookType.OnError, {
        run_id: runId,
        session_id: sessionId,
        error: errorMessage,
        phase: 'run',
      });
    } catch (hookError) {
      this.publishEvent({
        type: 'hook.error',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: sessionId,
          hook_type: HookType.OnError,
          error: errorText(hookError),
        },
        ts: Date.now(),
      });
    }

    // 用户显式取消发 run.cancelled；Host 关闭/中断与普通失败保持 run.failed
    const permissionTimeout = outcome.error instanceof PermissionTimeoutError;
    // 0.14 P0：结构化错误 envelope 只附加到 run.failed；run.cancelled 保持原形状。
    const envelope: ErrorEnvelope | undefined = cancelled
      ? undefined
      : toErrorEnvelope(outcome.error, {
          ...(execution.phase !== undefined ? { phase: execution.phase } : {}),
        });

    // durable 终态：失败 / 取消 / 中断（best-effort，不覆盖原始错误）。
    // 失败同样保存真实上下文，避免用单条 user 消息覆盖既有历史（C-02）。
    await this.writeRunRecord(execution, terminalStatus, errorMessage, true, envelope);
    this.finalizeSessionState(execution, sessionState, terminalStatus);
    await this.saveSessionState(sessionState);

    const partial = execution.partialContent;
    this.publishEvent({
      type: cancelled ? 'run.cancelled' : 'run.failed',
      run_id: runId,
      data: {
        run_id: runId,
        session_id: sessionId,
        error: errorMessage,
        duration_ms: Date.now() - startedAt,
        ...(cancelled && typeof signal?.reason === 'string' ? { reason: signal.reason } : {}),
        ...(envelope ?? {}),
        ...(envelope !== undefined ? { error_envelope: envelope } : {}),
        // 0.18：中断时已流出的文本（可还原用户看到的半截回答）
        ...(typeof partial === 'string' && partial.length > 0 ? { partial_content: partial } : {}),
        // 权限超时（DECISION-022 §2.2）：失败原因显式标注，供 UI / 观测区分
        ...(!cancelled && permissionTimeout ? { reason: 'permission_timeout' } : {}),
      },
      ts: Date.now(),
    });
    await this.finishEventLog(sessionState);
  }

  /**
   * 0.18：终态收尾——等待事件日志落盘，然后 best-effort 更新会话索引。
   * 成功/失败路径共用；日志失败不覆盖 run 终态。
   */
  private async finishEventLog(sessionState: SessionState): Promise<void> {
    // Stage 4 parity：终态事件（run.completed 等）已落盘；记录窗口覆盖到的游标，
    // 下一 Run 若日志尾未前进，就按 baseline 的复用路径处理（不发重建事件）。
    // 无 eventLog 时游标为 undefined；只要 session 一致，同样按“可复用”处理。
    if (!this.eventLog) {
      if (this.activeJournal !== undefined) {
        this.lastCoveredSessionId = sessionState.session_id;
        this.lastCoveredCursor = undefined;
      }
      return;
    }
    await this.flushJournalWrites();
    if (this.activeJournal !== undefined) {
      const cursor = await this.activeJournal.currentSeq(sessionState.session_id);
      this.lastCoveredSessionId = sessionState.session_id;
      this.lastCoveredCursor = cursor;
    }
    try {
      await this.updateSessionIndex(sessionState);
    } catch (error) {
      this.logger.warn('session index update failed', {
        session_id: sessionState.session_id,
        error: errorText(error),
      });
    }
    // P2：run 结束关闭该 session 的写句柄，避免长进程每会话永久占用一个 FD。
    // 下次 run/append 会重新打开并从文件尾恢复 seq。
    try {
      await this.eventLog.release?.(sessionState.session_id);
    } catch (error) {
      this.logger.warn('session event log release failed', {
        session_id: sessionState.session_id,
        error: errorText(error),
      });
    }
  }

  /**
   * 失败终态包装：终态持久化本身失败（如 session 盘满）也不得覆盖原始错误。
   * OnError hook 已在 finalizeRun 内部 best-effort。
   */
  private async finalizeFailure(
    execution: Run,
    sessionState: SessionState,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.finalizeRun(execution, sessionState, { status: 'failed', error, signal });
    } catch (finalizeError) {
      this.publishEvent({
        type: 'run.finalize.failed',
        run_id: execution.runId,
        data: {
          run_id: execution.runId,
          session_id: execution.sessionId,
          error: errorText(finalizeError),
        },
        ts: Date.now(),
      });
      // 终态写入失败时仍等待已入队的事件落盘，避免调用方看到 run 结束后日志缺尾。
      await this.flushJournalWrites();
    }
  }

  /**
   * SessionState 镜像 / RunRecord 共用的 usage 快照。
   *
   * CONTRACT-0.29 §1.2：缓存两项**只在有 provider 上报过时**才写出。
   * `UsageStats` 用数字累加，但「从未上报过缓存」必须回写成 `undefined`（省略键），
   * 不能因为累加器是数字就冒出一个 `cache_read_input_tokens: 0`。
   */
  private usageFromStats(stats: UsageStats): RunUsage {
    return {
      prompt_tokens: stats.inputTokens,
      completion_tokens: stats.outputTokens,
      total_tokens: stats.totalTokens,
      total_cost: stats.totalCost,
      ...(stats.cacheReadTokens !== undefined
        ? { cache_read_input_tokens: stats.cacheReadTokens }
        : {}),
      ...(stats.cacheCreationTokens !== undefined
        ? { cache_creation_input_tokens: stats.cacheCreationTokens }
        : {}),
    };
  }

  /**
   * 用一条历史投影复位并播种本次 run 的 WorkingContext。
   * 事件日志可能只有压缩摘要（role system）；基底 system 仍要补回。
   */
  private seedWorkingContext(
    execution: Run,
    history: StoredHistory,
    options?: { emitEvents?: boolean },
  ): void {
    const workingContext = execution.workingContext;
    // 先切到目标 session 再清空：clear() 只清当前 session 的桶。
    workingContext.setSessionId(execution.sessionId);
    workingContext.clear();
    const add = (message: Message): void => {
      if (options?.emitEvents === false) {
        // baseline 的窗口复用路径不发 context.changed；per-Run 重建保持同一可观察面。
        const stamped =
          message.timestamp === undefined ? { ...message, timestamp: Date.now() } : message;
        workingContext.add(stamped);
        return;
      }
      this.addContext(message, execution.runId, { stampIdentity: false });
    };
    if (
      !history.messages.some(
        (message) => message.role === 'system' && message.compaction_summary !== true,
      ) &&
      this.runSystemPrompt
    ) {
      add({ role: 'system', content: this.runSystemPrompt });
    }
    for (const message of history.messages) {
      add(message);
    }
  }

  /**
   * V4 / G4：用最近一次 provider 请求的 per-request usage 恢复真实 token 锚点。
   *
   * 取值来自已落盘的 `llm.response.usage`，**不是** RunRecord 的 `usage`：
   * 后者是整轮累计（例如 53 轮 agentic run 可到 35M），拿它当上下文大小会让
   * 每次新 run 都误判超预算、触发不必要的压缩，既丢历史又多一次摘要调用。
   * 没有 provider usage 时保持无锚点，由 `WorkingContext` 的字符估算兜底。
   */
  private seedRealTokensFromLastRequest(execution: Run, history: StoredHistory): void {
    const total = history.lastRequestTokens;
    if (total === undefined || total <= 0) return;
    execution.workingContext.updateRealTokens(total);
  }

  /**
   * 用已加载的 RunRecord 恢复并继续一次 run（0.3 durable）。
   *
   * - 调用方负责从 RunRecordStore 加载；EU 不再自己 load store；
   * - 会话历史 / usage / iteration 来自 RunRecord + SessionEventLog；
   * - 不注入新的用户消息；
   * - run id 保持不变，返回值语义与 run() 一致。
   */
  async resumeRun(record: RunRecord, opts?: RunOptions): Promise<string> {
    if (this.leaseLost) throw new LeaseExpiredError('lease_expired');
    const runId = record.run_id;
    if (this.resuming.has(runId)) throw new RunAlreadyRunningError(runId);
    if (record.status !== 'running' && record.status !== 'interrupted') {
      throw new RunResumeError('run_not_resumable', runId, record.status);
    }

    // 与 run() 共用单 run 守卫；同步占位，避免两次不同 run 的并发 resume。
    const execution = this.beginExecution(runId, record.session_id);
    const signal = this.executionSignal(execution, opts?.signal);
    this.resuming.add(runId);
    try {
      const sessionId = record.session_id;
      // resume 需要有效 SessionLease；token 刷新后继续同一 run。
      const lease = await this.acquireSessionLease(sessionId);
      execution.createdAt = record.created_at;
      execution.branch =
        record.branch ??
        (typeof record.metadata?.branch === 'string' ? record.metadata.branch : undefined);
      // Stage 4：本 Run 的 journal（run id / session 保持不变，写者唯一）。
      this.activeJournal = this.beginJournal(execution, lease?.fencingToken);
      // Run 持有的 RunRecord 与磁盘上的同一 run 对齐；后续安全点原地更新。
      const runRecord = execution.record;
      runRecord.session_id = sessionId;
      runRecord.created_at = record.created_at;
      runRecord.updated_at = record.updated_at;
      runRecord.branch = execution.branch;
      runRecord.agent_id = record.agent_id ?? this.boundAgentId;
      runRecord.metadata = record.metadata ?? runRecord.metadata;
      if (lease !== undefined) runRecord.fencing_token = lease.fencingToken;

      // 恢复统计，保持 limits / termination 连续
      execution.stats = {
        requestCount: record.iteration ?? 0,
        toolCallsCount:
          typeof record.metadata?.tool_calls_count === 'number'
            ? record.metadata.tool_calls_count
            : 0,
        inputTokens: record.usage?.prompt_tokens ?? 0,
        outputTokens: record.usage?.completion_tokens ?? 0,
        totalTokens: record.usage?.total_tokens ?? 0,
        totalCost: record.usage?.total_cost ?? 0,
        startTime: execution.startedAt,
        // CONTRACT-0.29 B1：缓存计数必须跨 resume 连续累加，否则命中率/成本归因归零。
        // 「RunRecord 里没有」= provider 从未上报过（§1.2），保持 `undefined` 而不是 0。
        ...(record.usage?.cache_read_input_tokens !== undefined
          ? { cacheReadTokens: record.usage.cache_read_input_tokens }
          : {}),
        ...(record.usage?.cache_creation_input_tokens !== undefined
          ? { cacheCreationTokens: record.usage.cache_creation_input_tokens }
          : {}),
      };

      // 0.18：SessionState 缓存 + 事件日志是恢复来源；legacy_messages 只作
      // 旧文件回退。禁止用较旧的 RunRecord 覆盖较新的 session。
      // 0.15 E9：resume 同样在 run 开始时生成一次 Self Card
      this.runSystemPrompt = this.composeRunSystemPrompt();
      // CONTRACT-prefix-invariant：resume 是显式前缀失效（历史可能已被裁剪）。
      this.pendingPrefixReason ??= 'resume';
      this.lastSessionId = sessionId;
      this.lastRunSystemPrompts.set(sessionId, this.runSystemPrompt ?? this.systemPrompt ?? '');
      const history = await this.loadStoredHistory(sessionId, record);
      if (history.messages.length === 0) {
        throw new RunResumeError('run_not_resumable', runId, 'empty checkpoint');
      }
      // 0.52 C：resume 是「重启后接管被中断 run」的入口，必须与 run() 同一处复原
      // 「上下文卡」去重指纹；漏了这一步会再发一张全量卡（用户实测的重启后重发）。
      this.restorePromptContextFingerprint(history.sessionState);
      // 同族漏点（ctx-card-dedup 审查时发现）：context_anchor 原来也只在 run() 里复原。
      // resume 接管时缺了它，估算就退回未校正值 ⇒ 压缩阈值比真实口径晚（估算偏小），
      // 与 0.52 的「锚点校正」预期相反。两处必须一致。
      execution.workingContext.setContextAnchor?.(history.sessionState?.context_anchor, this.model);
      this.seedWorkingContext(execution, history);
      this.seedRealTokensFromLastRequest(execution, history);

      const sessionState = this.createSessionState(
        sessionId,
        runId,
        history.sessionState,
        execution.branch,
        Date.now(),
      );
      // 0.18：先发布 run.resumed，再落盘；否则 derived_upto_seq 会漏掉
      // 这条事件（legacy RunRecord 复用 session 时尤其明显）。
      this.publishEvent({
        type: 'run.resumed',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: sessionId,
          from_status: record.status,
          iteration: execution.stats.requestCount,
        },
        ts: Date.now(),
      });

      // 标记已被接管（唯一写者：Run）。先 RunRecord，再 SessionState 投影。
      sessionState.messages = execution.workingContext.messages;
      await this.writeRunRecord(execution, 'running');
      await this.saveSessionState(sessionState);
      await this.updateSessionIndexBestEffort(sessionState);

      try {
        const response = await runToolCallingLoop(this.createLoopContext(execution, signal));

        // 与 run() 共用终态路径：用户取消同样发 run.cancelled（C1）
        await this.finalizeRun(execution, sessionState, { status: 'completed', output: response });

        return response;
      } catch (error) {
        await this.finalizeFailure(execution, sessionState, error, signal);
        throw error;
      }
    } finally {
      this.resuming.delete(runId);
      await this.endExecution(execution);
      await this.releaseTransientSessionLease(execution.sessionId);
    }
  }

  /**
   * 按 session 历史启动一次全新的 run（Q5；不新增 RPC）。
   *
   * - 会话必须已存在（SessionState 或事件日志）；不会新建会话；
   * - 生成新的 run id；调度器可通过 `opts.runId` 固定它；
   * - 历史播种 / 单 run 守卫 / 终态路径与 `run()` 完全共用。
   */
  async resumeSession(
    sessionId: string,
    input: string | Message,
    opts?: RunOptions,
  ): Promise<string> {
    if (this.leaseLost) throw new LeaseExpiredError('lease_expired');
    const stored = await this.loadSessionState(sessionId);
    const cursor = await this.resolveSessionCursor(sessionId);
    if (stored === null && cursor === undefined) {
      throw new Error(`session_not_found: ${sessionId}`);
    }
    const runId = opts?.runId ?? randomUUID();
    // 单 run 守卫必须在任何 await 之前同步占位（与 run() 同口径）。
    const execution = this.beginExecution(runId, sessionId, opts?.branch);
    if (opts?.branch !== undefined && opts.branch !== this.lastBranch) {
      this.pendingPrefixReason ??= 'branch';
    }
    if (opts?.branch !== undefined) this.lastBranch = opts.branch;
    try {
      return await this.executeRun(execution, input, opts);
    } finally {
      await this.endExecution(execution);
      await this.releaseTransientSessionLease(sessionId);
    }
  }

  /**
   * 为一次 run 构造 tool-calling loop 的依赖面。
   *
   * loop 只做算法编排；窗口、provider、工具执行、事件与控制策略全部经端口
   * 绑定回当前 `ExecutionUnit` / `execution`，不引入跨 run 状态。
   */
  private createLoopContext(
    execution: Run,
    signal?: AbortSignal,
    inputRefs?: readonly MessageRef[],
  ): LoopContext {
    return {
      execution,
      model: this.model,
      ...(this.pricing !== undefined ? { pricing: this.pricing } : {}),
      ...(inputRefs !== undefined && inputRefs.length > 0 ? { inputRefs } : {}),
      window: {
        addMessage: (m, id) => this.addContext(m, id),
        buildRequestMessages: (o) => this.buildRequestMessages(o, execution.workingContext),
        appendInjectedMessages: (id, m) => this.appendInjectedMessages(execution, id, m),
        updateRealTokens: (t) => {
          this.lastRealTokens = t;
          execution.workingContext.updateRealTokens(t);
        },
        autoCompact: async () => execution.workingContext.autoCompactAsync?.(),
      },
      provider: {
        chat: (args) => this.chatWithOverflowRetry(execution, args),
      },
      tools: {
        listToolSchemas: () =>
          this.pluginHost.listTools().map((tool) => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        isConcurrencySafe: (e) => this.isConcurrencySafe(e),
        runToolCall: (e, s) => this.runToolCall(e, execution, s),
      },
      events: {
        emit: (e, o) => this.publishEvent(e, o),
      },
      controls: {
        signal,
        limits: this.limits,
        termination: this.termination,
        hooks: this.hooks,
        guardrails: this.guardrails,
        prefixGuard: this.prefixGuard,
        limitChecker: this.limitChecker,
        getPausedMs: () => this.permissionPolicy.pausedMs,
        evaluateTermination: (stats) => evaluateTermination(stats, this.termination),
        evaluateUsageLimits: (stats) => evaluateUsageLimits(stats, this.limits),
        publishLimitWarnings: () => this.publishLimitWarnings(execution),
        publishContextPressureWarning: () => this.publishContextPressureWarning(execution),
        publishCompacted: (removed, reason) =>
          this.publishCompacted(
            execution.workingContext,
            execution.runId,
            execution.sessionId,
            removed,
            reason,
          ),
        ensurePrefixReason: (r) => {
          this.pendingPrefixReason ??= r;
        },
        takePrefixReason: () => {
          const r = this.pendingPrefixReason;
          this.pendingPrefixReason = undefined;
          return r;
        },
        getBaseSystemPrompt: () => this.runSystemPrompt ?? this.systemPrompt,
        markSystemPromptIgnored: () => {
          if (this.systemPromptIgnoredReported) return false;
          this.systemPromptIgnoredReported = true;
          return true;
        },
        markAdditionalContextDeprecated: () => {
          if (this.additionalContextDeprecatedReported) return false;
          this.additionalContextDeprecatedReported = true;
          return true;
        },
        hasSeenLegacyContext: (s) => this.legacyAdditionalContextSeen.has(s),
        markLegacyContextSeen: (s) => {
          this.legacyAdditionalContextSeen.add(s);
        },
        onSafePoint: () => this.writeRunRecord(execution, 'running'),
      },
    };
  }

  /**
   * 调用 provider，并处理两类重试：
   *
   * - **传输层 / 过载**（socket 断开、ECONNRESET、ETIMEDOUT、`fetch failed`、undici
   *   headers/body timeout、429 / 502 / 503 / 504）：指数退避 + 抖动后重发同一请求
   *   （`ProviderRetryPolicy`，默认 4 次、base 500ms、单次封顶 8s）。**只有本次请求
   *   一个增量都没流出过才重试**——已经流出正文 / 思考再重发，父级会看到两段重复文本。
   * - **context-overflow**（400）：强制压缩一次后重试一次（0.10 R2-17）。
   *
   * 取消优先：`AbortSignal` 中断（用户取消 / rotate / shutdown）立即抛出，不退避、
   * 不重试；退避期间不改 run 状态、不碰租约。
   *
   * 每次真实请求都递增 request 计数并发布 `llm.request`（重试请求看到的是压缩后的上下文）。
   * 重试用尽后原样抛出，不包装 provider 错误。
   *
   * 两处落盘形态：`llm.request` 的落盘副本只带元信息（`persistData`，正文留在发布
   * 副本里给 live / WS / trace）；每次请求结束都收口当前流式段落（`llm.stream.summary`）。
   */
  private async chatWithOverflowRetry(
    execution: Run,
    args: {
      messages: Message[];
      tools: NonNullable<ChatRequest['tools']>;
      sessionId: string;
      signal?: AbortSignal;
      rebuildMessages: () => Message[];
    },
  ): Promise<LLMResponse> {
    const { runId, stats } = execution;
    let messages = args.messages;
    let overflowRetried = false;
    /** 重试链（传输层 / overflow）里的第几次真实请求（1 起；写进落盘元信息） */
    let attempt = 1;
    /** 本请求已用掉的传输层重试次数（跨 overflow 压缩不重置：同一条消息不该再多一轮） */
    let transportRetries = 0;

    while (true) {
      // 0.14 P0：provider / 流式错误按 llm 阶段归类。
      execution.phase = 'llm';
      // 0.18：每次请求重置部分输出；中断时把已流出的文本写进终态 partial_content。
      execution.partialContent = '';
      // 调试元信息（0.10 R2-13）：只记数量/工具名，绝不输出 prompt 正文。
      // token 数不在这里重扫整段历史：`context.changed.token_count` 与
      // `llm.response.usage` 已是增量缓存的真值，debug 实参无条件求值不值。
      this.logger.debug('llm request', {
        run_id: runId,
        message_count: messages.length,
        tool_names: args.tools.map((tool) => tool.function.name),
      });

      // 上下文窗口（context window）的**运行时真值**：与 `context.pressure.max`、
      // 自动压缩阈值用的是同一个分母（`workingContext.maxTokens`）。实现不提供时
      // （缺省 `undefined`）就不写这个字段 —— 读侧退回配置兜底，不在这里编一个数。
      const rawContextMax = execution.workingContext.maxTokens;
      const contextMax =
        typeof rawContextMax === 'number' && Number.isFinite(rawContextMax) && rawContextMax > 0
          ? Math.floor(rawContextMax)
          : undefined;

      // 「模型这一轮看到的系统消息」（基底 system prompt + Self Card）紧贴着请求落一条
      // 独立事件：`composeRunSystemPrompt()` 已在 run 开始时拼好，这里有 `messages` /
      // `tools` 的最终条数，正是折叠态摘要要的那几个数。同 hash 只发一次（见
      // `publishSystemContext`），绝不把 prompt 塞进 `llm.request`。
      this.publishSystemContext(execution, {
        messageCount: messages.length,
        toolsCount: args.tools.length,
        estimatedTokens: execution.workingContext.tokenCount,
        ...(contextMax !== undefined ? { contextMax } : {}),
      });

      // 发布 LLM 请求事件（事件里剔除 reasoning_content，避免思维链泄漏到 TUI/观测）。
      //
      // 落盘副本（`persistData`）只留元信息：`messages` / `tools` 正文永远不落。
      // 发布出去的这份保持完整 —— trace 的全文策略与 WS 的 summarize 都不在此处改
      // （F2 另单）；写盘侧还另有 RunJournal 的兜底裁剪。
      //
      // `model` 在**发布副本**里也写一份（不只是 `persistData`）：trace 落的是
      // `summarizeLlmRequest` 的 `{...data}` 透传（去掉 messages 正文），发布副本
      // 不带 model 时观测侧（usage 插件）无从得知真实模型，只能退回用户配置的
      // 默认值。一个短字符串（~36 B），不违背「发布副本不带正文」的约束。
      this.publishEvent(
        {
          type: 'llm.request',
          run_id: runId,
          data: {
            run_id: runId,
            session_id: args.sessionId,
            model: this.model,
            messages: this.stripReasoning(messages),
            tools: args.tools,
          },
          ts: Date.now(),
        },
        {
          persistData: {
            run_id: runId,
            session_id: args.sessionId,
            content_omitted: true,
            model: this.model,
            message_count: messages.length,
            tools_count: args.tools.length,
            // 增量缓存的现成值（有真实锚点就返回锚点），不在这里重扫整段历史。
            estimated_tokens: execution.workingContext.tokenCount,
            // 上下文窗口上限随事件落盘（与 `estimated_tokens` 并列的一个整数）：
            // 历史会话因此自足 —— 读侧（`sessions.get.context_usage.max`）不必再
            // 回推「当时的配置值」，按 agent / 模型配不同窗口时也不会串。
            // 只加这一个整数：`messages` / `tools` 正文照旧不落盘。
            ...(contextMax !== undefined ? { context_max: contextMax } : {}),
            attempt,
            stream: true,
            ...(this.includeReasoning ? { include_reasoning: true } : {}),
            // temperature / max_tokens：core 今天不设（沿用 provider 默认），因此不写；
            // 字段已在 `LlmRequestPayload` 里预留，harness 接上时在这里补。
          },
        },
      );

      // 增加请求计数
      this.limitChecker.incrementRequest(stats);

      // 本次请求的起点：段落摘要的 ttft 以它为基准（只在本次请求的首个增量上带出，
      // 用完即清 —— 后续段不是「第一个 token」）。
      const requestStartedAt = Date.now();
      this.streamSegmentState(execution).pendingTtftBase = requestStartedAt;

      // 「本次请求是否已经流出过增量」：正文 / 思考 / 工具调用任一出现即置位。
      // 置位后不再自动重发——已流出的文本重来一遍，父级时间线上就是两段重复。
      let streamed = false;

      const request: ChatRequest = {
        messages,
        model: this.model,
        tools: args.tools.length > 0 ? args.tools : undefined,
        session_id: args.sessionId,
        // AbortSignal——Provider 透传给 fetch()，支持 Esc 中断（Hermes/Claude Code 模式）
        signal: args.signal,
        // 0.11.1：仅在显式开启时要求 reasoning 流式增量；默认请求形状不变
        ...(this.includeReasoning ? { include_reasoning: true } : {}),
        // 流式（ADR-007）：始终提供 stream + on_chunk。支持流式的 Provider 边收边经回调吐增量，
        // loop 在此发布 LlmStreamChunk 事件供 TUI 订阅渲染；不支持流式的 Provider 忽略字段、
        // 退化为整段返回（无 chunk 事件，无副作用）。chat() 仍返回完整 LLMResponse。
        stream: true,
        on_chunk: (chunk) => {
          if (streamsAssistantOutput(chunk)) streamed = true;
          if (chunk.type === 'text_delta' && typeof chunk.delta === 'string') {
            execution.partialContent = `${execution.partialContent ?? ''}${chunk.delta}`;
          }
          // 段骨架在发布点顺带聚合：`llm.stream.chunk` 本体不落盘，这里只累计计数。
          this.recordStreamChunk(execution, chunk);
          this.publishEvent({
            type: 'llm.stream.chunk',
            run_id: runId,
            data: { run_id: runId, chunk },
            ts: Date.now(),
          });
        },
      };

      this.logger.debug('llm call', {
        run_id: runId,
        message_count: messages.length,
      });

      try {
        const response = await this.provider.chat(request);
        // 0.52 C：真实用量到达的那一刻记下校正比（`prompt_tokens` 与同一请求的本地
        // 估算都在手边）。存的是「provider 口径 ÷ 本地口径」，与 `realTokens` 无关，
        // 所以重启后估算仍能被拉回真实量级。
        const promptTokens = response.usage?.prompt_tokens ?? 0;
        if (promptTokens > 0) {
          execution.workingContext.recordRealPromptTokens?.({
            promptTokens,
            model: this.model,
          });
        }
        // provider 未必发 `finish`；请求正常结束也要收口当前段。
        this.flushStreamSegment(execution, args.sessionId);
        return response;
      } catch (error) {
        // 中断 / 失败同样收口：已流出的骨架必须留在日志里（不含正文）。
        this.flushStreamSegment(execution, args.sessionId);

        // 取消优先：中断（用户 Esc / rotate / shutdown）立即抛出，不退避、不重试。
        if (args.signal?.aborted === true) throw error;

        const decision = classifyProviderRetry(error);
        if (decision.retryable && !streamed && transportRetries < this.retryPolicy.maxRetries) {
          transportRetries += 1;
          attempt += 1;
          const backoffMs = retryBackoffMs(
            transportRetries,
            this.retryPolicy,
            decision.retry_after_ms,
          );
          // 内部事件层（默认隐藏）：只记计数与分类，不带 prompt / 正文。
          this.publishEvent({
            type: 'llm.retry',
            run_id: runId,
            data: {
              run_id: runId,
              session_id: args.sessionId,
              attempt: transportRetries,
              backoff_ms: backoffMs,
              ...(decision.error_code !== undefined ? { error_code: decision.error_code } : {}),
              ...(decision.scope !== undefined ? { scope: decision.scope } : {}),
            },
            ts: Date.now(),
          });
          this.logger.warn('provider error; retrying after backoff', {
            run_id: runId,
            attempt: transportRetries,
            backoff_ms: backoffMs,
            scope: decision.scope,
            error: errorText(error),
          });
          // 退避期间：不释放租约、不改 run 状态；signal 中断立即抛出。
          await sleepWithAbort(backoffMs, args.signal);
          continue;
        }

        if (decision.retryable) {
          // 可重试但没重试：说清是哪条闸拦下的（已流出文本 / 次数用尽）。
          this.logger.warn('provider error; not retried', {
            run_id: runId,
            streamed,
            retries_used: transportRetries,
            max_retries: this.retryPolicy.maxRetries,
            error: errorText(error),
          });
        }

        if (overflowRetried || !isContextOverflowError(error)) throw error;
        overflowRetried = true;
        attempt += 1;
        const removed = await this.forceCompact(execution, 'overflow');
        messages = args.rebuildMessages();
        this.logger.warn('context overflow; compacted and retrying once', {
          run_id: runId,
          removed_messages: removed,
          error: errorText(error),
        });
      }
    }
  }

  /**
   * 取（必要时新建）本 run 的段落聚合状态。
   *
   * 状态挂在 `Run` 上而不是 EU 上：run 结束随 `Run` 释放，不需要清理，
   * 也不会在两次 run 之间串号。
   */
  private streamSegmentState(execution: Run): StreamSegmentState {
    execution.streamSegment ??= { nextSeq: 1, nextSegmentIndex: 0 };
    return execution.streamSegment;
  }

  /**
   * 流式增量 → 段落聚合（0.51）。
   *
   * 只在发布点累计计数：`text_delta` / `reasoning_delta` 归段，kind 切换即收口上一段；
   * `tool_call_delta` 不断段（与 `apps/web/src/state/events.ts` 的 buildGroup 同口径），
   * 但**占** run 内流式序号，所以段内跨度能把「有工具增量 / 有 finish」暴露出来；
   * `finish` 收口当前段。任何分支都不缓存正文。
   */
  private recordStreamChunk(execution: Run, chunk: StreamChunk): void {
    const state = this.streamSegmentState(execution);
    const seq = state.nextSeq;
    state.nextSeq += 1;

    const kind = chunkKindOf(chunk);
    if (kind === undefined) {
      // tool_call_delta / finish：不进段；finish 之后本次响应不再有增量，直接收口。
      if (chunk.type === 'finish') this.flushStreamSegment(execution);
      return;
    }

    const delta = chunk.delta ?? '';
    const now = Date.now();
    let open = state.open;
    if (open !== undefined && open.kind !== kind) {
      this.flushStreamSegment(execution);
      open = state.open;
    }
    if (open === undefined) {
      open = {
        kind,
        chunkCount: 0,
        bytes: 0,
        firstSeq: seq,
        lastSeq: seq,
        startedAt: now,
        endedAt: now,
      };
      // ttft 只记在「本次请求的首个增量」上；基准由请求入口写入，用完即清。
      if (state.pendingTtftBase !== undefined) {
        open.ttftMs = Math.max(0, now - state.pendingTtftBase);
        state.pendingTtftBase = undefined;
      }
      state.open = open;
    }
    open.chunkCount += 1;
    open.bytes += Buffer.byteLength(delta, 'utf8');
    open.lastSeq = seq;
    open.endedAt = now;
  }

  /**
   * 收口当前流式段落：发一条**定长**的 `llm.stream.summary`（不含任何正文）。
   *
   * 每段只在结束时发一条 —— 这是「流式正文不落、结构落摘要」的唯一出口；
   * 没有打开中的段时是 no-op（非流式 provider 完全不产生该事件）。
   */
  private flushStreamSegment(execution: Run, sessionId?: string): void {
    const state = execution.streamSegment;
    const open = state?.open;
    if (state === undefined || open === undefined) return;
    state.open = undefined;

    const segmentIndex = state.nextSegmentIndex;
    state.nextSegmentIndex += 1;

    this.publishEvent({
      type: 'llm.stream.summary',
      run_id: execution.runId,
      data: {
        run_id: execution.runId,
        session_id: sessionId ?? execution.sessionId,
        segment_index: segmentIndex,
        kind: open.kind,
        chunk_count: open.chunkCount,
        bytes: open.bytes,
        first_seq: open.firstSeq,
        last_seq: open.lastSeq,
        started_at: open.startedAt,
        ended_at: open.endedAt,
        ...(open.ttftMs !== undefined ? { ttft_ms: open.ttftMs } : {}),
      },
      ts: open.endedAt,
    });
  }

  /**
   * 0.15 E1 / 0.34 C6：手动压缩上下文，并发布 `context.compacted`（reason=manual）。
   * 供 harness 的 `/compact` 一类入口调用；直接调 WorkingContext 不会产生事件。
   * `sessionId` 用于无 active Run 的瞬态路径（idle EU 尚未跑过 run 时 lastSessionId 为空）。
   * @returns `{ removed, remaining, messages }`：移除条数、压缩后条数、压缩后窗口
   */
  async compactContext(
    sessionId?: string,
  ): Promise<{ removed: number; remaining: number; messages: Message[] }> {
    const execution = this.activeRun;
    let removed: number;
    let remaining: number;
    let messages: Message[];
    if (execution !== undefined) {
      const context = execution.workingContext;
      removed = context.compactAsync ? await context.compactAsync() : context.compact();
      this.publishCompacted(context, execution.runId, execution.sessionId, removed, 'manual');
      remaining = context.messages.length;
      messages = context.messages;
      // C6：摘要事件必须落盘后才能返回；否则调用方 kill 后 resume 看不到压缩态。
      await this.activeJournal?.flush();
    } else {
      // 两次 Run 之间：从 contextFactory 建瞬态窗口；播种后压缩，
      // 以 run_id='manual' 写摘要，写完即弃。
      const target = sessionId ?? this.lastSessionId ?? 'default';
      const context = this.contextFactory({ sessionId: target });
      context.setSessionId(target);
      const history = await this.loadStoredHistory(target);
      this.seedTransientContext(context, history);
      removed = context.compactAsync ? await context.compactAsync() : context.compact();
      this.publishCompacted(context, 'manual', target, removed, 'manual');
      remaining = context.messages.length;
      messages = context.messages;
      const journal = this.transientJournal('manual', target);
      if (removed > 0 && history.sessionState !== null) {
        // 无 active Run 的压缩也要落 SessionState：下一次 run/resume 直接读缓存，
        // 不必依赖“看到压缩事件再全量重投影”。journal 先 flush 事件再写 derived。
        await journal.saveSessionState({
          ...history.sessionState,
          messages,
          updated_at: Date.now(),
        });
      } else {
        await journal.flush();
      }
    }
    // 手动压缩（可能发生在两次 run 之间）同样是一次显式前缀失效。
    if (removed > 0) this.pendingPrefixReason ??= 'compaction';
    return { removed, remaining, messages };
  }

  /** 强制压缩一次（overflow 重试用）；压缩失败不覆盖 provider 原始错误。 */
  private async forceCompact(
    execution?: Run,
    reason: ContextCompactedReason = 'overflow',
  ): Promise<number> {
    let workingContext: WorkingContext;
    let runId: string;
    let sessionId: string;
    if (execution !== undefined) {
      workingContext = execution.workingContext;
      runId = execution.runId;
      sessionId = execution.sessionId;
    } else {
      // 无 active Run：瞬态窗口，压缩结果只经 journal 落摘要。
      sessionId = this.lastSessionId ?? 'default';
      workingContext = this.contextFactory({ sessionId });
      workingContext.setSessionId(sessionId);
      const history = await this.loadStoredHistory(sessionId);
      this.seedTransientContext(workingContext, history);
      runId = 'manual';
    }
    try {
      const removed = workingContext.compactAsync
        ? await workingContext.compactAsync()
        : workingContext.compact();
      this.publishCompacted(workingContext, runId, sessionId, removed, reason);
      // overflow 重试会跳过下一次守卫检查；把原因留给后续请求消费。
      if (removed > 0) this.pendingPrefixReason ??= 'compaction';
      return removed;
    } catch {
      return 0;
    }
  }

  /** 瞬态窗口播种：只写消息，不发布重放事件（不是一次 Run）。 */
  private seedTransientContext(workingContext: WorkingContext, history: StoredHistory): void {
    workingContext.clear();
    const baseSystem = this.runSystemPrompt ?? this.systemPrompt;
    if (
      !history.messages.some(
        (message) => message.role === 'system' && message.compaction_summary !== true,
      ) &&
      baseSystem
    ) {
      workingContext.add({ role: 'system', content: baseSystem, timestamp: Date.now() });
    }
    for (const message of history.messages) {
      workingContext.add(message);
    }
  }

  /** 0.15 E1：removed>0 时发布 `context.compacted`；0.32 同时把摘要落事件日志 */
  private publishCompacted(
    workingContext: WorkingContext,
    runId: string,
    sessionId: string,
    removed: number,
    reason: ContextCompactedReason,
  ): void {
    if (removed <= 0) return;
    // C2：直发路径（loop 自动 / overflow / manual）发布后记录 id，
    // 使 `addContext` 的补发不会对同一次压缩重复发事件。
    const report = workingContext.lastCompaction;
    if (report !== undefined) this.lastReportedCompactionId.set(runId, report.id);
    const remaining = workingContext.messages.length;
    this.publishEvent({
      type: 'context.compacted',
      run_id: runId,
      data: {
        run_id: runId,
        session_id: sessionId,
        removed,
        remaining,
        reason,
        // C1：摘要降级可观测（旧事件形状不变，字段缺省即不写）。
        ...(report?.degraded !== undefined ? { degraded: report.degraded } : {}),
      },
      ts: Date.now(),
    });

    // 0.32：压缩摘要进事件日志（唯一真相源），session cache 只做加速。
    // `data.message` 就是 applyCompaction 写入的摘要；`kept` 是应用后保留的
    // 非 system 消息数，供投影按同一边界裁剪旧历史。摘要只能取自刚压缩的那个
    // 会话；会话在 await 期间被切换时不写错事件。
    if (workingContext.getSessionId() !== sessionId) return;
    const messages = workingContext.messages;
    let summary: Message | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate?.role === 'system' && candidate.compaction_summary === true) {
        summary = candidate;
        break;
      }
    }
    if (summary === undefined) return;
    const ts = summary.timestamp ?? Date.now();
    const clearedToolCallIds = report?.cleared_tool_call_ids ?? [];
    this.publishEvent({
      type: 'message.compaction',
      run_id: runId,
      data: {
        run_id: runId,
        session_id: sessionId,
        removed,
        remaining,
        kept: messages.filter((message) => message.role !== 'system').length,
        reason,
        message: { ...summary, timestamp: ts },
        // C1：本次被替换为占位的 tool_call_id（空数组省略）与摘要是否降级。
        ...(clearedToolCallIds.length > 0 ? { cleared_tool_call_ids: clearedToolCallIds } : {}),
        ...(report?.degraded !== undefined ? { degraded: report.degraded } : {}),
      },
      ts,
    });
  }

  /**
   * 90% 上下文压力：不压缩，只发一次事件 + 尾部消息，建议 `agent(rotate)`。
   * 自动压缩开启时超过压缩阈值静默让 autoCompactAsync 处理；**关闭时必须取消上界** ——
   * 此时没有压缩会把水位降回来，token 只会持续上穿阈值，上界会让提示永久静默。
   */
  private publishContextPressureWarning(execution: Run): void {
    const workingContext = execution.workingContext;
    const max = workingContext.maxTokens;
    if (max === undefined || max <= 0) return;
    const used = workingContext.tokenCount;
    const ratio = used / max;
    // 缺省（实现不暴露 autoCompact）按开启处理，与 0.27 行为一致。
    const autoCompact = workingContext.autoCompact !== false;
    // 压缩阈值：应用层经 config 注入，库实现不提供时用 core 兜底值。
    const threshold = workingContext.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    // 自动压缩开启时：低于预警线或已超过自动压缩阈值不提示。
    // 恰好等于阈值仍提示一次：压缩条件是严格大于，留出这一条边。
    if (ratio < CONTEXT_PRESSURE_WARN_RATIO) return;
    if (autoCompact && ratio > threshold) return;
    if (this.warnedLimitKeys.has('context_window')) return;
    this.warnedLimitKeys.add('context_window');

    const percent = Math.round(ratio * 100);
    const hint =
      this.contextPressureHint ??
      `Use agent(rotate) with a startup_prompt to move to a fresh body; automatic compaction runs above ${Math.round(threshold * 100)}%.`;
    this.publishEvent({
      type: 'context.pressure',
      run_id: execution.runId,
      data: {
        run_id: execution.runId,
        session_id: execution.sessionId,
        used,
        max,
        ratio,
        threshold: CONTEXT_PRESSURE_WARN_RATIO,
        hint,
      },
      ts: Date.now(),
    });
    // 与 limits 预警共用尾部消息格式；不改 system 前缀。
    this.addContext(
      {
        role: 'user',
        name: 'vessel:limit',
        content: `[runtime] context_window: ${used}/${max} (${percent}%) — ${hint}`,
        timestamp: Date.now(),
      },
      execution.runId,
    );
  }

  /** 0.15 E2：每 run 每 key 只发一次预警（数据形状为冻结契约） */
  private publishLimitWarnings(execution: Run): void {
    const warnings = evaluateLimitWarnings(
      execution.stats,
      this.limits,
      this.termination,
      LIMIT_WARNING_THRESHOLD,
    );
    for (const warning of warnings) {
      if (this.warnedLimitKeys.has(warning.key)) continue;
      this.warnedLimitKeys.add(warning.key);
      this.publishEvent({
        type: 'agent.limit.warning',
        run_id: execution.runId,
        data: {
          scope: warning.scope,
          key: warning.key,
          current: warning.current,
          max: warning.max,
          source: warning.source,
          threshold: warning.threshold,
          hint: warning.hint,
        },
        ts: Date.now(),
      });
      // 预警同时作为一条持久化尾部消息进入模型上下文（不改 system）。
      // publishLimitWarnings 在每轮请求组装前调用，因此本轮请求即可看到。
      const percent = warning.max > 0 ? Math.round((warning.current / warning.max) * 100) : 0;
      this.addContext(
        {
          role: 'user',
          name: 'vessel:limit',
          content: `[runtime] ${warning.key}: ${warning.current}/${warning.max} (${percent}%) — ${warning.hint}`,
          timestamp: Date.now(),
        },
        execution.runId,
      );
    }
  }

  /** 0.15 E9：本次 run 的 systemPrompt（含 Self Card）；缺省与 this.systemPrompt 相同 */
  private composeRunSystemPrompt(): string | undefined {
    if (!this.selfCard) return this.systemPrompt;
    const { system, selfCard } = this.systemParts();
    return system.length > 0 ? `${system}\n\n${selfCard}` : selfCard;
  }

  /**
   * 系统消息的两段原文：基底 system prompt + Self Card。
   *
   * `composeRunSystemPrompt()` 与 `prompt.system_context` 事件共用这一份口径，所以
   * 「模型看到的那段 system」与「事件里落的那两段」永远同源：模型看到的就是
   * `system` + `'\n\n'` + `selfCard`（有哪段拼哪段）。
   */
  private systemParts(): { system: string; selfCard: string } {
    return {
      system: this.systemPrompt ?? '',
      selfCard: this.selfCard ? formatSelfCard(this.selfCard) : '',
    };
  }

  /**
   * 把「模型这一轮看到的系统消息」落成一条事件（`prompt.system_context`）。
   *
   * **宗旨**：让模型可以看到的内容，用户也一样应该看到，只不过用各种方法去让其简化
   * （UX、可收缩）。基底 system prompt + Self Card 以前只在 `composeRunSystemPrompt()`
   * 里拼进请求 —— 不落消息、不发事件，用户永远看不到模型被喂了什么系统消息。这条事件
   * 补的就是这个洞。
   *
   * 口径：
   * - **同 hash 只发一次**，在 `composeRunSystemPrompt()` 之后、`llm.request` 之前发；
   *   hash 覆盖两段原文（工具 / 权限 / limits / 预算 / 模型任一变化都会换 hash）。
   *   去重键带 `sessionId`：同一个 EU 可能给多个会话干活（session_switch），换会话就是
   *   另一份落盘（不换会话的连续多轮才去重）。
   * - **独立事件**，绝不塞进 `llm.request`（那里的落盘副本只留元信息，塞回去就是复活
   *   55MB/run 的老问题）。每会话通常只发 1–3 次，单条约 1–2 KB。
   * - 没有任何系统消息（无基底 system 也无 Self Card）时不发：没有内容可给用户看。
   */
  private publishSystemContext(execution: Run, request: SystemContextRequestFacts): void {
    const { system, selfCard } = this.systemParts();
    if (system.length === 0 && selfCard.length === 0) return;
    const hash = systemContextHash(system, selfCard);
    const last = this.lastSystemContext;
    // 去重键是**整份环境快照**（两段原文 + 模型 + 工具个数），不只是 hash：`changed` 要报的是
    // 「模型 / 工具变了」，而它们不在 hash 里 —— 只按 hash 去重的话这两类变化永远不会被发布，
    // 增量视图就成了只看得到系统提示词变化的半张卡。
    if (
      last !== undefined &&
      last.sessionId === execution.sessionId &&
      last.hash === hash &&
      last.model === this.model &&
      last.toolsCount === request.toolsCount
    ) {
      return;
    }
    // 0.52：同进程没有上一份快照（= 刚重启 / 新 body）时，用**持久指纹**判断要不要发。
    // 只有 hash / model / tools 全同才跳过；跨进程拿不到原文差，所以有变化时发全量卡。
    const restoredFingerprint = this.promptContextFingerprint;
    const nextFingerprint: PromptContextFingerprint = {
      hash,
      model: this.model,
      tools_count: request.toolsCount,
      at: Date.now(),
    };
    if (
      !shouldPublishSystemContext({
        live: last !== undefined && last.sessionId === execution.sessionId,
        restored: this.promptContextFingerprint,
        next: nextFingerprint,
      })
    ) {
      return;
    }
    const snapshot: SystemContextSnapshot = {
      sessionId: execution.sessionId,
      hash,
      system,
      selfCard,
      model: this.model,
      toolsCount: request.toolsCount,
    };
    // 先算 diff 再推进快照：`changed` 说的是「与上一份**发布过**的差在哪」，不是与上一轮请求。
    const livePrevious =
      last !== undefined && last.sessionId === execution.sessionId ? last : undefined;
    const changed =
      livePrevious !== undefined
        ? systemContextChanges(livePrevious, snapshot)
        : systemContextChangesFromFingerprint(restoredFingerprint, nextFingerprint);
    const previousHash = livePrevious !== undefined ? livePrevious.hash : restoredFingerprint?.hash;
    this.lastSystemContext = snapshot;
    this.promptContextFingerprint = nextFingerprint;
    const at = nextFingerprint.at;
    this.publishEvent({
      type: 'prompt.system_context',
      run_id: execution.runId,
      data: {
        run_id: execution.runId,
        session_id: execution.sessionId,
        hash,
        ...(system.length > 0 ? { system_prompt: system } : {}),
        ...(selfCard.length > 0 ? { self_card: selfCard } : {}),
        model: this.model,
        message_count: request.messageCount,
        tools_count: request.toolsCount,
        ...(request.estimatedTokens !== undefined
          ? { estimated_tokens: request.estimatedTokens }
          : {}),
        ...(request.contextMax !== undefined ? { context_max: request.contextMax } : {}),
        // additive（0.52）：增量视图只列变了的项；首次 / 换会话没有可比对象 ⇒ 两个字段都不写，
        // 客户端按「首次 = 渲全量卡」处理（payload 本身仍是全量，不动前缀、不动请求体）。
        ...(changed.length > 0 ? { changed } : {}),
        ...(previousHash !== undefined ? { previous_hash: previousHash } : {}),
        at,
      },
      ts: at,
    });
  }

  /**
   * 释放资源（0.9）：按逆安装顺序 best-effort 调用插件 dispose（异常只发
   * `plugin.dispose.failed`，不外抛），最后关闭 session。重复调用幂等。
   */
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeRuntime();
    return this.disposePromise;
  }

  /**
   * 热应用权限规则（配置变更后调用）。下一轮工具调用按新规则判定，不需要重建 runtime。
   * 已记住的 "always" 不受影响；`autoApprove` / `neverAutoApprove` 整体替换。
   */
  applyPermissionRules(
    rules: Pick<RuntimePermissionConfig, 'default' | 'autoApprove' | 'neverAutoApprove'>,
  ): void {
    this.permissionPolicy.replaceRules(rules);
  }

  /**
   * 热应用上下文策略（身份转换后调用）。下一轮请求生效，不需要重建 runtime。
   *
   * 只替换压力提示的尾句：缺省（未给 `contextPressureHint`）回落到 `agent(rotate)`
   * 原文案。自动压缩开关由调用方自己的 `WorkingContext` 决定，core 不感知身份。
   */
  applyContextPolicy(policy: Pick<ExecutionUnitOptions, 'contextPressureHint'>): void {
    this.contextPressureHint = policy.contextPressureHint;
  }

  private async disposeRuntime(): Promise<void> {
    this.clearLeaseRenewTimer();
    this.eventLogUnsubscribe?.();
    // 逆安装顺序 best-effort；异常只发 `plugin.dispose.failed`（在 handle 内）。
    await this.plugins?.dispose();
    await this.flushJournalWrites();
    for (const journal of this.transientJournals.values()) {
      await journal.close();
    }
    this.transientJournals.clear();
    // 逆序释放两级租约：SessionLease → BindingLease。
    await this.releaseLeases();
    // Stage 4：SessionStore 归装配层 / bundle 所有；per-session EU 共享同一实例，
    // EU.dispose 不得关闭它，否则会截断同 tenant 其它 session 的读写。
  }

  /**
   * 记录一次工具失败：OnError hook → tool.call.failed 事件 → 返回错误文本（C-01）。
   * 错误文本由调用方按原顺序折回上下文；工具失败不终止 run，模型可自行纠错。
   */
  private async recordToolFailure(
    execution: Run,
    opts: {
      toolCallId: string;
      toolName: string;
      startTime: number;
      errorMessage: string;
      /** 原始错误；缺省时用 errorMessage 构造，仅按文本分类 */
      error?: unknown;
      /** 本次调用实际使用的参数（additive，便于日志还原工具卡） */
      arguments?: unknown;
      details?: Record<string, unknown>;
    },
  ): Promise<string> {
    // OnError hook 已由 HookRunner 隔离；这里再兜底，工具失败不得升级为 run 失败（C2）。
    try {
      await this.hooks.run(HookType.OnError, {
        run_id: execution.runId,
        session_id: execution.sessionId,
        error: opts.errorMessage,
        phase: 'tool_execution',
        tool_name: opts.toolName,
      });
    } catch (hookError) {
      this.publishEvent({
        type: 'hook.error',
        run_id: execution.runId,
        data: {
          run_id: execution.runId,
          session_id: execution.sessionId,
          hook_type: HookType.OnError,
          error: errorText(hookError),
        },
        ts: Date.now(),
      });
    }
    // 0.14 P0：保留原 error 文本，追加结构化 envelope（tool 阶段）。
    const envelope = toErrorEnvelope(opts.error ?? opts.errorMessage, {
      phase: 'tool',
      category: 'tool',
      details: { tool_name: opts.toolName, ...opts.details },
    });
    this.publishEvent({
      type: 'tool.call.failed',
      run_id: execution.runId,
      data: {
        run_id: execution.runId,
        session_id: execution.sessionId,
        tool_call_id: opts.toolCallId,
        tool_name: opts.toolName,
        ...(opts.arguments !== undefined ? { arguments: opts.arguments } : {}),
        error: opts.errorMessage,
        duration_ms: Date.now() - opts.startTime,
        ...envelope,
        error_envelope: envelope,
      },
      ts: Date.now(),
    });
    return `Error: ${opts.errorMessage}`;
  }

  /**
   * 连续只读工具可并发执行（0.6.1 P1）：仅当插件显式标记 `concurrencySafe`
   * 且该调用没有预处理失败时成立。
   */
  private isConcurrencySafe(entry: PreparedToolCall): boolean {
    if (entry.failureMessage !== undefined) return false;
    return this.pluginHost.getTool(entry.toolName)?.concurrencySafe === true;
  }

  /**
   * 执行单个工具调用（不含 BeforeTool / AfterTool，钩子由批次循环串行编排）。
   * 返回结果文本与成功标记；失败已通过 OnError hook 与 tool.call.failed 记录。
   */
  private async runToolCall(
    entry: PreparedToolCall,
    execution: Run,
    signal?: AbortSignal,
  ): Promise<ToolExecutionOutcome> {
    const { toolCall, toolName } = entry;
    const { runId, sessionId } = execution;

    if (entry.failureMessage !== undefined) {
      return {
        toolCall,
        input: entry.args,
        ok: false,
        content: await this.recordToolFailure(execution, {
          toolCallId: toolCall.id,
          toolName,
          startTime: entry.startedAt,
          errorMessage: entry.failureMessage,
          error: entry.failureMessage,
          arguments: entry.args,
        }),
      };
    }

    try {
      // 统一执行管道（0.8.2 Wave 2B1）：permission + handler(timeout/signal) + ToolResult guardrail。
      // BeforeTool / ToolCall guardrail / AfterTool 仍由外层批次与写回逻辑编排，故在此关闭。
      const result = await this.toolPipeline.execute({
        runId,
        sessionId,
        toolCall,
        args: entry.args,
        messages: execution.workingContext.messages,
        // 0.51：成员 cwd 随每次调用下发 —— 工具是 tenant 级共享对象（install 只做一次），
        // 唯一能区分「哪个成员在哪跑」的通道就是 ctx。
        ...(this.toolCwd !== undefined ? { cwd: this.toolCwd } : {}),
        // F10：把当前 run 的 signal 交给工具，便于 handler 响应取消
        ...(signal ? { signal } : {}),
        stages: {
          beforeToolHook: false,
          toolCallGuardrail: false,
          afterToolHook: false,
        },
      });

      if (!result.ok) {
        return {
          toolCall,
          input: entry.args,
          ok: false,
          content: await this.recordToolFailure(execution, {
            toolCallId: toolCall.id,
            toolName,
            startTime: entry.startedAt,
            errorMessage: result.error ?? result.content,
            error: result.error ?? result.content,
            arguments: result.input,
          }),
        };
      }

      // 发布工具调用完成事件
      this.publishEvent({
        type: 'tool.call.completed',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: sessionId,
          tool_call_id: toolCall.id,
          tool_name: toolName,
          arguments: entry.args,
          result: result.content,
          duration_ms: Date.now() - entry.startedAt,
        },
        ts: Date.now(),
      });

      return { toolCall, input: result.input, ok: true, content: result.content };
    } catch (error) {
      // 权限超时是致命错误（DECISION-022 §2.2）：终止 run，不折回工具错误让模型重试。
      if (error instanceof PermissionTimeoutError) throw error;
      // 0.13（DECISION-024 §2.3）：权限等待被取消同样终止 run，不记成工具失败。
      if (error instanceof PermissionAbortedError) throw error;
      return {
        toolCall,
        input: entry.args,
        ok: false,
        content: await this.recordToolFailure(execution, {
          toolCallId: toolCall.id,
          toolName,
          startTime: entry.startedAt,
          errorMessage: errorText(error),
          error,
          arguments: entry.args,
        }),
      };
    }
  }

  /**
   * 消费 BeforeLlm 的 `ctx.messages`（0.16 E5）：逐条写入上下文一次。
   * 已注入的消息按稳定键（`name` / `timestamp`）去重；两者都缺失时按对象引用去重。
   */
  private appendInjectedMessages(
    execution: Run,
    runId: string,
    messages: readonly Message[] | undefined,
  ): void {
    if (!messages || messages.length === 0) return;
    for (const message of messages) {
      const key = injectedMessageKey(message);
      if (key !== undefined) {
        if (this.injectedMessageKeys.has(key)) continue;
        this.injectedMessageKeys.add(key);
      } else {
        if (this.injectedMessageRefs.has(message)) continue;
        this.injectedMessageRefs.add(message);
      }
      this.publishEvent({
        type: 'message.injected',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: execution.workingContext.getSessionId(),
          message,
        },
        ts: Date.now(),
      });
      this.addContext(message, runId);
    }
  }

  /**
   * 组装本次请求的消息数组（ADR-018 / C-03）。
   * system 覆盖只来自会话级基底（含 Self Card），不接受每轮 hook 拼接。
   * 1) 先归一化成 Provider 可接受的序列（丢掉孤儿 tool 消息、降级不完整的 tool_calls 轮次）；
   * 2) 再把超出保留预算的旧工具结果换成占位文本（**只在这一层**：见下）；
   * 3) 最后处理 system：上下文缺 system 时补回基底；有 Self Card 时覆盖持久化的旧 system。
   * 注入只影响本次请求，不改动 WorkingContext 持久化的消息。
   *
   * 为什么占位替换放在这里而不是压缩里（0.52，用户裁定）：不变量是「落盘的 message 只能
   * pop 或 append」。以前 `clearOldToolResults` 在压缩时就地改正文，于是**已经落盘、压缩后
   * 还活着的旧工具结果**被换成了占位 —— 用户回看历史看到的不是当时那份，`sessions.get`
   * 读回来的也不是。搬到请求构建层之后：发出去的请求照旧省 token，落盘与读回的原文一个字
   * 不改。占位改变了请求消息序列 ⇒ 记一次显式的 `context_trim`，前缀守卫照旧有据可依。
   */
  private buildRequestMessages(
    systemOverrideInput: unknown,
    workingContext: WorkingContext,
  ): Message[] {
    const normalized = this.normalizeMessages(workingContext.messages);
    const prepared = withClearedToolResults(normalized, workingContext.maxTokens ?? 1_000_000);
    if (prepared.some((message, index) => message !== normalized[index])) {
      // 占位替换是真实的（已声明）前缀变化：不标 reason 的话守卫会当成「莫名重写」。
      this.pendingPrefixReason ??= 'context_trim';
    }
    // 读侧脱敏（0.52 pii-guard）：**只在这里（请求构造层）打码**，落盘原文一个字不改。
    // 前缀快照因此仍然稳定：脱敏是确定性的（同一份原文 → 同一份掩码），且幂等
    // （打过码的文本不再命中规则），连续两次请求的掩码序列一致。
    const messages = withReadSideMask(prepared, this.pluginHost.getReadSideMaskers?.() ?? []);
    const systemOverride =
      typeof systemOverrideInput === 'string' && systemOverrideInput
        ? systemOverrideInput
        : undefined;
    // 压缩摘要也是 role=system：它不是基底 system，缺省补回与 hook 改写都不能替换它。
    const isBaseSystem = (m: Message): boolean => m.role === 'system' && !m.compaction_summary;
    const hasSystem = messages.some(isBaseSystem);

    // 上下文缺 system（trim / 恢复 / 失败会话）时，补回基底的或 hook 改写后的 system
    if (!hasSystem) {
      return systemOverride ? [{ role: 'system', content: systemOverride }, ...messages] : messages;
    }
    // hook 未改写（或改写为空）且无 Self Card 时保持持久化 system 原样；
    // Self Card 必须覆盖持久化的旧 system，且只出现一次。
    const basePrompt = this.runSystemPrompt ?? this.systemPrompt;
    if (!systemOverride || (systemOverride === basePrompt && !this.selfCard)) {
      return messages;
    }
    return messages.map((m) => (isBaseSystem(m) ? { ...m, content: systemOverride } : m));
  }

  /**
   * 把持久化上下文整理成 Provider 可接受的序列（C-03）：
   * - 丢弃没有对应 assistant(tool_calls) 的 role:tool 消息（trim / compact 可能切断配对）；
   * - assistant(tool_calls) 缺少某些 tool 结果时，整轮降级为普通 assistant 文本
   *   （空文本则丢弃），同时丢弃该轮已出现的部分 tool 结果；
   * - 其余消息保持原顺序与对象引用。
   */
  private normalizeMessages(messages: Message[]): Message[] {
    const normalized: Message[] = [];
    let pending: {
      assistant: Message;
      ids: Set<string>;
      toolMessages: Message[];
    } | null = null;

    const flushPending = (): void => {
      if (!pending) return;
      const { assistant, ids, toolMessages } = pending;
      pending = null;
      if (ids.size === 0) {
        normalized.push(assistant, ...toolMessages);
        return;
      }
      // 有 tool_call 没拿到结果：不发送非法序列；保留 assistant 文本与 reasoning（若有）
      if (assistant.content || assistant.reasoning_content) {
        normalized.push({
          role: 'assistant',
          content: assistant.content,
          ...(assistant.reasoning_content
            ? { reasoning_content: assistant.reasoning_content }
            : {}),
        });
      }
    };

    for (const msg of messages) {
      if (msg.role === 'tool') {
        const id = msg.tool_call_id ?? '';
        if (pending?.ids.has(id)) {
          pending.ids.delete(id);
          pending.toolMessages.push(msg);
        }
        // 孤儿 tool 消息直接丢弃
        continue;
      }

      flushPending();

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        pending = {
          assistant: msg,
          ids: new Set(msg.tool_calls.map((tc) => tc.id)),
          toolMessages: [],
        };
      } else {
        normalized.push(msg);
      }
    }

    flushPending();
    return normalized;
  }

  /**
   * C2：`add()` 内部可能同步压缩（无 summarizer / 条数上限），那条路径不经过
   * loop 的发布点。与已发布的 `lastCompaction.id` 比对，变化时补发一次压缩事件。
   */
  private publishUntrackedCompaction(execution: Run): void {
    const report = execution.workingContext.lastCompaction;
    if (report === undefined) return;
    if (this.lastReportedCompactionId.get(execution.runId) === report.id) return;
    if (report.removed <= 0) {
      // 未移除任何消息：不发布（publishCompacted 同样跳过），但要记下 id 防止反复比对。
      this.lastReportedCompactionId.set(execution.runId, report.id);
      return;
    }
    this.publishCompacted(
      execution.workingContext,
      execution.runId,
      execution.sessionId,
      report.removed,
      'auto',
    );
  }

  /**
   * 加入上下文并发布 context.changed 事件（ADR-031：同步写保证关键路径可靠 + 事件观测可回放）
   */
  /**
   * 加入上下文并发布 `context.changed` 事件（ADR-031：同步写保证关键路径可靠 + 事件观测可回放）
   *
   * `options.stampIdentity === false`：**这一条不是本轮新写的消息**（典型是 run 开始时把
   * 历史重灌进窗口）。这种消息没有 `run_id` ≠ 它属于这一轮；给它盖章会把整个历史的归属
   * 抹成当前 run —— 0.51 首版就是这么错的：重启后第一次运行把 538 条老消息全盖成同一个
   * run id，段序跟着连成 0…69，而 Web 侧段序是「本 run 内第几段」，两侧永远对不上，
   * 认领一次都没命中（重复渲染照旧）。所以重灌只发事件、不盖章；身份只属于**真正写进
   * 这一轮**的消息。
   */
  private addContext(msg: Message, runId: string, options?: { stampIdentity?: boolean }): void {
    // 0.6.1 P2：逐条消息时间戳（已有值不覆盖，恢复的历史保持原时间）
    const stamped: Message = msg.timestamp === undefined ? { ...msg, timestamp: Date.now() } : msg;
    const execution = this.activeRun;
    if (execution === undefined) {
      // PLAN §4.3：无 active Run（只可能是 notice 类调用）写 SessionState 快照。
      void this.appendNoticeToSnapshot(stamped).catch((error: unknown) => {
        this.logger.warn('session context snapshot append failed', {
          session_id: this.lastSessionId,
          error: errorText(error),
        });
      });
      return;
    }
    // 消息身份（additive `run_id`）：这里是仓里**唯一**同时看见「消息」与「runId」的写入点。
    // 不在这里盖章，落盘后的消息就永远没有归属；而段序（`run_segment`）不在这里数
    // —— 计数器必须只有一份，见 `assignMessageIdentities`（落盘漏斗统一补）。
    const identified = options?.stampIdentity === false ? stamped : withRunIdentity(stamped, runId);
    const workingContext = execution.workingContext;
    workingContext.add(identified);
    this.publishUntrackedCompaction(execution);
    this.publishEvent({
      type: 'context.changed',
      run_id: runId,
      data: {
        run_id: runId,
        session_id: execution.sessionId,
        // 持久化保留 reasoning_content；事件里剔除，避免思维链泄漏到 TUI/观测
        message: this.stripReasoningFromMessage(identified),
        message_count: workingContext.messages.length,
        token_count: workingContext.tokenCount,
      },
      ts: Date.now(),
    });
  }

  /** 事件流/观测载荷里不暴露思维链（reasoning_content 只用于 Provider 回传与持久化） */
  private stripReasoningFromMessage(msg: Message): Message {
    if (msg.reasoning_content === undefined) return msg;
    const copy = { ...msg };
    delete copy.reasoning_content;
    return copy;
  }

  private stripReasoning(messages: Message[]): Message[] {
    return messages.map((msg) => this.stripReasoningFromMessage(msg));
  }

  /**
   * 原地更新执行中 Run 的 RunRecord，落盘并发布开放事件 `run.checkpoint`。
   * 未配置 store 时不落盘、不发事件，但仍更新内存记录供 SessionState 镜像。
   * 写入失败默认让 run 失败（durable 已开启就不能静默降级）；
   * `bestEffort` 用于失败路径上的最终写入，避免覆盖原始错误。
   */
  private async writeRunRecord(
    execution: Run,
    status: RunRecord['status'],
    error?: string,
    bestEffort = false,
    errorEnvelope?: ErrorEnvelope,
  ): Promise<void> {
    const { runId, sessionId, createdAt, stats, branch } = execution;
    const record = execution.record;
    record.run_id = runId;
    record.session_id = sessionId;
    record.status = status;
    if (errorEnvelope !== undefined) record.error_envelope = errorEnvelope;
    else delete record.error_envelope;
    record.usage = this.usageFromStats(stats);
    record.iteration = stats.requestCount;
    record.created_at = createdAt || Date.now();
    record.updated_at = Date.now();
    record.metadata = {
      tool_calls_count: stats.toolCallsCount,
      ...(branch !== undefined ? { branch } : {}),
      // 0.18：RunRecord 不再带 messages；durable 列表的 preview 从这里取。
      preview: deriveSessionMeta(execution.workingContext.messages).preview,
    };
    record.agent_id = this.boundAgentId ?? record.agent_id;
    record.branch = branch;
    if (error !== undefined) record.error = error;
    else delete record.error;

    // Stage 4：写者唯一——RunRecord / fencing 校验 / run.checkpoint 都在 journal。
    const journal = this.activeJournal ?? this.transientJournal('manual', sessionId);
    if (this.eventLog) await this.flushJournalWrites();

    // 0.14 P0：RunRecord 写失败按 checkpoint 阶段归类；成功后恢复原阶段。
    const previousPhase = execution.phase;
    execution.phase = 'checkpoint';
    try {
      await journal.saveCheckpoint(record, { bestEffort });
    } catch (error) {
      // stale_fence 在旧实现里发生在进入 checkpoint 阶段之前，保持原阶段；
      // 其它保存失败留在 checkpoint 阶段供 envelope 归类。
      if (error instanceof LeaseExpiredError) execution.phase = previousPhase;
      throw error;
    }
    execution.phase = previousPhase;
  }

  /**
   * 0.52 C：复原「上下文卡」跨进程去重指纹。
   *
   * executeRun（run 入口）与 resumeRun（重启后接管被中断 run 的入口）必须都调用：
   * 漏了 resumeRun 就会在恢复时再发一张全量「上下文」卡（只有 message_count /
   * tokens 变）。stored 为 null/undefined（新会话、store 读不到）时写成 undefined，
   * 语义是「没有可比指纹 ⇒ 发全量卡」。
   */
  private restorePromptContextFingerprint(stored: SessionState | null | undefined): void {
    this.promptContextFingerprint = stored?.prompt_context;
  }

  /**
   * 0.18：恢复历史（run 启动 / resume 共用）。优先级：
   * 1) SessionState 缓存（含压缩摘要等事件不可重建的消息）+ 事件日志中 `seq > derived_upto_seq` 的增量；
   * 2) 事件日志完整投影（旧缓存无 derived 时做重叠去重）；
   * 3) legacy 回退：RunRecord.legacy_messages（旧 checkpoint messages）→ SessionState.messages。
   *
   * run() 也必须走这里：否则崩溃后新 run 只读缓存，saveSessionState 会把未重放的
   * 尾段事件错误标记为已覆盖。
   */
  private async loadStoredHistory(sessionId: string, record?: RunRecord): Promise<StoredHistory> {
    let sessionState: SessionState | null = null;
    if (this.session) {
      sessionState = await this.session.load(sessionId);
    }

    const cached = sessionState?.messages?.length ? sessionState.messages : undefined;
    const derived = cached !== undefined ? sessionState?.derived_upto_seq : undefined;
    // 有缓存且知道派生态 → 只读增量；否则必须全量投影（旧 sqlite 行没有该列）。
    const needFullProjection = cached === undefined || typeof derived !== 'number';

    let events: Awaited<ReturnType<SessionEventLogPort['read']>> = [];
    let fullProjectionForReplacement = false;
    // 日志最后的 seq：既用于一致性告警，也用于把下面「补读 llm.response」
    // 限制在尾部窗口内。
    let lastSeq: number | undefined;
    if (this.eventLog) {
      try {
        await this.eventLog.flush(sessionId);
        events = await this.eventLog.read(
          sessionId,
          needFullProjection ? {} : { sinceSeq: derived },
        );
        // 压缩 / 撤回是「替换」不是「追加」：缓存 + 增量无法表达“删掉旧历史”，
        // 只要尾部出现这两类事件就回退到全量投影（事件本身很少）。
        if (
          events.some(
            (event) => event.type === 'message.compaction' || event.type === 'session.rewound',
          )
        ) {
          fullProjectionForReplacement = true;
          if (!needFullProjection) events = await this.eventLog.read(sessionId);
        }
        // 一致性校验（P2）：RunRecord 游标 / SessionState 派生游标不得超前于日志。
        lastSeq = await this.eventLog.lastSeq?.(sessionId);
        const recordCursor = record?.event_cursor;
        if (
          typeof recordCursor === 'number' &&
          recordCursor > 0 &&
          (lastSeq === undefined || lastSeq < recordCursor)
        ) {
          this.logger.warn('session event log is behind run record', {
            session_id: sessionId,
            event_cursor: recordCursor,
            last_seq: lastSeq,
          });
        }
        if (
          typeof derived === 'number' &&
          derived > 0 &&
          (lastSeq === undefined || lastSeq < derived)
        ) {
          this.logger.warn('session cache is ahead of event log', {
            session_id: sessionId,
            derived_upto_seq: derived,
            last_seq: lastSeq,
          });
        }
      } catch (error) {
        this.logger.warn('session event log read failed during resume', {
          session_id: sessionId,
          error: errorText(error),
        });
      }
    }

    // 上下文锚点只认最近一次请求的 per-request usage。增量里通常没有
    // `llm.response`（它在上一次 run 结束时已随派生游标被覆盖），
    // 此时补读日志；压缩 / 增量读已经不是全量时都需要。
    // 补读先只问尾部窗口：`llm.response` 每个请求一条、必然靠近 EOF（真实会话里
    // 最后一条距文件尾只有几 KB），没必要为一个数字把整份 NDJSON 读进来。
    // 窗口里没有（如尾部堆了大段工具结果）则回退全量读，行为与之前等价。
    let lastRequestTokens = lastRequestTokensFromEvents(events);
    if (lastRequestTokens === undefined && this.eventLog && !needFullProjection) {
      try {
        if (typeof lastSeq === 'number' && lastSeq > 0) {
          lastRequestTokens = lastRequestTokensFromEvents(
            await this.eventLog.read(sessionId, {
              sinceSeq: Math.max(0, lastSeq - LAST_REQUEST_PROBE_EVENTS),
            }),
          );
        }
        if (lastRequestTokens === undefined) {
          lastRequestTokens = lastRequestTokensFromEvents(await this.eventLog.read(sessionId));
        }
      } catch (error) {
        this.logger.warn('session event log usage probe failed', {
          session_id: sessionId,
          error: errorText(error),
        });
      }
    }

    // 消息窗口实际覆盖到的游标：缓存游标与本次读到的最后事件 seq 的较大者。
    let cursor = typeof derived === 'number' ? derived : undefined;
    const lastReadSeq = events[events.length - 1]?.seq;
    if (typeof lastReadSeq === 'number') cursor = Math.max(cursor ?? lastReadSeq, lastReadSeq);
    const eventCount = events.length;
    const usageField = lastRequestTokens !== undefined ? { lastRequestTokens } : {};

    if (cached !== undefined && !fullProjectionForReplacement) {
      const history = structuredClone(cached);
      const projected = projectMessages(events);
      if (typeof derived === 'number') {
        // 增量：tail 严格在缓存之后，直接追加；崩溃在工具轮中间时 tool 结果在这里。
        if (projected.length > 0) history.push(...projected);
        return {
          messages: history,
          ...(cursor !== undefined ? { cursor } : {}),
          sessionState,
          eventCount,
          ...usageField,
        };
      }
      // 旧数据（无 derived）：全量投影可能与缓存重叠，按尾部重叠去重后追加。
      const merged = projected.length > 0 ? mergeHistoryProjection(history, projected) : history;
      return {
        messages: merged,
        ...(cursor !== undefined ? { cursor } : {}),
        sessionState,
        eventCount,
        ...usageField,
      };
    }

    if (events.length > 0) {
      const projected = projectMessages(events);
      if (projected.length > 0) {
        return {
          messages: projected,
          ...(cursor !== undefined ? { cursor } : {}),
          sessionState,
          eventCount,
          ...usageField,
        };
      }
    }

    // legacy 回退：旧 RunRecord.messages 优先，其次 SessionState 的历史缓存。
    if (record?.legacy_messages !== undefined && record.legacy_messages.length > 0) {
      return { messages: record.legacy_messages, sessionState, eventCount, ...usageField };
    }
    return { messages: sessionState?.messages ?? [], sessionState, eventCount, ...usageField };
  }

  /** 0.18：best-effort 索引更新；永不向外抛 */
  private async updateSessionIndexBestEffort(sessionState: SessionState): Promise<void> {
    try {
      await this.updateSessionIndex(sessionState);
    } catch (error) {
      this.logger.warn('session index update failed', {
        session_id: sessionState.session_id,
        error: errorText(error),
      });
    }
  }

  /** 0.18：best-effort 更新 `index.json` 元数据（失败只记日志，不影响 run） */
  private async updateSessionIndex(sessionState: SessionState): Promise<void> {
    if (!this.eventLog?.updateIndex) return;
    await this.flushJournalWrites();
    const cursor = await (
      this.activeJournal ?? this.transientJournal('manual', sessionState.session_id)
    ).currentSeq(sessionState.session_id);
    let stored: SessionState | null = null;
    if (this.session) {
      try {
        stored = await this.session.load(sessionState.session_id);
      } catch (error) {
        this.logger.warn('session load failed during index update', {
          session_id: sessionState.session_id,
          error: errorText(error),
        });
      }
    }
    const messages = sessionState.messages ?? [];
    const derived = deriveSessionMeta(messages);
    await this.eventLog.updateIndex(sessionState.session_id, {
      status: sessionState.status,
      title: sessionState.title ?? stored?.title ?? derived.title,
      preview: sessionState.preview ?? stored?.preview ?? derived.preview,
      started_at: sessionState.created_at,
      updated_at: sessionState.updated_at,
      ...(cursor !== undefined ? { event_count: cursor, derived_upto_seq: cursor } : {}),
    });
  }

  /** 读取会话壳（SessionState）；无 SessionStore 时 null。 */
  private async loadSessionState(sessionId: string): Promise<SessionState | null> {
    if (!this.session) return null;
    return this.session.load(sessionId);
  }

  /** 当前会话日志尾；用于 resumeSession 判断会话是否存在（无事件日志时 undefined）。 */
  private async resolveSessionCursor(sessionId: string): Promise<number | undefined> {
    if (!this.eventLog) return undefined;
    try {
      await this.eventLog.flush(sessionId);
      const inMemory = this.eventLog.lastPersistedSeq(sessionId);
      if (inMemory !== undefined) return inMemory;
      return await this.eventLog.lastSeq?.(sessionId);
    } catch {
      return undefined;
    }
  }

  /**
   * 构造本次 run 的 SessionState 壳：
   * 保留既有 title / preview / created_at / created_on_branch，
   * 覆盖 status / last_run_id / updated_at；messages 在保存时由窗口投影补齐。
   */
  private createSessionState(
    sessionId: string,
    runId: string,
    stored: SessionState | null,
    branch: string | undefined,
    now: number,
  ): SessionState {
    const createdOnBranch = stored?.created_on_branch ?? branch;
    return {
      session_id: sessionId,
      ...(stored?.title !== undefined ? { title: stored.title } : {}),
      ...(stored?.title_source !== undefined ? { title_source: stored.title_source } : {}),
      ...(stored?.preview !== undefined ? { preview: stored.preview } : {}),
      created_at: stored?.created_at ?? now,
      updated_at: now,
      ...(createdOnBranch !== undefined ? { created_on_branch: createdOnBranch } : {}),
      // 0.52 C：锚点原样继承；本轮若拿到过真实用量，saveSessionState 会用窗口里的
      // 新锚点覆盖它。换模型时留着旧锚点无害 —— 应用侧按 model 过滤。
      ...(stored?.context_anchor !== undefined ? { context_anchor: stored.context_anchor } : {}),
      // 0.52：环境快照指纹跨轮继承（发布新卡时由 saveSessionState 覆盖成最新的一份）。
      ...(stored?.prompt_context !== undefined ? { prompt_context: stored.prompt_context } : {}),
      status: 'running',
      last_run_id: runId,
    };
  }

  /**
   * 终态收尾 SessionState：status / updated_at / last_run_id / messages，
   * 并按 Q4=b 写入顶层 run 字段镜像（来自刚落盘的 RunRecord）。
   */
  private finalizeSessionState(
    execution: Run,
    sessionState: SessionState,
    status: SessionStatus,
  ): void {
    sessionState.status = status;
    sessionState.updated_at = Date.now();
    sessionState.last_run_id = execution.runId;
    sessionState.messages = execution.workingContext.messages;
    const mirror = legacyRunFromRecord(execution.record);
    if (mirror !== undefined) sessionState.legacy_run = mirror;
    else delete sessionState.legacy_run;
  }

  /** 保存 SessionState 投影（委托 journal；journal 负责发布会话保存事件） */
  private async saveSessionState(sessionState: SessionState): Promise<void> {
    if (!this.session) return;
    const execution = this.activeRun;
    if (execution !== undefined) {
      sessionState.messages = execution.workingContext.messages;
      // 0.52 C：真实锚点跟着这份投影一起落盘（journal 是 SessionState 唯一写口）。
      // 窗口没有锚点（旧会话 / 本次没拿到 usage）时保留继承来的旧值。
      const anchor = execution.workingContext.contextAnchor;
      if (anchor !== undefined) sessionState.context_anchor = anchor;
    }
    // 0.52：环境快照的发布指纹随 session 落盘（跨重启去重用）。
    // 只在本轮确实发布过卡时存在；没有就不动（保留继承来的旧值）。
    if (this.promptContextFingerprint !== undefined) {
      sessionState.prompt_context = this.promptContextFingerprint;
    }
    // C4：终态快照保存前重读存储侧 title，保留 run 进行中的人工 rename。
    // 读失败保留快照并继续（不抛），不影响终态落盘。
    if (sessionState.status !== 'running') {
      try {
        const stored = await this.session.load(sessionState.session_id);
        if (stored?.title !== undefined) {
          // Adopt the stored title together with its source marker: a manual
          // rename that landed mid-run must not be re-flagged as generated.
          sessionState.title = stored.title;
          if (stored.title_source !== undefined) sessionState.title_source = stored.title_source;
          else delete sessionState.title_source;
        }
      } catch (error) {
        this.logger.warn('session load failed before final save', {
          session_id: sessionState.session_id,
          error: errorText(error),
        });
      }
    }
    // 先等待所有 journal 的在途事件落盘，再记录缓存覆盖到的 seq；
    // resume 只重放之后的增量（journal 自身也会 flush 一次）。
    await this.flushJournalWrites();
    const journal = this.activeJournal ?? this.transientJournal('manual', sessionState.session_id);
    await journal.saveSessionState(sessionState);
  }

  /** 用户显式取消（不是 Host 关闭/中断） */
  private isUserCancelled(signal?: AbortSignal): boolean {
    if (!signal?.aborted) return false;
    const reason = signal.reason;
    return !(typeof reason === 'string' && RUN_INTERRUPT_REASONS.has(reason));
  }

  /** AbortSignal 的 checkpoint 终态：Host 关闭 → interrupted，用户取消 → cancelled */
  private failureCheckpointStatus(signal?: AbortSignal): 'failed' | 'cancelled' | 'interrupted' {
    if (!signal?.aborted) return 'failed';
    const reason = signal.reason;
    return typeof reason === 'string' && RUN_INTERRUPT_REASONS.has(reason)
      ? 'interrupted'
      : 'cancelled';
  }

  /**
   * 发布事件（0.18：先落盘再发布；Stage 4 委托 RunJournal）。
   *
   * - 事实事件：journal 先追加日志，fsync 成功后才 `events.publish()`；
   * - 派生/观测事件直接发布；
   * - 落盘失败不阻塞事件发布，但必须经 Logger 报告（每个 journal 只报一次）。
   *
   * 由于落盘是异步的，事件会在 microtask/IO 完成后到达订阅者；run 终态
   * 返回前会 flush journal，调用方 await run() 后事件历史完整。
   */
  protected publishEvent(event: RunEvent, options?: { persistData?: unknown }): void {
    // Stage 4：写者唯一。active Run 用 begin 的 journal；run 之外（plugin /
    // 手动 compact / notice）用受控 transient journal。
    const journal =
      this.activeJournal ??
      this.transientJournal(
        event.run_id === 'plugin' ? 'plugin' : 'manual',
        typeof (event.data as { session_id?: unknown }).session_id === 'string'
          ? (event.data as { session_id: string }).session_id
          : this.lastSessionId,
      );
    journal.appendFact(event, options?.persistData);
  }

  /** harness / 插件直接发布的事件：只补落盘，不二次发布（避免回环） */
  private persistObservedEvent(event: RunEvent): void {
    const journal =
      this.activeJournal ??
      this.transientJournal(
        'manual',
        typeof (event.data as { session_id?: unknown }).session_id === 'string'
          ? (event.data as { session_id: string }).session_id
          : this.lastSessionId,
      );
    journal.appendObserved(event);
  }
}
