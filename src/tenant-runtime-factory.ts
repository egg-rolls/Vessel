/**
 * 每 tenant 执行面（0.5 A-6 / DECISION-010 §13.2）。
 *
 * `buildTenantRuntime()` 构造一个 tenant 的独立 bundle：
 *   config / provider / session / runStore / 共享 pluginHost + plugins /
 *   trace / metrics / redactor / sessionControl / feishu / MCP。
 * Stage 4：bundle 不持长期 WorkingContext / ExecutionUnit；profile 注册到传入的
 * per-node `Runtime`，`bundle.runtime` 是按 session 解析 EU 的门面。
 *
 * 一个 node 恰好构造一个 bundle（`--serve` 与本地模式共用），它是唯一执行面：
 * 单 EventStream / SessionStore / PluginHost / MetricsControl / scheduler。
 *
 * @module vessel/tenant-runtime-factory
 */

import { join } from 'node:path';
import { deriveSessionMeta } from '@vessel-agent/core/session';
import type { ConfigSources, VesselConfig } from '../packages/config/src/index';
import {
  type ContextSummarizer,
  createDefaultTraceRedactor,
  createRunJournalFactory,
  createSessionBreaker,
  type EventStream,
  estimateTokens,
  InProcessScheduler,
  installPluginsIntoHost,
  type LLMProvider,
  type Logger,
  MemoryPluginHost,
  MemoryWorkingContext,
  type Message,
  noopLogger,
  type Plugin,
  type PluginHost,
  projectMessages,
  type RunnableAgent,
  type RunRecordStore,
  type Runtime,
  type RuntimePermissionConfig,
  type Scheduler,
  SessionEventLog,
  type SessionStore,
  type TenantPaths,
  type TraceRedactor,
} from '../packages/core/src/index';
import type { FeishuChannelLike, MetricsControlLike } from './control-plane-types';
import { createFeishuFromConfig, stopFeishuChannel } from './feishu-wiring';
import { FileLeaseService } from './lease-service';
import { installMcp, type McpControl, type McpPluginLike } from './mcp-wiring';
import type { MockScenarioName } from './mock/scenarios';
import {
  createEventStream,
  createMetricsCollector,
  disposeMetrics,
  type MetricsFactory,
} from './observability-wiring';
import { resolveAgentCwd } from './path-resolution';
import { buildPluginConfigMap, declarativePluginEntries, withPluginConfig } from './plugin-config';
import { PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';
import { createProvider } from './provider-factory';
import { includeReasoningFor } from './reasoning';
import { closeRunRecordStore, createRunRecordStore } from './run-record-store-factory';
import { ownerSelfCard } from './self-card';
import { createSessionControl, type SessionControl } from './session-control';
import { createSessionStore } from './session-factory';
import { withSessionWriteLock } from './session-lock-runtime';
import { reportShutdownFailure } from './shutdown-report';
import {
  composeTraceRedactors,
  installTrace,
  pruneTenantTrace,
  type TraceControl,
  type TraceRecorderFactory,
} from './trace-wiring';
import { createUsagePricing } from './usage-pricing';

/** 构造一个 tenant 执行面的输入 */
export interface BuildTenantRuntimeOptions {
  tenantId: string;
  /**
   * Stage 4：per-node Runtime。tenant profile 注册到它，per-session EU 经
   * `getOrCreateExecutionUnit` 取得；bundle 不再自己构造 ExecutionUnit。
   */
  runtime: Runtime;
  /** 已合并 tenant overlay 的配置 */
  config: VesselConfig;
  tenantPaths: TenantPaths;
  /** config.loaded 事件的来源（缺省空） */
  configSources?: ConfigSources;
  /** 用户/项目配置路径（config.get.paths） */
  configPaths?: { user: string; project: string };
  /** tenant overlay 命中的叶子键（config snapshot） */
  tenantOverlayKeys?: string[];
  /** session 写锁（0.15）；缺省 memory 后端关闭，其余开启 */
  sessionLocks?: boolean;
  /**
   * 是否安装 trace（本地写意图）。false 时不创建 trace / 不写 events。
   * 默认 false：仅供 --serve 的只读执行面显式开启。
   */
  writeTrace?: boolean;
  /** 启动前按 trace 保留策略 prune；默认 false（本地 bootstrap 自己处理） */
  pruneTrace?: boolean;
  useMock?: boolean;
  /** mock 场景（仅 useMock）；缺省时 provider-factory 走 MemoryLLMProvider */
  mockScenario?: MockScenarioName;
  headless?: boolean;
  /**
   * ask_user：交互 REPL、serve/gateway 与 headless（落盘后挂起）都注册。
   * `ui.askUser: false` 可关闭（0.15）。
   */
  registerAskUser?: boolean;
  loader?: PluginLoader;
  nodeId: string;
  /** host owner 的初始 sessionId；缺省随机 UUID（serve 每 tenant 独立） */
  sessionId?: string;
  metricsFactory?: MetricsFactory;
  traceFactory?: TraceRecorderFactory;
  /** 共享 / 注入的 ext redactor；缺省从 loader 加载 */
  redactor?: TraceRedactor;
  /** 诊断 logger（0.10 R2-14）；缺省 noop，CLI / serve 注入 stderr logger */
  logger?: Logger;
  clock?: () => number;
  loadMcpModule?: () => Promise<unknown | null>;
  loadFeishuModule?: () => Promise<unknown | null>;
  feishuTransport?: unknown;
  /**
   * 0.28 F2：渠道成员被 TTL 回收后复活所需的 Team id。
   * Team 由 bootstrap 的 `createAgentServiceWiring` 在 bundle 之后才建出来，
   * 所以这里是晚绑定 getter（与 localHuman / localMember 同口径）；缺省不复活。
   */
  resolveFeishuTeamId?: () => string | undefined;
  /**
   * 0.28：飞书渠道执行面所需的 `AgentService`，同样是晚绑定 getter。
   * bundle（含渠道）先于 `createAgentServiceWiring` 构造；渠道在 `start()` 时求值。
   * 缺省时渠道 `start()` 保持显式失败（禁止静默降级）。
   */
  resolveFeishuService?: () => unknown;
}

/** 一个 tenant 的完整执行面 */
export interface TenantRuntimeBundle {
  tenantId: string;
  config: VesselConfig;
  tenantPaths: TenantPaths;
  configSources: ConfigSources;
  configPaths?: { user: string; project: string };
  tenantOverlayKeys: string[];
  provider: LLMProvider;
  providerName: string;
  providerModel: string;
  providerBaseUrl: string;
  /** tenant 独立事件流（trace / metrics 只订阅它） */
  events: EventStream;
  /** runtime 事件出口；与 tenant 流同一实例 */
  runtimeEvents: EventStream;
  session: SessionStore;
  pluginHost: PluginHost;
  /**
   * 0.27：每 tenant 唯一 `InProcessScheduler`（spec §5.1）。
   * 装配层只在这里构造一次；`AgentService` 的所有执行都经它的 executor。
   */
  scheduler: Scheduler;
  /**
   * per-session 门面：每次 run/resume 按 session_id 解析本 tenant 的
   * ExecutionUnit（Stage 4）。不再是一个长期存活的 EU 实例。
   */
  runtime: RunnableAgent;
  /** ADR-098 C2：本 tenant 的租约服务；memory 后端 / 关闭 sessionLocks 时缺省 */
  leaseService?: FileLeaseService;
  /** 0.34 Stage 3：seeded create（seed=compact）压缩摘要器（与 tenant 上下文共用） */
  summarizer?: ContextSummarizer;
  /** 0.34 S4 / R7：按 session 取带熔断的摘要器（与 `summarizer` 同分桶） */
  summarizerForSession?: (sessionId: string) => ContextSummarizer;
  runStore?: RunRecordStore;
  /** 0.18：会话事件日志（唯一真相源）；memory 后端或只读执行面不创建 */
  eventLog?: SessionEventLog;
  trace?: TraceControl;
  metrics?: MetricsControlLike;
  /** 组合后的 redactor（core 默认 + ext）；live hub / gateway 使用同一实例 */
  redactor: TraceRedactor;
  /** 0.18：未组合的 ext redactor；factory 透传给所有 tenant（缺省无 ext） */
  extRedactor?: TraceRedactor;
  sessionControl: SessionControl;
  /** 本 bundle 使用的插件扫描器（0.12：`gateway.reload` 刷新缓存） */
  pluginLoader: PluginLoader;
  plugins: Plugin[];
  mcpPlugin?: McpPluginLike;
  mcp?: McpControl;
  feishu?: FeishuChannelLike;
  /**
   * 幂等关闭。`drain: false` 用于调用方已先 `await gateway.stop()` 的场景：
   * gateway 已完成 interrupt('shutdown') + 5s 等待，避免重复限时等待。
   */
  close(options?: { drain?: boolean }): Promise<void>;
}

function tenantSessionsDbPath(tenantRoot: string): string {
  return join(tenantRoot, 'sessions.db');
}

/**
 * C4（AI 命名）：命名约束写在 system 提示词里，输出再经 `sanitizeGeneratedTitle` 清洗。
 * 不新增配置键；模型 / 超时沿用当前 tenant provider。
 */
const SESSION_TITLE_SYSTEM_PROMPT =
  'Give this conversation a title: 3-7 words, at most 40 characters. ' +
  "Make it imperative and follow the user's language. " +
  'No quotes, no markdown, no trailing punctuation. Do not answer the question. ' +
  'Reply with the title only.';

/** 去掉首尾引号 / 反引号（含中英文引号） */
function stripWrappingQuotes(value: string): string {
  return value
    .replace(/^["'`“”‘’]+/, '')
    .replace(/["'`“”‘’]+$/, '')
    .trim();
}

/**
 * C4：清洗 AI 生成的标题 —— trim → 去首尾引号 / 反引号 → 去 `Title:` 前缀
 * → 折叠空白 → 去句末标点 → 按码点截 40。返回空串表示放弃（保留派生标题）。
 */
export function sanitizeGeneratedTitle(raw: string): string {
  let title = stripWrappingQuotes(raw);
  title = title.replace(/^title\s*[:：]\s*/i, '').trim();
  // `Title: "Foo"` 这类组合：去前缀后再剥一次引号。
  title = stripWrappingQuotes(title);
  title = title.replace(/\s+/g, ' ').trim();
  title = title.replace(/[.,;:!?。，；：！？…]+$/u, '').trim();
  const codePoints = Array.from(title);
  return (codePoints.length > 40 ? codePoints.slice(0, 40).join('') : title).trim();
}

/**
 * C4：命名输入 —— 首条真实 user 消息（跳过 `vessel:` 注入与压缩摘要），
 * 取前 500 码点；没有可用输入返回 undefined。
 */
function firstUserInputForTitle(messages: Message[]): string | undefined {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (message.compaction_summary === true) continue;
    if (message.name?.startsWith('vessel:') === true) continue;
    const input = Array.from(message.content).slice(0, 500).join('').trim();
    if (input !== '') return input;
  }
  return undefined;
}

/** 单条消息渲染上限（字符）；超出只保留前缀，避免单条工具结果独占分块预算。 */
const SUMMARIZER_MAX_MESSAGE_CHARS = 12_000;
const SUMMARIZER_MAX_CHUNK_TOKENS = 48_000;
const SUMMARIZER_MIN_CHUNK_TOKENS = 2_000;
const SUMMARIZER_PARTIAL_MAX_TOKENS = 1024;
const SUMMARIZER_REDUCE_MAX_TOKENS = 2048;
/** C3：单次摘要请求的上限；超时由 provider 请求自身取消，不阻塞请求组装。 */
const SUMMARIZER_TIMEOUT_MS = 15_000;

/**
 * 压缩摘要的固定段落，按此顺序输出。
 *
 * 为什么固定：压缩后模型只能看到一条 system 摘要，段落稳定才能快速定位
 * 「正在做什么 / 卡在哪 / 关键值是多少」；部分摘要与 reduce 也沿用同一模板，
 * 合并时不会因段落漂移丢信息。摘要文本本身原样进入摘要消息与
 * `message.compaction` 事件，这里只约束模型输出，不做二次改写。
 */
const SUMMARY_SECTIONS = [
  '目标',
  '当前用户要求（原话）',
  '约束',
  '已完成',
  '进行中',
  '阻塞',
  '决策',
  '相关文件',
  '下一步',
  '关键值',
] as const;

/** 组装摘要提示：任务说明 + 固定段落 + 必须保留的事实。 */
function summaryPrompt(task: string): string {
  return [
    task,
    'Output only the summary. Use exactly these sections in this order, each as a markdown heading "## <section>"; write "（未提及）" under a section with no content:',
    SUMMARY_SECTIONS.map((section) => `## ${section}`).join('\n'),
    "Under 当前用户要求（原话）, quote the user's most recent explicit request as close to their original wording as possible.",
    'Preserve decisions, file paths, tool names and results, and open tasks. Put concrete values (ids, counts, thresholds, paths, versions) under 关键值.',
  ].join(' ');
}

const SUMMARY_SYSTEM_PROMPT = summaryPrompt('Summarize the conversation for context compaction.');
const PARTIAL_SYSTEM_PROMPT = summaryPrompt(
  'Summarize this part of a longer conversation for context compaction.',
);
const REDUCE_SYSTEM_PROMPT = summaryPrompt(
  'Combine the ordered partial summaries into one conversation summary for context compaction.',
);

/**
 * 渲染一条消息。`reasoning_content` 不进入摘要（与事件流一致）。
 * tool 结果与 assistant 的工具调用必须带上标识，否则摘要丢失工具名/参数。
 */
function renderSummarizerMessage(message: Message): string {
  const content = message.content ?? '';
  let rendered: string;
  if (message.role === 'tool') {
    rendered = `[tool:${message.tool_call_id ?? ''}] ${content}`;
  } else if (message.role === 'assistant') {
    const calls = (message.tool_calls ?? []).map(
      (call) => `[tool_call:${call.function?.name ?? ''}] ${call.function?.arguments ?? ''}`,
    );
    rendered = [`[assistant] ${content}`, ...calls].join('\n');
  } else {
    rendered = `[${message.role}] ${content}`;
  }
  return rendered.length > SUMMARIZER_MAX_MESSAGE_CHARS
    ? `${rendered.slice(0, SUMMARIZER_MAX_MESSAGE_CHARS)}\n[truncated]`
    : rendered;
}

/** 按渲染后文本的估算 token 分组；单条超出预算时独占一块。 */
function chunkSummarizerTranscript(rendered: string[], budget: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const text of rendered) {
    const tokens = estimateTokens(text);
    if (current.length > 0 && currentTokens + tokens > budget) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** 截断到估算 token 预算（预算按 token，字符数不固定）。 */
function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

/** C3：把当前窗口的已有摘要并入 system 提示，要求合并而非重写。 */
function withPreviousSummary(system: string, previous: string | undefined): string {
  if (previous === undefined || previous.trim() === '') return system;
  return `${system}\n\nMerge the existing summary; do not drop its facts.\n\nExisting summary:\n${previous}`;
}

/**
 * 用当前 provider 生成真实上下文摘要（0.6.1 E3，0.14.4 分块）。
 *
 * 单块：一次摘要调用（输出预算见 C3；有旧摘要时合并）。
 * 多块：每块一次部分摘要（≤1024），再 reduce 一次（同一输出预算，只在此合并旧摘要）。
 * 分块失败写占位标记继续；reduce 失败拼接部分摘要；全部失败返回空串，
 * 由 core 回退占位摘要。
 */
export function createContextSummarizer(provider: LLMProvider, model: string): ContextSummarizer {
  const summarize = async (system: string, user: string, maxTokens: number): Promise<string> => {
    const response = await provider.chat({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0,
      signal: AbortSignal.timeout(SUMMARIZER_TIMEOUT_MS),
    });
    return typeof response.content === 'string' ? response.content : '';
  };

  return async (messages, options) => {
    const rendered = messages.map(renderSummarizerMessage);
    const chunkBudget = Math.min(
      SUMMARIZER_MAX_CHUNK_TOKENS,
      Math.max(SUMMARIZER_MIN_CHUNK_TOKENS, Math.floor(options.maxTokens / 8)),
    );
    const chunks = chunkSummarizerTranscript(rendered, chunkBudget);
    if (chunks.length === 0) return '';

    // C3：输出预算随被移除内容的规模增长；无 removedTokens 时沿用旧上限。
    const maxOutputTokens =
      options.removedTokens !== undefined
        ? Math.max(2048, Math.min(8192, Math.floor(options.removedTokens / 8)))
        : Math.max(128, Math.min(options.maxTokens, SUMMARIZER_REDUCE_MAX_TOKENS));

    if (chunks.length === 1) {
      try {
        return await summarize(
          withPreviousSummary(SUMMARY_SYSTEM_PROMPT, options.previousSummary),
          chunks[0]?.join('\n\n') ?? '',
          maxOutputTokens,
        );
      } catch {
        return '';
      }
    }

    const partials: string[] = [];
    let succeeded = 0;
    for (const [index, chunk] of chunks.entries()) {
      try {
        partials.push(
          await summarize(PARTIAL_SYSTEM_PROMPT, chunk.join('\n\n'), SUMMARIZER_PARTIAL_MAX_TOKENS),
        );
        succeeded += 1;
      } catch {
        partials.push(`[partial summary unavailable: chunk ${index + 1}]`);
      }
    }
    if (succeeded === 0) return '';

    const joined = partials.join('\n\n');
    try {
      return await summarize(
        withPreviousSummary(REDUCE_SYSTEM_PROMPT, options.previousSummary),
        joined,
        maxOutputTokens,
      );
    } catch {
      return truncateToTokenBudget(joined, maxOutputTokens);
    }
  };
}

/** 每 tenant 的上下文配置（含真实 summarizer）；供 owner 与成员共用。 */
function contextConfigFor(config: VesselConfig, summarizer: ContextSummarizer | undefined) {
  return {
    maxTokens: config.context?.maxTokens,
    maxMessages: config.context?.maxMessages,
    autoCompact: config.context?.autoCompact,
    compactThreshold: config.context?.compactThreshold,
    ...(summarizer !== undefined ? { summarizer } : {}),
  };
}

/** 0.8.2 Wave 2B1：runtime 共用的 resolved 权限配置。 */
export function resolveRuntimePermission(
  config: VesselConfig,
  headless: boolean,
): RuntimePermissionConfig {
  return {
    default: headless ? 'allow' : 'ask',
    // E7：配置持久化的 always 规则 + 运行时始终免确认的 ask_user。
    autoApprove: [...new Set([...(config.permission?.autoApprove ?? []), 'ask_user'])],
    // 0.27：配置级保险；用户显式配置时以其值为准（与 autoApprove 语义一致，不合并默认）。
    neverAutoApprove: config.permission?.neverAutoApprove ?? ['agent.close'],
  };
}

/** `drainActiveRuns` 结果：无 run / 已终态 / 超时 / 运行时无 interrupt */
export type DrainOutcome = 'idle' | 'interrupted' | 'timeout' | 'unsupported';

export interface DrainActiveRunsOptions {
  /** active run id 集合；run 终态事件由订阅方删除 */
  activeRuns: Set<string>;
  /** ExecutionUnit.interrupt */
  interrupt?: (reason: 'shutdown') => void;
  logger: Logger;
  tenantId: string;
  timeoutMs?: number;
  /** 测试注入：等待下一次轮询 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * 0.10 R2-18：关闭前的软中断。调用方先 `interrupt('shutdown')`（checkpoint 落
 * interrupted，可 `--resume-run`），再限时等待 active run 从集合中消失。
 * 超时只 warning，不阻断关闭。
 */
export async function drainActiveRuns(options: DrainActiveRunsOptions): Promise<DrainOutcome> {
  if (options.activeRuns.size === 0) return 'idle';
  if (!options.interrupt) {
    options.logger.warn('shutdown drain: no interrupt hook for active runs', {
      runs: options.activeRuns.size,
    });
    return 'unsupported';
  }

  options.interrupt('shutdown');

  const timeoutMs = options.timeoutMs ?? 5000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;

  while (options.activeRuns.size > 0 && now() < deadline) {
    await sleep(25);
  }
  if (options.activeRuns.size > 0) {
    options.logger.warn('shutdown drain timed out', {
      runs: [...options.activeRuns],
    });
    return 'timeout';
  }
  return 'interrupted';
}

/**
 * 构造一个 tenant 的独立执行面。
 * 失败时释放本函数获取的锁；调用方负责释放传入的锁。
 */
export async function buildTenantRuntime(
  options: BuildTenantRuntimeOptions,
): Promise<TenantRuntimeBundle> {
  const { tenantId, config, tenantPaths } = options;
  const useMock = options.useMock ?? false;
  const headless = options.headless ?? false;
  const loader = options.loader ?? new PluginLoader();
  const logger = options.logger ?? noopLogger;

  const backend = config.session?.backend ?? 'file';
  if (options.pruneTrace === true) {
    try {
      await pruneTenantTrace({ config, tenantPaths });
    } catch (error) {
      console.warn(
        `⚠ Failed to prune trace for tenant "${tenantId}": ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  // ADR-098 C2：SessionLease 接管 session 级写排他；memory 后端或无写意图时缺省
  // 不创建（EU / 事件日志端口缺省为 no-op，行为等同现状）。
  const leaseConfig = (config as { lease?: { ttlMs?: number; renewMs?: number } }).lease;
  const sessionLocksEnabled = options.sessionLocks ?? backend !== 'memory';
  const leaseService = sessionLocksEnabled
    ? new FileLeaseService({
        tenantDir: tenantPaths.root,
        tenantId,
        ...(leaseConfig?.ttlMs !== undefined ? { ttlMs: leaseConfig.ttlMs } : {}),
        ...(leaseConfig?.renewMs !== undefined ? { renewMs: leaseConfig.renewMs } : {}),
        logger,
      })
    : undefined;

  const runStore = createRunRecordStore(config, {
    tenantRunsDir: tenantPaths.runs_dir,
    tenantId,
  });
  const resolvedProvider = await createProvider(config, loader, useMock, options.mockScenario);
  const { provider, providerName, providerModel, providerBaseUrl } = resolvedProvider;
  // 0.51：opt-in 计价；无配置时为 undefined，total_cost 保持 0。
  const pricing = createUsagePricing(config.pricing);

  const summarizer = createContextSummarizer(provider, providerModel);
  // R7：熔断按 session 分桶；owner / 成员共享同一份计数，`force` 由 core 传入。
  const summarizerForSession =
    summarizer !== undefined ? createSessionBreaker(summarizer) : undefined;
  const events = createEventStream(config);
  // 0.27（spec §5.1）：每 tenant 唯一 scheduler，装配层只在此处构造。
  // 所有 body / owner / 成员的执行都经它的 executor，不再有第二套队列。
  // 未配置项沿用 core 缺省（无并发上限 / 队列 100 / per-body 串行），符合 spec §5.1「默认无上限」。
  // 注意：`DEFAULT_SCHEDULER_OPTIONS.maxConcurrency` 仍是 1（0.2 遗留），这里**不用**它兜底。
  const scheduler = new InProcessScheduler({
    ...(config.scheduler?.maxConcurrency !== undefined
      ? { maxConcurrency: config.scheduler.maxConcurrency }
      : {}),
    ...(config.scheduler?.maxQueueSize !== undefined
      ? { maxQueueSize: config.scheduler.maxQueueSize }
      : {}),
    ...(config.scheduler?.perBodySerial !== undefined
      ? { perBodySerial: config.scheduler.perBodySerial }
      : {}),
    events,
  });

  // 0.10 R2-18：只跟踪真实在跑的 run（包装 `ExecutionUnit.run/resume`），
  // 不从事件推断——测试 / gateway 也会发布合成的 run.started，按事件跟踪会让
  // shutdown 白等 5s。
  const activeRuns = new Set<string>();
  let activeRunSeq = 0;
  const trackActive = <T>(promise: Promise<T>): Promise<T> => {
    activeRunSeq += 1;
    const token = `inflight-${activeRunSeq}`;
    activeRuns.add(token);
    void promise
      .finally(() => {
        activeRuns.delete(token);
      })
      .catch(() => {
        // 原 promise 的拒绝由调用方处理；这里只为清理跟踪标记
      });
    return promise;
  };

  // 事件流由 cli 的 `createGatewayEventHub({ streams: [...] })` 直接消费，
  // bundle 不再向 hub 注册（T3 单流）。
  const session = createSessionStore(config.session, {
    tenantSessionsDir: tenantPaths.sessions_dir,
    tenantSessionsDbPath: tenantSessionsDbPath(tenantPaths.root),
    tenantId,
  });
  // 0.18：事件日志按 tenant 的 sessions 目录落盘（`sessions/<id>/events.ndjson`）。
  // 仅在本地写意图 + 持久化后端时创建；memory 后端/只读执行面保持零磁盘写入。
  const eventLog =
    options.writeTrace === true && backend !== 'memory'
      ? new SessionEventLog({
          dir: tenantPaths.sessions_dir,
          tenantId,
          logger,
          // ADR-098 C2：旧 fencing token 拒绝 append；读路径不校验。
          ...(leaseService !== undefined
            ? { fenceOf: (kind, key) => leaseService.fenceOf(kind, key) }
            : {}),
        })
      : undefined;
  const sessionControl = createSessionControl({
    session,
    paths: tenantPaths,
    events,
    ...(runStore ? { runStore } : {}),
    ...(eventLog ? { eventLog } : {}),
  });

  // ── 插件 ──────────────────────────────────────
  const declarativePlugins = declarativePluginEntries(config);
  /** E1：插件名 → 安装配置（显式 plugins[].config 覆盖声明式条目） */
  const pluginConfigs = buildPluginConfigMap(
    config.plugins,
    declarativePlugins,
    resolveAgentCwd(config),
  );
  const pluginSelection = resolvePluginSelection(
    loader,
    config.plugins,
    Boolean(process.env.VESSEL_DEBUG),
    declarativePlugins,
  );
  // 默认集里的外部插件以完整进程权限运行：启动时告警一次（stderr）。
  warnExternalPluginsOnce(pluginSelection.external);
  const defaultPluginNames = pluginSelection.names;

  const plugins: Plugin[] = [];
  const pluginLoadEvents: Array<{
    type: 'plugin.loaded' | 'plugin.failed';
    data: Record<string, unknown>;
  }> = [];
  for (const name of defaultPluginNames) {
    const descriptor = loader.list().find((candidate) => candidate.name === name);
    const category = descriptor?.category ?? 'unknown';
    const plugin = await loader.load(name);
    if (plugin) {
      // E1：配置在 install 时透传（host 路径直接传；非 host 路径见 ExecutionUnit）。
      plugins.push(plugin);
      pluginLoadEvents.push({
        type: 'plugin.loaded',
        data: {
          name: plugin.name,
          category,
          version: plugin.version ?? descriptor?.version ?? '',
        },
      });
    } else {
      pluginLoadEvents.push({
        type: 'plugin.failed',
        data: { name, category, reason: 'load_failed' },
      });
    }
  }

  // 0.15：ui.askUser=false 按 tenant 关闭（overlay 生效）；无客户端入口不会传 true。
  if (options.registerAskUser === true && config.ui?.askUser !== false) {
    const { createAskUserTool } = await import('../packages/tui/src/renderer/ask-user');
    plugins.push({
      name: 'ask-user',
      version: '0.1.0',
      description: 'Ask-user interactive tool (ADR-029)',
      install(host) {
        host.registerTool(createAskUserTool());
      },
    });
  }
  // runtime 共用的 resolved 权限配置（0.8.2 Wave 2B1）。
  const permission = resolveRuntimePermission(config, headless);

  // ── Runtime ───────────────────────────────────
  const limits = config.limits ?? {};
  const termination = {
    maxIterations: config.termination?.maxIterations,
    maxRuntimeSeconds: config.termination?.maxRuntimeSeconds,
  };
  // 0.50：默认 system 完全由用户掌握。未配置时为空串，不注入任何内置 base system
  // 文本；Self Card 仍由 composeRunSystemPrompt 生成。
  const systemPrompt = config.agent?.systemPrompt ?? '';

  const contextFactory = () => new MemoryWorkingContext(contextConfigFor(config, summarizer));

  // ── Stage 4：tenant 范围内只安装一次插件 ──────────
  // 插件安装原本在 ExecutionUnit 构造内；改成 per-session EU 后，同一 tenant 的
  // 多个 EU 共享一个 PluginHost，安装/init/dispose 只发生一次。
  const finalPluginHost = new MemoryPluginHost();
  const installedPlugins = await installPluginsIntoHost({
    host: finalPluginHost,
    plugins: plugins.map((plugin) => withPluginConfig(plugin, pluginConfigs[plugin.name])),
    publish: (event) => events.publish(event),
    logger,
  });

  // 铁律 1：持久端口只到 Runtime 工厂层；EU 经 journal 写入。
  // 成员 run 与 tenant run 共用同一工厂 → 成员 run 同样写 RunRecord。
  const journalFactory = createRunJournalFactory({
    ...(eventLog !== undefined ? { eventLog } : {}),
    session,
    ...(runStore !== undefined ? { runStore } : {}),
    ...(leaseService !== undefined
      ? { fenceOf: (kind, key) => leaseService.fenceOf(kind, key) }
      : {}),
    logger,
  });

  options.runtime.registerProfile({
    tenantId,
    providerFactory: () => provider,
    model: providerModel,
    // 插件已由装配层安装到共享 host；EU 不重复安装。
    plugins: [],
    pluginHostFactory: () => finalPluginHost,
    limits,
    termination,
    ...(pricing !== undefined ? { pricing } : {}),
    // 0.11.1：`ui.showReasoning` 显式 opt-in（默认 false，行为同 0.11.0）。
    includeReasoning: includeReasoningFor(config),
    context: {
      ...(config.context?.maxTokens !== undefined ? { maxTokens: config.context.maxTokens } : {}),
      ...(config.context?.autoCompact !== undefined
        ? { autoCompact: config.context.autoCompact }
        : {}),
      summarizer,
    },
    systemPrompt,
    permission,
    journalFactory,
  });

  // 0.15 E9：主 agent 的 Self Card（成员由 AgentService 注入）。
  const selfCard = ownerSelfCard(config, providerModel, {
    askUser: options.registerAskUser === true,
  });

  /** 本 bundle 已服务过的 session（关闭时逐个 retire）。 */
  const servedSessionIds = new Set<string>();

  const executionUnitFor = (sessionId: string) =>
    options.runtime.getOrCreateExecutionUnit({
      tenantId,
      sessionId,
      events,
      session,
      ...(eventLog !== undefined ? { eventLog } : {}),
      ...(leaseService !== undefined ? { leaseService } : {}),
      pluginHost: finalPluginHost,
      plugins: [],
      // tenant EU 仍用完整 context 配置（maxMessages / compactThreshold 不进 profile 形状）；
      // profile 的 `context` 只是成员路径的缺省值。
      contextFactory: () =>
        new MemoryWorkingContext(
          contextConfigFor(config, summarizerForSession?.(sessionId) ?? summarizer),
        ),
      overrides: { selfCard },
    });

  /**
   * C6：idle session（无 live EU）的等价瞬态压缩路径。
   * 不启动 Run、不注入用户消息；从事件日志/缓存播种，压缩后经 transient journal
   * 写 `message.compaction` 与 SessionState，下一次 run/resume 直接读压缩后的缓存。
   */
  const compactIdleSession = async (
    sessionId: string,
  ): Promise<{ removed: number; remaining: number; messages: Message[] }> => {
    const state = await session.load(sessionId);
    if (state === null) throw new Error('compact_unavailable');
    const workingContext = new MemoryWorkingContext(
      contextConfigFor(config, summarizerForSession?.(sessionId) ?? summarizer),
    );
    workingContext.setSessionId(sessionId);
    let history: Message[] = state.messages ?? [];
    if (eventLog !== undefined) {
      await eventLog.flush(sessionId);
      const stored = await eventLog.read(sessionId);
      if (stored.length > 0) history = projectMessages(stored);
    }
    if (
      !history.some(
        (message) => message.role === 'system' && message.compaction_summary !== true,
      ) &&
      systemPrompt !== ''
    ) {
      workingContext.add({ role: 'system', content: systemPrompt, timestamp: Date.now() });
    }
    for (const message of history) workingContext.add(message);
    const removed = workingContext.compactAsync
      ? await workingContext.compactAsync()
      : workingContext.compact();
    const remaining = workingContext.messages.length;
    const messages = workingContext.messages;
    if (removed > 0) {
      const journal = journalFactory.transient({ runId: 'manual', events, sessionId });
      const report = workingContext.lastCompaction;
      const summary = [...messages]
        .reverse()
        .find((message) => message.role === 'system' && message.compaction_summary === true);
      const ts = summary?.timestamp ?? Date.now();
      journal.appendFact({
        type: 'context.compacted',
        run_id: 'manual',
        data: {
          run_id: 'manual',
          session_id: sessionId,
          removed,
          remaining,
          reason: 'manual',
          ...(report?.degraded !== undefined ? { degraded: report.degraded } : {}),
        },
        ts,
      });
      if (summary !== undefined) {
        const cleared = report?.cleared_tool_call_ids ?? [];
        journal.appendFact({
          type: 'message.compaction',
          run_id: 'manual',
          data: {
            run_id: 'manual',
            session_id: sessionId,
            removed,
            remaining,
            kept: messages.filter((message) => message.role !== 'system').length,
            reason: 'manual',
            message: { ...summary, timestamp: ts },
            ...(cleared.length > 0 ? { cleared_tool_call_ids: cleared } : {}),
            ...(report?.degraded !== undefined ? { degraded: report.degraded } : {}),
          },
          ts,
        });
      }
      await journal.saveSessionState({ ...state, messages, updated_at: Date.now() });
    }
    return { removed, remaining, messages };
  };

  // Stage 4：bundle.runtime 是 per-session 门面，不再是单个长期存活的 EU。
  // `id` / `applyPermissionRules` 让既有热应用装配（按结构解析 live runtime）继续命中
  // 本 tenant 已建的 EU，不新增公开 RPC/事件。
  const executionFacade: RunnableAgent & {
    readonly id: string;
    applyPermissionRules(rules: RuntimePermissionConfig): void;
    /** C6：手动压缩；有 live EU 用 EU，idle session 走等价瞬态路径。 */
    compactContext?(
      sessionId: string,
    ): Promise<{ removed: number; remaining: number; messages?: Message[] }>;
  } = {
    id: `tenant:${tenantId}`,
    events,
    pluginHost: finalPluginHost,
    applyPermissionRules(rules) {
      for (const sessionId of servedSessionIds) {
        options.runtime.getExecutionUnit({ tenantId, sessionId })?.applyPermissionRules(rules);
      }
    },
    async compactContext(sessionId) {
      // C6：有 live EU（含成员 EU）走 EU；idle session 走等价瞬态路径，
      // 不为它新造 EU（避免 agentId 绑定冲突与目录残留）。
      const unit = options.runtime.getExecutionUnit({ tenantId, sessionId });
      if (unit !== undefined) return unit.compactContext(sessionId);
      return compactIdleSession(sessionId);
    },
    async run(input, sessionId, opts) {
      const targetSession = sessionId ?? options.sessionId ?? 'default';
      servedSessionIds.add(targetSession);
      const unit = await executionUnitFor(targetSession);
      return trackActive(unit.run(input, targetSession, opts));
    },
    async resumeRun(runId, opts) {
      if (runStore === undefined) throw new Error(`durable_disabled: ${runId}`);
      const record = await runStore.load(runId);
      if (record === null) throw new Error(`run_not_found: ${runId}`);
      servedSessionIds.add(record.session_id);
      const unit = await executionUnitFor(record.session_id);
      // 调用方负责按 agent_id 路由；门面只处理 tenant EU。
      return trackActive(unit.resumeRun(record, opts));
    },
    async resumeSession(sessionId, input, opts) {
      servedSessionIds.add(sessionId);
      const unit = await executionUnitFor(sessionId);
      return trackActive(unit.resumeSession(sessionId, input, opts));
    },
    async dispose() {
      // 生命周期归 ControlPlane（bundle.close 逐个 retire）；门面不销毁共享 EU。
    },
  };

  // 0.15：run/resumeRun 的跨进程写锁。memory 后端不落盘，无需锁。
  const lockedRuntime = withSessionWriteLock(executionFacade, {
    tenantDir: tenantPaths.root,
    enabled: options.sessionLocks ?? backend !== 'memory',
  });

  // ── Trace ─────────────────────────────────────
  const extRedactor = options.redactor ?? (await loadRedactSecrets(loader));
  const redactor = composeTraceRedactors(createDefaultTraceRedactor(), extRedactor);
  const trace =
    options.writeTrace === true
      ? installTrace({
          events,
          config,
          tenantPaths,
          ...(extRedactor ? { redactor: extRedactor } : {}),
          ...(options.traceFactory ? { factory: options.traceFactory } : {}),
        })
      : undefined;

  // asm 事件：不含值、不含密钥。
  try {
    const nowTs = options.clock ?? Date.now;
    events.publish({
      type: 'config.loaded',
      run_id: 'config',
      data: {
        sources: [...new Set(Object.values(options.configSources ?? {}))],
        keys: Object.keys(config),
      },
      ts: nowTs(),
    });
    for (const event of pluginLoadEvents) {
      events.publish({ type: event.type, run_id: 'plugins', data: event.data, ts: nowTs() });
    }
  } catch {
    // 事件投递失败不阻断启动
  }

  // ── MCP ───────────────────────────────────────
  let mcpPlugin: McpPluginLike | undefined;
  let mcpControl: McpControl | undefined;
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    const wiring = await installMcp(
      {
        config,
        events,
        tenantId,
        loader,
        ...(options.loadMcpModule ? { loadModule: options.loadMcpModule } : {}),
      },
      finalPluginHost,
    );
    if (wiring) {
      mcpPlugin = wiring.plugin;
      mcpControl = wiring.control;
    }
  }

  // ── Feishu / Metrics ───────────────
  const feishuChannel = await createFeishuFromConfig({
    config,
    provider,
    model: providerModel,
    pluginHost: finalPluginHost,
    session,
    events,
    tenantId,
    env: {},
    ...(runStore ? { runStore } : {}),
    contextFactory,
    ...(options.feishuTransport !== undefined ? { transport: options.feishuTransport } : {}),
    ...(options.resolveFeishuTeamId !== undefined
      ? { resolveTeamId: options.resolveFeishuTeamId }
      : {}),
    ...(options.resolveFeishuService !== undefined
      ? { resolveService: options.resolveFeishuService }
      : {}),
    loader,
    ...(options.loadFeishuModule ? { loadModule: options.loadFeishuModule } : {}),
  });

  const metrics = createMetricsCollector(events, config, options.metricsFactory);

  // ── C4：AI 命名（ControlPlane 元数据写，与 sessions.rename 同一 save 路径） ──
  // 订阅本 tenant 事件流（含成员转发事件）；fire-and-forget，失败只 warn，
  // 不阻塞 run 终态，也不写 SessionEventLog。
  const titleGenerationInFlight = new Set<string>();
  const generateSessionTitle = async (sessionId: string): Promise<void> => {
    try {
      const state = await session.load(sessionId);
      if (state === null) return;
      const messages = state.messages ?? [];
      const derivedTitle = deriveSessionMeta(messages).title;
      // 人工 title 永不被覆盖；AI 已写过（不等于派生标题）则不再生成。
      if (state.title !== undefined && state.title !== derivedTitle) return;
      const input = firstUserInputForTitle(messages);
      if (input === undefined) return;
      const response = await provider.chat({
        model: providerModel,
        messages: [
          { role: 'system', content: SESSION_TITLE_SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        max_tokens: 64,
        temperature: 0.2,
        signal: AbortSignal.timeout(5000),
      });
      const title = sanitizeGeneratedTitle(response.content);
      if (title === '') return;
      // 生成窗口内可能人工 rename / 已有另一次命名：写前重读，保住人工标题。
      const current = await session.load(sessionId);
      if (current === null) return;
      const currentDerived = deriveSessionMeta(current.messages ?? []).title;
      if (current.title !== undefined && current.title !== currentDerived) return;
      await session.save({ ...current, title, updated_at: Date.now() });
      events.publish({
        type: 'session.titled',
        run_id: 'session',
        data: { session_id: sessionId, title },
        ts: Date.now(),
      });
    } catch (error) {
      logger.warn('session title generation failed', {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const unsubscribeTitles = events.subscribe((event) => {
    if (event.type !== 'run.completed') return;
    if (providerName === 'mock') return;
    const data = event.data as Record<string, unknown>;
    const sessionId = typeof data.session_id === 'string' ? data.session_id : undefined;
    if (sessionId === undefined) return;
    if (titleGenerationInFlight.has(sessionId)) return;
    titleGenerationInFlight.add(sessionId);
    void generateSessionTitle(sessionId).finally(() => {
      titleGenerationInFlight.delete(sessionId);
    });
  });

  let closed = false;
  const SHUTDOWN_DRAIN_TIMEOUT_MS = 5000;

  /** 关闭失败统一出口：logger.error + `shutdown.failed`（不阻断后续步骤） */
  const report = (step: string, error: unknown): void => {
    reportShutdownFailure({
      events,
      logger,
      step,
      error,
      tenantId,
      ...(options.clock ? { now: options.clock } : {}),
    });
  };

  /**
   * 0.10 R2-18：有在跑 run 时先 `interrupt('shutdown')`（checkpoint 落 interrupted，
   * 可 `--resume-run`），限时等待终态；超时记录 warning 后继续关闭。
   */
  const drain = async (): Promise<void> => {
    try {
      await drainActiveRuns({
        activeRuns,
        logger,
        tenantId,
        timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
        interrupt: (reason: 'shutdown') => {
          // Stage 4：每个 session 一个 EU；逐个软中断（checkpoint 落 interrupted）。
          for (const sessionId of servedSessionIds) {
            options.runtime.getExecutionUnit({ tenantId, sessionId })?.interrupt?.(reason);
          }
        },
      });
    } catch (error) {
      report('runtime.interrupt', error);
    }
  };

  const close = async (closeOptions: { drain?: boolean } = {}): Promise<void> => {
    if (closed) return;
    closed = true;

    // 先中断 / 等待在跑 run，再进入关闭顺序。
    // serve 路径已由 gateway.stop() 完成 drain，调用方传 drain:false 避免二次 5s。
    if (closeOptions.drain !== false) await drain();

    // 关闭顺序：feishu → metrics → MCP → runtime → trace
    // → runStore → session。全部 await，异常逐段隔离，后续步骤仍会执行。
    // 0.9：MCP 是工厂式插件，不在 runtime 的 `plugins` 数组里，
    // `ExecutionUnit.dispose()` 触达不到；它的 dispose() 只是 close() 的
    // 幂等别名（ext 0.9），因此这里保留显式 close —— 不要为接 dispose
    // 而改安装顺序（DECISION-019 A）。
    await stopFeishuChannel(feishuChannel, (error) => report('feishu.stop', error));

    disposeMetrics(metrics);

    if (mcpPlugin) {
      try {
        await mcpPlugin.close();
      } catch (error) {
        report('mcp.close', error);
      }
    }

    // Stage 4：per-session EU 由 Runtime 目录持有；逐个 retire（dispose + 移出目录）。
    // retire 幂等；单条失败不阻断其余条目与后续关闭步骤。
    for (const sessionId of servedSessionIds) {
      try {
        await options.runtime.retireExecutionUnit({ tenantId, sessionId });
      } catch (error) {
        report('runtime.retire', error);
      }
    }
    servedSessionIds.clear();

    // 插件在 EU 之外安装（tenant host 共享），随 bundle 关闭一起 dispose。
    try {
      await installedPlugins.dispose();
    } catch (error) {
      report('runtime.plugin.dispose', error);
    }

    if (trace) {
      try {
        await trace.flush();
      } catch (error) {
        report('trace.flush', error);
      }
      try {
        await trace.close();
      } catch (error) {
        report('trace.close', error);
      }
    }

    await closeRunRecordStore(runStore, (error) => report('runStore.close', error));

    if (eventLog) {
      try {
        await eventLog.close();
      } catch (error) {
        report('eventLog.close', error);
      }
    }

    try {
      session.close?.();
    } catch (error) {
      report('session.close', error);
    }

    unsubscribeTitles();
  };

  return {
    tenantId,
    config,
    tenantPaths,
    configSources: options.configSources ?? {},
    ...(options.configPaths ? { configPaths: options.configPaths } : {}),
    tenantOverlayKeys: options.tenantOverlayKeys ?? [],
    provider,
    providerName,
    providerModel,
    providerBaseUrl,
    events,
    runtimeEvents: events,
    session,
    pluginHost: finalPluginHost,
    scheduler,
    runtime: lockedRuntime,
    ...(leaseService !== undefined ? { leaseService } : {}),
    summarizer,
    ...(summarizerForSession !== undefined ? { summarizerForSession } : {}),
    ...(runStore ? { runStore } : {}),
    ...(eventLog ? { eventLog } : {}),
    ...(trace ? { trace } : {}),
    ...(metrics ? { metrics } : {}),
    redactor,
    ...(extRedactor ? { extRedactor } : {}),
    sessionControl,
    pluginLoader: loader,
    plugins,
    ...(mcpPlugin ? { mcpPlugin } : {}),
    ...(mcpControl ? { mcp: mcpControl } : {}),
    ...(feishuChannel ? { feishu: feishuChannel } : {}),
    close,
  };
}

/** ext redact-secrets 的结构镜像 */
interface RedactSecretsModuleLike {
  createTraceRedactor(config?: unknown): TraceRedactor;
}

/** 动态加载 ext redactor；缺失只 warn，不阻断启动 */
async function loadRedactSecrets(loader: PluginLoader): Promise<TraceRedactor | undefined> {
  try {
    const mod = (await loader.loadModule('redact-secrets')) as RedactSecretsModuleLike | null;
    if (!mod || typeof mod.createTraceRedactor !== 'function') {
      console.warn('⚠ redact-secrets unavailable; trace uses the core default redactor.');
      return undefined;
    }
    return mod.createTraceRedactor();
  } catch (error) {
    console.warn(
      `⚠ Failed to load redact-secrets: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
