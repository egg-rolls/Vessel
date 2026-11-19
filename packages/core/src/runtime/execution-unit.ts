/**
 * ExecutionUnit 实现
 * @module @vessel-agent/core/runtime
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  appendCompactionStub,
  applyReadSideMaskers,
  archiveNoticeSignature,
  archiveReadbackAvailability,
  auditChainOf,
  buildCompactionIndexEntry,
  type CompactionIndexEntry,
  type ContextAnchor,
  ContextWindowExceededError,
  clampAnchorRatio,
  decideProjectionRunMode,
  estimateMessagesTokensUpperBound,
  estimateRequestViewTokens,
  estimateTokens,
  formatCompactionStub,
  measureArchivedToolResults,
  measureToolResultPressure,
  modelChangeAlreadyAnnounced,
  NO_ANCHOR_SAFETY_MARGIN,
  normalizeContextAnchor,
  PROJECTION_POLICY_VERSION,
  type ProjectionRuntimeMode,
  planClearedToolResults,
  projectionVolumeDimensionApplies,
  renderArchiveNotice,
  renderContextOverflowNotice,
  renderContextTrimNotice,
  renderContextWindowExceededNotice,
  renderModelChangeNotice,
  renderSystemRevisionNotice,
  renderToolSurfaceNotice,
  resolveProjection,
  setWindowProjectionMode,
  shouldCompactForToolResultVolume,
  shouldPublishSystemContext,
  systemContextChangesFromFingerprint,
  type ToolResultPressureReport,
  trimNoticeSignature,
  windowProjectionMode,
  withClearedToolResults,
} from '../context/index.js';
import {
  evaluateLimitWarnings,
  evaluateTermination,
  evaluateUsageLimits,
  LIMIT_WARNING_THRESHOLD,
  MemoryLimitChecker,
} from '../limits/index.js';
import { createStderrLogger } from '../logging.js';
import {
  findHandles as findPiiHandleOccurrences,
  getPiiVault,
  PII_CAPACITY_NOTICE,
  PII_INVALIDATION_NOTICE,
  type PiiAuditEntry,
  type PiiCategory,
  PiiHandleUnresolvedError,
  type PiiVault,
  piiHandleOf,
  renderDeadReferencesNotice,
} from '../pii/index.js';
// D2：跨模块只允许从 barrel 导入（不得直接引用 session 的内部文件）。
import {
  alignMessageSeqs,
  appendCompactionIndex,
  createProjectionCursor,
  cursorFromProjectionSnapshot,
  deriveSessionMeta,
  extendProjection,
  injectedHookMessageIdOf,
  injectedMessageIdOf,
  noticeMessageIdOf,
  PROJECTION_CURSOR_MAX_TOOL_CALLS,
  type ProjectionCursor,
  reconcileCachedProjection,
  serializeProjectionCursor,
  userMessageIdOf,
  withMessageId,
  withRunIdentity,
} from '../session/index.js';
import { sessionDirPath } from '../tenant/index.js';
import {
  type ContextCompactedReason,
  DEFAULT_COMPACT_THRESHOLD,
  type PromptContextFingerprint,
  type WorkingContext,
} from '../types/context.js';
import type { EnvCadence } from '../types/env-cadence.js';
import type { ErrorEnvelope } from '../types/error.js';
import type {
  EventStream,
  RunEvent,
  SessionEventReadPort,
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
  ContextProjectionAudit,
  ProjectionDeclaration,
  ProjectionMode,
} from '../types/projection.js';
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
import type { AttachmentPlan, VisionSettings } from '../types/vision.js';
import { EMPTY_ATTACHMENT_PLAN } from '../types/vision.js';
import {
  imageDropLabel,
  imageDropStatus,
  resolveAttachmentPlan,
  sha8Of,
  summarizeAttachmentPlan,
} from '../vision/index.js';

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
import { createRunTiming, type RunTiming } from './run-timing.js';
import {
  type LoopContext,
  type PreparedToolCall,
  runToolCallingLoop,
  type ToolExecutionOutcome,
} from './tool-calling-loop.js';
import { createToolPipeline, type ToolPipeline } from './tool-pipeline.js';
import { isBridgeCall, type ToolTransport } from './tool-provenance.js';

/**
 * Context pressure warning ratio：达到该比例但未到自动压缩阈值时，
 * 只提示模型/用户考虑 `agent(rotate)`，不主动压缩。
 */
export const CONTEXT_PRESSURE_WARN_RATIO = 0.9;

/**
 * 历史投影的**增量续读**预算（第十一条：增量 / 有界）。
 *
 * 背景：0.54 B3 起 `loadStoredHistory` 每次 run 起点都**整份读**时间线（可读性口径正确，
 * 但代价是 O(会话)）。58k 事件 / 6.2k 块的会话实测 **7.0 s**，占一次发送的 ~92%；同一份
 * 数据在长寿进程里重复读还会随堆压力放大到 16 s（0.56 §1）。窗口只会 append，投影本身
 * 是折叠，所以「上一段折出的消息 + 尾巴那段事件」与整份重投影**逐条相同**。
 *
 * 这三条上界各回答一个问题：
 * - `PROJECTION_TAIL_MAX_EVENTS`：一次续读最多补多少条事件？超过 ⇒ 放弃增量、整份读。
 *   取值 2000 = 与前端首屏一段同量级（`apps/web` 的 `TIMELINE_SEGMENT_MAX_EVENTS`）：
 *   尾巴比一段还长，通常意味着进程重启过 / 别的写者写过一大段，那时候增量读要开的块数
 *   已经接近整份读，没必要赌。
 * - `PROJECTION_CURSOR_MAX_SESSIONS`：进程里最多留几条投影？EU 正常只服务一个 session
 *   （rotate 窗口里会短暂看到两个），再多的会话一旦回来也是整份读（不猜）。
 * - `PROJECTION_CURSOR_MAX_TOOL_CALLS`：一条游标里最多记多少个 tool_call 的实参？
 *   它与消息视图同阶（每条 assistant 的 tool_calls 本来就带同一份实参）；超过这个数
 *   （极端碎片会话）就不再缓存游标 —— 让内存有界，代价只是下次整份读。
 */
export const PROJECTION_TAIL_MAX_EVENTS = 2000;
export const PROJECTION_CURSOR_MAX_SESSIONS = 2;
/** 0.56 send-first：定义搬到 `session/project-messages.ts`（落盘快照也要按它判上界）。 */
export { PROJECTION_CURSOR_MAX_TOOL_CALLS };

/**
 * 这段续读能不能直接折进已有游标（**判据全在这里，别在调用点再判一次**）。
 *
 * 四条都是「不成立 ⇒ 整份读」的**保守**判据，绝不把「不确定」翻译成「少给几条」：
 * 1. 有数据；
 * 2. 没读满窗口（读满 ⇒ 尾巴比预算还长，我们还不知道日志头在哪）；
 * 3. 起点严格新于已折到的 seq（重叠 / 倒退 ⇒ 日志被换过）；
 * 4. seq 严格递增且最后一条正好是**日志头**（中间有洞 ⇒ 说明有别的东西动过盘）。
 */
function isContiguousTail(
  foldedSeq: number,
  tail: readonly SessionEventRecord[],
  head: number | undefined,
): boolean {
  if (tail.length === 0) return false;
  if (tail.length >= PROJECTION_TAIL_MAX_EVENTS) return false;
  if (head === undefined) return false;
  const first = tail[0]?.seq;
  if (typeof first !== 'number' || first <= foldedSeq) return false;
  let previous = foldedSeq;
  for (const event of tail) {
    if (typeof event.seq !== 'number' || event.seq <= previous) return false;
    previous = event.seq;
  }
  return previous === head;
}

/** finalizeRun 的终态输入（C1） */
type RunTerminalOutcome =
  | { status: 'completed'; output: string }
  | { status: 'failed'; error: unknown; signal?: AbortSignal };

/** loadStoredHistory 的结果：消息窗口 + 日志尾游标 + 会话壳。 */
interface StoredHistory {
  messages: Message[];
  /**
   * 本次窗口覆盖到的事件 seq = **日志尾**（0.54 B3：投影恒读整份日志，所以它就是最后一条
   * 事件的 seq）。没有事件日志 / 读失败时 undefined。
   */
  cursor?: number;
  sessionState: SessionState | null;
  /** 读到的会话事件条数（0.54 B3 起恒为整份日志的条数）。 */
  eventCount: number;
  /**
   * 最近一次 provider 请求的 `prompt_tokens + completion_tokens`。
   * 来自已落盘的 `llm.response` 事实（per-request），不是 RunRecord 的累计 usage。
   */
  lastRequestTokens?: number;
  /**
   * 本次历史恢复用的投影游标（0.56 ctx-recall，可选）。
   *
   * 只在「确实折过事件」时存在。窗口里的消息与 `projection.messages` 是同一批对象
   * （`ProjectionCursor` 的共享口径），而游标还带着一份平行的 seq 记录 —— 播种窗口时
   * 用它对齐出「窗口第 i 条消息来自哪条事件」，压缩时才写得出 `removed_ranges`。
   *
   * 缺省 = legacy 回退（RunRecord / 会话壳缓存）⇒ 那一批消息没有 seq 映射，压缩索引如实
   * 记 `unmapped_messages`，不猜。
   */
  projection?: ProjectionCursor;
}

/**
 * 本 run 的上下文计数状态（0.55 P0），按窗口对象存在 `contextAccounting` 里。
 *
 * 字段含义与合同见 `context/request-view.ts` 模块头；这里只放**状态**，判据在
 * `correctedContextTokens` / `recordProviderPromptTokens` 两个方法里。
 */
interface RunContextAccounting {
  /**
   * 最近一次真实请求视图的读数：`tokens` = `estimateRequestViewTokens(args.messages)`
   * 的上界估算（已含每条消息开销与 tools），`messageCount` = 那次请求的消息条数
   * （用来算「其后追加了多少」）。
   */
  requestView?: { tokens: number; messageCount: number };
  /** 校正锚点（provider `prompt_tokens` ÷ 同一请求视图的上界估算）。 */
  anchor?: ContextAnchor;
  /**
   * 上一次 provider 回报的 per-request 用量（地板值，不是现值）。
   * 「上一次响应之后追加的内容」不会被它抹掉：现值来自估算，它只做 `max` 的下界。
   */
  providerPrompt?: number;
}

/** 段起点压缩的触发维度（`ContextManager.shouldCompact()` 的三个维度，按判定顺序）。 */
type SegmentCompactionTrigger = 'token' | 'message_cap' | 'tool_result_volume';

/**
 * 段起点压缩判据的**输入快照**（0.56 ctx-drop）：跟着 `context.compacted` 一起落盘。
 *
 * 事件里带这些数的理由：压缩是「同一个会话的请求突然变短」的唯一正常原因，而旧事件只有
 * `removed / remaining` —— 事后无法回答「为什么这次压缩了」（估算多少、用哪个系数校正、
 * 跟哪条线比）。真实现场就是靠这几个数才定死「没有锚点 ⇒ 乘 1.15 ⇒ 越过阈值」。
 */
interface SegmentCompactionDecision {
  /** 判据里先成立的那个维度。 */
  trigger: SegmentCompactionTrigger;
  /** 整窗上界估算（未校正；`estimateMessagesTokensUpperBound` 口径）。 */
  estimate_upper: number;
  /** 生效的锚点比值；`null` = 没有可用锚点（此时用 `factor` 那条保守边距）。 */
  anchor_ratio: number | null;
  /** 实际乘上去的系数（= `anchor_ratio`，或 `NO_ANCHOR_SAFETY_MARGIN`）。 */
  factor: number;
  /**
   * 与阈值比较的那个数（估算 × 系数，再取 provider 地板）。
   */
  token_count: number;
  /**
   * 窗口自己算的那个数（`WorkingContext.tokenCount`）。
   *
   * 与 `token_count` 不等只有一种原因：包装层没有把锚点转发给窗口（
   * `packages/agent` 的 `RoleAwareContext` 就是这样），于是窗口按
   * `NO_ANCHOR_SAFETY_MARGIN`（×1.15）高报。这条差值本身就是「这次压缩是不是只由
   * 保守边距推动」的判据，见 `compactionWouldBeMarginOnly`。
   */
  window_token_count: number;
  /** 比较线 = `maxTokens × compactThreshold`。 */
  threshold: number;
  /** 压缩前的消息条数。 */
  messages_before: number;
  /** 窗口预算（`ContextConfig.maxTokens`）。 */
  context_max: number;
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

/** 事件 `data` 这类「键值容器」的窄化（只判形状，不解释语义）。 */
function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 这个错误是不是「0.54 之前的旧格式会话」（`legacy_session_unsupported`）。
 *
 * 只认冻结的错误码字符串，不用 `instanceof`：EU 与时间线读口都在 core 里，但错误可能被
 * 包装过（journal / 装配层）。判据就是那个码，见 `timeline/types.ts`。
 */
function isLegacySessionUnsupported(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'legacy_session_unsupported'
  );
}

/**
 * 一次 run 起点的历史恢复读数（`session history restored` 日志的载荷）。
 *
 * 为什么这条日志值得留：0.54 B3 之后「恢复历史」是发送路径上唯一 O(会话) 的动作，
 * 而它的成本结构（整份读 vs 尾读 / 投影 / 对账）不看数字根本猜不出来 —— 0.56 §10
 * 要求的就是「在真实 gateway 里加一次计时，只加计时、不改口径」。这里的数字全部是
 * `performance.now()` 的差，不参与任何判定。
 */
interface HistoryRestoreTiming {
  /** `full` = 整份读重建；`tail` = 尾部续读；`reuse` = 日志没长，一条都没读。 */
  mode: 'full' | 'tail' | 'reuse';
  /** 日志读（含范围读的定位）耗时。 */
  read_ms: number;
  /** 折叠（`extendProjection`）耗时。 */
  fold_ms: number;
  /**
   * 0.56 send-first：这批折叠是从哪来的。
   * - `memory`：本进程的游标（0.55 之前的唯一来源）；
   * - `cache`：落盘快照（重启 / 换 body 后的第一条消息走这条）；
   * - `full`：整份读（没有任何可用游标）。
   */
  source?: HistoryRestoreSource;
}

/** 投影的来源（留痕用：贴日志时一眼能看出「这次有没有吃到快照」）。 */
type HistoryRestoreSource = 'memory' | 'cache' | 'full';

/**
 * context-overflow 的通用文案 / 错误码（0.10 R2-17）。
 * 不绑定厂商名：只认状态码 400 + 可识别的描述。
 *
 * 0.55 P0：**补上 Volcengine / litellm 的措辞**。真实事故原文是
 * `litellm.BadRequestError: VolcengineException - Input exceeds the context limit
 * (1048568 tokens)` —— 老清单一条都不匹配（`context[_ ]length` / `context window` /
 * `maximum context` / `prompt is too long` / `input is too long` / `too many tokens` /
 * `token limit` / `request too large`），于是：
 * - 走不到「追加超限卡」那条路（会话里连一张说明都没有）；
 * - `run.failed.error_code` 落成 `provider_http_error`（不是 `provider_context_overflow`），
 *   观测侧因此看不出「这是上下文超了」。
 * 教训：**provider 已经告诉我们超限了，我们却没听懂**。新增的两条覆盖同族措辞：
 * `Input exceeds the context limit` / `context limit reached` / `exceeded the context limit`。
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[_ ]length/i,
  /context window/i,
  /context limit/i,
  /maximum context/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many tokens/i,
  /token limit/i,
  /request too large/i,
];

/**
 * 从 provider 的超限文案里读出它报的 token 数（读不出 = `undefined`）。
 *
 * 用途：把这一次 400 当成**免费的实测读数**——provider 说「这次输入到了 N tokens」，
 * 那就是上一次请求视图的真实大小（我们本地估算的下界）。记成锚点比值 + 地板，
 * 下一个段起点的压缩与发送前闸立刻按真实口径判定，不必等下一次成功响应。
 *
 * 只认紧挨着 `token(s)` 的数字（`: 1,048,568 tokens` / `(1048568 tokens)`），
 * 不抓消息里别的数字：误抓一个「400」当 token 数会让地板大得荒唐。
 */
function reportedContextTokens(message: string): number | undefined {
  if (!/token/i.test(message)) return undefined;
  const match = /(\d[\d,_ ]{2,})\s*tokens?\b/i.exec(message);
  if (!match?.[1]) return undefined;
  const value = Number(match[1].replace(/[,_ ]/g, ''));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

/**
 * 把「已识别的 provider 超限错误」包装成带稳定错误码的错误（0.55 P0）。
 *
 * `toErrorEnvelope`（`runtime/error-envelope.ts`）的模式表已补上 Volcengine 的措辞
 * （`Input exceeds the context limit`），所以这里**不再伪造前缀**：message 就是 provider
 * 原文。`status = 400` 仍写死，让 envelope 不必再从文本里猜状态码；`code` 让分类稳定。
 */
class ProviderContextOverflowError extends Error {
  readonly code = 'provider_context_overflow';
  readonly status = 400;
  /** 原始 provider 错误（不参与分类，只留给需要原始对象的调用方/调试）。 */
  readonly original: unknown;
  constructor(cause: unknown) {
    super(errorText(cause));
    this.name = 'ProviderContextOverflowError';
    this.original = cause;
  }
}

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
 * 本段**可执行**的投射模式。
 *
 * `ProjectionRuntimeMode`（context 层）只有 `placeholder` / `passthrough` 两档，因为它是
 * 「请求视图怎么变」的类型面。`archive_notice` 在本层多占一档：请求视图与 `passthrough`
 * **逐字节相同**（一个字节都不改写），但它是一条**真的生效了**的模式 —— 审计里必须写
 * `effective_mode: 'archive_notice'`，否则「用户声明了什么」与「到底跑成了什么」在重放时
 * 混成一件事（ADR-104 §2.1 末行）。所以类型在这里放宽一档，窗口上钉的仍然是
 * `passthrough`（见 `freezeSegmentProjection` 的说明）。
 */
type SegmentProjectionMode = 'placeholder' | 'passthrough' | 'archive_notice';

/**
 * 段起点裁决出来的**模式**（不含集合与 plan_hash —— 那些由 freeze 补）。
 *
 * 单独抽出来是因为它被两处用：`primeSegmentProjectionMode`（压缩**之前**，压缩要按本段
 * 模式判 0.20 维度）与 `freezeSegmentProjection`（压缩**之后**，按压缩后的消息算集合）。
 * 两处必须给出同一个答案，否则「模式钉到窗口」与「集合按哪个模式算」会分叉。
 */
interface SegmentProjectionVerdict {
  /** 声明里写的模式（fail-open 之前）。 */
  readonly requested_mode: ProjectionMode;
  /** 本段实际生效的模式。 */
  readonly effective_mode: SegmentProjectionMode;
  /** 降级 / 拒绝原因（正常为 null）。 */
  readonly reason: string | null;
  /** 决策链路（冻结词表：首项＝声明模式、末项＝生效模式）。 */
  readonly steps: readonly string[];
  /** 读回能力判据（只有 `archive_notice` 有定义）。 */
  readonly readback: 'available' | 'unavailable' | null;
  /** 生效的声明原样（没声明 = null）。 */
  readonly declaration: ProjectionDeclaration | null;
}

/**
 * 段起点冻结下来的投射决策（0.53 U2；U3 增 `archive_notice`）。
 *
 * 「run 起点冻结、run 内共享同一集合」是硬不变式：这份记录在段起点算一次，
 * run 内的所有请求共用它，请求期绝不重算（反事实测算：改成每请求重算，净收益
 * 从 +9.85 变 −72.37，占位集合每轮漂移把 prefix cache 全丢了）。
 */
interface FrozenProjectionDecision {
  /** 声明里写的模式（fail-open 之前）。 */
  readonly requested_mode: ProjectionMode;
  /** 本段实际生效的模式（决定请求层是否替换 + 0.20 维度是否参与判数）。 */
  readonly effective_mode: SegmentProjectionMode;
  /** 声明 id（没声明时为 null）。 */
  readonly declaration_id: string | null;
  /** 按冻结集合算的 plan 指纹（前 16 位 sha256；passthrough 下为集合空集的指纹）。 */
  readonly plan_hash: string;
  /**
   * 冻结的集合：`placeholder` = 要换占位的 id；`archive_notice` = 要归档的 id
   * （**不改写正文**，只登记）；`passthrough` 恒为空。
   */
  readonly ids: readonly string[];
  /** 集合的来源：'plan'＝规划出来的；'empty'＝passthrough 的空集。 */
  readonly basis: 'plan' | 'empty';
  /** 决策链路（原样写进审计 `steps`，也进事件 `data.steps`）。 */
  readonly steps: readonly string[];
  /** 降级 / 拒绝原因（正常为 null）。 */
  readonly reason: string | null;
  /**
   * 读回能力判据的结果（只有 `archive_notice` 有定义；其余模式为 null）。
   *
   * 单独一个字段而不是塞进 `steps`：`steps` 是**冻结词表**（声明模式 → 生效模式），
   * 门禁逐字断言它；「这次降级是因为读回路径不可用」是细节，放事件与日志里更诚实
   * （审计行 schema 冻结，不加字段）。
   */
  readonly readback: 'available' | 'unavailable' | null;
  /**
   * 这次段起点的决策是否**变更**（模式 / 集合任一变即为变更）。
   * 没变更就不写审计、不发事件 —— 否则每轮都刷一条同内容的记录。
   */
  readonly changed: boolean;
  /** 要落盘的新审计行（只在 `changed` 时非 null）。 */
  readonly audit: ContextProjectionAudit | null;
}

/**
 * 本段生效模式 → **钉在窗口上的**运行期模式。
 *
 * `archive_notice` 钉 `passthrough`，因为窗口模式管的三件事它都要 `passthrough` 的答案：
 *
 * 1. **请求视图不替换**（`buildRequestMessages` 按窗口模式短路）—— 归档模式的全部意义就是
 *    「一个字节都不改写」，落盘与请求逐字节相同，C1h 的豁免一个都不消费；
 * 2. **0.20 体积维度不驱动压缩**（ADR-104 §2.3(a)：`archive_notice` 下 0.20 触顶只告警）——
 *    这与 `passthrough` 同口径（`projectionVolumeDimensionApplies`）；
 * 3. 体积压力照旧可观测（`context.projection_pressure`）。
 *
 * 权威的「到底声明了什么 / 生效成什么」在 `segmentProjections`（写审计与事件），
 * 不在窗口上：窗口模式只有两档，它回答的是「请求期怎么改」，不是「用户的声明是什么」。
 */
function windowModeOf(mode: SegmentProjectionMode): ProjectionRuntimeMode {
  return mode === 'archive_notice' ? 'passthrough' : mode;
}

/**
 * 冻结集合的指纹（审计 `plan_hash` / 事件用）：sha256 前 16 位。
 *
 * 口径＝生效模式 + **排序后**的 call id 列表。排序 ⇒ 同一集合不同规划顺序算同一
 * plan（要的是集合语义，不是「谁先谁后」）；模式也进摘要 ⇒ `passthrough` 的空集与
 * `placeholder` 的空集不会撞成一个指纹 —— 否则「模式变了」在审计里看不出来。
 * `\u0000` 分隔避免拼接歧义（`a`+`bc` 与 `ab`+`c` 必须是两个 hash）。
 */
function projectionPlanHash(mode: SegmentProjectionMode, ids: readonly string[]): string {
  const digest = createHash('sha256');
  digest.update(mode);
  digest.update('\u0000');
  for (const id of [...ids].sort()) {
    digest.update(id);
    digest.update('\u0000');
  }
  return digest.digest('hex').slice(0, 16);
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
  /**
   * 本 run 已写进上下文的 hook 注入条数（0.56：`message_id` 的下标来源）。
   *
   * 只数**真正落进上下文**的那些（去重跳过的、对象引用重复的都不数），所以同一条
   * hook 消息在同一个 run 里拿到的是同一个 `${runId}:inject:hook:<n>`。
   */
  private injectedHookSeq = 0;
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
   * `updateRealTokens` 沿用该值（0.55 P0 起它只是 `tokenCount` 的**地板**，
   * 现值来自「下一次请求视图的上界估算」，见 `context/request-view.ts` 合同 1）。
   */
  private lastRealTokens?: number;
  private lastBranch?: string;
  private readonly lastRunSystemPrompts = new Map<string, string>();
  /**
   * tools-body-snapshot：本会话请求 tools[] 的快照（message-invariants §3：工具集会话内不可变）。
   * 懒捕获于该会话在本 EU 的第一条 LLM 请求（此时 MCP 异步建连的注册通常已完成）；
   * 新 EU / session_switch / 段起点压缩成功 ⇒ 重 pin；同会话新 run / branch / pop 不重建。
   * 执行侧不受影响：toolPipeline 仍 live `getTool`（新增可执行、移除稳定 tool_not_found）。
   */
  private pinnedTools?: {
    sessionId: string;
    schemas: NonNullable<ChatRequest['tools']>;
    names: string[];
  };
  /** 模型此刻相信的工具面（tools 卡去重：注入后推进；同一变更只报一次，回滚照报）。 */
  private reportedToolSurface?: { sessionId: string; names: string[] };
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
   * 0.57：当前 run 的分段耗时账本（`run.timing` / `run.llm.gap` 的唯一出口）。
   * 与 `activeRun` 同寿命：`beginExecution` 建、`endExecution` 丢。
   */
  private runTiming?: RunTiming;
  /** 本 run 的终态（`finalizeRun` 写，`endExecution` 读来打 `outcome=`）。 */
  private runTimingOutcome?: 'completed' | 'failed' | 'cancelled';
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
  /**
   * 0.18：会话事件读口（Stage 4 / 0.54 stop-write：**只读**）。
   *
   * 类型是 `SessionEventReadPort`（没有 `append`）：EU 只做三件事 —— 整份读投影历史、
   * 读回可用性判定、合并写 `index.json`。写入的唯一入口是 `RunJournal`（经时间线写者）。
   */
  private readonly eventLog?: SessionEventReadPort;
  /** 0.18：观察 harness 直接发布的交互事件（permission/ask response） */
  private readonly eventLogUnsubscribe?: Unsubscribe;
  /**
   * 会话目录根（`<dataDir>/sessions`，0.56 ctx-recall）。
   *
   * 只给压缩索引一个落点（`<sessionDir>/compactions.ndjson`）。缺省不注入 ⇒ 索引只活在
   * 事件与内存里（读回仍可由 `deriveCompactionIndex` 重建）。
   */
  private readonly compactionIndexDir?: string;
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
  /**
   * 视觉的**运行期设置**（0.56）：kill switch / 单请求张数 / 精度意图。
   * 能力在 `this.provider.vision`（插件的 `VisionBackend` 实例），不在这。
   */
  private readonly visionSettings?: VisionSettings;
  /**
   * 已报告过的图片投递事实（按 session：`sha8:kind`）。
   *
   * 为什么要去重：plan 是**每轮请求**重算的，同一条历史里的同一张图会被反复解析出来 ——
   * 不去重的话 `image.sent` / `context.image_dropped` 会随着轮数线性增长，GUI 的「这张图
   * 到底发没发出去」变成数数游戏，P1 的 TUI 也只能看到一堆重复事件。投递状态是**事实**
   * （发生过一次就够了），所以每个 (session, sha8, 结果) 只记一条。
   */
  private readonly reportedImageDelivery = new Map<string, Set<string>>();
  /** kill switch 已报告过的会话（每个会话一条 `vision.disabled`，不是静默） */
  private readonly visionDisabledReported = new Set<string>();
  /**
   * 环境信息检测节奏端口（注入粒度框架轴 A）：装配层注入，缺省 undefined ⇒
   * `envCadenceAllows` 恒 true（恒按 request 观察，零回归）。core 不认识 scope 业务词。
   */
  private readonly envCadence?: (scope: string) => EnvCadence;
  /**
   * cadence='run' 的 per-run 首请求守卫：runId → 本 run 已观察过的 scope 集。
   * 环形上限 64（仿 runtime-notice-hook 的 injectedByRun）：长进程不无界增长。
   */
  private readonly envRunGated = new Map<string, Set<string>>();

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
    this.compactionIndexDir = opts.compactionIndexDir;
    this.pricing = opts.pricing;
    this.leaseService = opts.leaseService;
    this.bindingLease = opts.bindingLease;
    this.visionSettings = opts.vision;
    this.envCadence = opts.envCadence;
    // 缺省走中枢薄封装：级别跟随进程级配置（不再以 VESSEL_DEBUG 定死 debug/noop）。
    this.logger = opts.logger ?? createStderrLogger();
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
      // 0.52：工具参数求值前把 `«pii:…»` 换回真值；解不开就整调用失败。
      // onHandleFailure 只负责「整批失效」这一档的系统级提示卡（每 session 至多一张）。
      pii: {
        substitute: (args, sessionId) => this.piiVault().substituteDeep(args, sessionId),
        onHandleFailure: (error, sessionId) => this.onPiiHandleFailure(error, sessionId),
      },
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
   *
   * 0.56：提示也是**进了会话的消息**，所以在这里（唯一构造点）盖 `message_id`。
   * 时间戳同样在构造时定死 —— id 由「归属 + 时间戳」拼出，两者必须同源，之后
   * `addContext` / 快照追加都不再改写它们，否则同一条提示会拿到两个身份。
   */
  appendNotice(text: string): void {
    const execution = this.activeRun;
    const timestamp = Date.now();
    const owner = execution?.runId ?? 'notice';
    const message: Message = {
      role: 'user',
      name: 'vessel:notice',
      content: text,
      timestamp,
      message_id: noticeMessageIdOf(owner, timestamp),
    };
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

  /**
   * 0.52 V2：压缩只在**段边界**发生（run 起点 / 用户显式压缩），run 内绝不改写历史。
   *
   * 调用点：`run()` 与 resume 的 seed 之后、本段第一条请求之前。压缩成功 ⇒ 本段的基准
   * 就是压缩后的 seed 视图（段因 `compaction`，守卫与 UI 都按 `new(compaction)` 记一段），
   * 段内不再压缩。旧行为是在 tool loop 的**每一轮**请求前压缩：同一段内请求前缀会被反复
   * 改形（删中段 + 插新摘要），「只有 append 或 pop」与 prefix cache 同时破。
   */
  /**
   * 0.56：压缩前后比较「还在窗里的图片 sha8」，被删掉的记一条 `context.image_dropped`
   * （`reason: 'compaction'`）。
   *
   * 为什么按 sha 而不按消息下标：压缩会删中段 + 插摘要，下标全部重排；图片的身份是内容
   * （sha256），**只有它能跨压缩对齐**。同一条图被压缩删掉一次就记一次（去重键含 session）。
   */
  private reportCompactionImageDrops(execution: Run, before: ReadonlySet<string>): void {
    if (before.size === 0) return;
    const after = new Set<string>();
    for (const ref of this.imageRefsOfWindow(execution.workingContext)) after.add(ref);
    if (after.size >= before.size) return;
    const reported = this.reportedImageDelivery.get(execution.sessionId);
    for (const sha8 of before) {
      if (after.has(sha8)) continue;
      const key = `drop:${sha8}:compaction`;
      if (reported?.has(key) === true) continue;
      reported?.add(key);
      this.publishEvent({
        type: 'context.image_dropped',
        run_id: execution.runId,
        data: {
          run_id: execution.runId,
          session_id: execution.sessionId,
          count: 1,
          reason: 'compaction',
          label: imageDropLabel('compaction'),
          status: imageDropStatus('compaction'),
          sha8,
        },
        ts: Date.now(),
      });
    }
  }

  /** 窗口里所有图片引用的 sha8（读 `refs`，不读字节、不碰 base64）。 */
  private imageRefsOfWindow(window: WorkingContext): Set<string> {
    const out = new Set<string>();
    for (const message of window.messages) {
      for (const ref of message.refs ?? []) {
        if (ref.kind !== 'image' || ref.sha256 === undefined) continue;
        out.add(sha8Of(ref.sha256));
      }
    }
    return out;
  }

  private async compactAtSegmentStart(execution: Run): Promise<void> {
    const window = execution.workingContext;
    const autoCompact = window.autoCompactAsync;
    if (autoCompact === undefined) return;
    // 0.53 U2：`passthrough` 下 0.20 体积维度**不参与**判据（`shouldCompact()` 里按
    // 模式分层），这里只把压力做成可观测量：一条 `context.projection_pressure` 事件。
    // 压缩仍然可能发生 —— 但只可能由 token 主阈值（0.85）/ 条数硬兜底触发，
    // 那两个对所有 mode 生效。
    if (windowProjectionMode(window) === 'passthrough') {
      this.publishProjectionPressure(window, execution.runId);
    }
    // 0.56 ctx-drop：判据的**输入**先拍一份快照 —— 压缩一旦发生，请求长度会当场掉一大截，
    // 而 `context.compacted` 以前只报 removed / remaining：为什么这次变小（估算多少、
    // 乘了哪个系数、跟哪条线比）在事后的日志里查不到，只能靠推。现在跟着事件一起落盘。
    const decision = this.segmentCompactionDecision(execution);
    if (this.compactionWouldBeMarginOnly(decision)) {
      // 只由「没有锚点 ⇒ ×1.15」推过线：不压缩，并留下可查的原因。
      // 方向是安全的（少压不会撑爆：真超限由 provider overflow + 下一个段起点兜住），
      // 而反方向的代价是**不可逆的信息损失**（摘要替换 766 条消息），不对称。
      this.logger.warn('segment compaction skipped (no-anchor margin only)', {
        session_id: execution.sessionId,
        estimate_upper: decision.estimate_upper,
        ledger_token_count: decision.token_count,
        window_token_count: decision.window_token_count,
        threshold: decision.threshold,
        anchor_ratio: decision.anchor_ratio,
        messages: decision.messages_before,
      });
      return;
    }
    let removed: number;
    // 0.56：压缩前后各拍一份「带图消息」的快照 —— 被删掉的图要留一条
    // `context.image_dropped{reason:'compaction'}`（GUI 回看时看得见「这里曾有 5 张图」，
    // 而不是图凭空消失）。快照只取引用，不读字节。
    const imagesBefore = this.imageRefsOfWindow(window);
    // 0.56 ctx-recall：压缩**之前**的窗口体积（索引里要记「前后各多少」；压缩之后就取不到了）。
    const tokensBefore = window.tokenCount;
    try {
      removed = await autoCompact.call(window);
    } catch {
      // 段起点压缩是尽力而为：摘要失败不该让整个 run 起不来（context-manager 内部已回退
      // 占位符压缩）。真撑爆时走「超限」卡 + 失败收尾那条路。
      return;
    }
    // 0.55 P0：窗口真的变小了 ⇒ 「上一次 provider 回报」这条地板必须撤掉，
    // 否则压缩后的显示会卡在压缩前的数（地板只保证「不倒退」，不该阻止「正当缩小」）。
    const compactedState = removed > 0 ? this.accounting(execution) : undefined;
    if (removed > 0) this.reportCompactionImageDrops(execution, imagesBefore);
    // 0.57：`compacted=yes/no` 是本段起点有没有压缩的唯一读数（压缩 = 额外一次 LLM
    // 摘要调用，会把第一条请求再往后推一大截）。
    this.runTiming?.text('compacted', removed > 0 ? 'yes' : 'no');
    this.publishCompacted(
      window,
      execution.runId,
      execution.sessionId,
      removed,
      'auto',
      decision,
      tokensBefore,
    );
    if (compactedState !== undefined) {
      // 压缩删掉了中段：本段从压缩后的视图开始，必须显式标段因，否则守卫会当成前缀重写。
      this.pendingPrefixReason ??= 'compaction';
      compactedState.providerPrompt = undefined;
      compactedState.requestView = undefined;
      // tools-body-snapshot（D1）：压缩 = 开新会话 ⇒ 作废本会话的 tools[] 快照与卡基线，
      // 下一轮请求重 pin。整段前缀已因摘要失效，重建 tools[] 零额外缓存代价。
      if (this.pinnedTools?.sessionId === execution.sessionId) {
        this.pinnedTools = undefined;
        this.reportedToolSurface = undefined;
      }
    }
  }

  /**
   * 这次段起点压缩是不是**只由保守边距推动**的（0.56 ctx-drop）。
   *
   * 判据：账本口径（与显示同一个数、有锚点时就是实测比值）**没过线**，而窗口口径
   * （`WorkingContext.tokenCount`）过线了。两者不等只可能因为窗口没拿到锚点
   * （`RoleAwareContext` 不转发 `setContextAnchor`），于是它按 `NO_ANCHOR_SAFETY_MARGIN`
   * ×1.15 高报 —— 真实现场就是 616,378 的真实 prompt（62%）被当成 867,898（87%）。
   *
   * 为什么要拦：高报 15% 换来的是**不可逆**的压缩（766 条消息 → 一条摘要），而它挡住的
   * 「真超限」有别的兜底（provider overflow 卡 + 下一个段起点），代价可逆（多一次往返）。
   * 量级不对称，所以宁可这一次不压，并把原因写进 warning。
   *
   * 体积维度 / 条数兜底不看 token 数，它们照旧生效（这里只在 token 维度过线时判）。
   */
  private compactionWouldBeMarginOnly(decision: SegmentCompactionDecision): boolean {
    if (decision.trigger !== 'token') return false;
    return decision.token_count <= decision.threshold;
  }

  /**
   * 段起点压缩判据的**输入**（`context.compacted` 的事件载荷，0.56 ctx-drop）。
   *
   * 口径与 `ContextManager.shouldCompact()` 逐项对齐（它判的三个维度就是这三个）：
   * `tokenCount`（估算 × 系数，再取 provider 地板）对 `maxTokens × compactThreshold`、
   * 保留工具结果的体积、消息条数兜底。
   *
   * 为什么值得复述：同一条会话重启后请求突然短掉一大截，唯一可能的原因是这里某个输入
   * 在段起点变了（最典型的是「没有锚点 ⇒ 乘 1.15」）。事件里没有这些数，就只能猜。
   *
   * 两个 `token_count` 都要报：`window_token_count` 是窗口自己算的那个（包装层没转发
   * 锚点时它乘 1.15），`token_count` 是 runtime 账本口径（与显示 / `context_max` 快照
   * 同一个数）。两者不等本身就是一条可查的事实（见 `compactionWouldBeMarginOnly`）。
   */
  private segmentCompactionDecision(execution: Run): SegmentCompactionDecision {
    const window = execution.workingContext;
    const accounting = this.accounting(execution);
    const anchorRatio = accounting.anchor?.ratio;
    const factor = anchorRatio ?? NO_ANCHOR_SAFETY_MARGIN;
    // 端口上的这三个成员都是可选的（包装层不一定转发）；缺省值与
    // `MemoryWorkingContext` 的构造缺省一致（`1_000_000` / `0.85`）。
    const maxTokens = window.maxTokens ?? 1_000_000;
    const threshold = maxTokens * (window.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD);
    const windowTokenCount = window.tokenCount ?? 0;
    const estimateUpper = estimateMessagesTokensUpperBound(window.messages);
    // 账本口径：与显示同一个数（`correctedContextTokens`）。
    const ledgerTokenCount = this.correctedContextTokens(execution, estimateUpper);
    const volumeExceeded = projectionVolumeDimensionApplies(windowProjectionMode(window))
      ? shouldCompactForToolResultVolume(window.messages, maxTokens)
      : false;
    // 判据只有三个维度（见 `shouldCompact`）：token 主阈值、条数兜底、体积维度。
    // `trigger` 按**两个口径任一过线**报（窗口是实际判定方，账本是显示/回落的基准）；
    // 「窗口过线而账本没过」这一种由 `compactionWouldBeMarginOnly` 拦下。
    const trigger: SegmentCompactionTrigger =
      windowTokenCount > threshold || ledgerTokenCount > threshold
        ? 'token'
        : volumeExceeded
          ? 'tool_result_volume'
          : 'message_cap';
    return {
      trigger,
      estimate_upper: estimateUpper,
      anchor_ratio: anchorRatio ?? null,
      factor,
      token_count: ledgerTokenCount,
      window_token_count: windowTokenCount,
      threshold: Math.round(threshold),
      messages_before: window.messages.length,
      context_max: maxTokens,
    };
  }

  /**
   * 0.52 R6：系统提示词 / 工具表 / 模型变了时的环境信息卡（**不开新会话**）。
   *
   * 以前这里标 `system_revision`：守卫看到 reason 就直接放行、什么都不发，前缀改写于是
   * 变成静默的。删掉 reason 之后 `PromptPrefixGuard` 会照旧把这类技术原因当「前缀变了」
   * 报出来（`prompt.prefix_changed`），卡负责让模型与用户也知道发生了什么。
   */
  private appendSystemRevisionNotice(): void {
    this.appendNotice(renderSystemRevisionNotice());
  }

  /**
   * model-follow Step D：跨重启 / 换 body 的模型变更通知（owner 与成员同一套）。
   *
   * EU 的 model 是构造期只读快照，config 换模型在（重）建 EU 的续接 run 才生效。
   * 事实源 = 目标会话存档恢复的指纹 `SessionState.prompt_context.model`（调用前已由
   * `restorePromptContextFingerprint` 按本次 run 的会话复原，session_switch 拿到的就是
   * 目标会话的值，不是 EU 上别的会话的旧值）。与 `this.model` 不同 ⇒ 经
   * `appendInjectedMessages` 追加一张 `vessel:notice`（scope `model`）：落
   * `message.injected` 事实事件、进本次请求、UI 同见（可见性对等），不改 system 前缀、
   * 不发 prefix-change reason、不动 `publishSystemContext` 的去重 / 推进逻辑。
   *
   * 只在（重）建 EU 的首个 run 实际触发：首个 run 发布后指纹推进到当前 model，后续 run
   * 恢复出的指纹相等即跳过；指纹缺省（老会话无 prompt_context）= 无比较基础 ⇒ 不发
   * （未知 ≠ 变更）。指纹只在 run 发布时推进，「连续两次重启、中间没跑 run」与
   * 「注入了卡但没走到发布就终止」由文本键去重兜住（同一过渡只报一次，回滚照报）。
   */
  private appendModelChangeNotice(execution: Run): void {
    const from = this.promptContextFingerprint?.model;
    // 空串与缺省同义：没有可比的旧模型就不发（normalize 允许空串落盘）。
    if (from === undefined || from === '' || from === this.model) return;
    if (modelChangeAlreadyAnnounced(execution.workingContext.messages, from, this.model)) return;
    this.appendInjectedMessages(execution, execution.runId, [
      {
        role: 'user',
        name: 'vessel:notice',
        content: renderModelChangeNotice(from, this.model),
      },
    ]);
  }

  /**
   * 0.52 V2：run 内撑爆上下文时**不许静默改写历史**。
   *
   * 追加一张「超限」env 卡（scope `context`）讲清发生了什么与下一步动作，然后让本次 Run
   * 以 provider 的原始错误收尾；压缩留到下一个段起点（`new(compaction)` 开新段）。
   * 旧行为是这里 `forceCompact(execution, 'overflow')` 就地删中段 + 插摘要后重试 —— 一次
   * run 内因此出现两个不同的历史视图。
   */
  private appendContextOverflowNotice(): void {
    this.appendNotice(renderContextOverflowNotice());
  }

  /**
   * 段冻结的工具结果占位集合，按窗口对象索引（0.52 V1）。
   *
   * 窗口换了（新 Run / `pop` / 换会话）就自然失效 —— 这正是「`pop` 之后按新段基准重算」的
   * 实现方式：不需要额外的失效通知，下一个段起点直接覆盖。请求期只读它，**不再**按当前
   * messages 重算窗口。
   */
  private readonly segmentClearPlans = new WeakMap<object, readonly string[]>();

  /**
   * 段起点冻结的**投射决策**（0.53 U2），按窗口对象索引。
   *
   * 与 `segmentClearPlans` 同一生命周期：窗口换了就失效（新 run / `pop` / 换会话）。
   * 存的是「本段生效模式 + 实际参与判数的 plan_hash / ids_count / basis / 是否降级」，
   * 供 `saveSessionState` 写审计用；请求期只读 `windowProjectionMode(window)`。
   */
  private readonly segmentProjections = new WeakMap<object, FrozenProjectionDecision>();

  /**
   * 「窗口第 i 条消息由哪条事件产出」的平行表，按窗口对象索引（0.56 ctx-recall）。
   *
   * 与 `segmentClearPlans` 同一生命周期：窗口换了就失效。缺口 / 整份缺失都允许 ——
   * 读它的人（压缩索引）把缺口记成 `unmapped_messages`，不猜一个相邻 seq。
   *
   * 值由 `rememberWindowSeqs` 在播种窗口时按内容对齐一次填好（对齐口径见
   * `alignMessageSeqs`）。**只服务索引记账**，不参与任何判据。
   */
  private readonly windowSeqMaps = new WeakMap<object, (number | undefined)[]>();

  /**
   * 每条会话已产生的压缩索引（0.56 ctx-recall），按 sessionId 索引。
   *
   * 存在的理由：stub 与 `compaction_id` 都要「多段累积」（不覆盖历史），而这两个数都只在
   * 追加时用得上。上界 = 该会话的压缩次数（真实会话个位数），随 EU 生命周期回收。
   *
   * 落盘有三份（见 `context/compaction-index.ts` 的条目注释）：事件（事实）、会话壳
   * （缓存，`SessionState.compactions`）、`compactions.ndjson`（工具用的物化索引）。
   */
  private readonly sessionCompactions = new Map<string, CompactionIndexEntry[]>();

  /**
   * 本 run 的**上下文计数状态**（0.55 P0），按窗口对象索引。
   *
   * 存在的理由：计数的唯一权威口径是「下一次请求视图的上界估算」（合同见
   * `context/request-view.ts`），而**请求视图**只有 runtime 手里有（`buildRequestMessages`
   * 之后、`withClearedToolResults` 之后的那一份）。窗口侧只有整窗，够不到冻结的占位集合
   * —— 而且 `WorkingContext` 端口上没有任何「把这个数交给你」的成员（`packages/agent` 的
   * `RoleAwareContext` 包装层也不会转发新增成员）。所以状态放在这里，不新增端口成员。
   *
   * 按窗口对象索引：新 run / `pop` / 换会话都会换窗口 ⇒ 自动失效，随窗口 GC，
   * 不需要显式清理，也不会跨 run 串味（与 `segmentClearPlans` 同一生命周期口径）。
   */
  private readonly contextAccounting = new WeakMap<object, RunContextAccounting>();

  /**
   * 取（必要时新建）本 run 的计数状态。
   *
   * 上界：每个窗口一条记录（三个数字 + 一个锚点对象），与窗口同生共死。
   */
  private accounting(execution: Run): RunContextAccounting {
    const key = execution.workingContext;
    let state = this.contextAccounting.get(key);
    if (state === undefined) {
      state = {};
      this.contextAccounting.set(key, state);
    }
    return state;
  }

  /**
   * 段起点：把落盘锚点接进本段账本（并按模型过滤）。
   *
   * 为什么过滤模型：换模型的 tokenizer 不同，硬套别人的比值比不校正更糟
   * （与 `MemoryWorkingContext.setContextAnchor` 同一判据，两处必须一致）。
   *
   * ## 为什么还要「从事件日志复原」（0.56 ctx-drop）
   *
   * 锚点是**唯一**能让压缩判据（`shouldCompact`）与真实占有对上的东西：有锚点时
   * `tokenCount = 估算 × ratio`（实测 ≈1.0），没有时退回 `NO_ANCHOR_SAFETY_MARGIN`
   * （×1.15）。这个 15% 足以把一次「不该压缩」的段起点推过 0.85 阈值 —— 真实现场：
   * 一条 1M 预算的会话，最后一条请求 provider 实测 prompt = 616,378（62%），
   * 重启后的第一个段起点却把 1941 条消息压成了 1175 条（请求 1940 → 1179 条消息），
   * 而**同一进程内**的下一个段起点什么都没发生。同一条会话、同一份落盘，
   * 「模型看到什么」不该因为进程重启而变化 —— 这就是那个 bug。
   *
   * 锚点会丢的路径有两条，都不报错：会话壳里没有 `context_anchor` 字段（字段被别的
   * 写者洗掉 / 壳落后于日志），或壳里的锚点记的是别的模型（换模型后按判据作废）。
   * 而锚点的两个分量本来就躺在事件日志里：`llm.response.usage.prompt_tokens`（分子）与
   * `llm.request.estimated_tokens`（分母，同一口径的请求视图上界估算）。所以壳丢了
   * 就从日志尾部把这两个数读回来，比值与 `recordProviderPromptTokens` 算出来的**同一口径**，
   * 段起点因此对「重启 / 不重启」等价。
   */
  private async adoptStoredAnchor(
    execution: Run,
    stored: SessionState | null,
    lastRequestTokens?: number,
  ): Promise<void> {
    const state = this.accounting(execution);
    const normalized = normalizeContextAnchor(stored?.context_anchor);
    const modelMismatch =
      normalized !== undefined &&
      normalized.model !== undefined &&
      this.model !== undefined &&
      normalized.model !== this.model;
    state.anchor = normalized === undefined || modelMismatch ? undefined : normalized;
    // 地板：上一次 provider 回报的 per-request 用量（prompt + completion，`llm.response`）。
    // 只做 `max` 的下界，保证「run 起点数字不倒退」（合同 1）——**不是**现值。
    state.providerPrompt =
      lastRequestTokens !== undefined && lastRequestTokens > 0 ? lastRequestTokens : undefined;
    if (state.anchor === undefined) {
      // 不许静默：壳里的锚点为什么不可用、后果是什么，先记下来。
      const reason =
        stored?.context_anchor === undefined
          ? 'absent'
          : normalized === undefined
            ? 'invalid'
            : 'model_mismatch';
      const recovered = await this.recoverAnchorFromLog(execution.sessionId);
      if (recovered !== undefined) {
        state.anchor = recovered;
        this.logger.info('context anchor recovered from event log', {
          session_id: execution.sessionId,
          reason,
          model: this.model,
          ratio: recovered.ratio,
          prompt_tokens: recovered.prompt_tokens,
          request_estimate: recovered.request_estimate,
        });
      } else {
        // 复原不出来（没有日志 / 尾部找不到配对）才真的没有锚点：这条 warning 是
        // 「本次段起点的压缩判据用了 ×1.15 保守边距」的唯一痕迹。
        this.logger.warn('context anchor unavailable at segment start', {
          session_id: execution.sessionId,
          reason,
          model: this.model,
          factor: NO_ANCHOR_SAFETY_MARGIN,
          consequence:
            'compaction threshold is compared against estimate*1.15 instead of the measured ratio',
        });
      }
    }
    // 窗口也注入一份：直接持有 `MemoryWorkingContext` 的实现（TUI / 无包装层）据此校正。
    execution.workingContext.setContextAnchor?.(state.anchor, this.model);
  }

  /**
   * 段起点复原锚点时回扫的事件条数。
   *
   * 一条 run 收尾时，最后一条 llm.request 之后还有 llm.response、工具事件、notice、
   * run.completed —— 真实会话实测 239 条（125421 → 125660）。512 覆盖这种量级，
   * 同时仍是一次范围读（几块），不扫整份会话；更长的尾巴就返回 undefined（宁可报
   * warning 也不整份读）。
   */
  private static readonly ANCHOR_RECOVERY_TAIL_EVENTS = 512;

  /**
   * 从事件日志尾部复原锚点（`prompt_tokens ÷ 请求视图估算`，与 `recordProviderPromptTokens`
   * 同一口径）。读的是范围读（`sinceSeq` + `limit`），不扫整份会话。
   *
   * 拿不到「配对的两个数」时返回 `undefined`：只有请求没有响应（run 在提供商那一步崩了）
   * 就没有可用的真实用量，宁可报 warning 也不猜。
   */
  private async recoverAnchorFromLog(sessionId: string): Promise<ContextAnchor | undefined> {
    const log = this.eventLog;
    if (log === undefined) return undefined;
    try {
      await log.flush(sessionId);
      const head = await log.lastSeq?.(sessionId);
      if (head === undefined || head <= 0) return undefined;
      const tailSize = ExecutionUnit.ANCHOR_RECOVERY_TAIL_EVENTS;
      const tail = await log.read(sessionId, {
        sinceSeq: Math.max(0, head - tailSize),
        limit: tailSize,
      });
      let estimate: number | undefined;
      let prompt: number | undefined;
      let at = 0;
      for (const event of tail) {
        const data = isRecordValue(event.data) ? event.data : undefined;
        if (data === undefined) continue;
        if (event.type === 'llm.request') {
          const value = data.estimated_tokens;
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) estimate = value;
          continue;
        }
        if (event.type !== 'llm.response') continue;
        const usage = isRecordValue(data.usage) ? data.usage : undefined;
        const value = usage?.prompt_tokens;
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
        prompt = value;
        if (typeof event.ts === 'number' && Number.isFinite(event.ts)) at = event.ts;
      }
      if (estimate === undefined || prompt === undefined) return undefined;
      const ratio = clampAnchorRatio(prompt / estimate);
      if (ratio === undefined) return undefined;
      return {
        ratio,
        prompt_tokens: prompt,
        request_estimate: estimate,
        ...(this.model !== undefined && this.model.length > 0 ? { model: this.model } : {}),
        at,
      };
    } catch (error) {
      this.logger.warn('context anchor recovery failed', {
        session_id: sessionId,
        error: errorText(error),
      });
      return undefined;
    }
  }

  /**
   * 把「本地上界估算」换算成**要显示 / 要比阈值**的那个数（合同 2 / 5）。
   *
   * - 有锚点：乘 `anchor.ratio`（provider ÷ 同一请求视图的上界估算，**同口径**，合同 3）。
   *   有锚点说明我们实测过这台机器 / 这个模型的偏差，`NO_ANCHOR_SAFETY_MARGIN` 不再叠加
   *   （再乘就是双重高报，会凭空提前压缩）。
   * - 无锚点：乘 `NO_ANCHOR_SAFETY_MARGIN`（未知 tokenizer 的保守边距，取值依据见
   *   `context/request-view.ts`）。
   * - 最后用 `providerPrompt` 做地板：数字永不因「provider 回报比较小」而倒退（合同 1）。
   */
  private correctedContextTokens(execution: Run, rawTokens: number): number {
    const state = this.accounting(execution);
    const factor = state.anchor !== undefined ? state.anchor.ratio : NO_ANCHOR_SAFETY_MARGIN;
    const corrected = Math.round(Math.max(0, rawTokens) * factor);
    const floor = state.providerPrompt ?? 0;
    return Math.max(corrected, floor);
  }

  /**
   * 「下一次请求」的视图估算（未校正）—— 显示 / 预警用的现值。
   *
   * 增量口径（第十一条）：本段已经构建过一次请求（`state.requestView` 有值）时，取那次
   * 的视图估算 + **其后追加的消息**的上界估算；没有请求过（run 刚起来）就按整窗上界估。
   * 两者都不会「倒退」：追加只加，压缩会换窗口（新 run 的段起点）。
   *
   * tools 只在有请求视图时计入（那是上一次请求真的带上的那张表）；整窗兜底路径不知道
   * 工具表，因此略偏低 —— 但发送前闸会补上 tools（它手上有 `args.tools`），闸不受影响。
   */
  private nextRequestTokens(execution: Run): number {
    const state = this.accounting(execution);
    const messages = execution.workingContext.messages;
    const view = state.requestView;
    if (view === undefined) return estimateMessagesTokensUpperBound(messages);
    if (messages.length <= view.messageCount) return view.tokens;
    const appended = messages.slice(view.messageCount);
    return view.tokens + estimateMessagesTokensUpperBound(appended);
  }

  /** 现值（显示 / 压缩判据口径）= 下一次请求视图估算，按锚点校正并压地板。 */
  private currentContextTokens(execution: Run): number {
    return this.correctedContextTokens(execution, this.nextRequestTokens(execution));
  }

  /**
   * 拿到 provider 上报的 `prompt_tokens` 那一刻记下校正比（合同 2 / 3）。
   *
   * 分母 `requestViewTokens` 必须是**这一次请求的视图**估算（`args.messages` 的上界），
   * 不是整窗：整窗比请求视图大（占位后正文变短），比值会被结构性压小，重启后校正不够
   * —— 那正是 0.52 起「锚点从没落过盘、落盘也偏小」的半个原因。
   *
   * 落盘由 `saveSessionState` 负责（`SessionState.context_anchor`）。这里同时把锚点注入
   * 窗口（`setContextAnchor`），让只认窗口的实现也能用上。
   */
  private recordProviderPromptTokens(
    execution: Run,
    promptTokens: number,
    requestViewTokens: number,
  ): void {
    const state = this.accounting(execution);
    if (!(promptTokens > 0)) return;
    // 地板值：provider 的 per-request 回报（含 completion —— 下一轮它会作为 assistant
    // 消息重新进请求，所以取 prompt + completion 不多算）。
    state.providerPrompt = promptTokens;
    if (!(requestViewTokens > 0)) return;
    const ratio = clampAnchorRatio(promptTokens / requestViewTokens);
    if (ratio === undefined) return;
    const anchor: ContextAnchor = {
      ratio,
      prompt_tokens: promptTokens,
      request_estimate: requestViewTokens,
      ...(this.model !== undefined && this.model.length > 0 ? { model: this.model } : {}),
      at: Date.now(),
    };
    state.anchor = anchor;
    execution.workingContext.setContextAnchor?.(anchor, this.model);
  }

  /** 本 run 当前可落盘的锚点（`saveSessionState` 用）。 */
  private anchorOf(execution: Run): ContextAnchor | undefined {
    return this.accounting(execution).anchor ?? execution.workingContext.contextAnchor;
  }

  /**
   * 上一张 trim 卡的**去重键**，按会话索引（0.53 主题3）。
   *
   * 去重键 = `trimNoticeSignature({ cleared, added, tool_call_ids })`，即「总数（本段共清了
   * 几条）/ 本轮新增条数 / 本轮新增的 call id 列表（按段基准出现顺序）」三件事全等 ⇒ 认为是
   * **同一张卡**，卡片与 `context.cleared_tool_result` 事件一起不再 append。
   *
   * 为什么不拿落盘的 `SessionState.cleared_tool_call_ids` 当去重依据：那正是本卡缺的输入 ——
   * 某个后端不持久化这个 additive 字段时（旧 store / 只搬 messages 的宿主 / 字段被洗掉），
   * 每个段起点都算不出 `fresh` 差集（`known` 恒空），于是同一张卡（同样的总数、同样的 id
   * 列表）被一轮一轮重复追加。会话级的「上一张卡的签名」是唯一不依赖那个字段的依据。
   *
   * 键里带上 `added`（它与 id 列表长度恒等，取念上是冗余）是为了让键与卡面讲的口径一一对应：
   * 改卡面口径时必须同步改键，漏改会被 T7 的去重断言当场抓住。
   *
   * 内存态、按会话：进程重启后的第一个段起点会重发一次同样的卡 —— 宁可多一张，不可漏一张。
   */
  private readonly lastTrimNoticeKeys = new Map<string, string>();

  /**
   * 上一张 **归档卡** 的去重键 + 「上一次冻结的归档集合」，按会话索引（0.53 U3）。
   *
   * 两个状态都在内存里、都按会话，理由与 `lastTrimNoticeKeys` 同一条：
   * `SessionState` **没有**「已归档 id」这个字段（U1 的落盘 schema 冻结，本单不加），
   * 所以「哪些算新增」与「这张卡发过没有」只能靠会话级记忆。
   *
   * - `lastArchivePlans`：上一次段起点冻结的归档集合（算 `fresh` 差集 + 判「决策是否变更」）；
   * - `lastArchiveNoticeKeys`：上一张卡的 `archiveNoticeSignature`（同载荷不重复发）。
   *
   * 代价写清楚：进程重启后这两个 Map 是空的 ⇒ 重启后的第一个段起点会把当前集合整体当成
   * 「本轮新增」再发一张卡。这比漏一张好（宁可多一张，不可漏一张），与 trim 卡同一取舍；
   * 而且卡本身只有元数据、上限 200 token，重复一张不会误导读者（数字仍是真实的累计）。
   */
  private readonly lastArchivePlans = new Map<string, readonly string[]>();
  private readonly lastArchiveNoticeKeys = new Map<string, string>();

  /**
   * 0.53 U2/U3：段起点裁决本段的投射模式（**唯一**入口，prime 与 freeze 共用）。
   *
   * 三层口径，一层都不许混：
   *
   * 1. `placeholder` / `passthrough` / 非法声明 / `externalize`：完全沿用 U2 的
   *    `decideProjectionRunMode`（一个字都不改它的判据）。
   * 2. `archive_notice` **且读回能力可用**：生效 `archive_notice`（不改写正文，追加归档卡）。
   * 3. `archive_notice` **且读回能力不可用**：fail-open 到 `passthrough` + 审计 reason
   *    （沿用 §6.4 的冻结码 `projection_mode_unavailable`，**不新造码**；链路仍是
   *    `声明 → unavailable → passthrough`，细节「是读回路径不可用」只进事件与日志）。
   *    不许写一张指向不存在日志的卡（ADR-104 §2.3(f)）。
   */
  private decideSegmentProjection(stored: SessionState | null): SegmentProjectionVerdict {
    const resolution = resolveProjection(stored);
    const decided = decideProjectionRunMode(resolution.mode, resolution.error);
    const declaration = resolution.declaration;
    if (resolution.mode !== 'archive_notice' || resolution.error !== null) {
      return { ...decided, readback: null, declaration };
    }
    const readback = archiveReadbackAvailability(this.eventLog);
    if (!readback.available) {
      this.logger.warn('archive_notice degraded: readback path unavailable', {
        session_id: stored?.session_id,
        reason: readback.reason,
      });
      return { ...decided, readback: 'unavailable', declaration };
    }
    return {
      requested_mode: 'archive_notice',
      effective_mode: 'archive_notice',
      reason: null,
      steps: ['archive_notice', 'archive_notice'],
      readback: 'available',
      declaration,
    };
  }

  /**
   * 0.53 U2：段起点**第一步** —— 只裁决模式并钉到窗口上（不含集合、不写审计）。
   *
   * 为什么单独一层：段起点的压缩要按本段的模式判定（`passthrough` 不吃 0.20 体积
   * 维度），而占位集合必须等压缩**之后**、按压缩后的消息算。所以模式先定、集合后算。
   * 两侧都走 `decideSegmentProjection`（纯函数 + 同步能力判据，同样的输入 ⇒ 同样的结果），
   * 不会漂。
   */
  private primeSegmentProjectionMode(execution: Run, stored: SessionState | null): void {
    const verdict = this.decideSegmentProjection(stored);
    setWindowProjectionMode(execution.workingContext, windowModeOf(verdict.effective_mode));
  }

  /**
   * 0.52 V1：段起点把「清哪些工具结果」一次算完并**冻结**（清理必须一次到位）。
   *
   * 旧行为是每次请求按当前 messages 重算窗口（K = min(10, 5% 预算)）⇒ 第 11 条工具结果
   * 之后每轮多清一条：同一段内每轮请求都比上一轮多差一条（prefix cache 全丢，也不满足
   * 「分段只有 new / pop」）。现在：
   *
   * - 集合在段起点算一次，随 session 落盘（`SessionState.cleared_tool_call_ids`，
   *   RunJournal 单写口，两 backend 都写）；
   * - 请求期只读（`buildRequestMessages`），段内一个字都不再改；
   * - `pop`（回退 / 分支切换）之后基准重置，下一个段起点按新基准重算并覆盖。
   *
   * 清理必须可见：新增 call id 时追加一张 env 卡（scope `trim`）+ 一条
   * `context.cleared_tool_result` 事件；正文只说「本轮新增几条 / 会话内累计几条 / 为什么 /
   * 被清的 call id」（首行＝折叠态的增量标题，其余行进展开明细），不含任何工具输出正文。
   * 同一批 id 只讲一次：先按已落盘的集合取差集，再按「上一张卡的签名」去重
   * （0.53 主题3，见 `lastTrimNoticeKeys`）。
   *
   * 0.53 U2：这里同时是**投射模式的段起点冻结点**（`freezeSegmentProjection`）。
   * `passthrough` 下集合恒为空：没有占位、没有 trim 卡、没有 trim 事件 —— 请求与
   * 「完全没有投射机制」逐字节相同。
   */
  private freezeSegmentClearedToolResults(execution: Run, stored: SessionState | null): void {
    const window = execution.workingContext;
    const messages = window.messages;
    // 0.53 U2：模式先定，集合再算（顺序不能反：passthrough 下不该跑 plan）。
    const projection = this.freezeSegmentProjection(execution, stored);
    const ids = projection.ids;
    // `archive_notice` 不改写任何正文 ⇒ 请求视图一条都不替换 ⇒ 落盘的 `cleared_tool_call_ids`
    // 必须是空集（`saveSessionState` 就是拿这份当「审计集合」写的）。把归档集合写进去等于
    // 伪造「这批被换成占位了」，C1g（请求视图 vs 审计集合）会当场红。
    this.segmentClearPlans.set(window, projection.effective_mode === 'archive_notice' ? [] : ids);
    // 0.53 U3：归档模式只做一件事 —— 新增归档时追加一张归档卡（不替换、不删历史）。
    if (projection.effective_mode === 'archive_notice') {
      this.announceArchivedToolResults(execution, messages, projection);
      return;
    }
    // passthrough：本段没有占位 ⇒ 不存在「新增了什么要讲」。直接收工。
    if (projection.effective_mode !== 'placeholder') return;
    const known = new Set(stored?.cleared_tool_call_ids ?? []);
    const fresh = ids.filter((id) => !known.has(id));
    if (fresh.length === 0) return;
    // 去重（0.53 主题3）：同一会话里「总数 + 本轮新增条数 + 新增 id 列表」与上一张卡全等
    // ⇒ 这张卡已经在上下文里了，不再 append 卡片、也不再发事件（键的口径见字段注释）。
    const added = fresh.length;
    const key = trimNoticeSignature({ cleared: ids.length, added, tool_call_ids: fresh });
    if (this.lastTrimNoticeKeys.get(execution.sessionId) === key) return;
    this.lastTrimNoticeKeys.set(execution.sessionId, key);
    const cleared = new Set(ids);
    const kept = messages.filter(
      (message) =>
        message.role === 'tool' &&
        typeof message.tool_call_id === 'string' &&
        !cleared.has(message.tool_call_id),
    ).length;
    // 两个口径分两层（0.53 主题3）：**首行**（折叠态标题）只说本轮新增
    // （`tool_call_ids` 的长度），**明细行**（展开后）才给总数 `cleared` / 保留条数 /
    // 新增的 call id。列出的 id 仍然只有新增的那几条 —— 改回全量会把卡本身撑大。
    const notice = renderContextTrimNotice({ cleared: ids.length, kept, tool_call_ids: fresh });
    this.appendNotice(notice);
    this.publishEvent({
      type: 'context.cleared_tool_result',
      run_id: execution.runId,
      ts: Date.now(),
      data: {
        // 旧消费者只认 data.summary：占位卡的可见投影，与 env 卡正文逐字一致。
        summary: notice,
        // `cleared` = **总数**（本会话/本段累计清了几条），`added` = **本轮新增**
        // （additive，0.53）。卡面把增量放折叠态标题、总数放展开后的明细，事件两个都带
        // （UI 自己决定展示层次，消费者不必再从 summary 里抠数字）。
        cleared: ids.length,
        added,
        kept,
        // 只报本次新增的 id（同一批只讲一次）；顺序＝段基准里的出现顺序。
        tool_call_ids: fresh,
        segment: 'context_trim',
      },
    });
  }

  /**
   * 0.53 U3：`archive_notice` 的**唯一**产出 —— 新增归档时追加一张归档卡 + 一条事件。
   *
   * 三条规矩（都是断言，见 `scripts/check-archive-notice.ts`）：
   *
   * 1. **只追加，不改写**：卡片走 `appendNotice`（落盘、UI 可见，与 trim 卡同一类）；
   *    被归档的工具结果正文一个字节都不动，请求视图与落盘逐字节相同。
   * 2. **两个口径分两层**：首行只说**本轮**新增（`fresh.length`），累计数只在明细行
   *    （`docs/specs/projection-card-spec.md` §3.0）。
   * 3. **同载荷不重复发**：`archiveNoticeSignature`（累计 + 本轮新增 + 新增 id 列表）与
   *    上一张卡全等 ⇒ 卡与事件一起不再 append。
   *
   * 「哪些算已归档」用的就是 `placeholder` 的那套保留预算（`planClearedToolResults`，见
   * `freezeSegmentProjection`）：本节不另造预算、不改常量 —— 两个模式对「哪些结果是旧的」
   * 必须给出同一个答案，否则同一段历史在换模式后会被讲成两件事。
   */
  private announceArchivedToolResults(
    execution: Run,
    messages: readonly Message[],
    projection: FrozenProjectionDecision,
  ): void {
    const ids = projection.ids;
    const announced = new Set(this.lastArchivePlans.get(execution.sessionId) ?? []);
    const fresh = ids.filter((id) => !announced.has(id));
    // 先记下本段的集合：无论这张卡发不发，下一次段起点都按它算差集（不重复讲同一批）。
    this.lastArchivePlans.set(execution.sessionId, [...ids]);
    if (fresh.length === 0) return;
    const key = archiveNoticeSignature({
      archived: ids.length,
      added: fresh.length,
      tool_call_ids: fresh,
    });
    if (this.lastArchiveNoticeKeys.get(execution.sessionId) === key) return;
    this.lastArchiveNoticeKeys.set(execution.sessionId, key);
    const entries = measureArchivedToolResults(messages, fresh);
    const toolNames = entries.map((entry) => entry.tool_name);
    const bytes = entries.map((entry) => entry.bytes);
    const bytesTotal = bytes.reduce((sum, value) => sum + value, 0);
    const notice = renderArchiveNotice({
      ids: fresh,
      tools: toolNames,
      bytes,
      sessionId: execution.sessionId,
      archived: ids.length,
    });
    this.appendNotice(notice);
    this.publishEvent({
      type: 'context.archive_notice',
      run_id: execution.runId,
      ts: Date.now(),
      data: {
        // 卡正文逐字（与 trim 卡同套路）：UI 与模型看的是同一份文本。
        summary: notice,
        // `archived` = 会话内**累计**归档条数，`added` = **本轮新增**（两者分两层，见卡面）。
        archived: ids.length,
        added: fresh.length,
        // 只报本轮新增的条目（同一批只讲一次）；顺序＝段基准里的出现顺序。
        tool_call_ids: fresh,
        tool_names: toolNames,
        bytes,
        bytes_total: bytesTotal,
        session_id: execution.sessionId,
        // 怎么读回来（ADR-104 §2.3(c)）。不再报「原文在哪个文件」：0.54 停写 events.ndjson 后那个路径是假的。
        readback: 'sessions.events',
        plan_hash: projection.plan_hash,
        segment: 'archive_notice',
      },
    });
  }

  /**
   * 0.53 U2：段起点裁决本段的投射模式并冻结集合。
   *
   * 三个必须守住的点：
   *
   * 1. **run 起点冻结、run 内共享同一集合**。模式和集合都在这里定一次，写进
   *    `windowProjectionMode(window)` + `segmentClearPlans`，请求期只读。
   * 2. **passthrough 与「没有投射机制」逐字节相同**：不跑 plan（集合恒为空），
   *    请求层直接放行（`buildRequestMessages`），不发 trim 卡 / trim 事件。
   * 3. **未实现的 mode / 读不出的声明 / 读回路径不可用一律 fail-open 到 `passthrough`
   *    并留痕**，不许静默按 `placeholder` 跑（那等于偷偷开机制）。两层降级的目标不许混：
   *    声明期降级 → `placeholder`（U1 的 `declareProjection`），运行期单 run 降级 →
   *    `passthrough`（本函数）。见 ADR-104 §4.4。
   *
   * 0.53 U3：`archive_notice` 也要跑 plan（**同一套保留预算**，见 `planClearedToolResults`），
   * 但那份集合的用途是「哪些算已归档」，不是「哪些换成占位」—— 所以它只进
   * `plan_hash` / 归档卡 / 事件，**不进** `segmentClearPlans`（见
   * `freezeSegmentClearedToolResults` 的第一行注释）。
   *
   * 审计只在**决策变更**的段起点写一条（ADR-104 §5.1：不刷日志）。
   */
  private freezeSegmentProjection(
    execution: Run,
    stored: SessionState | null,
  ): FrozenProjectionDecision {
    const window = execution.workingContext;
    const messages = window.messages;
    const decided = this.decideSegmentProjection(stored);
    const declaration = decided.declaration;
    // 集合：`placeholder` 与 `archive_notice` 都按同一套保留预算规划（一个换占位、一个只
    // 登记）；`passthrough` 恒为空集（不读也不改历史）。
    const ids =
      decided.effective_mode === 'passthrough'
        ? []
        : planClearedToolResults(messages, window.maxTokens ?? 0);
    // 模式先钉到窗口上（此后本段内任何请求读到的都是它）。`archive_notice` 钉 `passthrough`，
    // 理由见 `windowModeOf`：请求视图与体积维度两件事上两者等价。
    setWindowProjectionMode(window, windowModeOf(decided.effective_mode));
    const planHash = projectionPlanHash(decided.effective_mode, ids);
    const previous = auditChainOf(stored?.context_projection_audit);
    // 「上一次的集合」按模式取：`placeholder` 读落盘的占位集合（U2 的既有口径），
    // `archive_notice` 读本进程上一次冻结的归档集合（`SessionState` 没有归档字段，
    // 本单不加）。`passthrough` 恒为空集。
    const previousIds = [
      ...(decided.effective_mode === 'archive_notice'
        ? (this.lastArchivePlans.get(execution.sessionId) ?? [])
        : (stored?.cleared_tool_call_ids ?? [])),
    ].sort();
    const nextIds = [...ids].sort();
    // 决策变更 = 模式链 / 降级原因 / 冻结集合任一变。第一次决策也算变更
    // （`auditChainOf(null)` 全 null ⇒ 必与任何一个 mode 不等）。
    const changed =
      previous.declared !== decided.requested_mode ||
      previous.effective !== decided.effective_mode ||
      previous.reason !== decided.reason ||
      previousIds.length !== nextIds.length ||
      previousIds.some((id, index) => id !== nextIds[index]);
    const now = Date.now();
    const audit: ContextProjectionAudit | null = changed
      ? {
          schema_version: PROJECTION_POLICY_VERSION,
          // 审计里存**实际使用的声明原样**（U1 的归一化结果），不二次改写；
          // 没声明就是 null（旧会话 / 未声明）。
          declaration,
          steps: decided.steps,
          reason: decided.reason,
          requested_mode: decided.reason !== null ? decided.requested_mode : null,
          at: now,
        }
      : null;
    const frozen: FrozenProjectionDecision = {
      requested_mode: decided.requested_mode,
      effective_mode: decided.effective_mode,
      declaration_id: declaration?.declaration_id ?? null,
      plan_hash: planHash,
      ids,
      basis: decided.effective_mode === 'passthrough' ? 'empty' : 'plan',
      steps: decided.steps,
      reason: decided.reason,
      readback: decided.readback,
      changed,
      audit,
    };
    this.segmentProjections.set(window, frozen);
    if (changed) this.publishProjectionDecision(execution, frozen, now);
    return frozen;
  }

  /**
   * 决策变更时：一条审计（随 session 落盘，`saveSessionState` 写）+ 同名可见事件。
   *
   * 事件是审计行的可见投影（与 `context.cleared_tool_result` 同套路）：`data` 里把
   * 任务单要求的字段全带上（mode / effective_mode / declaration_id / plan_hash /
   * ids_count / basis / reason / schema_version）。审计行本身**不**加字段 ——
   * U1 的 `ContextProjectionAudit` schema 冻结，多出来的信息只能走事件与 `steps`。
   */
  private publishProjectionDecision(
    execution: Run,
    frozen: FrozenProjectionDecision,
    at: number,
  ): void {
    this.publishEvent({
      type: 'context.projection_applied',
      run_id: execution.runId,
      ts: at,
      data: {
        schema_version: PROJECTION_POLICY_VERSION,
        mode: frozen.requested_mode,
        effective_mode: frozen.effective_mode,
        declaration_id: frozen.declaration_id,
        plan_hash: frozen.plan_hash,
        ids_count: frozen.ids.length,
        basis: frozen.basis,
        reason: frozen.reason,
        steps: frozen.steps,
        // additive（0.53 U3）：读回能力判据（只有 archive_notice 有值）。降级到 passthrough
        // 时它说明「是读回路径不可用」，而不必让消费者去猜 steps 的中间项。
        readback: frozen.readback,
        at,
      },
    });
    if (frozen.reason === null) return;
    // 降级要单独可见：消费者不必从 applied 里推断「这次是不是被降级了」。
    this.publishEvent({
      type: 'context.projection_degraded',
      run_id: execution.runId,
      ts: at,
      data: {
        schema_version: PROJECTION_POLICY_VERSION,
        mode: frozen.requested_mode,
        effective_mode: frozen.effective_mode,
        reason: frozen.reason,
        basis: frozen.basis,
        steps: frozen.steps,
        readback: frozen.readback,
      },
    });
  }

  /** 针对本 ExecutionUnit 覆盖用的 vault（默认进程单例；探针可替换）。 */
  private piiVaultOverride: PiiVault | undefined;

  /**
   * 覆盖 PII vault（探针 / 多租户隔离用）。不传则用进程级单例。
   */
  setPiiVault(vault: PiiVault | undefined): void {
    this.piiVaultOverride = vault;
  }

  /** 三处边界共用的 broker。 */
  private piiVault(): PiiVault {
    return this.piiVaultOverride ?? getPiiVault();
  }

  /**
   * 句柄解不开时的上层动作（0.52 裁定，口径：**动作错误 vs 环境变化**）：
   *
   * 环境卡表达「世界的状态变了」；句柄过期/未知是「这一次动作没做成」。混在一起会同时
   * 坏三件事：卡片语义被稀释、错误归属不清（哪个 tool、哪次调用）、逐调用错误被伪装成
   * 全局变化。所以：
   * - `unknown_handle` / `expired_handle`：**只**是那个工具调用的失败
   *   （`retryable: false`，下一步写在错误文本里；卡片由工具失败卡承载），
   *   **不发**环境信息卡 —— 动作错误不是环境变化；
   * - `invalidated_handle`：broker 重启导致**整批**失效（一次性影响所有在途句柄），
   *   除工具失败外**再**发一张环境信息卡（每 session 至多一张，靠
   *   `claimInvalidationNotice` 去重）。两者**并存**：卡解释「为什么突然都不行了」，
   *   工具卡解释「这一次没做成」。
   */
  private onPiiHandleFailure(error: unknown, sessionId: string): void {
    if (!(error instanceof PiiHandleUnresolvedError)) return;
    if (error.reason !== 'invalidated_handle') return;
    const vault = this.piiVault();
    if (!vault.claimInvalidationNotice(sessionId)) return;
    // 追加是异步的（journal append）；这里在同步回调里，发出去即可，失败不影响本次工具错误。
    void this.appendNotice(PII_INVALIDATION_NOTICE.en);
    this.publishEvent({
      type: 'pii.handles.invalidated',
      run_id: this.activeRun?.runId ?? 'plugin',
      ts: Date.now(),
      data: {
        session: sessionId,
        reason: error.reason,
        handle_count: error.handles.length,
      },
    });
  }

  /**
   * append 侧脱敏（0.52 三处边界的落点，**不是**请求侧改写）。
   *
   * 为什么在 append：用户 0.52 的硬不变量是
   * 1. **可见性对等** —— UI 渲染出来的必须包含 agent 看得到的一切；
   * 2. **请求 messages 只许 append** —— 回改任何一条历史都会让前缀缓存全废。
   * 两条合起来只有一个解：真值在**写入上下文那一刻**就换成占位符，落盘的字节
   * 就是 store / 请求 / UI 共用的那一份；真值只活在内存 vault 里。
   *
   * 顺序：先 `protect()`（真值 → 句柄，超限降级为直接掩码，同时中和入站伪造的同形
   * token），再跑插件注册的 read-side masker（幂等；给第三方 masker 留扩展点，
   * 核心规则已经是超集，所以正常情况下是 no-op）。
   */
  private maskForAppend(message: Message, sessionId: string): Message {
    const vault = this.piiVault();
    const maskers = this.pluginHost.getReadSideMaskers?.() ?? [];
    if (!vault.isEnabled && maskers.length === 0) return message;
    // 运行时自己生成的 env 卡 / 提示（`vessel:notice`）**不脱敏**：
    // 它只带状态与占位符 id，从不含真值；而它的价值恰恰在于「把已经解不开的 id 原样
    // 列出来」，过一遍 `protect()` 的入站中和反而会把 id 抹成 «pii:neutralized»。
    if (message.name === 'vessel:notice') return message;
    const audit = new Map<string, PiiAuditEntry>();
    const transform = (text: string): string => {
      // 1) 句柄化：真值 → 占位符（超限降级为直接掩码；入站伪造的同形 token 一并中和）
      let out = text;
      if (vault.isEnabled) {
        const protectedText = vault.protect(text, sessionId);
        out = protectedText.text;
        for (const entry of protectedText.audit) audit.set(entry.category, entry);
      }
      // 2) 插件注册的脱敏器（幂等；核心规则已是超集，正常是 no-op）
      out = applyReadSideMaskers(out, maskers);
      return out;
    };
    // content 声明为 string，但历史/多模态可能是 content-part 数组：
    // 先按 unknown 收窄，否则 Array.isArray 会把类型窄成 never。
    const content: unknown = message.content;
    let next: Message = message;
    if (typeof content === 'string') {
      const masked = transform(content);
      if (masked !== content) next = { ...message, content: masked };
    } else if (Array.isArray(content)) {
      let changed = false;
      const parts = content.map((part) => {
        if (
          part !== null &&
          typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          const original = (part as { text: string }).text;
          const masked = transform(original);
          if (masked !== original) changed = true;
          return masked === original ? part : { ...part, text: masked };
        }
        return part;
      });
      // content 的声明类型是 string，但实际允许 content-part 数组（历史兼容）。
      if (changed) next = { ...message, content: parts as unknown as string };
    }

    // 审计只落 {session, category, count, first_seen_at}（无真值）。
    for (const entry of audit.values()) {
      this.publishEvent({
        type: 'pii.vault.audit',
        run_id: this.activeRun?.runId ?? 'plugin',
        ts: Date.now(),
        data: entry as unknown as Record<string, unknown>,
      });
    }
    return next;
  }

  /**
   * 检测节奏 gate（轴 A）：`cadence='run'` 时每 run 只放行**首次观察**。
   *
   * 端口未注入 / cadence='request' ⇒ 恒 true（缺省零回归）。必须在 producer 的
   * **观察 / diff 之前**调用：否则 believed-value 已推进而卡被吞 = 变更永丢。
   * 去重（轴 B：believed-value / 游标 / 签名 / 预算）恒开，与本 gate 正交。
   * model / trim 的自然节奏钉死（前缀不变量 / EU 生命周期），不经此 gate。
   */
  private envCadenceAllows(scope: string, runId: string): boolean {
    if (this.envCadence?.(scope) !== 'run') return true;
    // runId 未知（无 active run）：无法 per-run 记帐，放行（退化为 request，不吞卡）。
    if (runId === '') return true;
    const RUNS_REMEMBERED_MAX = 64;
    let seen = this.envRunGated.get(runId);
    if (seen === undefined) {
      seen = new Set<string>();
      this.envRunGated.set(runId, seen);
      // 环形上限：只留最近 N 个 run 的记帐（长时间运行的进程不无界增长）。
      while (this.envRunGated.size > RUNS_REMEMBERED_MAX) {
        const oldest = this.envRunGated.keys().next();
        if (oldest.done === true) break;
        this.envRunGated.delete(oldest.value);
      }
    }
    if (seen.has(scope)) return false;
    seen.add(scope);
    return true;
  }

  /**
   * 发请求前扫一遍已经 append 的消息，把**已经解不开**的占位符集合追加成一条 env 卡。
   *
   * append-only 决定了「失效」只能以**追加**表达（不能回改成新的标记形状）。
   * 去重靠 `claimUnannouncedDeadHandles`：同一批 id 只宣告一次，之后每轮不再重复。
   * 整批失效（broker 重启）与个别失效共用同一张卡的额度（每 session 至多一张）。
   */
  private async appendPiiDeadNotice(sessionId: string): Promise<void> {
    // 节奏 gate 在扫消息之前（run 级配置下后续请求不观察；去重轴不受影响）。
    if (!this.envCadenceAllows('pii', this.activeRun?.runId ?? '')) return;
    const vault = this.piiVault();
    if (!vault.isEnabled) return;
    const seen = new Set<string>();
    for (const message of this.activeRun?.workingContext.messages ?? []) {
      const content: unknown = message.content;
      const texts =
        typeof content === 'string'
          ? [content]
          : Array.isArray(content)
            ? content
                .map((part) =>
                  part !== null &&
                  typeof part === 'object' &&
                  typeof (part as { text?: unknown }).text === 'string'
                    ? (part as { text: string }).text
                    : undefined,
                )
                .filter((text): text is string => text !== undefined)
            : [];
      for (const text of texts) {
        for (const occurrence of findPiiHandleOccurrences(text)) seen.add(occurrence.id);
      }
    }

    // 分拣：哪些是真解不开的、其中哪些属于「整批失效」（broker 重启）。
    const dead: Array<{ id: string; category: PiiCategory | undefined }> = [];
    let systemic = false;
    for (const id of seen) {
      const result = vault.resolve(sessionId, id);
      if (result.ok) continue;
      dead.push({ id, category: vault.categoryOfDeadHandle(sessionId, id) });
      if (result.reason === 'invalidated_handle') systemic = true;
    }

    // 容量耗尽：也是「面上的」事件，与失效卡共用每 60s 一张的预算。
    if (dead.length === 0) {
      if (vault.takeDegradedCount(sessionId) === 0) return;
      if (!vault.claimNoticeBudget(sessionId)) return;
      await this.appendNotice(PII_CAPACITY_NOTICE.en);
      this.publishEvent({
        type: 'pii.handles.capacity',
        run_id: this.activeRun?.runId ?? 'plugin',
        ts: Date.now(),
        data: { session: sessionId },
      });
      return;
    }

    // 去重 + 防抖一次判完：同批不重发；换一批新 id 且已过 60s 冷却才再发一张。
    if (
      !vault.shouldAnnounceDeadBatch(
        sessionId,
        dead.map((entry) => entry.id),
        systemic ? 'systemic' : 'dead',
      )
    ) {
      return;
    }

    if (systemic) {
      // broker 重启导致整批失效：发「状态变化」卡（不逐条列 id，避免泄漏 + 噪音）。
      await this.appendNotice(PII_INVALIDATION_NOTICE.en);
      this.publishEvent({
        type: 'pii.handles.invalidated',
        run_id: this.activeRun?.runId ?? 'plugin',
        ts: Date.now(),
        data: { session: sessionId, reason: 'invalidated_handle', handle_count: dead.length },
      });
      return;
    }

    // 个别失效：追加一张 env 卡，明细**只列占位符 id 与类别**（无真值/片段/长度）。
    await this.appendNotice(
      renderDeadReferencesNotice(
        dead.map((entry) => ({
          handle: piiHandleOf(entry.id),
          ...(entry.category === undefined ? {} : { category: entry.category }),
        })),
      ),
    );
  }

  /**
   * tools-body-snapshot：请求 tools[] 的唯一来源 —— 会话起点快照，不再每轮 live 读宿主。
   *
   * 懒捕获于该会话的第一条 LLM 请求（卡端口在 loop 里先于 `listToolSchemas` 被调，
   * 首轮由它完成 pin）：比构造期捕获更准 —— MCP 异步建连可能在 EU 创建后才注册完，
   * 首请求前注册完的工具直接进列表，不算「中途新增」。pin=live ⇒ 首轮无卡。
   *
   * 重 pin 只发生在：新 EU（新会话 / rotate / 重启续接天然重建）、sessionId 不符
   * （session_switch，本就是 `new` 段）、段起点压缩成功（D1，见 compactAtSegmentStart）。
   * 同会话新 run / branch / pop 不重建。中途 register/unregister 只进 PluginHost，
   * 不触碰 pin —— 请求侧不再读 live，无需任何拦截代码。
   */
  private ensureToolPin(sessionId: string): {
    schemas: NonNullable<ChatRequest['tools']>;
    names: string[];
  } {
    const existing = this.pinnedTools;
    if (existing !== undefined && existing.sessionId === sessionId) return existing;
    const tools = this.pluginHost.listTools();
    const pin = {
      sessionId,
      // 映射形状与旧每轮 live 读逐字相同（type:'function' + name/description/parameters），
      // 只是时机从每轮现算变成每会话一次。包装对象是 pin 时新建的：宿主同名更新走
      // unregister+register 新定义对象，不改写旧对象 ⇒ 快照内容稳定。
      schemas: tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      names: [...new Set(tools.map((tool) => tool.name))].sort(),
    };
    this.pinnedTools = pin;
    this.reportedToolSurface = { sessionId, names: pin.names };
    return pin;
  }

  /**
   * tools-body-snapshot：工具面变更卡的唯一生产者（owner / member / MCP 同一通道）。
   *
   * 每轮请求前 diff「模型相信的面」（reportedToolSurface）与 live 宿主名字集：
   * 空 ⇒ 不注入；非空 ⇒ 先推进 reported 再经 `appendInjectedMessages` 追加一张
   * `vessel:notice`（scope `tools`）—— 进本次请求、落 `message.injected` 事实、
   * UI 同见（可见性对等），不改 system、不发 prefix reason、tools[] 本身不动。
   * 新增工具 best-effort 可执行（live getTool 命中）；移除工具稳定报 tool_not_found，
   * 卡里已解释。MCP toggle / 热应用 / refreshTools / 权限档 / inbox 都改同一个宿主，
   * 下一轮 diff 自动出卡，零新触发代码。agent 侧旧 createToolSurfaceDeltaHook 已撤
   * （否则双卡）；热应用既有的 scope `config` 摘要卡保留（语义不同，D5）。
   */
  private appendToolSurfaceNotice(execution: Run): void {
    // 节奏 gate 在 diff 之前（run 级配置下后续请求不观察）。工具面 pin 不受影响：
    // ensureToolPin 另由 listToolSchemas 每请求独立调用。
    if (!this.envCadenceAllows('tools', execution.runId)) return;
    const pin = this.ensureToolPin(execution.sessionId);
    const reported = this.reportedToolSurface;
    const reportedNames =
      reported !== undefined && reported.sessionId === execution.sessionId
        ? reported.names
        : pin.names;
    const liveTools = this.pluginHost.listTools();
    const liveNames = [...new Set(liveTools.map((tool) => tool.name))].sort();
    const before = new Set(reportedNames);
    const after = new Set(liveNames);
    const added = liveNames.filter((name) => !before.has(name));
    const removed = reportedNames.filter((name) => !after.has(name));
    if (added.length === 0 && removed.length === 0) return;
    // 先推进再注入（self-card-delta 同族）：同一 run 后续轮 diff 为空，不另存已报签名；
    // 回滚（A→B→A）与相信的集合不同，照样报。timestamp 让同文卡不被注入键去重吞掉。
    this.reportedToolSurface = { sessionId: execution.sessionId, names: liveNames };
    this.appendInjectedMessages(execution, execution.runId, [
      {
        role: 'user',
        name: 'vessel:notice',
        content: renderToolSurfaceNotice(
          added.map((name) => ({
            name,
            description: liveTools.find((tool) => tool.name === name)?.description,
          })),
          removed,
        ),
        timestamp: Date.now(),
      },
    ]);
  }

  /**
   * 无 active Run 的 notice：best-effort 写 SessionState 投影缓存。
   */
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
    // 0.57：本 run 的分段耗时账本。起点 = run 真正开始执行（不含上游排队）。
    this.runTiming = createRunTiming(runId);
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
    // 0.56：hook 注入的 `message_id` 下标同口径按 run 重置（与去重集合同一个生命周期）
    this.injectedHookSeq = 0;
    // CONTRACT-prefix-invariant：每 run 只报告一次的事件与旧 additionalContext 去重
    this.systemPromptIgnoredReported = false;
    this.additionalContextDeprecatedReported = false;
    this.legacyAdditionalContextSeen.clear();
    return execution;
  }

  private async endExecution(execution: Run): Promise<void> {
    // 0.57：run 收口时打一行 `run.timing`（一次 run 一条，宪法第十四条：不刷屏）。
    // 放在最前面：即使后面的清理失败，账也已经落地。
    this.runTiming?.finish({
      outcome: this.runTimingOutcome ?? 'failed',
      totalMs: Date.now() - execution.startedAt,
    });
    this.runTiming = undefined;
    this.runTimingOutcome = undefined;
    // 记录本 Run 结束时的水位；下一 Run 重建窗口，无 active Run 时 host 读此值。
    // 0.55 P0：口径 = 下一次请求视图的上界估算（锚点校正 + provider 地板），
    // 不是 `workingContext.tokenCount`（那只是整窗上界，占位后偏大且不含 tools）。
    const context = execution.workingContext;
    const max = context.maxTokens;
    this.lastContextRatioValue =
      typeof max === 'number' && Number.isFinite(max) && max > 0
        ? this.currentContextTokens(execution) / max
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

    // Stage 4：本 Run 的新窗口不从上一 Run 对象复用；总是用「事件日志整份投影 + 会话壳
    // 缓存按内容对账」重新播种（0.54 B3：不再有「位说覆盖到日志尾就 O(1) 复用」那条路，
    // 那条路会让运行中刷新只剩 run 起点的几条 —— P7）。
    const history = await this.loadStoredHistory(sessionId);
    // 0.57：历史加载是一段独立的账。`history=` 给的是**读到了什么规模**，不是「用了多久」——
    // 两者一起才能回答「启动首条消息为什么慢」（消息多 / 每条大 / 投影没命中）。
    this.runTiming?.mark('history');
    this.runTiming?.count('history.messages', history.messages.length);
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
    // 0.52 C / 0.55 P0：真实用量锚点（按会话落盘）。计数现值现在由「下一次请求视图的
    // 上界估算」给出（见 `context/request-view.ts` 合同），锚点只负责把估算校正到
    // provider 口径；`realTokens` 退化成地板值（数字不许倒退）。
    // 必须在 seed 之后注入：播种会 setSessionId，切会话时会把锚点清掉。
    // 落盘锚点同时进本段账本（`contextAccounting`）—— provider 的包装层
    // （`RoleAwareContext`）不转发 `setContextAnchor`，账本才是唯一权威。
    await this.adoptStoredAnchor(execution, stored, history.lastRequestTokens);
    // 0.52：恢复「上次发布过的环境快照指纹」，让重启后的第一条消息能正确去重。
    this.restorePromptContextFingerprint(stored);

    // 0.53 U2：**先**裁决本段的投射模式并钉到窗口上，再压缩 —— 顺序反过来会让
    // 段起点的压缩按上一段的模式判（passthrough 会话会误吃 0.20 体积维度，
    // 请求序列就与「没有投射机制」不同了）。集合的冻结仍在压缩之后（见下）。
    this.primeSegmentProjectionMode(execution, stored);
    // 0.52 V2：压缩只在**段边界**发生 —— 这里是本段的起点（seed 之后、第一条请求之前）。
    // 压缩成功 ⇒ 本段基准 = 压缩后的 seed 视图（`new(compaction)`），段内不再改写历史。
    await this.compactAtSegmentStart(execution);
    // 0.57：压缩**是否发生**必须出现在账上（用户问的是「我们中间做了什么」，
    // 「这一次 run 起点有没有压缩」直接决定第一条请求要等多久）。
    this.runTiming?.mark('compact');

    // 0.52 V1：段起点的占位决策只算一次并冻结（落 SessionState.cleared_tool_call_ids）。
    // 必须在 seed / 压缩之后、本 Run 第一条请求之前：段内不再改，`pop` 之后下一个段起点重算。
    this.freezeSegmentClearedToolResults(execution, stored);

    // system 前缀只允许显式 revision：基底 system / Self Card 只在构造期变化，
    // 0.52 R6：同一 session 的基底确实不同（运行时重建 / 换模型 / 换工具表重新拼装）
    // **不开新会话**，也不许用「洗白 reason」把前缀改写藏起来 —— 追加一张环境信息卡让
    // 变化可见，守卫照旧能把这类技术原因当前缀变化报出来（删 reason 只会更严）。
    const requestBaseSystem = this.runSystemPrompt ?? this.systemPrompt ?? '';
    const previousBaseSystem = this.lastRunSystemPrompts.get(sessionId);
    if (previousBaseSystem !== undefined && previousBaseSystem !== requestBaseSystem) {
      this.appendSystemRevisionNotice();
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
      // model-follow Step D：跨重启 / 换 body 的模型变更通知。历史播种 / 压缩 / 指纹恢复
      // 都已完成、首次 LLM 请求尚未发出；放在 run.started 之后，与下面的注入消息同段，
      // message.injected 归属于已开始的 run。指纹相等 / 已宣告过时是 no-op。
      this.appendModelChangeNotice(execution);

      // 注入消息（C5）：core 不解释其语义（skill / 附件 / 引用文件……），先于用户输入写入并持久化
      //
      // 0.56：每条注入消息在**进入会话的这一处**拿一个稳定 id（`${runId}:inject:下标`），
      // 事件流与上下文/落盘带的是同一个字符串。同一批注入被执行两遍 ⇒ 同一个 id ⇒
      // 渲染层按 id 合并，而不是拿正文去猜（旧数据没有这个字段，退回 0.51 的判据）。
      for (const [injectedIndex, injected] of (opts?.messages ?? []).entries()) {
        const identifiedInjected = withMessageId(
          injected,
          injectedMessageIdOf(runId, injectedIndex),
        );
        this.publishEvent({
          type: 'message.injected',
          run_id: runId,
          data: { run_id: runId, session_id: sessionId, message: identifiedInjected },
          ts: Date.now(),
        });
        this.addContext(identifiedInjected, runId);
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
      //
      // 0.56：用户输入同样在进入会话的这一处拿稳定 id（`${runId}:user`）——
      // 成本只有一行的原因见 `message-identity.ts`；收益是「这一轮的输入是哪条消息」
      // 变成事实而不是推断（旧数据没有该字段时前端照旧退回 0.51 的两道判据）。
      const identifiedUser = withMessageId(effectiveUser, userMessageIdOf(runId));
      this.addContext(identifiedUser, runId);

      // 0.18：用户输入是唯一真相源的一部分（run.started.input 是改写前文本，
      // 不能单独用于恢复）。记录实际写入上下文的消息原文。
      this.publishEvent({
        type: 'user.message',
        run_id: runId,
        data: { run_id: runId, session_id: sessionId, message: identifiedUser },
        ts: Date.now(),
      });

      // 初始保存：先 RunRecord（含 event_cursor），再 SessionState 投影（含缓存覆盖水位
      // `projection_cache_seq` / 旧名 `derived_upto_seq`，由 RunJournal 在落盘前写 —
      // 0.54 B3 起它只是缓存提示，读侧不拿它做任何判定）。
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
   * `index.json` 终态（先落小文件）→ saveSessionState → 发布 run.completed /
   * run.cancelled / run.failed。
   *
   * 为什么 `index.json` 排在 `saveSessionState` **之前**：壳（`sessions/<id>.json`）是
   * 投影缓存，动辄几百 KB～几 MB，一次 `atomicWrite`（含 fsync）在真机上要几百毫秒；
   * 而 `index.json` 是几百字节的元数据。终态是**已经确定的事实**，没有理由让它排在
   * 一份大文件的写后面 —— 排后面的直接后果就是用户先看到的「状态」比事实晚，界面
   * 在那段窗口里只能继续挂着「正在思考」。两处都只写一次，与事件条数无关。
   */
  private async finalizeRun(
    execution: Run,
    sessionState: SessionState,
    outcome: RunTerminalOutcome,
  ): Promise<void> {
    const { runId, sessionId, startedAt, stats } = execution;

    if (outcome.status === 'completed') {
      // 0.57：账上的终态（`endExecution` 收口并打印 `run.timing`）。
      this.runTimingOutcome = 'completed';
      await this.writeRunRecord(execution, 'completed');
      this.finalizeSessionState(execution, sessionState, 'completed');
      // 终态第一落点：小文件、便宜、与投影壳的大小无关（见方法注释）。
      await this.updateSessionIndexBestEffort(sessionState);
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
    // 0.57：run 终态在账上要一眼看出（ended 后再由 `endExecution` 打那一行）。
    this.runTimingOutcome = cancelled ? 'cancelled' : 'failed';
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
    // 与成功路径同一顺序：终态先落 `index.json`，再写投影壳（见 finalizeRun 注释）。
    await this.updateSessionIndexBestEffort(sessionState);
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
    // 0.56 send-first：run 收尾顺手把投影快照推进到日志尾（详见 refreshProjectionSnapshot）。
    // 成功 / 失败两条终态路径都走这里；`void` 是为了不把一次 JSON 序列化 + 后台写挂到
    // run 收尾的返回路径上（用户体感的「那条消息发完了」不该等它）。
    void this.refreshProjectionSnapshot(sessionState.session_id);
    try {
      await this.updateSessionIndex(sessionState);
    } catch (error) {
      this.logger.warn('session index update failed', {
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
    let prependedBaseSystem = false;
    if (
      !history.messages.some(
        (message) => message.role === 'system' && message.compaction_summary !== true,
      ) &&
      this.runSystemPrompt
    ) {
      add({ role: 'system', content: this.runSystemPrompt });
      prependedBaseSystem = true;
    }
    for (const message of history.messages) {
      add(message);
    }
    this.rememberWindowSeqs(workingContext, history, prependedBaseSystem);
  }

  /**
   * 把「窗口第 i 条消息来自哪条事件」记下来（0.56 ctx-recall）。
   *
   * 为什么现在就要做：压缩发生的时刻（段起点 / 用户显式压缩）正是窗口刚播种完的时刻，
   * 而**过了那一刻**消息对象就开始被追加 / 被替换，再想回头对账只能靠猜。所以播种的同时
   * 对齐一次，存在按窗口对象的弱表里；压缩时按 `CompactionReport.removed_indices` 查。
   *
   * 对齐永远**按内容**（`alignMessageSeqs`）：窗口里的消息可能是会话壳缓存的深拷贝，
   * 对象身份对不上，只有内容签名对得上。对不上的记 `undefined` —— 不猜号。
   *
   * 不一致（窗口条数既不等于「历史 + 1」也不等于「历史」）时整份置空：错位的区间读出来
   * 是别人的历史，比「这段读不回来」糟得多。
   */
  private rememberWindowSeqs(
    workingContext: WorkingContext,
    history: StoredHistory,
    prependedBaseSystem: boolean,
  ): void {
    const projection = history.projection;
    if (projection === undefined || history.messages.length === 0) return;
    const aligned = alignMessageSeqs(history.messages, projection.messages, projection.messageSeqs);
    const expected = aligned.length + (prependedBaseSystem ? 1 : 0);
    if (workingContext.messages.length !== expected) return;
    this.windowSeqMaps.set(workingContext, prependedBaseSystem ? [undefined, ...aligned] : aligned);
  }

  /**
   * V4 / G4：用最近一次 provider 请求的 per-request usage 播种**地板值**。
   *
   * 取值来自已落盘的 `llm.response.usage`，**不是** RunRecord 的 `usage`：
   * 后者是整轮累计（例如 53 轮 agentic run 可到 35M），拿它当上下文大小会让
   * 每次新 run 都误判超预算、触发不必要的压缩，既丢历史又多一次摘要调用。
   *
   * ⚠️ 0.55 P0：这个值**不再是现值**（合同 1）。事故里正是它把数字从 778,258 拽回
   * 673,076 —— 上一次响应之后追加的那条 106k 工具结果被整体抹掉，于是三个 run 都以
   * 67% 的假象发出一个 105% 的真实请求。现在它只做 `correctedContextTokens` 的地板
   * （`max`），现值来自「下一次请求视图的上界估算」；锚点由 `adoptStoredAnchor` 接。
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
      // 0.52 R6：resume 是**续段**（追加），不需要前缀失效 reason。删掉 reason 之后守卫
      // 照旧会对「基底 system 真的变了」报警（`prompt.prefix_changed`），不会静默放过。
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
      // 0.55 P0：改由 `adoptStoredAnchor` 一次接进本段账本（锚点 + 地板值 + 窗口注入），
      // 且必须在 seed 之后（seed 会 clear 窗口、切会话会清锚点）。
      this.seedWorkingContext(execution, history);
      this.seedRealTokensFromLastRequest(execution, history);
      await this.adoptStoredAnchor(
        execution,
        history.sessionState ?? null,
        history.lastRequestTokens,
      );
      // 0.53 U2：resume 同为段起点 —— 模式也要在压缩之前先钉住（同 run()）。
      this.primeSegmentProjectionMode(execution, history.sessionState ?? null);
      // 0.52 V2：resume 也是一个段起点 —— 压缩同样只在这里做一次。
      await this.compactAtSegmentStart(execution);
      // 0.52 V1：resume 也是一个段起点 —— 占位决策同样只在这里算一次并冻结。
      this.freezeSegmentClearedToolResults(execution, history.sessionState ?? null);

      const sessionState = this.createSessionState(
        sessionId,
        runId,
        history.sessionState,
        execution.branch,
        Date.now(),
      );
      // 0.18：先发布 run.resumed，再落盘；否则缓存覆盖水位（`projection_cache_seq`，
      // 旧名 `derived_upto_seq`）会漏掉这条事件（legacy RunRecord 复用 session 时尤其明显）。
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

      // model-follow Step D：resume 同为（重）建 EU 的续接 run —— 重启后换模型接管时
      // 同样在首次请求前宣告（指纹已在上方按本会话恢复；播种 / 压缩之后，进初始保存）。
      this.appendModelChangeNotice(execution);

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
        appendPiiDeadNotice: () => this.appendPiiDeadNotice(execution.sessionId),
        appendToolSurfaceNotice: () => this.appendToolSurfaceNotice(execution),
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
        // tools-body-snapshot：请求面读会话快照（ensureToolPin），不再每轮 live 读宿主；
        // 执行侧（runToolCall → toolPipeline.getTool）保持 live 不变。
        listToolSchemas: () => this.ensureToolPin(execution.sessionId).schemas,
        isConcurrencySafe: (e) => this.isConcurrencySafe(e),
        runToolCall: (e, s) => this.runToolCall(e, execution, s),
      },
      events: {
        emit: (e, o) => this.publishEvent(e, o),
      },
      ...(this.runTiming !== undefined ? { timing: this.runTiming } : {}),
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
   * - **context-overflow**（400）：0.52 V2 起**不再**就地压缩重试 —— run 内不许改写历史
   *   （见 `appendContextOverflowNotice`）：追加一张「超限」卡并原样抛出，下一个段起点压缩。
   *
   * 取消优先：`AbortSignal` 中断（用户取消 / rotate / shutdown）立即抛出，不退避、
   * 不重试；退避期间不改 run 状态、不碰租约。
   *
   * 每次真实请求都递增 request 计数并发布 `llm.request`。0.52 V2：run 内**不再**压缩 --
   * 撑爆上下文就追加一张「超限」卡并原样抛出，压缩留给下一个段起点（`new(compaction)`），
   * 所以这里不再有「重试时看到另一份历史」的路径。
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
      /** 重新按当前窗口组装请求；0.52 V2 起 run 内不改写历史，保留位给段起点以后的路径。 */
      rebuildMessages: () => Message[];
    },
  ): Promise<LLMResponse> {
    const { runId, stats } = execution;
    const messages = args.messages;
    let overflowRetried = false;

    // ── 0.56：图片计划（请求期算一次，整条重试链复用）───────────────────────────
    // 位置就是 design §3.3 的步 ②：在 `buildRequestMessages` 之后、发送前闸之前。
    // **重试必须复用同一份 plan**：字节在入池时已冻结，重算只会重复 I/O；更重要的是
    // plan 进请求体，重试换一份字节就是「同一条请求两次内容不同」。
    // 无图（绝大多数会话）= 空计划，请求体与 0.55 逐字节相同。
    const attachmentPlan = await this.resolveAttachmentPlanFor(messages);
    this.reportImageDelivery(execution, args.sessionId, attachmentPlan);
    const attachmentTokens = attachmentPlan.tokens;

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

      // ── 0.55 P0：上下文计数 / 发送前闸 ────────────────────────────────────────
      // 这个 `messages` 就是**请求视图**（`buildRequestMessages` 之后、
      // `withClearedToolResults` 之后），也是合同（`context/request-view.ts`）要求
      // 估算的那一份。三件事按顺序做：
      //   1) 估算 + 记进本段账本（此后 `context.changed` / 预警 / 下一轮都从它增量推）；
      //   2) 发送前闸：按锚点校正（无锚点用保守上界）≥ 窗口上限 ⇒ **不发**；
      //   3) 把同一个数写进 `llm.request.estimated_tokens`（显示 / `sessions.get` 的口径）。
      // 顺序不能反：闸先判定，判定通过才允许发事件与请求 —— 否则日志里会出现一条
      // 「请求已发出」但实际没发的假事实。
      const requestViewTokens = estimateRequestViewTokens(messages, {
        tools: args.tools,
        // 0.56：图片 token **必填**（没有图也要显式传 0）。漏传 = 闸低估 = 必然 400。
        attachments: { tokens: attachmentTokens },
      });

      this.accounting(execution).requestView = {
        tokens: requestViewTokens,
        messageCount: messages.length,
      };
      const contextUsed = this.correctedContextTokens(execution, requestViewTokens);
      if (contextMax !== undefined && contextUsed >= contextMax) {
        // 压缩只在段起点发生（`compactAtSegmentStart`）。走到这里说明「段起点压缩之后
        // 仍然装不下」（典型：单条巨型工具结果，或压缩刚做完又追加了一大坨输出）。
        // 此时发出去必然被 provider 400 打回（今天真实发生了三次），所以不发：
        // 把原因写进两个可见处（env 卡 + `run.failed`）与一条 `context.pressure`（环）。
        this.publishEvent({
          type: 'context.pressure',
          run_id: runId,
          data: {
            run_id: runId,
            session_id: args.sessionId,
            used: contextUsed,
            max: contextMax,
            ratio: contextUsed / contextMax,
            threshold: CONTEXT_PRESSURE_WARN_RATIO,
            hint:
              'request not sent: context window exceeded; compact at the next segment start ' +
              'or start a new session',
          },
          ts: Date.now(),
        });
        this.appendNotice(
          renderContextWindowExceededNotice({ used: contextUsed, max: contextMax }),
        );
        // 阶段写成 run（而不是 llm）：这是本地闸拦下的，不是 provider 报错，
        // `run.failed` 的 envelope 因此是 `context_window_exceeded` + `{used, max}`。
        execution.phase = 'run';
        throw new ContextWindowExceededError(contextUsed, contextMax);
      }

      // 「模型这一轮看到的系统消息」（基底 system prompt + Self Card）紧贴着请求落一条
      // 独立事件：`composeRunSystemPrompt()` 已在 run 开始时拼好，这里有 `messages` /
      // `tools` 的最终条数，正是折叠态摘要要的那几个数。同 hash 只发一次（见
      // `publishSystemContext`），绝不把 prompt 塞进 `llm.request`。
      this.publishSystemContext(execution, {
        messageCount: messages.length,
        toolsCount: args.tools.length,
        estimatedTokens: contextUsed,
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
            // 0.55 P0：**请求视图**的估算（`args.messages` 的上界估算 + tools），
            // 按锚点校正、以 provider 上一次回报为地板。它回答的是「这一次请求有多大」，
            // 不再是「上一次 provider 回报了多少」（那就是 67% vs 105% 的来源）。
            // 读侧（`sessions.get.context_usage.used`）用的就是它。
            estimated_tokens: contextUsed,
            // 上下文窗口上限随事件落盘（与 `estimated_tokens` 并列的一个整数）：
            // 历史会话因此自足 —— 读侧（`sessions.get.context_usage.max`）不必再
            // 回推「当时的配置值」，按 agent / 模型配不同窗口时也不会串。
            // 只加这一个整数：`messages` / `tools` 正文照旧不落盘。
            ...(contextMax !== undefined ? { context_max: contextMax } : {}),
            attempt,
            stream: true,
            ...(this.includeReasoning ? { include_reasoning: true } : {}),
            // 0.56：图片的**计价读数**（只有数字与 sha8，没有 base64、没有字节）。
            // 落盘的理由与 `estimated_tokens` 同一条：出问题时（涨了 40 万 token、
            // 该发的没发）要能从日志里看出「这一轮算了几张、算成多少 token」。
            ...(attachmentPlan.images > 0 || attachmentPlan.dropped.length > 0
              ? { images: summarizeAttachmentPlan(attachmentPlan) }
              : {}),
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
      // 0.57：run 账上的 `llm` 段 = 第一条请求发出的时刻（前面的时间都花在我们这边：
      // 历史加载 / 压缩 / 组请求）。之后几轮的请求起点不再覆盖它。
      this.runTiming?.mark('llm');

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
        // 0.56：这一轮要发的图。**只有适配器读它**（`Message` 一个字节没变）；
        // 一张都没发时缺省 ⇒ 请求体与 0.55 逐字节相同（P0-13）。
        ...(attachmentPlan.images > 0 ? { attachment_plan: attachmentPlan } : {}),
        // 流式（ADR-007）：始终提供 stream + on_chunk。支持流式的 Provider 边收边经回调吐增量，
        // loop 在此发布 LlmStreamChunk 事件供 TUI 订阅渲染；不支持流式的 Provider 忽略字段、
        // 退化为整段返回（无 chunk 事件，无副作用）。chat() 仍返回完整 LLMResponse。
        stream: true,
        on_chunk: (chunk) => {
          if (streamsAssistantOutput(chunk)) streamed = true;
          // 0.57：首个真实增量 = 用户看到的「开始输出」那一刻（mark 保留第一次）。
          if (streamsAssistantOutput(chunk)) this.runTiming?.mark('first_token');
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
        // 0.52 C / 0.55 P0：真实用量到达的那一刻记下校正比。分子是 provider 的
        // `prompt_tokens`，分母是**这一次请求视图**的同一个上界估算（`requestViewTokens`
        // 就在上面算过）—— 同口径才叫校正（合同 3）。比值随 `saveSessionState` 落进
        // `SessionState.context_anchor`，重启后由 `adoptStoredAnchor` 读回来。
        this.recordProviderPromptTokens(
          execution,
          response.usage?.prompt_tokens ?? 0,
          requestViewTokens,
        );
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
        // 0.55 P0：**把这一次 400 当实测读数**（provider 亲口说的输入大小）。
        // 记成锚点（比值 = 它报的 token ÷ 本次请求视图的上界估算）+ 地板，于是：
        // - 显示立刻变成真实量级（事故里会从 67% 变成 105%），不再是「上一次回报」；
        // - 下一个段起点的压缩按真实口径触发（窗口地板 ≥ 窗口上限 ⇒ 必然压缩）；
        // - 压缩后仍装不下时，发送前闸会**不发**，不再重复 400。
        // 读不出数字（文案里没有 token 数）时至少把地板抬到窗口上限 —— provider 已经说
        // 「这次输入超了」⇒ 这一次请求的真实大小 ≥ 窗口上限，这是下界，不是猜测。
        const reported = reportedContextTokens(errorText(error));
        const overflowFloor = reported ?? (contextMax !== undefined ? contextMax : undefined);
        if (overflowFloor !== undefined) {
          this.recordProviderPromptTokens(execution, overflowFloor, requestViewTokens);
        }
        // 0.52 V2：run 内**不许**改写历史（旧行为是 `forceCompact(execution, 'overflow')`
        // 删中段 + 插新摘要后重试 ⇒ 一次 run 里出现两个历史视图）。现在只追加一张
        // 「超限」卡并把本次 Run 以原始错误收尾：压缩发生在下一个段起点
        // （`compactAtSegmentStart`），那里开的是 `new(compaction)` 新段。
        this.appendContextOverflowNotice();
        this.logger.warn('context overflow; run ends here, next run starts a new segment', {
          run_id: runId,
          streamed,
          reported_tokens: reported,
          error: errorText(error),
        });
        // 重写前缀只为让 envelope 给出 `provider_context_overflow`（原文一字不动地保留）。
        throw new ProviderContextOverflowError(error);
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
      const tokensBefore = context.tokenCount;
      removed = context.compactAsync ? await context.compactAsync() : context.compact();
      this.publishCompacted(
        context,
        execution.runId,
        execution.sessionId,
        removed,
        'manual',
        undefined,
        tokensBefore,
      );
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
      const tokensBefore = context.tokenCount;
      removed = context.compactAsync ? await context.compactAsync() : context.compact();
      this.publishCompacted(context, 'manual', target, removed, 'manual', undefined, tokensBefore);
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

  /**
   * 强制压缩一次（用户显式压缩；压缩失败不覆盖调用方的原始错误）。
   *
   * 0.52 V2：**唯一**合法的压缩时机是段边界 —— 用户显式压缩（两次 run 之间）与 run 起点
   * （`compactAtSegmentStart`）。run 内撑爆上下文走「超限」卡 + 收尾失败，不再走这里。
   */
  // 0.52：保留为公开的手动压缩入口（ 侧透传）；run 内不再调用，
  // 唯一合法时机是段边界 —— 见下方 V2 注释。
  async forceCompact(
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
      const tokensBefore = workingContext.tokenCount;
      const removed = workingContext.compactAsync
        ? await workingContext.compactAsync()
        : workingContext.compact();
      this.publishCompacted(
        workingContext,
        runId,
        sessionId,
        removed,
        reason,
        undefined,
        tokensBefore,
      );
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
    let prependedBaseSystem = false;
    if (
      !history.messages.some(
        (message) => message.role === 'system' && message.compaction_summary !== true,
      ) &&
      baseSystem
    ) {
      workingContext.add({ role: 'system', content: baseSystem, timestamp: Date.now() });
      prependedBaseSystem = true;
    }
    for (const message of history.messages) {
      workingContext.add(message);
    }
    // 0.56 ctx-recall：这条路径（idle 压缩）同样是段边界，同样要能写索引区间。
    this.rememberWindowSeqs(workingContext, history, prependedBaseSystem);
  }

  /**
   * 0.53 U2：`passthrough` 下的体积压力观测（**只发事件，不驱动压缩**）。
   *
   * 为什么不压缩：`passthrough` 的语义是「与完全没有投射机制时逐字节相同」，
   * 按体积开新段 / 压缩本身就是机制产物，会改变请求消息序列。压力必须仍然可见，
   * 否则「宣告了 passthrough 的会话其实一直在爆窗口」就没人知道。
   *
   * `basis: 'all_tool_results'` 显式标口径：量的是窗口里全部工具结果的原文，
   * 不是保留口径的判据（判据只在 `placeholder` 下用，见 `shouldCompact()`）。
   * 同时带上 ADR-104 §5.2 里的 `retained_tokens / max_tokens / top_result_bytes`
   * 等价字段，读事件的人不必自己换算。
   */
  private publishProjectionPressure(window: WorkingContext, runId: string): void {
    const max = window.maxTokens ?? 0;
    if (max <= 0) return;
    const pressure: ToolResultPressureReport = measureToolResultPressure(window.messages, max);
    // 没触顶就不发：事件是「压力触顶」的观测面，不是每段一条的日志噪声。
    if (!pressure.exceeded) return;
    this.publishEvent({
      type: 'context.projection_pressure',
      run_id: runId,
      ts: Date.now(),
      data: {
        used: pressure.used,
        max: pressure.max,
        ratio: pressure.ratio,
        basis: pressure.basis,
        threshold_ratio: pressure.thresholdRatio,
        total_count: pressure.totalCount,
        // ADR-104 §5.2 的同义字段（换算关系见事件文档）：不给读侧留换算工作。
        retained_tokens: pressure.retainedTokens,
        max_tokens: pressure.max,
        retained_ratio: pressure.retainedRatio,
        top_result_bytes: pressure.topResultTokens,
        effective_mode: 'passthrough',
      },
    });
  }

  /**
   * 0.15 E1：removed>0 时发布 `context.compacted`；0.32 同时把摘要落事件日志。
   *
   * 0.56 ctx-recall：**同时写出压缩索引**（`data.compaction`）并在摘要正文末尾追加一条
   * 极短 stub —— 于是「被替换的是哪些消息、原来在哪、被谁替换」这三件事都可查，模型也能
   * 按 id 把原文读回来。见 `context/compaction-index.ts`。
   *
   * 为什么索引落盘是「发出即不管」：`publishCompacted` 被 run 内的同步发布点调用（loop 的
   * `publishCompacted` 回调 / `add()` 内的补发），把它整条改成 async 会污染那条链路。
   * 事件（事实）已经**同步**发出去，文件只是物化缓存 —— 写失败只记日志，读回不受影响
   * （`deriveCompactionIndex` 可从事件重建）。
   */
  private publishCompacted(
    workingContext: WorkingContext,
    runId: string,
    sessionId: string,
    removed: number,
    reason: ContextCompactedReason,
    decision?: SegmentCompactionDecision,
    tokensBefore = 0,
  ): void {
    if (removed <= 0) return;
    // C2：直发路径（loop 自动 / overflow / manual）发布后记录 id，
    // 使 `addContext` 的补发不会对同一次压缩重复发事件。
    const report = workingContext.lastCompaction;
    if (report !== undefined) this.lastReportedCompactionId.set(runId, report.id);
    const remaining = workingContext.messages.length;
    const compaction =
      workingContext.getSessionId() === sessionId
        ? this.buildCompactionEntry(workingContext, sessionId, removed, reason, tokensBefore)
        : undefined;
    if (compaction !== undefined) {
      // 先记账再渲染 stub：stub 要列出**含这一段在内**的全部段（多段累积），
      // 顺序反过来会让最新那一段在 stub 里缺一行（真机验证抓到过：stub 只列到 id=1，
      // 而当时已经是第 3 段）。
      this.rememberCompaction(sessionId, compaction);
      // stub 只在这里写**一次**：之后再也不会被改写（摘要正文也跟着冻结），所以同一会话
      // 连续两次请求里这一段逐字节相同（`stub_prefix_stable` 的证据基础）。
      appendCompactionStub(
        workingContext.messages,
        formatCompactionStub(this.sessionCompactions.get(sessionId) ?? []),
      );
    }
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
        // 0.56 ctx-drop：判据的输入（段起点那条路径才有）。请求长度掉一大截时，
        // 这张表就是「为什么」：估算多少、乘了哪个系数（有锚点 = 实测比值，
        // 无锚点 = 1.15 保守边距）、跟哪条线比、多出来的那截是什么。
        ...(decision !== undefined ? { decision } : {}),
        ...(decision !== undefined ? { messages_before: decision.messages_before } : {}),
        // 0.56 ctx-recall：这次替换的索引（被替换的区间 / 条数 / 摘要指纹 / 前后体积）。
        // 缺省（降级 / 会话在 await 期间被切走）⇒ 不写，读侧就当「这一段没有索引」。
        ...(compaction !== undefined ? { compaction } : {}),
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
    // 索引落盘放在事件之后：事件是事实（丢了也能 `deriveCompactionIndex` 重建），
    // 索引文件是**物化缓存**，晚一步没关系；写失败只记日志（见 appendCompactionIndex）。
    if (compaction !== undefined) this.writeCompactionIndex(sessionId, compaction);
  }

  /**
   * 把一条索引追加进会话目录（fire-and-forget；**永不抛**）。
   *
   * 为什么可以不 await：`context.compacted` 已经同步发出去了（事实在），这份文件只是给
   * `recall` 无参列表用的物化索引；延迟一拍写进去不影响任何正确性。
   */
  private writeCompactionIndex(sessionId: string, entry: CompactionIndexEntry): void {
    const dir = this.compactionDirOf(sessionId);
    if (dir === undefined) return;
    void appendCompactionIndex(dir, entry).then(
      (written) => {
        if (written) return;
        this.logger.warn('compaction index write failed', {
          session_id: sessionId,
          compaction_id: entry.compaction_id,
        });
      },
      () => undefined,
    );
  }

  /**
   * 由「窗口 + 报告」算出这次压缩的索引条目（0.56 ctx-recall）。
   *
   * 三件事都要如实：
   * 1. **区间**：`CompactionReport.removed_indices` 给出被移除消息在压缩前窗口里的下标，
   *    `windowSeqMaps` 把下标翻成事件 seq；对不上的**记 `undefined`**（→ `unmapped_messages`），
   *    不猜一个相邻号；
   * 2. **摘要指纹**：取摘要正文（**不含** stub —— stub 是索引的消费者），`summary_sha8`
   *    因此可复算、可对账；
   * 3. **前后体积**：`tokensBefore` 是压缩前窗口的估算（调用方在压缩**之前**取），
   *    `tokensAfter` 取当下的窗口估算。
   *
   * 拿不到摘要消息（降级 / 会话被切走）⇒ `undefined`：宁可不写索引，也不写一条指向
   * 不存在摘要的账。
   */
  private buildCompactionEntry(
    workingContext: WorkingContext,
    sessionId: string,
    removed: number,
    reason: ContextCompactedReason,
    tokensBefore: number,
  ): CompactionIndexEntry | undefined {
    const messages = workingContext.messages;
    let summaryIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate?.role === 'system' && candidate.compaction_summary === true) {
        summaryIndex = index;
        break;
      }
    }
    if (summaryIndex < 0) return undefined;
    const summary = messages[summaryIndex] as Message;
    const report = workingContext.lastCompaction;
    const indices = report?.removed_indices ?? [];
    const seqMap = this.windowSeqMaps.get(workingContext);
    const removedSeqs: (number | undefined)[] = [];
    for (let offset = 0; offset < removed; offset += 1) {
      const index = indices[offset];
      removedSeqs.push(index === undefined ? undefined : seqMap?.[index]);
    }
    const existing = this.sessionCompactions.get(sessionId) ?? [];
    const nextId = existing.reduce((max, entry) => Math.max(max, entry.compaction_id), 0) + 1;
    return buildCompactionIndexEntry({
      compaction_id: nextId,
      at: summary.timestamp ?? Date.now(),
      reason,
      summary: summary.content,
      removedSeqs,
      tokens_before: tokensBefore,
      tokens_after: workingContext.tokenCount,
    });
  }

  /** 记住一条索引（同 id 覆盖：重放 / 二次发布会走到这里）。 */
  private rememberCompaction(sessionId: string, entry: CompactionIndexEntry): void {
    const existing = this.sessionCompactions.get(sessionId) ?? [];
    const next = existing.filter((item) => item.compaction_id !== entry.compaction_id);
    next.push(entry);
    next.sort((left, right) => left.compaction_id - right.compaction_id);
    this.sessionCompactions.set(sessionId, next);
  }

  /**
   * 把会话壳里已有的索引接进内存（0.56 ctx-recall）。
   *
   * 只做「补齐」：内存里已有的条目按 id 去重后保留（本进程写的更新鲜），再补上壳里的。
   * 壳里没有（老会话 / 还没压缩过）⇒ 什么都不做。
   */
  private adoptStoredCompactions(sessionId: string, stored: SessionState | null): void {
    const storedEntries = stored?.compactions;
    if (storedEntries === undefined || storedEntries.length === 0) return;
    const merged = new Map<number, CompactionIndexEntry>();
    for (const entry of storedEntries) merged.set(entry.compaction_id, entry);
    for (const entry of this.sessionCompactions.get(sessionId) ?? []) {
      merged.set(entry.compaction_id, entry);
    }
    const sorted = [...merged.values()].sort(
      (left, right) => left.compaction_id - right.compaction_id,
    );
    this.sessionCompactions.set(sessionId, sorted);
  }

  /**
   * 某会话的索引文件所在目录。
   *
   * 两个来源，先显式后推导：
   * 1. `compactionIndexDir`（装配层给的 `<dataDir>/sessions`）；
   * 2. 读口自己知道会话目录时（`TimelineEventLog.sessionDir`）用它 —— 这样**任何**
   *    已经装了时间线读口的装配（含成员侧那条路）都能写索引，不必每处都传一个目录。
   *
   * 两者都没有 ⇒ `undefined`：索引只留在事件与内存里（读回仍可由
   * `deriveCompactionIndex` 重建），不假装写过。
   */
  private compactionDirOf(sessionId: string): string | undefined {
    const sessionsDir = this.compactionIndexDir;
    if (sessionsDir !== undefined && sessionsDir !== '') {
      return sessionDirPath(sessionsDir, sessionId);
    }
    const port = this.eventLog as { sessionDir?: (id: string) => string } | undefined;
    const derived = typeof port?.sessionDir === 'function' ? port.sessionDir(sessionId) : undefined;
    return typeof derived === 'string' && derived !== '' ? derived : undefined;
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
    // 0.55 P0：与显示 / 闸同一个数（下一次请求视图的上界估算，锚点校正后），
    // 不是 `workingContext.tokenCount` —— 两处口径必须一致，否则「环」与「闸」打架。
    const used = this.currentContextTokens(execution);
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
      /** O4 additive：执行位置（管道认领的转发回执；缺省 = in_process 旧语义）。 */
      transport?: ToolTransport;
      /** O4 additive：vessel-bridge 改写溯源（replacement 对象打标）。 */
      viaBridge?: boolean;
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
        // O4 additive：缺省不写 = 旧事件逐字节不变。
        ...(opts.transport !== undefined ? { transport: opts.transport } : {}),
        ...(opts.viaBridge === true ? { via_bridge: true } : {}),
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
          viaBridge: isBridgeCall(toolCall),
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
            transport: result.transport,
            viaBridge: isBridgeCall(toolCall),
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
          // O4 additive：缺省不写 = 旧事件逐字节不变。
          ...(result.transport !== undefined ? { transport: result.transport } : {}),
          ...(isBridgeCall(toolCall) ? { via_bridge: true } : {}),
        },
        ts: Date.now(),
      });

      return {
        toolCall,
        input: result.input,
        ok: true,
        content: result.content,
        // 0.56 闸上移：handler 自己裁过的结果不再过 loop 的闸（否则省略标注会被裁掉）
        ...(result.bounded === true
          ? { bounded: true as const, original_chars: result.original_chars }
          : {}),
      };
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
          viaBridge: isBridgeCall(toolCall),
        }),
      };
    }
  }

  /**
   * 消费 BeforeLlm 的 `ctx.messages`（0.16 E5）：逐条写入上下文一次。
   * 已注入的消息按稳定键（`name` / `timestamp`）去重；两者都缺失时按对象引用去重。
   *
   * 0.56：这一条通道同样在**进入会话的这一处**盖 `message_id`（`${runId}:inject:hook:<n>`）。
   * 不补这里会留下一整类「没有身份」的人类可见消息（环境卡 / 收件箱提示 / Self Card
   * delta / refs 提示 / 订阅通知都从这里进库），前端只能退回内容比较 —— 正是本单要根除
   * 的那件事。id 必须与落盘、事件流是**同一个字符串**，所以盖章点只能在这一处。
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
      const identified = withMessageId(
        message,
        injectedHookMessageIdOf(runId, this.injectedHookSeq),
      );
      this.injectedHookSeq += 1;
      this.publishEvent({
        type: 'message.injected',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: execution.workingContext.getSessionId(),
          message: identified,
        },
        ts: Date.now(),
      });
      this.addContext(identified, runId);
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
  /**
   * 0.56：为**这一次请求**算出图片计划（design §3.3 步 ②）。
   *
   * 三件事一次做完，顺序不能变：
   * 1. 能力问 `this.provider.vision`（插件的 `VisionBackend`；`undefined` = 没有视觉）；
   * 2. 设置问 `this.visionSettings` + env（kill switch 是**唯一**的回退通道，不是门）；
   * 3. 字节只从 blob 读（`vision/plan.ts` 的 `readImageBlob`）——**永不**回源读
   *    `refs[].path`（那就是「用户改了原图 ⇒ 前缀变化」的入口）。
   *
   * 无图时返回空计划（一次 `Map` 分配，没有 I/O），请求体与 0.55 逐字节相同。
   */
  private async resolveAttachmentPlanFor(messages: readonly Message[]): Promise<AttachmentPlan> {
    const hasImageRef = messages.some((message) =>
      (message.refs ?? []).some((ref) => ref.kind === 'image'),
    );
    if (!hasImageRef) return EMPTY_ATTACHMENT_PLAN;
    return resolveAttachmentPlan({
      messages,
      ...(this.provider.vision !== undefined ? { backend: this.provider.vision } : {}),
      ...(this.visionSettings !== undefined ? { settings: this.visionSettings } : {}),
    });
  }

  /**
   * 0.56：把图片投递事实写成事件（**GUI 三态 chip 的唯一数据源**）。
   *
   * 为什么是事件而不是 `refs` 上的字段（design §6.3 禁止项 1）：`refs[]` 里加
   * `status` / `sent_at` 会 ① 改写历史前缀（前缀守卫逐条 `JSON.stringify(message)`）且
   * ② 被 `messageSignature` 无视（它只取 `kind:path`）—— 最坏的一类字段：既不进签名、
   * 又污染前缀。所以状态只从事件派生（`image.sent` / `context.image_dropped`），随 wire
   * 投影下发。
   *
   * 去重：(session, sha8, 结果) 只记一条 —— plan 每轮重算，同一张历史里的图会被反复解析
   * 出来，不去重就会随轮数线性增长（P0-09 的幂等性判据）。
   */
  private reportImageDelivery(execution: Run, sessionId: string, plan: AttachmentPlan): void {
    const { runId } = execution;
    if (plan.disabled === true && !this.visionDisabledReported.has(sessionId)) {
      this.visionDisabledReported.add(sessionId);
      this.publishEvent({
        type: 'vision.disabled',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: sessionId,
          source: this.visionSettings?.disabled === true ? 'config' : 'env',
          images_withheld: plan.dropped.length,
        },
        ts: Date.now(),
      });
    }
    const reported =
      this.reportedImageDelivery.get(sessionId) ??
      ((): Set<string> => {
        const fresh = new Set<string>();
        this.reportedImageDelivery.set(sessionId, fresh);
        return fresh;
      })();
    const perImageTokens = this.provider.vision?.tokenCost(1);
    for (const [messageIndex, images] of plan.byMessageIndex) {
      for (const image of images) {
        const sha8 = sha8Of(image.sha256);
        const key = `sent:${sha8}`;
        if (reported.has(key)) continue;
        reported.add(key);
        this.publishEvent({
          type: 'image.sent',
          run_id: runId,
          data: {
            run_id: runId,
            session_id: sessionId,
            message_index: messageIndex,
            sha8,
            sha256: image.sha256,
            media_type: image.media_type,
            bytes: image.bytes,
            ...(perImageTokens !== undefined ? { tokens: perImageTokens } : {}),
            ...(plan.backend !== undefined
              ? { backend: plan.backend.id, kind: plan.backend.kind }
              : {}),
            model: this.model,
          },
          ts: Date.now(),
        });
      }
    }
    for (const drop of plan.dropped) {
      const sha8 = drop.sha256 !== undefined ? sha8Of(drop.sha256) : '';
      const key = `drop:${sha8 !== '' ? sha8 : drop.path}:${drop.reason}`;
      if (reported.has(key)) continue;
      reported.add(key);
      this.publishEvent({
        type: 'context.image_dropped',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: sessionId,
          message_index: drop.message_index,
          count: 1,
          reason: drop.reason,
          label: imageDropLabel(drop.reason),
          status: imageDropStatus(drop.reason),
          ...(sha8 !== '' ? { sha8 } : {}),
          path: drop.path,
        },
        ts: Date.now(),
      });
    }
  }

  /**
   * 0.56：占位替换顺带删掉图片引用时，把这件事写成事件（`reason: 'placeholder'`）。
   *
   * 为什么必须成对：占位的意义是「这条工具结果省掉」，而图在 `refs` 里 —— 只换文本不删
   * 引用，就是「花了钱还看不到」（design §7.6 的第一行）。这条事件让 GUI 把那条消息的
   * chip 从「已发送」改成「已丢弃（占位）」，同时给 P1 的 TUI 留下数据源。
   *
   * 去重键与 `reportImageDelivery` 同一套（session + sha8 + 结果）：请求视图每轮都重建，
   * 不去重就会每轮重复记一条。
   */
  private reportPlaceholderImageDrops(before: readonly Message[], after: readonly Message[]): void {
    const run = this.activeRun;
    if (run === undefined) return;
    const reported = this.reportedImageDelivery.get(run.sessionId);
    for (let index = 0; index < before.length; index += 1) {
      const was = before[index];
      const now = after[index];
      if (was === undefined || now === undefined || was === now) continue;
      const imagesBefore = (was.refs ?? []).filter((ref) => ref.kind === 'image');
      if (imagesBefore.length === 0) continue;
      const imagesAfter = (now.refs ?? []).filter((ref) => ref.kind === 'image');
      if (imagesAfter.length >= imagesBefore.length) continue;
      for (const ref of imagesBefore) {
        const sha8 = ref.sha256 !== undefined ? sha8Of(ref.sha256) : '';
        const key = `drop:${sha8 !== '' ? sha8 : ref.path}:placeholder`;
        if (reported?.has(key) === true) continue;
        reported?.add(key);
        this.publishEvent({
          type: 'context.image_dropped',
          run_id: run.runId,
          data: {
            run_id: run.runId,
            session_id: run.sessionId,
            message_index: index,
            count: 1,
            reason: 'placeholder',
            label: imageDropLabel('placeholder'),
            status: imageDropStatus('placeholder'),
            ...(sha8 !== '' ? { sha8 } : {}),
            path: ref.path,
          },
          ts: Date.now(),
        });
      }
    }
  }

  private buildRequestMessages(
    systemOverrideInput: unknown,
    workingContext: WorkingContext,
  ): Message[] {
    const normalized = this.normalizeMessages(workingContext.messages);
    // 0.53 U2：`passthrough` ⇒ 请求视图**就是**落盘历史（不跑 plan、不替换、不加占位），
    // 与「完全没有投射机制」逐字节相同。这里读的是段起点钉死的模式，不是当前
    // messages 重算出来的东西 —— run 内不重算。
    const runtimeMode = windowProjectionMode(workingContext);
    const frozen = this.segmentClearPlans.get(workingContext) ?? [];
    // 0.52 V1：只应用「本段冻结」的集合，**不再**按当前 messages 重算窗口；
    // 没冻结过（非常规入口）= 一条都不清，请求视图与落盘逐字一致。
    const prepared =
      runtimeMode === 'passthrough' ? normalized : withClearedToolResults(normalized, frozen);
    if (prepared.some((message, index) => message !== normalized[index])) {
      // 占位替换是真实的（已声明）前缀变化：不标 reason 的话守卫会当成「莫名重写」。
      this.pendingPrefixReason ??= 'context_trim';
      // 0.56：占位同时删掉了图片引用 ⇒ 写一条 `context.image_dropped{reason:'placeholder'}`
      // （不是静默：GUI 的 chip 要能从「已发送」变「已丢弃（占位）」）。
      this.reportPlaceholderImageDrops(normalized, prepared);
    }
    // 0.52（用户裁定两条不变量）：脱敏**不在这里**做。
    // - 可见性对等：UI 渲染的就是 store 里的字节 ⇒ 脱敏必须在 **append 侧**
    //   （见 `maskForAppend`），请求侧只做组装；
    // - 请求 messages 只许 append：这里不再改写/投影任何一条历史（前缀缓存不能废）。
    // 句柄失效同样以**追加一张 env 卡**表达（见 `appendPiiDeadNotice`），不回改历史。
    const messages = prepared;
    // 压缩摘要也是 role=system：它不是基底 system，缺省补回与 hook 改写都不能替换它。
    const isBaseSystem = (m: Message): boolean => m.role === 'system' && !m.compaction_summary;
    const systemOverride =
      typeof systemOverrideInput === 'string' && systemOverrideInput
        ? systemOverrideInput
        : undefined;
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
      //
      // 0.56：这条通道同样是「消息进入会话」，所以同样补 `message_id`（只补缺；调用方
      // 已在构造处盖过章的原样保留）。id 用 `notice` 作为归属段：无 active run 时没有
      // run id 可拼，时间戳是这条消息唯一的稳定事实。
      const identified =
        typeof stamped.message_id === 'string' && stamped.message_id.length > 0
          ? stamped
          : withMessageId(stamped, noticeMessageIdOf('notice', stamped.timestamp ?? Date.now()));
      void this.appendNoticeToSnapshot(identified).catch((error: unknown) => {
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
    // 0.52：脱敏落在 **append 侧** —— 落盘即占位符，store / 请求 / UI 共用同一份字节
    // （可见性对等），并且请求 messages 天然只增不改（前缀缓存不废）。
    const masked = this.maskForAppend(identified, execution.sessionId);
    const workingContext = execution.workingContext;
    workingContext.add(masked);
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
        // 0.55 P0：同一个现值口径（下一次请求视图的上界估算 + 锚点校正 + 地板）。
        // 以前这里是 `workingContext.tokenCount` = 上一次 provider 回报 + 增量，
        // 也就是事故里那条「刚追加了 106k 却还显示 67%」的数。
        token_count: this.currentContextTokens(execution),
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
   * 0.18：恢复历史（run 启动 / resume 共用）。0.54 B3 起是**纯读侧**：
   *
   * 1) 事件日志投影（`extendProjection`，原文口径）＝事实。**整份读或尾部续读**两种走法
   *    输出逐条相同（见 `restoreProjection`）；0.55 之前恒为整份读 —— 58k 事件的会话实测
   *    7.0 s，占一次发送的 92%；
   * 2) 会话壳里的 `messages` 只是**缓存**，按内容与那份投影对账（`reconcileCachedProjection`），
   *    **不读** `derived_upto_seq` / `projection_cache_seq`（见该方法注释与门禁
   *    `scripts/check-projection-cache-agnostic.ts`）；
   * 3) legacy 回退：RunRecord.legacy_messages（旧 checkpoint messages）→ SessionState.messages。
   *
   * 为什么不再「照水位只读增量」（0.54 的教训，与 0.55 的增量不是一回事）：那个水位只在
   * 四路保存点推进（初始保存 / checkpoint / 终态 / 手动压缩），普通 run 期间一直停在 run
   * 起点 ⇒ 读侧把「缓存覆盖到哪」当成了「事实覆盖到哪」，运行中刷新只剩 4 条（P7）。
   * ADR-105 D2 要求投影是 `fold(timeline[1..seq])` 的纯函数结果、缓存可丢弃；删掉那个字段
   * 产出必须逐字节不变。0.55 的游标**不是**那个水位：它是本进程内 `fold` 到哪，判据是
   * 事件 seq 的连续性与日志头比对，与任何落盘游标字段无关。
   *
   * run() 与 resume 都必须走这里：否则崩溃后新 run 只读缓存，未重放的尾段事件就丢了。
   */
  private async loadStoredHistory(sessionId: string, record?: RunRecord): Promise<StoredHistory> {
    const startedAt = performance.now();
    let sessionState: SessionState | null = null;
    if (this.session) {
      sessionState = await this.session.load(sessionId);
    }
    const shellMs = performance.now() - startedAt;
    // 0.56 ctx-recall：把会话壳里已有的压缩索引接回来（`compaction_id` 必须跨重启单调，
    // 否则重启后第一段压缩又会叫 id=1，stub 与工具列表就自相矛盾）。
    this.adoptStoredCompactions(sessionId, sessionState);
    let restoreMs = 0;
    let restore: { cursor: ProjectionCursor | undefined; timing: HistoryRestoreTiming } = {
      cursor: undefined,
      timing: { mode: 'full', read_ms: 0, fold_ms: 0 },
    };

    const cached = sessionState?.messages?.length ? sessionState.messages : undefined;

    let projection: ProjectionCursor | undefined;
    // 日志最后的 seq：既用于一致性告警，也是本次窗口「覆盖到哪」的唯一来源。
    let lastSeq: number | undefined;
    if (this.eventLog) {
      try {
        const tRestore = performance.now();
        await this.eventLog.flush(sessionId);
        // 一致性校验（P2）：RunRecord 游标不得超前于日志。
        lastSeq = await this.eventLog.lastSeq?.(sessionId);
        // 投影：整份读（0.54 B3 的可读性口径，一次都不能少）或尾部续读（第十一条）。
        // 选哪条只由「本进程上次折到哪 + 这次日志头在哪」决定，见 restoreProjection。
        restore = await this.restoreProjection(sessionId, lastSeq);
        projection = restore.cursor;
        restoreMs = performance.now() - tRestore;
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
      } catch (error) {
        this.logger.warn('session event log read failed during resume', {
          session_id: sessionId,
          error: errorText(error),
        });
        // 0.55：**旧格式会话必须让这次恢复失败**，不能带着空历史继续跑。
        // 吞掉它等于把「这套文件 0.55 读不了」说成「这个会话没有历史」：用户会在一个
        // 看起来正常的空会话里继续对话，而他的旧逐字记录还在磁盘上。
        // 其它读取失败仍是「尽力恢复」（少几条历史比开不动会话好），这条不是。
        if (isLegacySessionUnsupported(error)) throw error;
      }
    }

    // 上下文锚点只认最近一次请求的 per-request usage（`llm.response.usage`）。
    // 0.54 B3：投影输入恒为整份日志 ⇒ 这里不必再「补读尾部窗口」。
    const lastRequestTokens = projection?.lastRequestTokens;

    // 覆盖游标**只由日志决定**：它是「本次窗口覆盖到哪」的上报值（`lastCoveredCursor`
    // 据此决定要不要发 `context.changed`），不许再被会话壳里的任何缓存提示影响。
    const lastReadSeq = projection?.seq;
    const cursor = typeof lastReadSeq === 'number' ? lastReadSeq : undefined;
    const eventCount = projection?.count ?? 0;
    const usageField = lastRequestTokens !== undefined ? { lastRequestTokens } : {};

    // 「这次历史恢复花了多少」：整份读 / 尾读 / 一条都没读，各是多少毫秒 —— 这是发送
    // 路径上唯一 O(会话) 的一段，只观测、不参与任何判定（0.56 §10 的同一条要求）。
    this.logger.debug('session history restored', {
      session_id: sessionId,
      mode: restore.timing.mode,
      source: restore.timing.source,
      shell_ms: Math.round(shellMs),
      event_read_ms: Math.round(restore.timing.read_ms),
      fold_ms: Math.round(restore.timing.fold_ms),
      restore_ms: Math.round(restoreMs),
      events: projection?.count ?? 0,
      messages: projection?.messages.length ?? 0,
    });

    // 0.56 send-first：整份读**刚**付过的代价不能白付 —— 立刻存一份快照，进程被硬杀
    // （用户点「重启」/ 网关崩）之后的下一条消息就从它接上。其它两种 mode 不写：
    // 它们的游标与已存在的快照内容等价（或是 tail 续读，收尾时还会再刷一次）。
    if (restore.timing.mode === 'full' && projection !== undefined) {
      this.persistProjectionSnapshot(sessionId, projection);
    }

    if (projection !== undefined && projection.messages.length > 0) {
      // 0.54 B3：缓存覆盖到哪**只按内容算**（`reconcileCachedProjection`），不读会话壳里的
      // 任何游标字段。投影恒取原文口径 —— 见 `SessionState.messages` 的注释：这里会经
      // `finalizeSessionState` 写回盘上，占位不许物化。
      //
      // 数组复制一份（消息对象共享，口径见 `ProjectionCursor` 注释）：游标要活到下一次
      // run，调用方对「它拿到的那个数组」做任何事都不该改到游标自己的视图。
      const projected = [...projection.messages];
      const messages =
        cached !== undefined
          ? // 深拷贝：缓存对象是 store 的内存引用，播种过程会就地补 `timestamp`。
            reconcileCachedProjection(structuredClone(cached), projected, {
              // 撤回 = 删尾部事实：缓存里那几条必须消失（与压缩同一类「替换」语义）。
              replacementInLog: projection.rewoundSeen,
            })
          : projected;
      if (messages.length > 0) {
        return {
          messages,
          ...(cursor !== undefined ? { cursor } : {}),
          // 0.56 ctx-recall：投影游标随历史一起交出去 —— 压缩索引要按 seq 定位
          // 「被替换的是哪几条」，而消息对象上没有 seq（平行记录在游标里）。
          projection,
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

  /**
   * 本进程内已折出的会话投影（0.55 增量续读的起点）。
   *
   * 上界：`PROJECTION_CURSOR_MAX_SESSIONS` 条；每条的内容就是「一次会话视图」，与
   * `WorkingContext` 里那份是**同一批消息对象**（共享，不复制二次）。
   */
  private readonly projectionCursors = new Map<string, ProjectionCursor>();

  /**
   * 取出（或重建）会话投影：**能续读就续读，不能就整份读**。
   *
   * 为什么可以续：投影是折叠（`fold`），`fold(fold(∅, A), B) === fold(∅, A ++ B)`；
   * `project-messages.ts` 里只有一份折叠实现（`extendProjection`），所以两条路输出
   * 逐条相同。**为什么必须有整份读的退路**：0.54 B3 的可读性判据是「投影 = 日志的纯
   * 函数」，一旦「上次折到哪」与「这次日志头在哪」对不上（日志被换过 / 中间有洞 / 读不
   * 满窗口 / 进程刚起），续读就会把一段事实当成不存在 —— 那不是优化，那是丢数据。
   *
   * 判据不成立时的动作只有一条：**丢掉游标、整份读**，并留痕（否则下次没人知道增量
   * 一直没生效）。
   */
  private async restoreProjection(
    sessionId: string,
    head: number | undefined,
  ): Promise<{ cursor: ProjectionCursor | undefined; timing: HistoryRestoreTiming }> {
    const log = this.eventLog;
    if (log === undefined)
      return { cursor: undefined, timing: { mode: 'full', read_ms: 0, fold_ms: 0 } };
    // 0.56 send-first：三级回退 —— 内存游标（同进程热态）→ 落盘快照（重启 / 换 body）→
    // 整份读。落盘那一级的判据与内存级**完全一样**（下面是同一段代码）：快照只是「上一
    // 个进程的游标」，它没有豁免权。
    const memory = this.projectionCursors.get(sessionId);
    const folded = memory ?? (await this.loadPersistedProjection(sessionId));
    const source: HistoryRestoreSource =
      memory !== undefined ? 'memory' : folded !== undefined ? 'cache' : 'full';
    if (folded !== undefined) {
      if (head !== undefined && folded.seq !== undefined && head === folded.seq) {
        // 日志没长（同一段内再次组请求 / 上个 run 收尾后没有新事件）：一条都不用读。
        return { cursor: folded, timing: { mode: 'reuse', read_ms: 0, fold_ms: 0, source } };
      }
      if (head !== undefined && folded.seq !== undefined && head > folded.seq) {
        const tTail = performance.now();
        const tail = await log.read(sessionId, {
          sinceSeq: folded.seq,
          limit: PROJECTION_TAIL_MAX_EVENTS,
        });
        const readMs = performance.now() - tTail;
        if (isContiguousTail(folded.seq, tail, head)) {
          const tFold = performance.now();
          extendProjection(folded, tail);
          const foldMs = performance.now() - tFold;
          if (folded.seq === head) {
            // 从快照接上的那一段也要进内存游标：下一次组请求（同进程）就走 reuse。
            this.rememberProjection(sessionId, folded);
            return {
              cursor: folded,
              timing: { mode: 'tail', read_ms: readMs, fold_ms: foldMs, source },
            };
          }
        }
      }
      this.projectionCursors.delete(sessionId);
      // 落盘那份也别留着：判据不成立说明它要么过期要么与日志对不上，下一次冷启动
      // 再从它起读只会重演一遍「读 1.3 MB 再丢掉」。删掉之后由下一次整份读重新写。
      if (memory === undefined) {
        void this.journalFactory.projectionCache?.clear(sessionId).catch(() => undefined);
      }
      this.logger.debug('session projection cursor dropped', {
        session_id: sessionId,
        folded_seq: folded.seq,
        head_seq: head,
        source,
      });
    }
    const tFull = performance.now();
    const events = await log.read(sessionId);
    const readMs = performance.now() - tFull;
    const tFold = performance.now();
    const cursor = createProjectionCursor({ applyClearedReplacements: false });
    extendProjection(cursor, events);
    const foldMs = performance.now() - tFold;
    this.rememberProjection(sessionId, cursor);
    return { cursor, timing: { mode: 'full', read_ms: readMs, fold_ms: foldMs, source: 'full' } };
  }

  /**
   * 0.56 send-first：从**落盘快照**重建游标（重启 / 换 body 的第一条消息走这里）。
   *
   * 与内存游标同一条口径（`applyClearedReplacements: false`，原文），快照本身已经在
   * `session/projection-cache.ts` 里逐字段校验过；这里只做形状到游标的搬运，
   * **不做任何判定** —— 续读判据全部在 `restoreProjection` 里（快照没有豁免权）。
   */
  private async loadPersistedProjection(sessionId: string): Promise<ProjectionCursor | undefined> {
    const cache = this.journalFactory.projectionCache;
    if (cache === undefined) return undefined;
    const snapshot = await cache.load(sessionId);
    if (snapshot === undefined) return undefined;
    return cursorFromProjectionSnapshot(snapshot);
  }

  /**
   * 把当前游标写成落盘快照（**同步序列化 + 异步落盘**，永不抛、永不 await 在 run 路径上）。
   *
   * 两处调用：
   * - 整份读刚成功（`mode === 'full'`）：先存一份，之后进程就算被硬杀，下一次启动也能
   *   从这份接上；
   * - run 收尾（`refreshProjectionSnapshot`）：把本轮新增的事件折进去再存，让「重启后
   *   第一条消息」的尾巴尽可能短（尾巴长过 `PROJECTION_TAIL_MAX_EVENTS` 就得整份读了）。
   */
  private persistProjectionSnapshot(sessionId: string, cursor: ProjectionCursor): void {
    const cache = this.journalFactory.projectionCache;
    if (cache === undefined) return;
    const payload = serializeProjectionCursor(sessionId, cursor);
    if (payload === undefined) return;
    void cache.save(sessionId, payload).catch((error: unknown) => {
      this.logger.warn('session projection cache save failed', {
        session_id: sessionId,
        error: errorText(error),
      });
    });
  }

  /**
   * run 收尾时刷新快照：把本轮追加的事件折进游标，再落盘。
   *
   * 为什么要折：持久化只在 run 起点写的话，尾巴 = 整个上一轮（工具密集的一轮可以超过
   * `PROJECTION_TAIL_MAX_EVENTS`，下次重启就退回整份读）。折进来之后尾巴通常只剩几条。
   * 折不动（读满预算 / 中间有洞）就存**旧游标**：它仍是某一段的合法折叠，下次照样能用
   * 续读判据自证。
   */
  private async refreshProjectionSnapshot(sessionId: string): Promise<void> {
    const cache = this.journalFactory.projectionCache;
    if (cache === undefined) return;
    const cursor = this.projectionCursors.get(sessionId);
    if (cursor === undefined) return;
    try {
      const head = await this.resolveSessionCursor(sessionId);
      if (head !== undefined && cursor.seq !== undefined && head > cursor.seq) {
        const tail = await this.eventLog?.read(sessionId, {
          sinceSeq: cursor.seq,
          limit: PROJECTION_TAIL_MAX_EVENTS,
        });
        if (tail !== undefined && isContiguousTail(cursor.seq, tail, head)) {
          extendProjection(cursor, tail);
        }
      }
    } catch (error) {
      this.logger.warn('session projection snapshot refresh failed', {
        session_id: sessionId,
        error: errorText(error),
      });
    }
    this.persistProjectionSnapshot(sessionId, cursor);
  }

  /** 记住一条投影游标（超出条数 / 条目上界就干脆不留，下次整份读）。 */
  private rememberProjection(sessionId: string, cursor: ProjectionCursor): void {
    if (cursor.toolStarts.size > PROJECTION_CURSOR_MAX_TOOL_CALLS) return;
    this.projectionCursors.delete(sessionId);
    this.projectionCursors.set(sessionId, cursor);
    while (this.projectionCursors.size > PROJECTION_CURSOR_MAX_SESSIONS) {
      const oldest = this.projectionCursors.keys().next();
      if (oldest.done === true) break;
      this.projectionCursors.delete(oldest.value);
    }
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
      // 两个计数**不从这里给**：`RunJournal.currentSeq()` 是旧日志（`events.ndjson`）的行数，
      // 在双写会话里它是**另一个 seq 空间**（实测 4115 vs 时间线 195382）。日志实现自己知道
      // 「落盘到哪」（时间线 `lastSeq()` / 旧写者 `persistedSeq`），索引的唯一口径就在那里取。
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
      // 0.52 V1：本段冻结的占位集合也**必须**继承 —— 这里是 S1c 踩过的那个坑：
      // createSessionState 只认自己认识的字段，漏一行的 additive 字段会被整轮洗掉，
      // 于是「段内只读」变成「每轮重新决策」。saveSessionState 会按窗口里的新决策覆盖它。
      ...(stored?.cleared_tool_call_ids !== undefined
        ? { cleared_tool_call_ids: stored.cleared_tool_call_ids }
        : {}),
      // 0.53 U2：投射声明与审计同理必须继承 —— 漏一行就会把「用户声明的 mode」整轮洗掉，
      // 下一次段起点退回缺省 placeholder（等于偷偷改声明）。声明只由应用层写
      // （U1 的 `declareProjection`），runtime 只读不写；审计由 saveSessionState 按
      // 本段决策覆盖。
      ...(stored?.context_projection !== undefined
        ? { context_projection: stored.context_projection }
        : {}),
      ...(stored?.context_projection_audit !== undefined
        ? { context_projection_audit: stored.context_projection_audit }
        : {}),
      // 0.56 ctx-recall：压缩索引也必须继承 —— 索引是**累积**的（多段压缩不覆盖历史），
      // 漏这一行会让重启后 `compaction_id` 从 1 重来、stub 只列最新一段。
      ...(stored?.compactions !== undefined ? { compactions: stored.compactions } : {}),
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
      // 0.52 C / 0.55 P0：真实锚点跟着这份投影一起落盘（journal 是 SessionState 唯一写口）。
      // 取**账本**里的锚点（`contextAccounting`）—— 计数的权威口径在 runtime，而
      // `packages/agent` 的 `RoleAwareContext` 包装层不会转发 `setContextAnchor` /
      // `contextAnchor`，只读窗口的那条路在 agent 模式下恒为 undefined（这就是
      // 「283 个会话文件一个 `context_anchor` 都没有」的原因）。
      // 窗口没有锚点（旧会话 / 本次没拿到 usage）时保留继承来的旧值。
      const anchor = this.anchorOf(execution);
      if (anchor !== undefined) sessionState.context_anchor = anchor;
      // 0.52 V1：本段冻结的占位集合跟着窗口一起落盘（这一段没有决策就清掉继承来的旧值，
      // 否则下次段起点会把「已经不在窗口里的 id」当成已讲过的卡而不发）。
      const frozen = this.segmentClearPlans.get(execution.workingContext);
      if (frozen !== undefined && frozen.length > 0) {
        sessionState.cleared_tool_call_ids = [...frozen];
      } else {
        delete sessionState.cleared_tool_call_ids;
      }
      // 0.53 U2：审计只在**决策变更**的段起点更新（`segmentProjections` 里只有变更时才
      // 带 audit）；没变更就原样保留继承来的那条 —— 不刷日志，也不伪造「新决策」。
      const projection = this.segmentProjections.get(execution.workingContext);
      if (projection?.changed === true && projection.audit !== null) {
        sessionState.context_projection_audit = projection.audit;
      }
    }
    // 0.56 ctx-recall：压缩索引随会话壳一起落盘（累积、按 id 去重）。继承来的旧条目 +
    // 本进程新写的条目，都留 —— 索引是「历史每一段」的账，不是「最新一段」的快照。
    const knownCompactions = this.sessionCompactions.get(sessionState.session_id);
    if (knownCompactions !== undefined && knownCompactions.length > 0) {
      sessionState.compactions = knownCompactions;
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
