/**
 * Plugin 类型定义
 * @module @vessel-agent/core/plugin
 */

import type { Guardrail } from './guardrail.js';
import type { Hook } from './hook.js';
import type { MemberBodyContribution, PluginPortName } from './member-port.js';
import type { ProviderFactory } from './provider.js';
import type { RunJournalFactory } from './run-journal.js';
import type { ToolDefinition } from './tool.js';
import type { ToolNameAlias, ToolNameAudit } from './tool-name.js';

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
  /** `ExecutionUnit.dispose()` 时按逆安装顺序调用；best-effort（0.9） */
  dispose?(): void | Promise<void>;
  /**
   * in-process RPC handler 入口（model-registry D3）：与 child dispatch 同形
   * （bare 方法名 + JSON DTO params，返回 JSON DTO）。装配层在 install 后把它
   * 注册进宿主 PluginRpcRegistry（canonical `plugin.<id>.<name>`，同一 DTO 校验）；
   * child 插件经子进程协议 dispatch，不实现它。
   */
  rpc?(name: string, params: Record<string, unknown>): Promise<unknown>;
}

/**
 * 一次插件安装的注册记录（0.9）。
 * `commit()` 丢弃记录；`rollback()` 撤销本次记录的注册条目。
 */
export interface PluginInstallScope {
  commit(): void;
  rollback(): void;
  /**
   * 生命周期审计（q-plugin-lifecycle §6.1）：本次安装至今登记过的注册面种类。
   * 真源是宿主实际看到的注册行为，不是插件自报 —— 供 per-capability 生命周期推导。
   * 可选：不实现的自定义宿主退化成「审计为空」，推导按保守口径处理。
   */
  surfaces?(): ReadonlySet<PluginSurfaceKind>;
}

/**
 * 插件 install 期可登记的注册面种类（与 MemoryPluginHost 的注册条目 kind 同集）。
 * 生命周期推导据此判断「热应用能否完整摘除 / 重建该插件的全部注册面」。
 */
export type PluginSurfaceKind =
  | 'tool'
  | 'provider'
  | 'guardrail'
  | 'hook'
  | 'memberBody'
  | 'readSideMasker';

/**
 * 读侧文本脱敏器（0.52 pii-guard）。
 *
 * 只作用于「请求构造层」与「展示投影层」的文本投影：`mask` 收到原文、返回展示 /
 * 请求用的文本。**它绝不参与落盘**——会话存储里保留的是原文（append-only 硬约束）。
 */
export interface ReadSideMasker {
  /** 去重 / 回滚用的标识（插件名足够） */
  name: string;
  mask(text: string): string;
}

/**
 * 注册工具的选项（0.55 工具名 snake_case）。
 *
 * `external: true` 是**外部来源通道**（MCP server / 第三方插件）：名字由对方决定，
 * 我们原样透传、不改写，但注册表仍会校验它——不合规只报 warning（装配日志里可见），
 * 不阻断装配。内置 / 本仓插件一律不要传它。
 */
export interface RegisterToolOptions {
  /** 外部来源（MCP 等）：不合规只 warning，不阻断 */
  external?: boolean;
  /** 外部来源的可读标识（例如 `mcp:<server>`），只进告警文案 */
  source?: string;
}

/** PluginHost 接口 */
export interface PluginHost {
  registerTool(def: ToolDefinition, options?: RegisterToolOptions): void;
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
   * 可选（q-plugin-lifecycle §6.3）：按名注销 hook / guardrail / provider / 读侧脱敏器。
   * 与 `unregisterTool?` 同口径——热应用要把一个插件的**全部注册面**整体摘干净 / 重建，
   * 只有工具面可注销会造成「pii_reveal 进了但脱敏 guardrail 不生效」的危险半态。
   * 返回是否真的移除（未注册过 false，不视为错误）；不实现的自定义宿主由调用方按
   * 「该面不可热移除」保守处理（生命周期推导取 restart）。
   */
  unregisterHook?(name: string): boolean;
  unregisterGuardrail?(name: string): boolean;
  unregisterProvider?(name: string): boolean;
  unregisterReadSideMasker?(name: string): boolean;
  /**
   * 可选：记录一次插件安装的注册，用于安装失败时回滚（0.9）。
   * 不支持回滚的自定义宿主可以不实现。
   */
  beginPluginInstall?(pluginName: string): PluginInstallScope;
  /**
   * 可选（0.51）：登记一个成员身体贡献 —— 插件申请宿主端口 / 给成员 body 供工具与 hook。
   *
   * 可选而不是必选，与 `unregisterTool?` / `beginPluginInstall?` 同口径：老的自定义宿主
   * 不实现就退化成「没有成员面」（成员 body 拿到的工具面与 0.50 完全一致），不炸。
   *
   * 只有 `MemberExecutionHost.spawn` 消费它；节点侧永不读（端口只属于成员身体）。
   * 实现方须按 `name` 去重，并把这次登记记进当前 `beginPluginInstall` 的 scope ——
   * 安装失败回滚要能把它一起摘掉，否则一次失败的安装会留下半个成员面。
   */
  registerMemberBodyContribution?(contribution: MemberBodyContribution<PluginPortName>): void;
  /**
   * 可选（0.51）：本宿主上已登记的成员身体贡献，按登记顺序。
   * 未实现 / 没有贡献时调用方按空数组处理。
   */
  getMemberBodyContributions?(): readonly MemberBodyContribution<PluginPortName>[];
  /**
   * 可选（0.52 pii-guard）：登记一个**读侧**文本脱敏器。
   *
   * 只作用于「请求构造层」（发给 provider 的 messages）与「展示投影层」，
   * **绝不作用于落盘路径**：会话存储里的原文一个字都不许改（append-only 硬约束）。
   * 这正是 0.52 修「PII 打码写坏 transcript」的落点——脱敏从写侧搬到读侧。
   *
   * 实现方须按 `name` 去重；同 `registerMemberBodyContribution?` 的口径，
   * 不实现该方法的自定义宿主退化成「没有读侧脱敏」，不炸。
   */
  registerReadSideMasker?(masker: ReadSideMasker): void;
  /** 可选（0.52）：本宿主上已登记的读侧脱敏器，按登记顺序 */
  getReadSideMaskers?(): readonly ReadSideMasker[];
  /**
   * 可选（0.55 工具名 snake_case）：装配期审计已登记的全部工具名。
   *
   * 不实现的自定义宿主退化成「按 `listTools()` 全当内置工具校验」（见
   * `assertToolNameLegality`）——外部工具的例外通道只是省掉误报，不是放宽校验。
   */
  auditToolNames?(): ToolNameAudit;
  /**
   * 可选（0.55）：按旧名查改名别名。命中且目标已注册时才有意义（表驱动，
   * 单一真源 `TOOL_NAME_ALIASES`）。
   */
  getToolAlias?(name: string): ToolNameAlias | undefined;
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

/** ExecutionUnit 配置 */
export interface ExecutionUnitOptions {
  provider: import('./provider.js').LLMProvider;
  model: string;
  /**
   * 每次 Run 新建一个 WorkingContext（Stage 4）：EU 不持有跨 Run 的窗口实例。
   * 返回值应按 `init.sessionId` 切到目标会话。
   */
  contextFactory: (init: { sessionId: string }) => import('./context.js').WorkingContext;
  events: import('./event.js').EventStream;
  limits: import('./limits.js').UsageLimits;
  termination: import('./limits.js').TerminationPolicy;
  /**
   * opt-in 用量计价（0.51）。缺省不注入 → `totalCost` 保持 0；
   * 注入后每次 provider 响应的 usage 按分项费率折算并累加。
   */
  pricing?: import('./limits.js').UsagePricing;
  plugins?: Plugin[];
  session?: import('./session.js').SessionStore;
  systemPrompt?: string; // 系统提示词
  /** 默认权限策略——未声明 checkPermission 的工具用 default/autoApprove 判定（ADR-029） */
  permission?: RuntimePermissionConfig;
  /** 可注入的 PluginHost（默认 MemoryPluginHost）——依赖倒置（ADR-033） */
  pluginHost?: PluginHost;
  /** 可注入的限制检查器（默认 MemoryLimitChecker）——依赖倒置（ADR-033） */
  limitChecker?: import('./limits.js').LimitChecker;
  /**
   * Run 写端口工厂（Stage 4）：事件落盘 / RunRecord / SessionState 全经此写。
   * 缺省装配必须注入；EU 只持只读 EventLog。
   */
  journalFactory: RunJournalFactory;
  /** 可选：写入 checkpoint.agent_id（Host 注入成员 id；单 agent 可缺省） */
  agentId?: string;
  /**
   * 0.11.1：是否把思维的流式增量（`reasoning_delta`）经 `llm.stream.chunk` 发布。
   * 默认 false（显式 opt-in）；false 时请求 / 事件与 0.11.0 完全一致。
   */
  includeReasoning?: boolean;
  /**
   * 传输层 / 过载重试策略（指数退避 + 抖动）。缺省 = core
   * `DEFAULT_PROVIDER_RETRY_POLICY`（base 500ms / x2 / 4 次 / 单次封顶 8s）；
   * `maxRetries: 0` 关闭。只管「一个增量都没流出」的请求，见 `runtime/provider-retry.ts`。
   */
  retry?: Partial<import('./provider.js').ProviderRetryPolicy>;
  /**
   * 空响应兜底策略（q-empty-response；additive 可缺省）。
   * 缺省 = 启用、nudge 重试 2 次；`enabled: false` 回退修复前行为。
   */
  emptyResponse?: import('./provider.js').EmptyResponsePolicy;
  /**
   * 0.10：诊断日志 sink；缺省 noop。
   * 未注入且设置了 `VESSEL_DEBUG` 时，runtime 兜底为 stderr logger（level=debug）。
   */
  logger?: import('./logging.js').Logger;
  /** 0.15 E9：Self Card；缺省不注入，行为不变 */
  selfCard?: SelfCardOptions;
  /**
   * 0.51：本 EU 的默认工作目录（成员 cwd），每次工具调用注入 `ToolContext.cwd`。
   *
   * 与 `pluginConfigs['basic-tools'].cwd`（`agent.cwd`，全 tenant 一份）的分工：这里是
   * **per-成员** 的具体起点，那边是**全局默认**。工具侧的优先级由工具自己决定
   * （basic-tools：参数 cwd > 配置 cwd > 本字段 > `process.cwd()`）。
   * 缺省不注入 → 工具行为与 0.50 完全一致。
   */
  cwd?: string;
  /**
   * 0.28：上下文压力提示的尾句文案；缺省保持 `agent(rotate)` 原文案。
   * 供不能靠 rotate 自愈的入口（如 temporary 成员）换成自己的行动建议。
   * 运行期可用 `ExecutionUnit.applyContextPolicy` 热替换（身份转换后下一轮生效）。
   */
  contextPressureHint?: string;
  /**
   * 0.18：会话事件**读口**（0.55 stop-write：只读子集，没有 `append`）。
   *
   * 提供时 runtime 用它读历史投影 / 读回判定 / 合并写 `index.json`。写入的唯一入口是
   * `RunJournal`（journal 经时间线写者落盘），EU 拿不到写权限。
   */
  eventLog?: import('./event.js').SessionEventReadPort;
  /**
   * 会话目录根（`<dataDir>/sessions`，0.56 ctx-recall；additive）。
   *
   * 只有一件事要用它：**压缩索引**（`<sessionDir>/compactions.ndjson`）。压缩发生的那一刻
   * `context.compacted` 事件里会带一份索引条目（被替换消息的 seq 区间），这份小文件是它的
   * 物化副本，专供 `recall` 工具无参列表 —— 读它只值一次 `readFile`，而按事件回扫
   * （`readTailMatches` 有 4 MB 上界）会漏掉较早的段、纯读会话壳要 parse 1.8 MB。
   *
   * 缺省（库用法 / 没注入）：索引只留在**事件与内存**里，读回仍可用
   * `deriveCompactionIndex` 从事件重建，行为不降级成「静默没有索引」。
   */
  compactionIndexDir?: string;
  /**
   * ADR-098 C2：两级租约服务（装配层注入；缺省 no-op，行为等同现状）。
   * 提供时 EU 在首个 run/resume 前 acquire SessionLease，后台续租并注入 fencing token。
   */
  leaseService?: import('./lease.js').LeaseServicePort;
  /**
   * ADR-098 C2：ControlPlane 在 spawn 时授予的 BindingLease。
   * EU 只续租 / 释放，不负责首次获取。
   */
  bindingLease?: import('./lease.js').LeaseGrant;
  /**
   * 视觉的**运行期设置**（0.56 P0；additive）。
   *
   * 能力不在这里：能发什么图问 `provider.vision`（`VisionBackend` 描述符，由插件挂上）。
   * 这里只有「本轮要不要发、最多几张（token 预算推导）、精度意图」几件事，以及 kill switch
   * （`disabled` / `VESSEL_DISABLE_VISION=1`）—— 缺省 = 支持即直通（决策 1：没有 enable 门）。
   *
   * 装配层从 `vision.*` 配置段解析；缺省不注入 ⇒ 用默认值（图片 token 预算 = 窗口 × 0.05，
   * 窗口未知兜底 6144 / 无精度偏好 / 不关闭；见 `vision/plan.ts`）。
   */
  vision?: import('./vision.js').VisionSettings;
  /**
   * 环境信息检测节奏端口（注入粒度框架轴 A；additive）。
   *
   * 装配层注入 `scope => resolveEnvCadence(scope, config.envInjection)`；EU 的
   * notice producer（tools / pii）在**观察 / diff 之前**问它：`run` ⇒ 每 run 只观察
   * 首次请求。core 不认识 scope 业务词，只调注入函数。缺省不注入 ⇒ 恒按 request
   * 观察（今天行为，零回归）。model / trim 的自然节奏钉死，不经此端口。
   */
  envCadence?: (scope: string) => import('./env-cadence.js').EnvCadence;
  /**
   * 环境信息投递通道端口（注入粒度框架轴 C；P2，additive）。
   *
   * 装配层注入 `scope => resolveEnvChannel(scope, config.envInjection)`；EU 的
   * notice producer 在发射前问它：`ui-only` ⇒ 只落 `message.injected` 事实（UI 卡），
   * 不写入模型上下文；`model+ui`（缺省）⇒ 事实 + 上下文（今天行为，零回归）。
   * `off`（轴 A）整段静默，先于通道判定。core 不认识 scope 业务词，只调注入函数。
   */
  envChannel?: (scope: string) => import('./env-cadence.js').EnvChannel;
  /**
   * 工具结果压缩白名单（q-tool-result-whitelist；additive）。
   *
   * 命中的工具结果抗 trim 不抗 compaction：段起点冻结占位集合时把命中的
   * tool_call_id 过滤掉（请求视图保持原文），段边界 compaction 照常收尾。
   * 缺省不注入 ⇒ 内置默认（inbox read + agent read）；显式 `[]` ⇒ 关闭。
   * 装配层从 `context.tool_result_whitelist` 映射；构造期注入，重启生效。
   */
  toolResultWhitelist?: readonly import('./context.js').ToolResultWhitelistRule[];
  /**
   * 请求组成快照开关（q-context-composition；additive）。
   *
   * `true`/缺省 = 每次真实请求落一条 `context.composition` 事实事件（各成分
   * token/条数/占比，供上下文优化分析）；`false` = 关闭（不算、不发）。
   * 装配层从 `context.composition_record` 映射；构造期注入，重启生效。
   */
  compositionRecord?: boolean;
}
