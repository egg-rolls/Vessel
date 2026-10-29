/**
 * Plugin 类型定义
 * @module @vessel-agent/core/plugin
 */

import type { Guardrail } from './guardrail.js';
import type { Hook } from './hook.js';
import type { ProviderFactory } from './provider.js';
import type { RunStore } from './run-store.js';
import type { ToolDefinition } from './tool.js';

/**
 * Plugin 安装选项（0.6.1 E1）。
 * 宿主按插件配置透传；未提供配置时沿用旧调用 `install(host)`。
 */
export interface PluginInstallOptions {
  config?: Record<string, unknown>;
}

/** `init` 的上下文（0.9 生命周期 v2）；只暴露宿主，不引入配置/事件依赖 */
export interface PluginInitContext {
  host: PluginHost;
}

/** Plugin 接口 */
export interface Plugin {
  name: string;
  version?: string;
  description?: string;
  /** 第二个参数可选：旧的 `install(host)` 实现与调用继续合法（E1） */
  install(host: PluginHost, options?: PluginInstallOptions): void | Promise<void>;
  /** 所有插件 install 成功后按安装顺序调用；异常被隔离在单个插件内（0.9） */
  init?(ctx: PluginInitContext): void | Promise<void>;
  /** `AgentRuntime.dispose()` 时按逆安装顺序调用；best-effort（0.9） */
  dispose?(): void | Promise<void>;
}

/**
 * 一次插件安装的注册记录（0.9）。
 * `commit()` 丢弃记录；`rollback()` 撤销本次记录的注册条目。
 */
export interface PluginInstallScope {
  commit(): void;
  rollback(): void;
}

/** PluginHost 接口 */
export interface PluginHost {
  registerTool(def: ToolDefinition): void;
  registerProvider(name: string, factory: ProviderFactory): void;
  registerGuardrail(guardrail: Guardrail): void;
  registerHook(hook: Hook): void;
  getTool(name: string): ToolDefinition | undefined;
  getProvider(name: string): ProviderFactory | undefined;
  getGuardrails(): Guardrail[];
  getHooks(): Hook[];
  listTools(): ToolDefinition[];
  listProviders(): string[];
  /**
   * 可选：注销已注册的工具（热应用用）。缺省不支持的宿主由调用方按“不可热移除”处理。
   * 返回是否真的移除了——未注册过返回 false，不视为错误。
   */
  unregisterTool?(name: string): boolean;
  /**
   * 可选：记录一次插件安装的注册，用于安装失败时回滚（0.9）。
   * 不支持回滚的自定义宿主可以不实现。
   */
  beginPluginInstall?(pluginName: string): PluginInstallScope;
}

/** 默认权限策略（ADR-029：未声明 checkPermission 的工具用此默认判定） */
export interface RuntimePermissionConfig {
  /** 默认判定：'ask'（交互确认）或 'allow'（放行）。默认 'allow'——库默认不确认，由 app 层显式开启 */
  default?: 'allow' | 'ask';
  /** 免确认工具名列表 */
  autoApprove?: string[];
  /**
   * 自动放行的例外键（0.27 / CONTRACT-tool-policy-ui §1）：
   * - exact 工具名命中：把任何 `allow`（含工具 `checkPermission` 的显式 allow）降级为 `ask`；
   * - `${tool.name}.${action}` 命中：只把 **auto 来源**的 allow 降级为 `ask`，
   *   不覆盖工具显式 allow（保留 `agent.close` 对 contractor close 的语义）。
   * `deny` 不受影响。
   */
  neverAutoApprove?: string[];
  /**
   * 0.13（DECISION-024 Addendum A）：等待 `tool.permission.response` 的显式超时（毫秒）。
   * 缺省 / `<= 0` = 无限期等待，直到应答或取消；只有正数才产生
   * `PermissionTimeoutError` 并在请求事件里带 `deadline_at`。
   */
  timeoutMs?: number;
}

/** Self Card 的有效限额（0.15 E9）：键名与 UsageLimits / TerminationPolicy 一致 */
export interface SelfCardLimits {
  requestLimit?: number;
  toolCallsLimit?: number;
  inputTokensLimit?: number;
  outputTokensLimit?: number;
  totalCostLimit?: number;
  maxIterations?: number;
  maxRuntimeSeconds?: number;
}

/** Self Card 的上下文预算（0.15 E9） */
export interface SelfCardContext {
  /** token 预算上限 */
  max: number;
  /** 已用 token；run 开始时由 runtime 用 context.tokenCount 补齐 */
  used?: number;
}

/**
 * 0.15 E9：注入 systemPrompt 的 Self Card（≤400 tokens）。
 * 顶层字段名按冻结契约（`parent_id` / `how_to_ask`）；缺省不注入。
 */
export interface SelfCardOptions {
  role: string;
  parent_id?: string;
  /** 所属 Team（仅绑定 Team 的成员）；非空时渲染 `team: <id>` */
  team_id?: string;
  depth: number;
  model: string;
  /** 可调用工具名 */
  tools: string[];
  limits: SelfCardLimits;
  context: SelfCardContext;
  /** 如何请求人工帮助 */
  how_to_ask?: string;
}

/** AgentRuntime 配置 */
export interface AgentRuntimeOptions {
  provider: import('./provider.js').LLMProvider;
  model: string;
  context: import('./context.js').ContextManager;
  events: import('./event.js').EventStream;
  limits: import('./limits.js').UsageLimits;
  termination: import('./limits.js').TerminationPolicy;
  plugins?: Plugin[];
  /**
   * 按插件名提供的安装配置（0.6.1 E1）。
   * 存在时以 `install(host, { config })` 调用；缺省时保持 `install(host)`。
   */
  pluginConfigs?: Record<string, Record<string, unknown>>;
  session?: import('./session.js').SessionBackend;
  systemPrompt?: string; // 系统提示词
  /** 默认权限策略——未声明 checkPermission 的工具用 default/autoApprove 判定（ADR-029） */
  permission?: RuntimePermissionConfig;
  /** 可注入的 PluginHost（默认 MemoryPluginHost）——依赖倒置（ADR-033） */
  pluginHost?: PluginHost;
  /** 可注入的限制检查器（默认 MemoryLimitChecker）——依赖倒置（ADR-033） */
  limitChecker?: import('./limits.js').LimitChecker;
  /** 可选：durable run 检查点存储；缺省不写 checkpoint（零开销） */
  runStore?: RunStore;
  /** 可选：写入 checkpoint.agent_id（Host 注入成员 id；单 agent 可缺省） */
  agentId?: string;
  /** 0.5：所属 tenant；事件 / RunState / RunCheckpoint 在缺失时补齐 */
  tenantId?: string;
  /**
   * 0.11.1：是否把思维的流式增量（`reasoning_delta`）经 `llm.stream.chunk` 发布。
   * 默认 false（显式 opt-in）；false 时请求 / 事件与 0.11.0 完全一致。
   */
  includeReasoning?: boolean;
  /**
   * 0.10：诊断日志 sink；缺省 noop。
   * 未注入且设置了 `VESSEL_DEBUG` 时，runtime 兜底为 stderr logger（level=debug）。
   */
  logger?: import('./logging.js').Logger;
  /** 0.15 E9：Self Card；缺省不注入，行为不变 */
  selfCard?: SelfCardOptions;
  /**
   * 0.28：上下文压力提示的尾句文案；缺省保持 `agent(rotate)` 原文案。
   * 供不能靠 rotate 自愈的入口（如 temporary 成员）换成自己的行动建议。
   * 运行期可用 `AgentRuntime.applyContextPolicy` 热替换（身份转换后下一轮生效）。
   */
  contextPressureHint?: string;
  /**
   * 0.18：会话事件日志（唯一真相源）。提供时 runtime 在发布每个事实事件前
   * 先追加落盘（`llm.stream.chunk` 等派生事件除外）；缺省不落盘，行为与 0.17 一致。
   */
  eventLog?: import('./event.js').SessionEventLogPort;
}
