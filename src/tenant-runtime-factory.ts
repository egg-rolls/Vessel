/**
 * 每 tenant 执行面（0.5 A-6 / DECISION-010 §13.2）。
 *
 * `buildTenantRuntime()` 构造一个 tenant 的独立 bundle：
 *   config / provider / session / runStore / context / pluginHost + plugins /
 *   trace / metrics / redactor / sessionControl / feishu / MCP。
 *
 * `createTenantRuntimeFactory()` 为 `--serve` 预构建全部 active tenant：
 * - 每个 tenant 独立 EventStream，构建时注册进 gateway 的 `TenantEventHub`；
 * - trace / metrics 只订阅本 tenant 流；
 * - 每个 tenant 持有自己的 writer lock；启动失败回滚已获取的锁。
 *
 * 本地单 tenant 模式复用 `buildTenantRuntime()`，只是只创建一个 bundle。
 *
 * @module vessel/tenant-runtime-factory
 */

import { join } from 'node:path';
import {
  type ConfigSources,
  DEFAULT_CONFIG,
  isTenantToolAllowed,
  loadConfig,
  resolveTenantToolPolicy,
  type TenantToolPolicy,
  type VesselConfig,
} from '../packages/config/src/index';
import {
  AgentRuntime,
  createDefaultTraceRedactor,
  type EventStream,
  estimateTokens,
  type Guardrail,
  type Hook,
  type LLMProvider,
  type Logger,
  MemoryContextManager,
  MemoryPluginHost,
  type Message,
  noopLogger,
  type Plugin,
  type PluginHost,
  type PluginInstallScope,
  type ProviderFactory,
  type RunnableAgent,
  type RunStore,
  type RuntimeHost,
  type RuntimePermissionConfig,
  resolveTenantPaths,
  type SelfCardOptions,
  type SessionBackend,
  SessionEventLog,
  type TenantPaths,
  type ToolDefinition,
  type TraceRedactor,
} from '../packages/core/src/index';
import type { TenantEventHub } from '../packages/serve/src/index';
import type { FeishuChannelLike, MetricsControlLike } from './control-plane-types';
import { resolveDataDir } from './data-paths';
import {
  assertUniqueFeishuAppIds,
  createFeishuFromConfig,
  stopFeishuChannel,
} from './feishu-wiring';
import { installMcp, type McpControl, type McpPluginLike } from './mcp-wiring';
import type { MockScenarioName } from './mock/scenarios';
import {
  createEventBus,
  createEventStream,
  createMetricsCollector,
  disposeMetrics,
  type MetricsFactory,
} from './observability-wiring';
import { resolveAgentCwd } from './path-resolution';
import {
  buildPluginConfigMap,
  declarativePluginEntries,
  installWithConfig,
  withPluginConfig,
} from './plugin-config';
import { PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';
import { createProvider } from './provider-factory';
import { withReasoning } from './reasoning';
import { closeRunStore, createRunStore } from './run-store-factory';
import { isHostEnabled, tryCreateHostRuntime } from './runtime-factory';
import { ownerSelfCard } from './self-card';
import { createSessionControl, type SessionControl } from './session-control';
import { createSessionBackend } from './session-factory';
import { withSessionWriteLock } from './session-lock-runtime';
import { reportShutdownFailure } from './shutdown-report';
import { acquireTenantLock, type TenantLock, type TenantLockMode } from './tenant-lock';
import {
  composeTraceRedactors,
  installTrace,
  pruneTenantTrace,
  type TraceControl,
  type TraceRecorderFactory,
} from './trace-wiring';

/** 构造一个 tenant 执行面的输入 */
export interface BuildTenantRuntimeOptions {
  tenantId: string;
  /** 已合并 tenant overlay 的配置 */
  config: VesselConfig;
  tenantPaths: TenantPaths;
  /** config.loaded 事件的来源（缺省空） */
  configSources?: ConfigSources;
  /** 用户/项目配置路径（config.get.paths） */
  configPaths?: { user: string; project: string };
  /** tenant overlay 命中的叶子键（config snapshot） */
  tenantOverlayKeys?: string[];
  /** 已持有的锁；缺省且 acquireLock=true 时由本函数获取并负责释放 */
  lock?: TenantLock;
  acquireLock?: boolean;
  /** tenant 锁模式；缺省 file/memory 后端 shared，sqlite 后端 exclusive */
  lockMode?: TenantLockMode;
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
   * ask_user：交互 REPL 与 serve/gateway 注册；headless / --run 不注册。
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
  /** 0.18：tenant 事件扇入面；每个 tenant 的运行时流在构建时注册。 */
  hub?: TenantEventHub;
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
  /** runtime 事件出口；host 模式下同 tenant 流（host bus 已桥接） */
  runtimeEvents: EventStream;
  session: SessionBackend;
  context: MemoryContextManager;
  pluginHost: PluginHost;
  runtime: RunnableAgent;
  host?: RuntimeHost;
  agentRuntime?: AgentRuntime;
  runStore?: RunStore;
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
  lock?: TenantLock;
  /**
   * 幂等关闭。`drain: false` 用于调用方已先 `await gateway.stop()` 的场景：
   * gateway 已完成 interrupt('shutdown') + 5s 等待，避免重复限时等待。
   */
  close(options?: { drain?: boolean }): Promise<void>;
}

/** 内部：锁所有权 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function tenantSessionsDbPath(tenantRoot: string): string {
  return join(tenantRoot, 'sessions.db');
}

/**
 * 0.18（DECISION-032 §1）：tenant 工具策略的 PluginHost 包装器。
 *
 * 只在注册边界过滤工具：被拒绝的工具既不进 `listTools()` / `getTool()`，
 * 也不会被模型看到或执行。provider / hook / guardrail / 插件生命周期不变；
 * `beginPluginInstall` 原样转发，安装失败回滚继续生效。
 */
export class TenantToolHost implements PluginHost {
  private readonly inner: PluginHost;
  private readonly policy: TenantToolPolicy | undefined;
  /** 仅在内部 host 支持回滚时暴露；未支持时不冒充 */
  beginPluginInstall?: (pluginName: string) => PluginInstallScope;

  constructor(inner: PluginHost, policy?: TenantToolPolicy) {
    this.inner = inner;
    this.policy = policy;
    const begin = inner.beginPluginInstall?.bind(inner);
    if (begin) {
      this.beginPluginInstall = (pluginName: string): PluginInstallScope => begin(pluginName);
    }
  }

  registerTool(def: ToolDefinition): void {
    if (!isTenantToolAllowed(def.name, this.policy)) return;
    this.inner.registerTool(def);
  }

  registerProvider(name: string, factory: ProviderFactory): void {
    this.inner.registerProvider(name, factory);
  }

  registerGuardrail(guardrail: Guardrail): void {
    this.inner.registerGuardrail(guardrail);
  }

  registerHook(hook: Hook): void {
    this.inner.registerHook(hook);
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.inner.getTool(name);
  }

  getProvider(name: string): ProviderFactory | undefined {
    return this.inner.getProvider(name);
  }

  getGuardrails(): Guardrail[] {
    return this.inner.getGuardrails();
  }

  getHooks(): Hook[] {
    return this.inner.getHooks();
  }

  listTools(): ToolDefinition[] {
    return this.inner.listTools();
  }

  listProviders(): string[] {
    return this.inner.listProviders();
  }
}

/** Self Card 的工具面只减不增：与 tenant policy 求交集（`src/self-card.ts` 不动）。 */
function withTenantToolPolicy(
  card: SelfCardOptions,
  policy: TenantToolPolicy | undefined,
): SelfCardOptions {
  if (!policy) return card;
  return {
    ...card,
    tools: card.tools.filter((name) => isTenantToolAllowed(name, policy)),
  };
}

/** core 0.6.1 E3 的 summarizer 形状（本 worktree 的 core 尚未导出该类型） */
type ContextSummarizer = (messages: Message[], options: { maxTokens: number }) => Promise<string>;

/** 单条消息渲染上限（字符）；超出只保留前缀，避免单条工具结果独占分块预算。 */
const SUMMARIZER_MAX_MESSAGE_CHARS = 12_000;
const SUMMARIZER_MAX_CHUNK_TOKENS = 48_000;
const SUMMARIZER_MIN_CHUNK_TOKENS = 2_000;
const SUMMARIZER_PARTIAL_MAX_TOKENS = 1024;
const SUMMARIZER_REDUCE_MAX_TOKENS = 2048;

const SUMMARY_SYSTEM_PROMPT =
  'Summarize the conversation for context compaction. Preserve decisions, file paths, tool names and results, and open tasks. Output only the summary.';
const PARTIAL_SYSTEM_PROMPT =
  'Summarize this part of a longer conversation for context compaction. Preserve decisions, file paths, tool names and results, and open tasks. Output only the partial summary.';
const REDUCE_SYSTEM_PROMPT =
  'Combine the ordered partial summaries into one conversation summary for context compaction. Preserve decisions, file paths, tool names and results, and open tasks. Output only the final summary.';

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

/**
 * 用当前 provider 生成真实上下文摘要（0.6.1 E3，0.14.4 分块）。
 *
 * 单块：一次摘要调用（输出 ≤ max(128, min(context.maxTokens, 2048))）。
 * 多块：每块一次部分摘要（≤1024），再 reduce 一次（≤2048）。
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

    const maxOutputTokens = Math.max(
      128,
      Math.min(options.maxTokens, SUMMARIZER_REDUCE_MAX_TOKENS),
    );

    if (chunks.length === 1) {
      try {
        return await summarize(
          SUMMARY_SYSTEM_PROMPT,
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
      return await summarize(REDUCE_SYSTEM_PROMPT, joined, maxOutputTokens);
    } catch {
      return truncateToTokenBudget(joined, maxOutputTokens);
    }
  };
}

/** 每 tenant 的上下文配置（含真实 summarizer）；供 owner 与成员共用。 */
function contextConfigFor(config: VesselConfig, summarizer: ContextSummarizer) {
  return {
    maxTokens: config.context?.maxTokens,
    maxMessages: config.context?.maxMessages,
    autoCompact: config.context?.autoCompact,
    compactThreshold: config.context?.compactThreshold,
    summarizer,
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
  };
}

/** `drainActiveRuns` 结果：无 run / 已终态 / 超时 / 运行时无 interrupt */
export type DrainOutcome = 'idle' | 'interrupted' | 'timeout' | 'unsupported';

export interface DrainActiveRunsOptions {
  /** active run id 集合；run 终态事件由订阅方删除 */
  activeRuns: Set<string>;
  /** legacy AgentRuntime.interrupt；host 模式没有 */
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
      tenant_id: options.tenantId,
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
      tenant_id: options.tenantId,
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
  // 0.18（DECISION-032 §1）：本 tenant 的工具策略在注册边界生效。
  const toolPolicy = resolveTenantToolPolicy(config, tenantId);
  const useMock = options.useMock ?? false;
  const headless = options.headless ?? false;
  const loader = options.loader ?? new PluginLoader();
  const logger = options.logger ?? noopLogger;

  const backend = config.session?.backend ?? 'file';
  const lockMode =
    options.lockMode ?? (backend === 'sqlite' ? ('exclusive' as const) : ('shared' as const));
  let ownedLock: TenantLock | undefined;
  if (options.lock === undefined && options.acquireLock === true) {
    ownedLock = await acquireTenantLock({
      tenantDir: tenantPaths.root,
      tenantId,
      mode: lockMode,
      ...(options.clock ? { now: options.clock } : {}),
    });
  }
  const lock = options.lock ?? ownedLock;

  try {
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

    const runStore = createRunStore(config, {
      tenantRunsDir: tenantPaths.runs_dir,
      tenantId,
    });
    const resolvedProvider = await createProvider(config, loader, useMock, options.mockScenario);
    const { provider, providerName, providerModel, providerBaseUrl } = resolvedProvider;

    const summarizer = createContextSummarizer(provider, providerModel);
    const context = new MemoryContextManager(contextConfigFor(config, summarizer));
    const events = createEventStream(config);

    // 0.10 R2-18：只跟踪真实在跑的 run（包装 legacy `AgentRuntime.run/resume`），
    // 不从事件推断——测试 / gateway 也会发布合成的 run.started，按事件跟踪会让
    // shutdown 白等 5s。host 模式没有可中断的 handle，不在此集合内。
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

    // 0.18：本 tenant 的运行时流注册进 gateway 的事件扇入面。
    const unregisterHub = options.hub?.register(tenantId, events);

    const session = createSessionBackend(config.session, {
      tenantSessionsDir: tenantPaths.sessions_dir,
      tenantSessionsDbPath: tenantSessionsDbPath(tenantPaths.root),
      tenantId,
    });
    // 0.18：事件日志按 tenant 的 sessions 目录落盘（`sessions/<id>/events.ndjson`）。
    // 仅在本地写意图 + 持久化后端时创建；memory 后端/只读执行面保持零磁盘写入。
    const eventLog =
      options.writeTrace === true && backend !== 'memory'
        ? new SessionEventLog({ dir: tenantPaths.sessions_dir, tenantId, logger })
        : undefined;
    const sessionControl = createSessionControl({
      session,
      paths: tenantPaths,
      events,
      tenantId,
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
        // E1：配置在 install 时透传（host 路径直接传；非 host 路径见 AgentRuntime）。
        plugins.push(plugin);
        pluginLoadEvents.push({
          type: 'plugin.loaded',
          data: {
            name: plugin.name,
            category,
            version: plugin.version ?? descriptor?.version ?? '',
            tenant_id: tenantId,
          },
        });
      } else {
        pluginLoadEvents.push({
          type: 'plugin.failed',
          data: { name, category, reason: 'load_failed', tenant_id: tenantId },
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
    const limits = config.limits ?? DEFAULT_CONFIG.limits ?? {};
    const termination = {
      maxIterations:
        config.termination?.maxIterations ?? DEFAULT_CONFIG.termination?.maxIterations ?? 20,
      maxRuntimeSeconds:
        config.termination?.maxRuntimeSeconds ?? DEFAULT_CONFIG.termination?.maxRuntimeSeconds,
    };
    const systemPrompt = config.agent?.systemPrompt ?? '你是一个有用的 AI 助手。';

    let runtime: RunnableAgent | undefined;
    let host: RuntimeHost | undefined;
    let agentRuntime: AgentRuntime | undefined;
    let selectedPluginHost: PluginHost | undefined;
    let unsubHostBridge: (() => void) | undefined;

    const contextFactory = () => new MemoryContextManager(contextConfigFor(config, summarizer));

    if (isHostEnabled(config)) {
      // 0.9 已知限制：host 模式把插件直接装到共享 PluginHost，成员 runtime 不再持有
      // `plugins` 列表，因此 `AgentRuntime.dispose()`（插件逆序清理）触达不到这些插件。
      // 本轮的关闭责任在宿主侧（bootstrap shutdown 只关 runtime/host），等 core 给出
      // PluginHost/Host 级 dispose 接缝后再迁移；不要在此另造一套清理顺序。
      const hostPluginHost = new TenantToolHost(new MemoryPluginHost(), toolPolicy);
      for (const plugin of plugins) {
        await installWithConfig(plugin, hostPluginHost, pluginConfigs[plugin.name]);
      }

      const hostEvents = createEventBus(config);
      // host runtime 事件先进入 host bus，再桥接到本 tenant 流。
      unsubHostBridge = hostEvents.subscribe((event) => {
        try {
          events.publish(event);
        } catch {
          // tenant 流订阅者异常不影响 host
        }
      });

      const hostResult = await tryCreateHostRuntime({
        config,
        owner: {
          id: config.agent?.ownerId ?? 'main',
          provider,
          model: providerModel,
          pluginHost: hostPluginHost,
          context,
          session,
          systemPrompt,
          limits,
          termination,
          permission,
          selfCard: withTenantToolPolicy(
            ownerSelfCard(config, providerModel, {
              askUser: options.registerAskUser === true,
            }),
            toolPolicy,
          ),
        },
        sessionId: options.sessionId ?? crypto.randomUUID(),
        ...(runStore ? { runStore } : {}),
        ...(eventLog ? { eventLog } : {}),
        ...(hostEvents ? { events: hostEvents } : {}),
        contextFactory,
      });

      if (hostResult.ok) {
        runtime = hostResult.runtime;
        host = hostResult.host;
        selectedPluginHost = hostPluginHost;
      } else {
        console.warn(
          `⚠ Host runtime unavailable (${hostResult.error}); falling back to the single-agent runtime.`,
        );
      }
    }

    if (!runtime) {
      agentRuntime = await AgentRuntime.create(
        // 0.11.1：`ui.showReasoning` 显式 opt-in（默认 false，行为同 0.11.0）。
        withReasoning(config, {
          provider,
          model: providerModel,
          context,
          events,
          limits,
          termination,
          session,
          // core 0.6.1：pluginConfigs 按名透传；本 worktree 的 core 尚未有该字段，
          // 同时用 wrapper 绑定配置，保证 core 合并前后行为一致。
          plugins: plugins.map((plugin) => withPluginConfig(plugin, pluginConfigs[plugin.name])),
          systemPrompt,
          permission,
          // 0.15 E9：主 agent 的 Self Card（成员由 AgentService 注入）；
          // 0.18：tenant policy 只减不增。
          selfCard: withTenantToolPolicy(
            ownerSelfCard(config, providerModel, {
              askUser: options.registerAskUser === true,
            }),
            toolPolicy,
          ),
          // 0.18（DECISION-032 §1.5）：非 host 路径同样经过滤器注册工具
          // （AgentRuntime 不再自建 host）。
          pluginHost: new TenantToolHost(new MemoryPluginHost(), toolPolicy),
          ...(Object.keys(pluginConfigs).length > 0 ? { pluginConfigs } : {}),
          ...(runStore ? { runStore } : {}),
          ...(eventLog ? { eventLog } : {}),
          logger,
        } as Parameters<typeof AgentRuntime.create>[0] & {
          pluginConfigs?: Record<string, Record<string, unknown>>;
        }),
      );
      // 0.10 R2-18：包装 run/resume 以精确跟踪在跑 run（shutdown drain 用）。
      const originalRun = agentRuntime.run.bind(agentRuntime);
      agentRuntime.run = (input, sessionId, opts) =>
        trackActive(originalRun(input, sessionId, opts));
      const originalResume = agentRuntime.resume?.bind(agentRuntime);
      if (originalResume) {
        agentRuntime.resume = (runId, opts) => trackActive(originalResume(runId, opts));
      }
      runtime = agentRuntime;
      selectedPluginHost = agentRuntime.pluginHost;
    }

    const activeRuntime = runtime;
    // 0.15：run/resume 的跨进程写锁。memory 后端不落盘，无需锁。
    const lockedRuntime = withSessionWriteLock(activeRuntime, {
      tenantDir: tenantPaths.root,
      enabled: options.sessionLocks ?? backend !== 'memory',
    });
    const finalPluginHost = selectedPluginHost ?? activeRuntime.pluginHost;

    // ── Trace ─────────────────────────────────────
    const extRedactor = options.redactor ?? (await loadRedactSecrets(loader));
    const redactor = composeTraceRedactors(createDefaultTraceRedactor(), extRedactor);
    const trace =
      options.writeTrace === true
        ? installTrace({
            events,
            config,
            tenantPaths,
            tenantId,
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
          tenant_id: tenantId,
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
      loader,
      ...(options.loadFeishuModule ? { loadModule: options.loadFeishuModule } : {}),
    });

    const metrics = createMetricsCollector(events, config, options.metricsFactory);

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
     * host 模式 core 尚无公开 interrupt，只有 host.close() 的取消语义。
     */
    const drain = async (): Promise<void> => {
      const interrupt = (agentRuntime as { interrupt?: (reason?: 'shutdown') => void } | undefined)
        ?.interrupt;
      try {
        await drainActiveRuns({
          activeRuns,
          logger,
          tenantId,
          timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
          ...(typeof interrupt === 'function'
            ? { interrupt: (reason: 'shutdown') => interrupt.call(agentRuntime, reason) }
            : {}),
        });
      } catch (error) {
        report('runtime.interrupt', error);
      }
    };

    const close = async (options: { drain?: boolean } = {}): Promise<void> => {
      if (closed) return;
      closed = true;

      // 先中断 / 等待在跑 run，再进入关闭顺序。
      // serve 路径已由 gateway.stop() 完成 drain，调用方传 drain:false 避免二次 5s。
      if (options.drain !== false) await drain();

      // 关闭顺序：feishu → metrics → MCP → host/runtime → trace
      // → runStore → session。全部 await，异常逐段隔离，后续步骤仍会执行。
      // 0.9：MCP 是工厂式插件，不在 runtime 的 `plugins` 数组里，
      // `AgentRuntime.dispose()` 触达不到；它的 dispose() 只是 close() 的
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

      try {
        if (host) await host.close();
      } catch (error) {
        report('host.close', error);
      }

      // 0.9：AgentRuntime.dispose() 返回 Promise（逆序调插件 dispose）；
      // 必须等待，否则进程退出会截断插件清理。dispose 自身幂等且不外抛。
      try {
        await activeRuntime.dispose();
      } catch (error) {
        report('runtime.dispose', error);
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

      await closeRunStore(runStore, (error) => report('runStore.close', error));

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

      unsubHostBridge?.();
      unregisterHub?.();

      if (ownedLock) {
        try {
          await ownedLock.release();
        } catch (error) {
          report('tenantLock.release', error);
        }
      }
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
      context,
      pluginHost: finalPluginHost,
      runtime: lockedRuntime,
      ...(host ? { host } : {}),
      ...(agentRuntime ? { agentRuntime } : {}),
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
      ...(lock ? { lock } : {}),
      close,
    };
  } catch (error) {
    if (ownedLock) {
      try {
        await ownedLock.release();
      } catch {
        // best-effort
      }
    }
    throw error;
  }
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

// ── 多租户工厂（--serve） ─────────────────────────

/** 工厂注入 */
export interface TenantRuntimeFactoryOptions {
  /** 基础配置（用于 data_dir / tenant 列表） */
  config: VesselConfig;
  configPath?: string;
  userConfigPath?: string;
  dataDir?: string;
  useMock?: boolean;
  /** mock 场景（仅 useMock）；逐 tenant 透传 */
  mockScenario?: MockScenarioName;
  headless?: boolean;
  /**
   * 0.15：是否为每个 tenant 注册 ask_user（gateway / serve 有可交互客户端时为 true）。
   * 每个 tenant 的 `ui.askUser: false` 仍会单独关闭。
   */
  registerAskUser?: boolean;
  loader?: PluginLoader;
  nodeId: string;
  /** 0.18：所有 tenant 运行时流的扇入面 */
  hub?: TenantEventHub;
  metricsFactory?: MetricsFactory;
  traceFactory?: TraceRecorderFactory;
  redactor?: TraceRedactor;
  /** 诊断 logger（0.10 R2-14）；所有 tenant 共用同一 stderr sink */
  logger?: Logger;
  clock?: () => number;
  /** 默认 true：serve 为每个 active tenant 持锁 */
  acquireLocks?: boolean;
  /** 0.15：`--exclusive` 强制全部 tenant 用单写者锁 */
  exclusive?: boolean;
  /** 默认 true：serve 安装每 tenant trace */
  writeTrace?: boolean;
  /**
   * 已由 bootstrap 构建的 tenant（serve 的默认 tenant）。
   * 工厂不重复构建、不关闭；调用方负责其生命周期。
   */
  seededTenants?: TenantRuntimeBundle[];
  loadMcpModule?: () => Promise<unknown | null>;
  loadFeishuModule?: () => Promise<unknown | null>;
}

/** 工厂（启动完成后访问器是同步的，匹配 gateway 的注入面） */
export interface TenantRuntimeFactory {
  /** 已成功构建的 tenant id */
  tenantIds(): string[];
  runtimeFor(tenantId: string): RunnableAgent | undefined;
  sessionFor(tenantId: string): SessionBackend | undefined;
  contextFor(tenantId: string): MemoryContextManager | undefined;
  pluginHostFor(tenantId: string): PluginHost | undefined;
  metricsFor(tenantId: string): MetricsControlLike | undefined;
  pluginsFor(tenantId: string): Array<{ name: string; enabled: boolean }> | undefined;
  bundleFor(tenantId: string): TenantRuntimeBundle | undefined;
  /** 0.12：清空所有 tenant 的插件扫描缓存（下次 list() 重新扫描） */
  refreshPlugins(): void;
  /** `drain: false`：调用方已 await gateway.stop()（已做 interrupt + 5s 等待） */
  closeAll(options?: { drain?: boolean }): Promise<void>;
}

/** `status` 缺省视为 active；包含显式 default tenant（隐式配置）。 */
export function listActiveTenantIds(config: VesselConfig): string[] {
  const configured = config.tenant?.tenants ?? {};
  const ids = Object.entries(configured)
    .filter(([, settings]) => settings.status !== 'disabled')
    .map(([id]) => id);
  const fallback = nonEmpty(config.tenant?.default) ?? 'default';
  const fallbackSettings = configured[fallback];
  if (fallbackSettings?.status !== 'disabled' && !ids.includes(fallback)) ids.push(fallback);
  return ids;
}

/** 载入一个 tenant 的合并配置；禁用 tenant 返回 null。 */
export async function loadTenantRuntimeConfig(
  tenantId: string,
  options: Pick<TenantRuntimeFactoryOptions, 'configPath' | 'userConfigPath' | 'dataDir'>,
): Promise<{
  config: VesselConfig;
  sources: ConfigSources;
  tenantPaths: TenantPaths;
  paths: { user: string; project: string };
  tenantOverlayKeys: string[];
} | null> {
  const loaded = await loadConfig({
    tenantId,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
  });
  if (loaded.validation.errors.length > 0) {
    throw new Error(
      `tenant "${tenantId}" config invalid: ${loaded.validation.errors
        .map((error) => error.message)
        .join('; ')}`,
    );
  }
  if (loaded.config.tenant?.tenants?.[tenantId]?.status === 'disabled') return null;
  const tenantPaths = resolveTenantPaths(
    options.dataDir ?? resolveDataDir(loaded.config),
    tenantId,
  );
  return {
    config: loaded.config,
    sources: loaded.sources,
    tenantPaths,
    paths: loaded.paths,
    tenantOverlayKeys: loaded.tenantOverlayKeys,
  };
}

/**
 * 预构建全部 active tenant；任一 tenant 失败 → 释放已建 bundle 的锁并抛出。
 * 同一 app_id 跨 tenant → 装配期拒绝启动（A-6 §13.4）。
 */
export async function createTenantRuntimeFactory(
  options: TenantRuntimeFactoryOptions,
): Promise<TenantRuntimeFactory> {
  const bundles = new Map<string, TenantRuntimeBundle>();
  const owned = new Set<string>();
  for (const seeded of options.seededTenants ?? []) {
    bundles.set(seeded.tenantId, seeded);
  }
  const loader = options.loader ?? new PluginLoader();
  const acquireLocks = options.acquireLocks ?? true;
  const writeTrace = options.writeTrace ?? true;

  try {
    const activeIds = listActiveTenantIds(options.config);
    const loadedTenants = new Map<
      string,
      {
        config: VesselConfig;
        sources: ConfigSources;
        tenantPaths: TenantPaths;
        paths: { user: string; project: string };
        tenantOverlayKeys: string[];
      }
    >();

    for (const tenantId of activeIds) {
      const seeded = bundles.get(tenantId);
      if (seeded) {
        // 不重新加载：bootstrap 可能已合并首启向导写入的内存配置。
        loadedTenants.set(tenantId, {
          config: seeded.config,
          sources: seeded.configSources,
          tenantPaths: seeded.tenantPaths,
          paths: seeded.configPaths ?? { user: '', project: 'vessel.yaml' },
          tenantOverlayKeys: seeded.tenantOverlayKeys,
        });
        continue;
      }
      const loaded = await loadTenantRuntimeConfig(tenantId, options);
      if (!loaded) continue;
      loadedTenants.set(tenantId, loaded);
    }

    assertUniqueFeishuAppIds(
      [...loadedTenants.entries()].map(([tenantId, loaded]) => ({
        tenantId,
        config: loaded.config,
      })),
    );

    for (const [tenantId, loaded] of loadedTenants) {
      // serve 的默认 tenant 已由 bootstrap 构建。
      if (bundles.has(tenantId)) continue;
      const bundle = await buildTenantRuntime({
        tenantId,
        config: loaded.config,
        tenantPaths: loaded.tenantPaths,
        configSources: loaded.sources,
        configPaths: loaded.paths,
        tenantOverlayKeys: loaded.tenantOverlayKeys,
        acquireLock: acquireLocks,
        ...(options.exclusive === true ? { lockMode: 'exclusive' as const } : {}),
        writeTrace,
        pruneTrace: writeTrace,
        ...(options.useMock !== undefined ? { useMock: options.useMock } : {}),
        ...(options.mockScenario !== undefined ? { mockScenario: options.mockScenario } : {}),
        ...(options.headless !== undefined ? { headless: options.headless } : {}),
        ...(options.registerAskUser !== undefined
          ? { registerAskUser: options.registerAskUser }
          : {}),
        loader,
        nodeId: options.nodeId,
        ...(options.hub ? { hub: options.hub } : {}),
        ...(options.metricsFactory ? { metricsFactory: options.metricsFactory } : {}),
        ...(options.traceFactory ? { traceFactory: options.traceFactory } : {}),
        ...(options.redactor ? { redactor: options.redactor } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.loadMcpModule ? { loadMcpModule: options.loadMcpModule } : {}),
        ...(options.loadFeishuModule ? { loadFeishuModule: options.loadFeishuModule } : {}),
      });
      bundles.set(tenantId, bundle);
      owned.add(tenantId);
    }

    let closed = false;
    return {
      tenantIds: () => [...bundles.keys()],
      runtimeFor: (tenantId) => bundles.get(tenantId)?.runtime,
      sessionFor: (tenantId) => bundles.get(tenantId)?.session,
      contextFor: (tenantId) => bundles.get(tenantId)?.context,
      pluginHostFor: (tenantId) => bundles.get(tenantId)?.pluginHost,
      metricsFor: (tenantId) => bundles.get(tenantId)?.metrics,
      pluginsFor: (tenantId) => {
        const bundle = bundles.get(tenantId);
        if (!bundle) return undefined;
        const loaded = new Set(bundle.plugins.map((plugin) => plugin.name));
        const listed = bundle.plugins.map((plugin) => ({ name: plugin.name, enabled: true }));
        // 配置里显式 disabled 的插件不加载，但仍要出现在 plugins.list 中。
        for (const configured of bundle.config.plugins ?? []) {
          if (configured.enabled === false && !loaded.has(configured.name)) {
            listed.push({ name: configured.name, enabled: false });
          }
        }
        return listed;
      },
      bundleFor: (tenantId) => bundles.get(tenantId),
      refreshPlugins: () => {
        const loaders = new Set<PluginLoader>([loader]);
        for (const bundle of bundles.values()) loaders.add(bundle.pluginLoader);
        for (const pluginLoader of loaders) pluginLoader.refresh();
      },
      closeAll: async (closeOptions: { drain?: boolean } = {}) => {
        if (closed) return;
        closed = true;
        // 逆序关闭本工厂构建的 tenant；seed 由调用方关闭。
        const entries = [...bundles.entries()].filter(([id]) => owned.has(id)).reverse();
        for (const [, bundle] of entries) {
          try {
            await bundle.close(closeOptions);
          } catch (error) {
            console.warn(
              `⚠ Failed to close tenant "${bundle.tenantId}": ${
                error instanceof Error ? error.message : error
              }`,
            );
          }
        }
        bundles.clear();
        owned.clear();
      },
    };
  } catch (error) {
    for (const [id, bundle] of [...bundles.entries()].reverse()) {
      if (!owned.has(id)) continue;
      try {
        await bundle.close();
      } catch {
        // best-effort rollback
      }
    }
    throw error;
  }
}
