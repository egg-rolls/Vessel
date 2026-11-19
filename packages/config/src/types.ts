/**
 * Vessel 配置类型定义
 * @module @vessel-agent/config
 *
 * 所有字段使用 camelCase（ADR-019）。config loader 自动将 YAML 的 snake_case 映射过来。
 */

/** Provider 配置 */
export interface ProviderConfig {
  name: string;
  apiKey?: string;
  /** 从该环境变量读取 apiKey（同层显式 apiKey 优先） */
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 请求超时毫秒；<=0 关闭。缺省由 provider 插件决定（当前 120s） */
  timeoutMs?: number;
  /** 显式提示词缓存断点。anthropic 默认 true；OpenAI 兼容端点缺省按模型名自动（含 claude 才开），显式值覆盖 */
  promptCache?: boolean;
}

/**
 * models 注册表里的每模型配置（model-registry §2.1）。
 * 唯一可选字段是 promptCache 三态；不加 temperature/maxTokens（请求参数沿用全局 provider.*）。
 */
export interface ModelEntry {
  /** true 强开 / false 强关 / 缺省 auto（openai 兼容按模型名含 claude；anthropic 默认 true） */
  promptCache?: boolean;
}

/**
 * models.vendors.<id> 条目：protocol + 端点 + 凭证引用 + 模型清单。
 * id 即名称（kebab-case，同插件 id 形状），不加 display-name；鉴权由 protocol 蕴含，
 * 不另设 auth 字段；不给 vendor 新增明文 api_key（legacy provider.apiKey 原样保留）。
 */
export interface VendorEntry {
  /** 已注册的 provider 工厂名（openai / anthropic / google / ... 或自定义 provider 插件名） */
  protocol: string;
  /** 可选；缺省用 protocol 工厂的默认 baseUrl */
  baseUrl?: string;
  /** credentials.json 凭证引用 id（值不进 yaml）；与 apiKeyEnv 互斥 */
  credential?: string;
  /** 环境变量间接引用（ADR-050 §4）；与 credential 互斥 */
  apiKeyEnv?: string;
  /** wire model id（可含 `/`）→ 每模型配置；至少 1 条 */
  models: Record<string, ModelEntry>;
}

/**
 * models 块：模型 / 厂商 / 别名元数据（无密钥值，user/project 层可叠）。
 * 缺省 = 纯 legacy provider.* 行为；旧配置由 synthesizeLegacyRegistry 折成
 * `legacy:<provider.name>` 隐式条目，不改也能跑。
 */
export interface ModelsConfig {
  /** 有效默认 ref（别名或 vendor/model）；必须命中注册条目（P0 起严格） */
  default?: string;
  /** vendor id（^[a-z0-9][a-z0-9-]{0,63}$；`legacy:` 前缀保留）→ 厂商条目 */
  vendors?: Record<string, VendorEntry>;
  /** 扁平别名：alias → vendor/model；别名 key 不含 `/`，不允许别名 → 别名 */
  aliases?: Record<string, string>;
}

/** Guardrail 配置 */
export interface GuardrailConfig {
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Hook 配置 */
export interface HookConfig {
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** 使用量限制配置 */
export interface UsageLimitsConfig {
  requestLimit?: number;
  inputTokensLimit?: number;
  outputTokensLimit?: number;
  totalCostLimit?: number;
}

/**
 * 单个模型的价格（0.51，opt-in）。
 *
 * 单位：用户自己的计价货币 / 每百万 token。Vessel 不内置任何厂商价格。
 * 缓存两项缺省时回落到 `inputPerMillion`（不猜测厂商倍率；建议显式配置）。
 */
export interface ModelPricingConfig {
  /** 非缓存输入（fresh input）单价 / 百万 token */
  inputPerMillion: number;
  /** 输出单价 / 百万 token */
  outputPerMillion: number;
  /** 缓存读取单价 / 百万 token；缺省 = inputPerMillion */
  cacheReadPerMillion?: number;
  /** 缓存写入单价 / 百万 token；缺省 = inputPerMillion */
  cacheWritePerMillion?: number;
}

/** 用量计价配置（0.51）；键为 provider.model 的精确值。 */
export interface PricingConfig {
  models: Record<string, ModelPricingConfig>;
}

/** 终止策略配置 */
export interface TerminationConfig {
  maxIterations?: number;
  maxRuntimeSeconds?: number;
}

/** 成员可见性（0.16；默认 private） */
export type AgentVisibility = 'private' | 'team' | 'tenant';

/** Agent 配置 */
export interface AgentConfig {
  name?: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 是否注册 canonical `agent` 工具并启动 AgentService（默认 false） */
  enabled?: boolean;
  /** spawn 成员的默认可见性（默认 private） */
  defaultVisibility?: AgentVisibility;
  /** 成员回复是否允许触发父级新一轮（默认 false） */
  followReplies?: boolean;
  /** 成员限额；缺省继承顶层 limits */
  limits?: UsageLimitsConfig;
  /** 成员终止策略；缺省继承顶层 termination */
  termination?: TerminationConfig;
  /** 成员权限模式；缺省交互 bridge、headless allow */
  permissionMode?: 'bridge' | 'allow' | 'deny';
  /** deny 模式保留的只读工具（默认 ['read']） */
  readOnlyTools?: string[];
  /** 主 agent（owner）成员 ID（默认 main） */
  ownerId?: string;
  /**
   * 临时 agent 空闲回收 TTL（小时，默认 2，0 = 关闭；D5）。
   *
   * 只回收 `role === 'temporary'` 且仍在册的 agent；`member`（含 `main`）永不回收。
   * 回收可逆：`reinstate` 会原地复活同一具 body（session 继续可续接）。
   */
  temporaryTtlHours?: number;
  /**
   * 每个成员持久化收件箱的消息条数上限（0.32；默认 200）。
   *
   * 超出时按最旧裁剪（`AgentInboxStore` 的 `maxMessages`）。缺省不写入配置，
   * 由 store 使用 `DEFAULT_MAX_INBOX_MESSAGES`。
   */
  inboxMaxMessages?: number;
  /**
   * 默认工作目录（0.11.1，DECISION-022 §2.4）。
   * 支持 `~`；相对路径按进程 cwd 解析为绝对路径（由装配层解析，validator 只校验类型）。
   * 优先级：工具参数 `cwd` > `agent.cwd` > `process.cwd()`。
   */
  cwd?: string;
}

/** 会话配置 */
export interface SessionConfig {
  /** 存储后端：file（0.5 默认）/ sqlite / memory */
  backend?: 'sqlite' | 'file' | 'memory';
  /** sqlite = 数据库文件路径；file = 目录；memory 忽略 */
  storagePath?: string;
  /** @deprecated 0.1.0 未消费；保留仅为兼容旧配置 */
  maxHistory?: number;
}

/** 上下文配置 */
export interface ContextConfig {
  maxTokens?: number;
  maxMessages?: number;
  autoCompact?: boolean;
  compactThreshold?: number;
}

/**
 * 视觉配置（0.56，P0；全部可选）。
 *
 * **故意没有 `enable` 这个键**：决策 1 = 「模型支持视觉就直接发」，所以能力问
 * `provider.vision`（插件的 `VisionBackend` 描述符），配置只提供**运行期**的三件事：
 * 出事时一键退回（`disabled`）、预算（张数）、精度意图。`disabled` 是**闸**，不是默认门。
 */
export interface VisionConfig {
  /**
   * 全局 kill switch（等价于 `VESSEL_DISABLE_VISION=1`）：一律不内联、`[refs]` 尾注回落
   * 0.55 老文案、记一条 `vision.disabled` 事件（**不是静默**）。默认 `false`。
   */
  disabled?: boolean;
  /** 单请求最多几张图（与后端描述符取 `min`）；缺省 6。 */
  maxImagesPerRequest?: number;
  /** 精度意图（必须落在后端 `detailLevels()` 里，否则不带）；缺省不传。 */
  detail?: string;
  /**
   * 上传后预处理：P0 = `none`（identity，交给 provider 自动缩到 ~1300²）。
   *
   * **一旦不等于 `none`**，「产出新字节必须写回 `refs.sha256`」立刻从建议变成硬约束
   * （P1）：不写回 = 每轮重新编码 = 前缀守卫必报 `prompt.prefix_changed`。
   */
  preprocess?: string;
  /** 孤儿 blob 的宽限窗（小时，上限 168）；缺省 24。 */
  orphanGraceHours?: number;
  /** 孤儿 blob 的死线（天）；缺省 30。 */
  imageBlobTtlDays?: number;
  /**
   * blob GC 的定时开关（0.56 P1）。**缺省开**：不开的话「没人用的图」永远占着磁盘，
   * 而池上限（2 GiB）触顶会让新图不再内联 —— 那是静默降级。
   *
   * 显式 `false` 才关；关掉之后 `blobGc*` 其它键不生效。
   */
  blobGcEnabled?: boolean;
  /** GC 间隔（小时，夹到 [1, 168]）；缺省 6。 */
  blobGcIntervalHours?: number;
  /**
   * 只报不删（dry-run）。缺省 `false`：**进程启动后的第一趟无论如何都是 dry-run**
   * （见 `image-blob-gc.ts`），这个键是「一直只看不删」的长期开关。
   */
  blobGcDryRun?: boolean;
}

/**
 * 0.48 M4：外部插件扩展面授权（CONTRACT-0.48 §5）。
 * 只做 allow/deny；路由 / 命令定义仍只来自 manifest。
 */
export interface PluginExposeConfig {
  /** `contributes.http[].id`；不接受 `true` 简写。 */
  http?: string[];
  /** `contributes.cli[].path.join('.')`。 */
  cli?: string[];
}

/** 插件配置 */
export interface PluginConfig {
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** 0.48 M4：manifest 声明面的显式授权；内置插件忽略，外部插件缺省全关。 */
  expose?: PluginExposeConfig;
  /**
   * plugin-embed 契约 §1：内嵌 UI 的显式信任确认（独立于进程权限）。
   * 缺省 = isolated；`embedded` 还需哈希锁（TOFU）一致才生效。builtin 忽略。
   */
  trust_ui?: 'embedded';
}

/** 自动更新配置 */
export interface UpdateConfig {
  /** REPL 启动后台检查（默认 true） */
  autoCheck?: boolean;
  /** 更新通道（默认 latest） */
  channel?: 'latest' | 'beta';
  /** 自定义清单源；缺省用 GitHub Release */
  source?: string;
}

/** Host 配置（节点身份；无开关，节点始终存在） */
export interface HostConfig {
  /** nodeId 唯一来源；缺省进程内生成 */
  nodeId?: string;
  /**
   * 节点展示名（0.25）；缺省按 hostname 派生。
   * 只影响展示，寻址 / 去重仍用 `nodeId`。
   */
  nodeName?: string;
}

/** Scheduler 配置（所有 agent/body 都经同一 scheduler，始终生效） */
export interface SchedulerConfig {
  /** 全局 FIFO 并发上限（默认 1） */
  maxConcurrency?: number;
  /** 队列上限（默认 100） */
  maxQueueSize?: number;
  /** 同一 body 串行（默认 true） */
  perBodySerial?: boolean;
}

/**
 * Lease 配置（0.34 两级租约）。
 *
 * 约束：`ttlMs > renewMs`，且 `renewMs >= 1000`、`ttlMs >= renewMs + 1000`。
 * 缺省消费 `DEFAULT_LEASE_OPTIONS`；除默认值外不硬编码。
 */
export interface LeaseConfig {
  /** 租约 TTL 毫秒（默认 30000） */
  ttlMs?: number;
  /** 续租间隔毫秒（默认 10000） */
  renewMs?: number;
}

/** MCP server 配置（0.3；`mcp_servers` map 的值，键为 server 名） */
export interface McpServerConfig {
  /** 传输方式；stdio 必填 command，http 必填 url */
  transport: 'stdio' | 'http';
  /** stdio：启动命令 */
  command?: string;
  /** stdio：命令参数 */
  args?: string[];
  /** stdio：子进程环境变量 */
  env?: Record<string, string>;
  /** http：MCP Streamable HTTP 端点 */
  url?: string;
  /** http：请求头 */
  headers?: Record<string, string>;
  /** 是否启用（默认 true）；false 时仍出现在 MCP 状态快照中 */
  enabled?: boolean;
  /** 建连超时毫秒（默认 10000） */
  connectTimeoutMs?: number;
  /** 单次工具调用超时毫秒（默认 60000） */
  toolTimeoutMs?: number;
  /** 工具名加 `mcp__<server>__` 前缀（默认 true） */
  toolPrefix?: boolean;
  /** 自动允许的工具原始名（前缀前、大小写敏感） */
  autoApproveTools?: string[];
}

/** Durable run 配置（0.3；默认关闭） */
export interface DurableConfig {
  /** true 才创建 RunStore 并写 checkpoint（默认 false） */
  enabled?: boolean;
  /** 后端（默认 file） */
  backend?: 'file' | 'memory';
  /** file 后端目录（默认 ~/.vessel/runs） */
  path?: string;
  /** checkpoint 时机；0.3 仅支持 iteration（每轮 tool-call 后） */
  checkpointEvery?: 'iteration';
}

/** Eval harness 配置（0.4；默认关闭、默认离线） */
export interface EvalsConfig {
  /** true 才允许 CLI eval（默认 false） */
  enabled?: boolean;
  /** suite 目录（默认 ./evals） */
  dir?: string;
  /** 报告输出目录（默认 ~/.vessel/evals） */
  outDir?: string;
  /** 配置层网络允许；仍需 CLI --allow-network（默认 false） */
  allowNetwork?: boolean;
}

/** 飞书渠道配置（0.4；默认关闭；凭据 env 优先） */
export interface FeishuConfig {
  enabled?: boolean;
  /** 环境变量 VESSEL_FEISHU_APP_ID 优先 */
  appId?: string;
  /** 环境变量 VESSEL_FEISHU_APP_SECRET 优先；永不打印 */
  appSecret?: string;
  /** 从该环境变量读取 appSecret（同层显式 appSecret 优先） */
  appSecretEnv?: string;
  /** 仅切换域名，不改变语义（默认 feishu） */
  domain?: 'feishu' | 'lark';
  /** 空 = 机器人所在全部会话 */
  allowedChatIds?: string[];
  /** session = <prefix>:<chat_id>（默认 feishu） */
  sessionPrefix?: string;
  /** 单次回复超时毫秒（默认 300000；1..86400000） */
  replyTimeoutMs?: number;
  /** 单条回复最大字符数（默认 4000；1..100000） */
  maxReplyChars?: number;
  /** 专用 Host 成员上限（默认 8；1..64） */
  maxMembers?: number;
}

/**
 * 日志中枢配置（observability.log；对应 core 的 LoggingConfig）。
 * 环境变量覆盖优先：VESSEL_DEBUG > VESSEL_LOG_LEVEL > VESSEL_LOG_JSON > 本配置。
 */
export interface ObservabilityLogConfig {
  /** 全局最低输出级别；默认 info */
  level?: 'debug' | 'info' | 'warn' | 'error';
  /**
   * 事件名前缀 → 级别（最长前缀匹配，按点分段，如 `gateway.ws` 命中
   * `gateway.ws.closed`）。**键是事件名**，loader 不做 snake→camel 改写。
   */
  modules?: Record<string, 'debug' | 'info' | 'warn' | 'error'>;
  /** 着色；默认 auto（TTY 才着色；NO_COLOR / FORCE_COLOR 仍可覆盖） */
  color?: 'auto' | 'always' | 'never';
  /** 输出格式；默认 pretty（vite 式单行），json = 单行 JSON（机器接口） */
  format?: 'pretty' | 'json';
  /** 时间显示；默认 auto（TTY 用 clock，落盘用 iso） */
  time?: 'auto' | 'none' | 'clock' | 'iso';
}

/** 可观测性配置（0.4；块存在时才启用 metrics） */
export interface ObservabilityConfig {
  /** 事件历史容量：默认 1000；显式 0 = 不限制；>0 = 环形缓冲 */
  eventHistory?: number;
  /** 创建 MetricsCollector 并注入 gateway / TUI（默认 true） */
  metrics?: boolean;
  /**
   * 是否把 `process.error` / `shutdown.failed` 等进程级错误暴露给诊断面
   * （0.14；默认 false，仅 logger + trace）。
   */
  showProcessErrors?: boolean;
  /** 日志中枢（级别 / 模块级别 / 颜色 / 格式 / 时间；热应用） */
  log?: ObservabilityLogConfig;
}

/** `node.tls` 配置；cert/key 必须成对 */
export interface ServeTlsConfig {
  certFile?: string;
  keyFile?: string;
}

/** gateway principal 角色 */
export type PrincipalRole = 'read' | 'write' | 'admin';

/** S5：节点动态 token 的 scope（additive；静态 token 缺省） */
export type PrincipalScope = 'view' | 'exchange' | 'control' | 'admin';

/** 由 token 解析出的 principal（A-3 §10.4；0.49 T4 删除 tenant 维度） */
export interface Principal {
  role: PrincipalRole;
  /** S5：动态 token 的 scope；静态 token 缺省 */
  scope?: PrincipalScope;
  /** S5：control token 的 team 限制 */
  team_id?: string;
  /** S5：吊销 / 关闭 WS 用 */
  token_id?: string;
  /** S5：token 绑定的 hub */
  hub_id?: string;
}

/** `node.tokens` 的条目（A-3 §10.4；键为原始 token，永不打印） */
export interface ServeTokenEntry {
  role?: PrincipalRole;
}

/** 可观测性 trace 配置（0.5；缺省不写入 config，消费 DEFAULT_TRACE_OPTIONS） */
export interface TraceConfig {
  enabled?: boolean;
  level?: 'full' | 'metadata' | 'off';
  retentionDays?: number;
  maxRuns?: number;
  /** 0 = 不限 */
  maxBytes?: number;
  /**
   * 是否把 `llm.stream.chunk` 落盘（0.10 R2-14）。
   * 默认 false：实时事件仍发布，只是不写 trace（避免 trace 体积随流式输出暴涨）。
   */
  includeStreamChunks?: boolean;
}

/**
 * 会话 timeline 配置（ADR-105 §11 / plan-054 A4）。
 *
 * **不写入 `DEFAULT_CONFIG`**：未配置 `timeline` 时消费 {@link DEFAULT_TIMELINE_OPTIONS}
 * （等价于「双写开启」）。YAML 键走 snake_case（`timeline.dual_write`），
 * loader 统一转 camelCase 后就是下面的字段名。
 *
 * `dualWrite` 的语义是**全有或全无**：`false` ⇒ 旁路一次都不调（旧链路逐字节不变）；
 * `true` ⇒ 每条已持久化事件多写一份 timeline，新链路任何失败只记指标/日志。
 */
export interface TimelineConfig {
  /**
   * 双写开关；默认 `true`（0.54 cutover 起）。
   *
   * 显式 `false` = 旧的「只有 `events.ndjson`」安装形态；0.54 之后新的写入路径是唯一
   * 被保证的路径，`false` 只留给还没迁移的安装。
   */
  dualWrite?: boolean;
  /** chunk 空闲封块间隔（ms，1..1000）；缺省 150（`timeline.CHUNK_FLUSH_MS`）。 */
  chunkFlushMs?: number;
  /**
   * 归档周期保底间隔（ms）；缺省 5000（`timeline.archive_interval_ms`）。
   *
   * 长 run 期间没有 `journal.close()`，只靠 run 终态触发的话 `timeline_head` 会一直停在 0。
   * 这个值是**同一会话两次自动归档之间的最小间隔**（不是「多久必须归档一次」）。
   * `0` ⇒ 关掉周期保底（只剩 run 终态触发）；归档失败只影响空间回收，不影响任何读写路径。
   */
  archiveIntervalMs?: number;
}

/**
 * 0.48 M1：插件 HTTP 反代限额（CONTRACT-0.48 §3.4）。
 *
 * 字段缺省用宿主默认值；`null` 表示该维度不限制。
 */
export interface PluginHttpLimitsConfig {
  maxBodyBytes?: number | null;
  maxResponseBytes?: number | null;
  timeoutMs?: number | null;
  idleTimeoutMs?: number | null;
  maxConnections?: number | null;
  /** 0.48 M3：WS 单帧上限（默认 1 MiB；每路由只能收紧）。 */
  maxFrameBytes?: number | null;
}

/**
 * `node:` 段（0.55 定稿名；对应 `vessel node start`）。
 *
 * 0.55 起 **`serve:` 段整个不再接受**：loader 读到它就报错并要求改名（`serve.<x>` →
 * `node.<x>`），所以用户层唯一的块名是 `node:`。类型名从 `ServeConfig` 改成 `NodeConfig`
 * 是为了让错误 / 文档 / 类型三处说的是同一个词（0.3 时代它还叫 `serve`，那个命令 0.49 就没了）。
 */
export interface NodeConfig {
  /** 监听地址（默认 127.0.0.1） */
  hostname?: string;
  /**
   * 0.6：独立前端允许的浏览器 Origin。
   * 绝对 http(s) origin；禁止 `*` / path / query / hash；非回环必须 https。
   */
  allowedOrigins?: string[];
  /** 监听端口（默认 8642；0 = 系统分配） */
  port?: number;
  /** 显式允许非回环监听（默认 false） */
  allowRemote?: boolean;
  /** 旧单 token（0.4）：principal = default/admin */
  token?: string;
  /** 从该环境变量读取 token */
  tokenEnv?: string;
  /** A-3：token → { role }；键为原始 token，必须原样保留 */
  tokens?: Record<string, ServeTokenEntry>;
  /**
   * 0.55 P0：反代共享密钥的环境变量名（opt-in）。
   *
   * 反代与 node 同机时客户端 peer 恒为 127.0.0.1，「回环 = 本机」不再成立。
   * 配了它之后：**无凭据**的请求必须由反代注入 `x-vessel-proxy-secret` 才放行；
   * 带 Bearer token 的请求（本机 CLI / TUI / 客户端）行为不变。不配 = 旧行为。
   */
  proxySecretEnv?: string;
  /** TLS 证书对 */
  tls?: ServeTlsConfig;
  /**
   * 0.48 M1：插件 HTTP 反代限额。
   * manifest 的 per-route 限额只能收紧这里的值。
   */
  pluginHttp?: PluginHttpLimitsConfig;
}

/**
 * 0.49：平台 Gateway 配置（与 `node` 的 node 配置分区，不共享 token 键）。
 * YAML 键：`gateway.port / hostname / token / token_env / allowed_origins`。
 * 平台 token 是静态 bearer；G1 不铸造、不哈希、不落盘。
 */
export interface GatewayConfig {
  /** 平台监听端口（默认 8642） */
  port?: number;
  /** 平台监听地址（默认 127.0.0.1） */
  hostname?: string;
  /** 平台静态 bearer token（优先级高于 tokenEnv） */
  token?: string;
  /** 从该环境变量读取平台 token（token 未设置时生效） */
  tokenEnv?: string;
  /** 平台静态宿主的浏览器 Origin allowlist（规则同 node.allowedOrigins） */
  allowedOrigins?: string[];
  /**
   * 0.55 P0：反代共享密钥的环境变量名（opt-in）。
   *
   * 配置后，「回环 socket」不再自动等于可信来源：平台只在请求带
   * `x-vessel-proxy-secret` 时才把回环对端当成本机，`platform.nodes.credentials`
   * 因此不会经同机反代被匿名取走。不配 = 旧行为（0.55 之前）。
   */
  proxySecretEnv?: string;
  /**
   * 0.58：平台是否代理 node（`/nodes/:nodeId/**`，HTTP + WS）。
   *
   * 缺省 `true`：注册进来的 node 由平台代理，浏览器**拿不到** node token。
   * `false` = **保留的显式回退开关**：平台不提供 `/nodes/*`，前端据
   * `platform.whoami.proxy.enabled === false` 回到「取 credentials 直连 node」的老路径。
   *
   * 只有一种情况该关它：本机调试时想让浏览器直连 node（例如用 devtools 直接看
   * node 的 `/v1/events`）。关掉等于把 node token 交回浏览器 —— 那是有意为之的选择。
   */
  proxyNodes?: boolean;
  /** 0.58：父进程侧存活看门狗（探活 + 受限重启）；缺省开。 */
  supervise?: GatewaySuperviseConfig;
}

/**
 * 0.58：外部存活看门狗（父进程替 node 子进程兜底）。
 *
 * 为什么需要：`runs.start` 之后的整段僵死（`docs/dev/research/run-start-stall.md`）
 * 会让子进程**进程内所有定时器一起停摆**、`/health` 超时、日志无新行 —— 这个状态下
 * 进程内部没有任何自救手段（连 setInterval 都不跑），只能由父进程强杀重起。
 *
 * 什么时候关掉：外面已经有 systemd / k8s 之类在做「探活 + 重启」时，
 * `enabled: false` 让两层不要互相打架（关掉后父进程只探「子进程是否退出」，
 * 不做周期性健康探测、也不重启）。
 *
 * YAML 键：`gateway.supervise.enabled / probe_interval_ms / probe_timeout_ms /
 * failure_threshold / max_restarts_per_hour / backoff_start_ms / backoff_max_ms /
 * recovery_probes`。
 */
export interface GatewaySuperviseConfig {
  /** 缺省 true；false = 完全不探活、不重启（交给外部看护）。 */
  enabled?: boolean;
  /** 探活周期（毫秒，缺省 2000）。 */
  probeIntervalMs?: number;
  /** 单次探活超时（毫秒，缺省 2000）。 */
  probeTimeoutMs?: number;
  /** 连续失败多少次判僵死（缺省 3；**成功一次即清零**）。 */
  failureThreshold?: number;
  /** 每小时重启上限（缺省 5；超了停手并明确报错，不无限重启）。 */
  maxRestartsPerHour?: number;
  /** 重启后的退避起点（毫秒，缺省 1000；每次翻倍）。 */
  backoffStartMs?: number;
  /** 退避上限（毫秒，缺省 60000）。 */
  backoffMaxMs?: number;
  /** 连续成功探活多少次退出退避（缺省 5）。 */
  recoveryProbes?: number;
}

/**
 * 0.62：OAuth 登录后端（`github_oauth` / `microsoft_oauth` / `gitee_oauth` /
 * 以后新增的 provider 共用同一字段形状）。
 *
 * `kind` 是**开放取值**：合法值由登录策略注册表决定
 * （`packages/config/src/auth-strategies/`），不在这里枚举 —— 加一个 provider
 * 只加一个策略文件 + 注册一行，不改这个文件，也不改校验器的白名单。
 */
export interface OAuthBackendConfig {
  /** 后端种类。缺省即 github_oauth（兼容 0.56 P1 的写法）。未知值在校验期报错。 */
  kind?: string;
  /** OAuth App 的 client id（非密钥）。 */
  clientId?: string;
  /**
   * client_secret 的**环境变量名**（不是值）。密钥永不进配置、日志、错误文案。
   * 约定：github 用 VESSEL_GITHUB_OAUTH_SECRET，microsoft 可用 MS_CLIENT_SECRET。
   */
  clientSecretEnv?: string;
  /**
   * 单用户白名单（**语义按 kind 走**，见策略的 `allowUserIdsShape`）：
   * - github：数值 user id；
   * - microsoft：Graph `/v1.0/me` 的 `id`（GUID，大小写不敏感）；
   * - gitee：数值 id 或用户名。
   */
  allowUserIds?: Array<number | string>;
  /** 登录按钮文案；缺省按 provider 给（如「Sign in with GitHub」）。 */
  label?: string;
}

/** 0.56 名称的兼容别名。 */
export type GitHubOAuthBackendConfig = OAuthBackendConfig;

/**
 * 0.56 P2：口令后端（自建、离线可用；可选 TOTP 第二因子）。
 *
 * 口令 hash **不在配置里**，两条合法来源：
 * 1. `passwordHashEnv` 指向的环境变量（argon2id PHC 串，适合 IaC / 容器）；
 * 2. `<dataDir>/auth/credentials.json`，由一次性引导码在浏览器里设置。
 *
 * 两条都没有时，启动会打印**一次性引导码**（单次 + 10 分钟 TTL）；不生成任何默认口令。
 */
export interface PasswordBackendConfig {
  kind: 'password';
  /** 单用户登录名；缺省 `admin`。只用于展示与按账户限流。 */
  username?: string;
  /** 口令 hash（argon2id）所在环境变量名；设置后不需要引导码。 */
  passwordHashEnv?: string;
  /** TOTP base32 密钥所在环境变量名；设置后登录必须再给一个验证码。 */
  totpSecretEnv?: string;
  /** 登录按钮 / 表单文案覆盖。 */
  label?: string;
}

/** 一个登录后端。 */
export type AuthBackendConfig = OAuthBackendConfig | PasswordBackendConfig;

/** 0.56：WebUI 登录（`auth` 块）。未配置 = 不启用，行为与 0.55 一致。 */
export interface AuthConfig {
  /** 显式开关；false = 忽略 backends，退回今天的行为。 */
  enabled?: boolean;
  /**
   * 公网 origin（如 `https://egg-rolls.top`），`redirect_uri` 的来源。
   * 只接受 scheme://host[:port]，不许带路径/查询/凭据。
   *
   * 0.60：语义等价于「只有一个元素的 `publicOrigins`」；两者同时出现时合并去重。
   */
  publicOrigin?: string;
  /**
   * 0.60：**并列**的公网来源白名单（不是通配）。线上域名与回环直连可以并存：
   *
   * ```yaml
   * auth:
   *   public_origins:
   *     - https://egg-rolls.top
   *     - http://127.0.0.1:8642
   * ```
   *
   * 每条必须是完整 origin（scheme + host[:port]，无路径、无尾斜杠）；
   * 非 https 的只允许 loopback / 私网地址。登录时选哪一个由**受信边缘**决定
   * （`X-Forwarded-*` 只在反代密钥成立时被采信），`redirect_uri` 只能是
   * 「选中的来源 + 固定路径」。
   */
  publicOrigins?: string[];
  /** 额外允许的 Host（反代保留原始 Host 但域名与 publicOrigin 不同时用）。 */
  allowedHosts?: string[];
  /**
   * 受信代理地址（精确地址或 `10.0.` 前缀）；缺省只信回环 socket。
   * 只有来自这些地址的请求，其 Host / X-Forwarded-Proto 才被采信。
   */
  trustedProxies?: string[];
  /** 登录后端列表。 */
  backends?: AuthBackendConfig[];
  /** 会话生命周期与落盘。 */
  session?: AuthSessionConfig;
  /**
   * 0.63：**本机直连免登录**开关（缺省 `false`，安全默认）。
   *
   * `true` 时，「回环 socket + 回环 Host + 未被证明是受信反代」的请求算作本机直连，
   * 平台数据面不再要求身份（`/platform/rpc`、`/nodes/**`）。
   *
   * ```yaml
   * auth:
   *   allow_loopback_anonymous: true   # 单机开发可接受；共享机 / 公网部署不要开
   * ```
   *
   * 代价：**同一台机器上的任何进程**都能不经登录读写数据。它只影响「是否要求身份」，
   * 不参与 Origin 白名单（`http.allowed_origins`）、Bearer 凭据闸与 CSRF 闸的判定 ——
   * 那三道闸的次序与严格性不变。
   */
  allowLoopbackAnonymous?: boolean;
}

/** 0.56：会话基座的可配置项。 */
export interface AuthSessionConfig {
  /** 空闲超时（分钟，滑动）；缺省 30。 */
  idleMinutes?: number;
  /** 绝对超时（小时）；缺省 12。 */
  absoluteHours?: number;
  /** 会话摘要是否落盘（只存 sha256，重启后仍需重新登录才会换 id）；缺省 true。 */
  persist?: boolean;
}

/** Transport 配置（0.2；0.22.1 只剩 in-process） */
export interface TransportConfig {
  kind?: 'in-process';
  /** 缺省复用 VESSEL_GATEWAY_TOKEN / gateway token */
  token?: string;
}

/** 0.6：`--connect` 客户端配置（token/CA；URL 仍走 CLI/env） */
export interface ConnectConfig {
  /** gateway token；建议改用 tokenEnv */
  token?: string;
  /** 从该环境变量读取 token */
  tokenEnv?: string;
  /** 自签/私有 CA 文件（PEM） */
  caFile?: string;
}

/**
 * 多节点 attention 的节点（S9.4）。
 *
 * token 只从 `tokenEnv` 指向的环境变量读取，**不接受内联 token**；
 * 每节点独立凭据，不与 `connect` / `node` 的 token 互相回退。
 */
export interface AttentionNodeConfig {
  /** `--node <name>` 选择器；同一配置内唯一 */
  name: string;
  /** 节点 gateway URL（非回环必须 https） */
  url: string;
  /** 人类 token（gateway / team token）所在环境变量名 */
  tokenEnv?: string;
  /** 期望的 node_id；配置后使用前用 `health.get` 校验 */
  nodeId?: string;
  /** 自签/私有 CA 文件（PEM） */
  caFile?: string;
}

/** 多节点 attention 配置（S9.4） */
export interface AttentionConfig {
  nodes?: AttentionNodeConfig[];
}

/**
 * Team 声明（0.19 S3）。
 *
 * 全局配置；tenant overlay 不允许声明 `teams`。
 */
export interface TeamConfigInput {
  /** Team 名；可选，缺省由装配层决定 */
  name?: string;
  /**
   * Team 工作区路径（必填）。
   * validator 只做 trim + `path.resolve` 归一化去重；存值保持 trim 后的原文，
   * `~` 展开由装配层负责。
   */
  workspace: string;
  /** 自由文本：这个 Team 是什么、找谁、怎么用（0.21 additive） */
  description?: string;
  /** Team 策略；顶层键开放，`permission` / `budget` 由 `parseTeamPolicy` 校验 */
  policy?: Record<string, unknown>;
}

/**
 * S7：跨节点 team ↔ team 的 peer 声明（全局配置）。
 *
 * - `nodeId` / `teamId` 是对端身份；`localTeamId` 只用于入站映射。
 * - `tokenEnv` 必填；明文 token 不接受。
 * - `url` 在 `direction` 含 `out` 时必填；非回环必须 https。
 * - YAML 写 `node_id` / `team_id` / `local_team_id`，loader 递归转 camelCase。
 */
export interface FederationPeerConfig {
  nodeId: string;
  teamId: string;
  url?: string;
  tokenEnv: string;
  caFile?: string;
  direction?: 'in' | 'out' | 'both';
  localTeamId?: string;
  /** 入站 team-info 目录查询开关（0.21 additive；缺省 false） */
  allowDirectory?: boolean;
}

/** S7：跨节点 federation（缺省关闭；不做自动发现）。 */
export interface FederationConfig {
  enabled?: boolean;
  /** 节点间跨越次数上界；缺省 4，1..16 */
  maxHops?: number;
  /**
   * 每 peer 入站速率上限（0.21 additive）。
   * 缺省 60；合法范围 1..600（无“不限制”值）。
   */
  rateLimitPerMinute?: number;
  peers?: FederationPeerConfig[];
}

/** 无人值守权限策略；缺省 hold。没有 allow-after。 */
export interface TeamPermissionPolicy {
  unattended?: 'hold' | 'deny-after';
  /** deny-after 必填；1..86400 秒 */
  denyAfterSeconds?: number;
}

/** 环检测参数；不可关闭，只能调阈值。 */
export interface TeamBudgetCyclePolicy {
  /** 同一有向边在一个 `cooldownSeconds` 窗口内允许的次数；缺省 2，>= 1 */
  maxRepeats?: number;
  /** 滑动窗口长度（秒），也是越界后的重试间隔；缺省 60，>= 1（0 等于关掉检测） */
  cooldownSeconds?: number;
}

/** 预算限额；缺省 = 不限。 */
export interface TeamBudgetPolicy {
  maxHops?: number;
  maxTurns?: number;
  maxTokens?: number;
  maxWallClockSeconds?: number;
  /** 0 < x < 1；缺省 0.8 */
  warningThreshold?: number;
  cycle?: TeamBudgetCyclePolicy;
}

/** 接收侧对跨节点入站报文的同意策略（0.21 起无全员 fan-out）。 */
export interface TeamFederationPolicy {
  /**
   * `principal` = 按地址投递给单个 present 成员（缺省）；
   * `log` = 只写 Team 日志，忽略 principal。
   */
  accept?: 'principal' | 'log';
}

/** 解析后的 Team policy 视图；`policy` 顶层仍允许其它键。 */
export interface TeamPolicy {
  permission?: TeamPermissionPolicy;
  budget?: TeamBudgetPolicy;
  /** dispatch 在 resume 失败后是否允许自动创建 agent；缺省 false（手改别名 `allow_auto_create`） */
  allowAutoCreate?: boolean;
  /** S7.2：跨节点接收策略；缺省 log。 */
  federation?: TeamFederationPolicy;
  [key: string]: unknown;
}

/** S5：hub TLS 配置；cert/key 必须成对 */
export interface HubTlsConfig {
  certFile?: string;
  keyFile?: string;
}

/** S5：hub 监听地址 */
export interface HubListenConfig {
  hostname?: string;
  port?: number;
}

/**
 * S5 / S5.1：hub 控制面配置。
 *
 * - `dataDir` 必须与 gateway 的 `dataDir` 不同；
 * - `direction: 'node'` = gateway 出站加入 hub；
 * - `url` / `caFile` / `joinCodeEnv` 只在 node 角色使用；
 * - `token` 明文不接受，只允许 `tokenEnv` / SecretStore。
 */
export interface HubConfig {
  dataDir?: string;
  /** `gateway start` 是否自动拉起本地 Hub；缺省 true。`direction: 'node'` 时忽略。 */
  autoStart?: boolean;
  direction?: 'node';
  /** node → hub 出站：hub 基址（join 的缺省 URL）。 */
  url?: string;
  /** node → hub 出站：hub TLS CA 路径。 */
  caFile?: string;
  /** `vessel hub join` 缺 `--code` 时读取的 env 名。 */
  joinCodeEnv?: string;
  listen?: HubListenConfig;
  allowRemote?: boolean;
  tls?: HubTlsConfig;
  allowedOrigins?: string[];
  tokenEnv?: string;
  /**
   * 0.55 P0：反代共享密钥的环境变量名（opt-in）。
   *
   * 配置后，hub 只把「回环 peer **且** 带 `X-Vessel-Proxy-Secret`」的请求当成可信本机
   * （目录 / WS 目录流 / 删节点都走这条判定）。不配 = 旧行为（回环即可信）。
   * 与 `node.proxy_secret_env` / `gateway.proxy_secret_env` 同机制，密钥不要跨用途复用。
   */
  proxySecretEnv?: string;
  allowFileSecrets?: boolean;
  pairingTtlSeconds?: number;
  /**
   * 0.61：hub 签发的 node token 有效期（天，1–365，缺省 30）。
   *
   * 只影响**新签发**的 token（已有记录不会被改写）。开发机上的 node 可以写长，
   * 免得每 30 天回去敲一次 `vessel hub join-code`。
   */
  tokenTtlDays?: number;
}

/** 配置来源（叶子级追踪） */
export type ConfigSource = 'cli' | 'env' | 'project' | 'user' | 'default';

/** 叶子键（camelCase 点路径）→ 来源 */
export type ConfigSources = Record<string, ConfigSource>;

/**
 * 脱敏后的来源映射：敏感路径（`node.tokens.*` / `*.apiKey` / `*.token`）
 * 的值是 `<set>` 而不是来源标签。
 */
export type RedactedConfigSources = Record<string, ConfigSource | '<set>'>;

/** 配置快照（A-3 §10.6；web 使用结构镜像或注入，不 import 本包） */
export interface ConfigSnapshot {
  schema_version: 1;
  /** 已脱敏 */
  config: VesselConfig;
  /** 基础层来源（敏感路径已脱敏） */
  sources: RedactedConfigSources;
  paths: { user: string; project: string };
}

/**
 * 0.56：单一根密钥（`<dataDir>/root-secret`）的覆盖点。
 *
 * 只读环境变量名，**不接受内联密钥**（避免密钥落盘到 config）。
 */
export interface SecurityConfig {
  /**
   * 根密钥所在环境变量名。
   *
   * 未配置（或变量为空）→ 使用 `<dataDir>/root-secret`（首次启动自动生成 0600）；
   * 配置后该环境变量**优先于文件**，值可以是 base64（恰好 32 字节）或 ≥32 字节的
   * 原始字符串。用途是容器 / systemd 只注入密钥、不落盘的部署形态。
   */
  rootSecretEnv?: string;
}

/** 权限配置（0.6.1；交互确认与免确认规则） */
export interface PermissionConfig {
  /**
   * 免确认工具名列表（精确匹配）。交互 REPL 的 "always" 也会写回这里，
   * 重启后继续生效。`ask` 由运行时始终免确认（历史配置里的旧名 `ask_user` 会被
   * 换算成 `ask`，老规则不失效）。
   */
  autoApprove?: string[];
  /**
   * 自动放行的例外键（0.27）：工具名或 `tool.action`。命中时即使工具在
   * `autoApprove` / 默认放行中也必须确认。YAML 别名 `never_auto_approve`
   * 由 loader 的 snake_case → camelCase 映射自动转换。
   */
  neverAutoApprove?: string[];
  /**
   * 桥可达性拒绝名单（tools-engine P2 O2）：精确工具名（别名经同一 TOOL_NAME_ALIASES
   * 表解析）。命中 → vessel call_tool 桥拦截（稳定 reason，run 继续）；**只影响桥可达性，
   * 不影响新会话直调**。vessel 自身在代码层硬排除，config 不可覆盖；缺省 [] = 无拒绝。
   * YAML 别名 `bridge_deny` 由 loader 的 snake_case → camelCase 映射自动转换。
   */
  bridgeDeny?: string[];
}

/** 状态栏位置（0.13）：top / bottom / both / none */
export type UiStatusBars = 'top' | 'bottom' | 'both' | 'none';

/** UI 输出详略（0.14；默认 normal） */
export type UiVerbosity = 'minimal' | 'normal' | 'debug';

/** 错误展示层级（0.14；默认 user） */
export type UiErrorLevel = 'user' | 'all';

/** UI 配置（0.8.5；0.11 clearOnStart；0.11.1 showReasoning；0.13 statusBars；0.14 可见性；0.15 askUser） */
export interface UiConfig {
  /** UI 语言；'zh-CN' | 'en'，非法值由消费方归一化回退 */
  language?: string;
  /**
   * 输出详略（0.14；默认 normal）。
   * minimal = 只保留结果，normal = 现有行为，debug = 额外诊断。
   */
  verbosity?: UiVerbosity;
  /**
   * 是否在事件流中展示 `llm.request` / `hook.*` / `agent.*` 等内部事件
   * （0.14；默认 false，保持 0.13 行为）。
   */
  showInternalEvents?: boolean;
  /**
   * 列表里是否展示「已归档 Team / 已停用 agent」（0.51；默认 false = 隐藏）。
   *
   * 为什么默认隐藏：这两类对象都是「等待被 prune 移除」的残留物，默认视图里列出来
   * 只会拉长扫描路径。隐藏**不是**删除：直接 URL 仍可打开（打开时带待移除提示），
   * 打开这个开关后它们回到列表并带「已归档 · 待移除 / 已停用 · 待移除」标记。
   */
  showArchived?: boolean;
  /**
   * 错误展示层级（0.14；默认 user：只展示 run/tool/permission 级错误）。
   * all = 同时展示 internal / process 级错误。
   */
  errorLevel?: UiErrorLevel;
  /**
   * 进入交互 REPL 时是否发送 ANSI 清屏（默认 true）。
   * 不写入默认配置；消费方按 `!== false` 处理。
   */
  clearOnStart?: boolean;
  /**
   * 是否把模型思考流（`reasoning_delta`）发布给 UI（默认 false）。
   * 不写入默认配置；消费方按 `=== true` 处理，避免思维链默认外泄。
   */
  showReasoning?: boolean;
  /**
   * 状态栏位置（默认由消费方决定）。
   * YAML 键为 `status_bars`；非法值由 validator 拒绝，不做静默回退。
   */
  statusBars?: UiStatusBars;
  /**
   * 时间线卡片（工具 / 系统消息 / 排队）是否默认展开（YAML 键 expand_cards；默认 false）。
   *
   * 只有纯信息卡听这个开关；带可操作控件（权限 / ask / 确认）的卡片一律默认展开。
   * 用户在某张卡片上手动开合后，以手动状态为准。
   */
  expandCards?: boolean;
  /**
   * 是否注册 `ask` 工具（0.15；YAML 键 `ui.ask_user`，键名未随工具改名而变）。
   *
   * 默认由入口决定：交互 REPL（TTY）与 `gateway start` / `--serve` 为 true，
   * `--run` / headless / 管道为 false。显式 `false` 关闭；显式 `true` 也不会在
   * 无客户端的 headless 入口注册（否则只能等 120s 超时）。
   */
  askUser?: boolean;
}

/** Vessel 配置 */
export interface VesselConfig {
  apiKey?: string;
  /** 从该环境变量读取 apiKey（同层显式 apiKey 优先） */
  apiKeyEnv?: string;
  /** 全局数据根 */
  dataDir?: string;
  /**
   * 0.56：密钥文件路径（一个路径或路径列表）。配置里**只写路径，永远不写值**——
   * 值留在文件里，启动时注入进程环境。
   *
   * - 语法：`KEY=VALUE`（允许 `export ` 前缀、单双引号、`#` 注释、空行）；
   * - 优先级：**真实环境变量 > 文件**（显式 `export` 仍然赢），文件只填空缺的键；
   * - 相对路径按**进程 cwd** 解析；`~` 会展开；
   * - 显式配置的路径**读不到就报错**（不静默跳过）。
   *
   * 为什么不支持「配置里直接写 key」：那会绕过项目配置的密钥拦截与日志脱敏。
   */
  envFile?: string | string[];
  /** trace 配置；缺省消费 DEFAULT_TRACE_OPTIONS */
  trace?: TraceConfig;
  /**
   * 0.54：会话 timeline（ADR-105）；缺省消费 DEFAULT_TIMELINE_OPTIONS
   * （`dualWrite: true` = 双写默认开；显式 `false` 才退回旧链路）。
   */
  timeline?: TimelineConfig;
  provider?: ProviderConfig;
  /** models 注册表（厂商 / 模型 / 别名元数据，无密钥值）；缺省 = 纯 legacy provider.* 行为 */
  models?: ModelsConfig;
  agent?: AgentConfig;
  guardrails?: GuardrailConfig[];
  hooks?: HookConfig[];
  limits?: UsageLimitsConfig;
  termination?: TerminationConfig;
  /** 0.51：opt-in 模型价格表；配置后 `total_cost` / `total_cost_limit` 才有意义。 */
  pricing?: PricingConfig;
  session?: SessionConfig;
  context?: ContextConfig;
  /** 0.56：视觉（kill switch / 预算 / 精度 / 预处理 / blob 生命周期）；缺省全部走默认值。 */
  vision?: VisionConfig;
  /** 0.6.1：工具权限免确认规则 */
  permission?: PermissionConfig;
  plugins?: PluginConfig[];
  update?: UpdateConfig;
  host?: HostConfig;
  scheduler?: SchedulerConfig;
  /** 0.34：两级 body/session 租约（TTL / 续租间隔） */
  lease?: LeaseConfig;
  transport?: TransportConfig;
  /** 0.6：`--connect` 客户端 token/CA */
  connect?: ConnectConfig;
  /** S9.4：多节点 attention（每节点独立人类 token，只从 env 读取） */
  attention?: AttentionConfig;
  /** 0.3：MCP servers，键为 server 名 */
  mcpServers?: Record<string, McpServerConfig>;
  /** 0.3：durable run（checkpoint / resume） */
  durable?: DurableConfig;
  /**
   * 0.55：`node:` 段（对应 `vessel node start`）—— gateway 监听、TLS、token、Origin allowlist。
   *
   * **`serve:` 段已移除**（0.55）：它是这个块的 0.3 时代旧名，而 `vessel serve` 命令
   * 0.49 就没了。loader 读到 `serve:` 直接报错，并按 `serve.<x>` → `node.<x>` 逐项给出
   * 改名提示 —— 绝不静默生效、也绝不静默丢弃。
   */
  node?: NodeConfig;
  /** 0.56：单一根密钥（派生 token 的来源） */
  security?: SecurityConfig;
  /** 0.49：平台 Gateway（与 `node:` 段分区，不共享 token 键） */
  gateway?: GatewayConfig;
  /**
   * 0.61：浏览器侧 **HTTP 访问控制**（谁能发 RPC），与 `auth.public_origins`
   * （`redirect_uri` 的来源选择）是两件事。
   *
   * ```yaml
   * http:
   *   allowed_origins:
   *     - http://127.0.0.1:*      # 回环通配端口（本机任意端口的 WebUI）
   *     - https://egg-rolls.top
   * ```
   *
   * 缺省（不写这一块）= 回落 `auth.public_origins` + 三条回环通配，老配置一字不改。
   * 条目口径与 `auth.public_origins` 相同：完整 origin，或回环 host 的端口通配；
   * 非回环写 `:*` 报错。
   */
  http?: { allowedOrigins?: string[] };
  /** S5：hub 控制面 */
  hub?: HubConfig;
  /** 0.4：eval harness */
  evals?: EvalsConfig;
  /** 0.4：飞书渠道 */
  feishu?: FeishuConfig;
  /** 0.4：可观测性 */
  observability?: ObservabilityConfig;
  /** 0.8.5：UI 语言 */
  ui?: UiConfig;
  /** 0.19 S3：全局 Team 声明；tenant overlay 不允许覆盖 */
  teams?: TeamConfigInput[];
  /** S7：跨节点 team ↔ team；全局配置，tenant overlay 不允许 */
  federation?: FederationConfig;
  /** 0.56：WebUI 登录（GitHub OAuth，单用户） */
  auth?: AuthConfig;
}

/** 配置加载选项 */
export interface ConfigLoadOptions {
  /** 项目配置文件路径（默认 ./vessel.yaml） */
  configPath?: string;
  /** 用户配置文件路径（默认 ~/.vessel/config.yaml） */
  userConfigPath?: string;
  /** 环境变量前缀（默认 VESSEL_） */
  envPrefix?: string;
  /** 环境变量来源；缺省 process.env（便于测试注入） */
  env?: Record<string, string | undefined>;
  /**
   * CLI 覆盖层（最高优先级）。生产路径由 CLI/外壳把显式 flag 组装成
   * `Partial<VesselConfig>` 后传入，loader 统一合并并标注 source=cli。
   */
  cliOverrides?: Partial<VesselConfig>;
  /**
   * @deprecated 与 `cliOverrides` 同义；保留仅为兼容旧调用方。
   * 同时提供时 `cliOverrides` 后应用（优先）。
   */
  defaults?: Partial<VesselConfig>;
}

/** 用户级配置（~/.vessel/config.yaml） */
export interface UserConfig {
  /** API Key（唯一必填项） */
  apiKey?: string;
  /** 默认 provider */
  defaultProvider?: string;
  /** 默认模型 */
  defaultModel?: string;
  /** 多 provider Key */
  providers?: Record<string, { apiKey: string; baseUrl?: string; model?: string }>;
  /** models 注册表（元数据，无密钥值；与项目层深合并） */
  models?: ModelsConfig;
}

/** 配置校验结果 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  warnings: ConfigValidationWarning[];
}

/** 配置校验错误 */
export interface ConfigValidationError {
  path: string;
  message: string;
  value?: unknown;
}

/** 配置校验警告 */
export interface ConfigValidationWarning {
  path: string;
  message: string;
  value?: unknown;
}
