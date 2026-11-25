import type { RunEvent, RuntimeHealth } from './runs';

/** 统一状态语义（Web 与 TUI 共享词表；颜色只是增强，必须同时有字形 + 文本） */
export type StatusKind =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'pending'
  | 'connected'
  | 'disconnected'
  | 'unreachable'
  | 'disabled'
  | 'unavailable';

/** 网关错误信封 */
export interface GatewayErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** 协议信息 */
export interface ProtocolInfo {
  name: 'vessel.gateway';
  version: number;
  min: number;
  features: string[];
}

/** 节点公开信息 */
export interface NodeInfo {
  node_id: string;
  /** 0.25 additive：可读显示名；旧 gateway 缺失时回退 node_id。 */
  name?: string;
  pid: number;
  started_at: number;
  endpoint: string;
  role: 'standalone' | 'team';
  status: 'idle' | 'busy' | 'draining';
  current_run_id?: string;
  current_session_id?: string;
  capabilities: {
    tools: string[];
    provider?: string;
    model?: string;
    max_concurrency: number;
    protocol: number;
  };
}

/**
 * hello 帧的时间线段（0.54 B1，ADR-105 §6）。**它存在就是判据**（0.55）。
 *
 * **这是客户端的归一化形状，不是线上形状**：线上 `hello` 把这几个键**平铺**在帧上
 * （`packages/serve/src/gateway/frames.ts#helloFrame` 的 spread），映射发生在
 * `node/protocol.ts#handleFrame`（wire → 这里）**唯一一处**。为什么归一化：下游
 * （`readTimelineHelloSegment` / 四条校验 / `EventStore#beginTimelineEpoch`）只认一个对象，
 * 不必到处判「帧上有没有这几个键」。
 */
export interface HelloTimelineSegment {
  start_seq: number;
  end_seq: number;
  count: number;
  timeline_head: number;
  wal_head: number;
  /**
   * 一定被发布过（`published_head <= wal_head`）：`(published_head, wal_head]` 允许不被推送。
   *
   * 可选：0.54 早期服务端不发这个键，缺省语义 = 全部已发布（`= wal_head`），与 core 自己
   * `open()` 的口径一致（`timeline-protocol.ts#cursorTarget` 同一条规则）。
   */
  published_head?: number;
  holes: { from_seq: number; to_seq: number }[];
  tainted: boolean;
  reset?: true;
}

/** hello 帧 */
export interface HelloInfo {
  protocol: ProtocolInfo;
  node: NodeInfo;
  from_seq: number;
  latest_seq: number;
  /**
   * **客户端内部标记**（不上 wire）：这条 hello 是 `connect()` 等的那条**连接级** hello。
   *
   * 为什么需要它：连接级回放的帧是**进程级 hub seq**，时间线订阅的帧是**会话 seq**。两者
   * 不可比，而 `pendingHello` 只表达「有一条订阅 hello 在途」，遇到「订阅请求超时 / 重连
   * 与订阅交错」时它无法回答这条 hello 是谁的 —— 历史上正是这里把 hub 游标写进了时间线
   * 游标，下一次订阅越过 `wal_head`，服务端按 reset 从 seq 1 重放整段历史。
   */
  connectionLevel?: true;
  /** 0.24 additive：进程 incarnation；仅当前 WS 节点可读。 */
  incarnation?: string;
  /**
   * 时间线段（0.55：**在不在就是判据**）。
   *
   * 在 ⇒ 本 epoch 是时间线 epoch（帧带 `timeline_seq`、要做四条 count 校验、可以依赖
   * `timeline-epoch-end` 结趟）；不在 ⇒ 老 epoch（帧带 hub seq，老行为：游标退到
   * `from_seq - 1`、不发 `timeline_gap`）。
   *
   * 0.54 时代这里还有一个 `timeline_source: 'timeline' | 'legacy'` 显式标记，0.55 删了：
   * 形状本身已经足够，多一个字段就多一处可能与形状不一致。老服务端（0.54）发的
   * `timeline_source` 现在被当成未知键忽略 —— 它们的 `timeline` 段照旧被本形状读出来，
   * 所以判据不变；唯一会退化的是「服务端不再发 `timeline_source`、客户端却还在读它」这种
   * **反向**组合，也就是本次升级的方向，因此必须在 CHANGELOG 里写明「升级后刷新页面」。
   */
  timeline?: HelloTimelineSegment;
}

/**
 * 时间线 epoch 的**显式结束标记**（0.55，additive 新 kind；能力位 `timeline.epoch-end`）。
 *
 * 服务端把本趟声明区间（`hello.start_seq..end_seq`）的帧发完后补发这一帧，位置是最后一帧
 * 之后、订阅 `res` 之前。客户端据此结趟 —— 0.54 的「400ms 没新帧 = 发完了」那张空闲猜测
 * 已删除（见 `state/event-store.ts` 里 `EPOCH_IDLE_MS` 的位置）。
 *
 * 三条判据（都是契约，不是措辞）：
 * - **只在时间线 epoch 发**：老 epoch 的环形 seq 没有「本趟区间」的声明，发结束标记等于
 *   凭空造第二个事实源；
 * - **只在整趟发完时发**：提前停（连接坏 / 撞背压硬阈值）不发 —— 那一刻「发完了」不是事实，
 *   客户端会从订阅 `res` 那条显式事实按连续前缀收口续拉；
 * - `count` = 本趟**实发**条数（整趟发完 ⇒ 与 `hello.count` 必然相等，留它是让客户端核对）；
 *   `end_seq` = 本趟已发末条（零条已发时 = `start_seq - 1`）；`has_more` = 后面还有**可读**的
 *   没发（写者声明的洞不算「还有」，否则客户端的续拉会原地打转）。
 *
 * 老客户端不受影响：未知 `kind` 在 `node/protocol.ts#handleFrame` 的 `switch` 里落
 * `default: return`（静默忽略），JSON 解析还包着 try/catch ⇒ 收到这一帧与收到空行等价。
 */
export interface TimelineEpochEndFrame {
  kind: 'timeline-epoch-end';
  /** 本 epoch 的会话（时间线订阅必有；缺省则不出现在线上）。 */
  session_id?: string;
  /** 本趟已发的最后一条 seq（零条已发时 = `start_seq - 1`）。 */
  end_seq: number;
  /** 本趟**实发**的事件帧条数（整趟发完 ⇒ 等于 `hello.count`）。 */
  count: number;
  /** 后面还有**可读**的没发（洞不算「还有」）。 */
  has_more: boolean;
}

/** RPC 响应信封（0.5） */
export interface RpcResponseEnvelope<T = unknown> {
  v: 1;
  id: string;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * plugin 导航归属；缺省当 `top`（CONTRACT-0.43 §2.1）。
 * 0.45 E5：内置分组 `top/observe/settings/plugins` 之外，页面可引用本 plugin 的
 * `plugin:<pluginId>` 自定义分组，因此类型放开为 string（由 normalizer 校验）。
 */
export type PluginNavSlot = string;

/** CONTRACT-0.43 §2.11 E9：插件私有字典（只支持 en / zh-CN）。 */
export interface PluginI18n {
  en?: Record<string, string>;
  'zh-CN'?: Record<string, string>;
}

/** CONTRACT-0.43 §2.9 E5：plugin 自定义导航分组。 */
export interface PluginNavGroupContribution {
  /** 必须是 `plugin:<pluginId>`；v1 每个 plugin 最多一个。 */
  id: string;
  title: string;
  /** 可选 i18n key；由该 plugin 的 i18n 字典解析。 */
  titleKey?: string;
  /** 白名单图标名；未知名由 Web normalizer 丢弃。 */
  icon?: string;
  order?: number;
}

/** panel 槽位（CONTRACT-0.43 §2.6）。 */
export type PluginPanelSlot = 'run-detail' | 'session-detail' | 'nav';

/**
 * 输入框工具栏槽位（0.51 additive）：插件只能**声明**按钮（id + label），
 * 点击由宿主映射成宿主回调；v1 只有会话 / 团队共用的 `composer` 一个槽位。
 */
export type PluginToolbarSlot = 'composer';

/** `contributes.toolbar[]` 的 wire 形状（additive；旧 gateway 不返回）。 */
export interface PluginContributionToolbar {
  slot: PluginToolbarSlot;
  /** 宿主映射用的稳定 id（同一 plugin 内唯一）。 */
  id: string;
  /** 按钮可见文字；宿主可覆盖成自己的文案。 */
  label: string;
  /** 可选 i18n key；由该 plugin 的私有字典解析。 */
  titleKey?: string;
  /** 白名单图标名；未知名由 Web normalizer 丢弃。 */
  icon?: string;
  order?: number;
  /** 通用 RPC 绑定菜单（additive，q-thinking-plugin P3）；旧 gateway 不返回。 */
  menu?: PluginContributionToolbarMenu;
}

/** 菜单档位项 wire 形状（additive）。 */
export interface PluginContributionToolbarMenuItem {
  value: string;
  labelKey?: string;
  label?: string;
}

/** 通用 RPC 绑定菜单 wire 形状（additive）。 */
export interface PluginContributionToolbarMenu {
  read: string;
  write: string;
  valueKey: string;
  sessionScoped?: boolean;
  items: PluginContributionToolbarMenuItem[];
}

/** `plugins.list` 的 additive 贡献点；旧 gateway 不返回。 */
export interface PluginContributionPage {
  id: string;
  title: string;
  nav?: PluginNavSlot;
  /** 可选 i18n key；Web 导航优先用它，缺省回退 manifest title。 */
  titleKey?: string;
  /** 白名单图标名；未知名由 Web normalizer 丢弃该页。 */
  icon?: string;
  order?: number;
  /** 相对 `ui.dir` 的 iframe 入口；缺失时回退 index.html。 */
  entry?: string;
  /** 宿主可选的完整路由；仅用于从旧数据推导 entry。 */
  route?: string;
  /** plugin-embed 契约 §3：embed 模块的具名导出组件（additive）。 */
  component?: string;
}

export interface PluginContributionPanel {
  slot: PluginPanelSlot;
  id: string;
  title?: string;
  order?: number;
  entry?: string;
}

export interface PluginContributionCommand {
  name: string;
  title?: string;
}

export interface PluginContributions {
  /** CONTRACT-0.43 §2.11 E9：插件私有 i18n 字典；不合并进宿主 catalog。 */
  i18n?: PluginI18n;
  /** CONTRACT-0.43 §2.9 E5：自定义导航分组（v1 每 plugin 最多一个）。 */
  navGroups?: PluginNavGroupContribution[];
  pages?: PluginContributionPage[];
  panels?: PluginContributionPanel[];
  /** 输入框工具栏声明（additive）；插件只声明按钮，点击由宿主映射。 */
  toolbar?: PluginContributionToolbar[];
  commands?: PluginContributionCommand[];
  /**
   * CONTRACT-0.43 E1：canonical 是裸方法名字符串数组（`["summary","logs"]`）。
   * Web 仅用于 postMessage 方法校验，不渲染。旧 gateway 可能仍发 `{name}` 对象，
   * 读侧容忍该形状。
   */
  rpc?: Array<string | { name?: string; description?: string; permission?: 'read' | 'write' }>;
  /**
   * S3 additive（vscode-settings-design §4.2）：插件设置域 spec。
   * 旧 gateway 不返回 → 归一化得空数组 → 扩展组不渲染。
   */
  settings?: Record<string, PluginSettingSpecWire>;
}

/** `contributes.settings.<key>` 的 wire 形状（§4.1；扩展字段全部可选）。 */
export interface PluginSettingSpecWire {
  type?: string;
  title?: string;
  titleKey?: string;
  description?: string;
  descriptionKey?: string;
  default?: unknown;
  enum?: unknown;
  keywords?: unknown;
  order?: unknown;
  minimum?: unknown;
  maximum?: unknown;
}

export type PluginRuntimeMode = 'in-process' | 'child';
export type PluginRuntimeStatus = 'inactive' | 'active' | 'unhealthy' | 'disabled' | 'invalid';

/** CONTRACT-0.47 §3：插件发现来源。 */
export type PluginCatalogScope = 'builtin' | 'user' | 'project' | 'node_modules';
/** CONTRACT-0.47 §3：builtin / 外部体验插件 / 外部能力插件。 */
export type PluginCatalogKind = 'builtin' | 'marketplace' | 'dynamic';

/** CONTRACT-0.48 §8.1：catalog 扩展面摘要（只放 id/method/path，不放 handler）。 */
export interface PluginSurfaceHttpEntry {
  id: string;
  method: string;
  path: string;
}

export interface PluginSurfaceCliEntry {
  path: string[];
  description?: string;
}

export interface PluginSurfaceSummary {
  http: PluginSurfaceHttpEntry[];
  cli: PluginSurfaceCliEntry[];
}

/**
 * per-capability 生命周期（q-plugin-lifecycle §6.1）：宿主推导 + manifest 保守声明。
 * 每个能力 hot = 热应用即生效；restart = 需重启 gateway。前端只消费，不推导。
 */
export interface PluginLifecycleProfile {
  toggle: 'hot' | 'restart';
  settings: 'hot' | 'restart';
  code: 'hot' | 'restart';
}

/**
 * CONTRACT-0.47 §3：`plugins.catalog` 的只读条目。
 * 前端不推导字段；`kind` / `pendingRestart` 以 gateway 返回值为准。
 */
export interface PluginCatalogItem {
  id: string;
  name: string;
  version: string;
  scope: PluginCatalogScope;
  kind: PluginCatalogKind;
  mode: PluginRuntimeMode;
  enabled: boolean;
  supportsToggle: boolean;
  /** 兼容别名 = pendingRestart（q-plugin-lifecycle §6.2 R2 语义变更）。 */
  restartRequired: boolean;
  /** 存在「期望态 ≠ 已生效态」且该面 restart 的差异（真阳性 badge）。 */
  pendingRestart?: boolean;
  /** per-capability 生命周期；旧 gateway 缺省。 */
  lifecycle?: PluginLifecycleProfile;
  status?: PluginRuntimeStatus;
  path: string;
  entry?: string;
  /** child 插件清单；字段随插件类型变化，前端只透传不解释。 */
  manifest?: Record<string, unknown>;
  /** CONTRACT-0.48 §8.1：manifest 声明面；没有声明 / in-process 时缺省。 */
  declaredSurface?: PluginSurfaceSummary;
  /** 声明 ∩ enabled ∩ config.expose；只在 `declaredSurface` 存在时出现。 */
  effectiveSurface?: PluginSurfaceSummary;
}

export interface PluginCatalogResponse {
  items: PluginCatalogItem[];
}

/** plugin-embed 契约 §1：UI 信任档（服务端计算，前端只消费，不自行推断）。 */
export type PluginUiTrust = 'embedded' | 'isolated';

/** plugin-embed 契约 §3：`ui.embed` 声明的 wire 形状。 */
export interface PluginUiEmbed {
  entry: string;
  css?: string;
  runtime: { react: string; sdk: string };
}

export interface PluginListItem {
  name: string;
  enabled: boolean;
  /** E10 additive runtime metadata；旧 gateway 缺省。 */
  version?: string;
  mode?: PluginRuntimeMode;
  status?: PluginRuntimeStatus;
  /** plugin 私有配置快照（E10；marketplace 用 registry_url）。 */
  config?: Record<string, unknown>;
  /** additive（CONTRACT-0.43 §2.7）；能力插件不返回。 */
  contributions?: PluginContributions;
  /** plugin-embed 契约 §3：没有 ui.embed 的插件三字段缺省（旧 gateway 同）。 */
  ui_trust?: PluginUiTrust;
  ui_bundle_hash?: string;
  ui_embed?: PluginUiEmbed;
}

/** capability manifest（0.5） */
export interface CapabilityManifest {
  version: string;
  config_schema_version: number;
  methods: Array<{
    name: string;
    params_schema?: unknown;
    result_schema?: unknown;
    permission: 'read' | 'write' | 'admin';
  }>;
  tools: Array<{ name: string; description?: string }>;
  plugins: Array<{ name: string; enabled: boolean; contributions?: PluginContributions }>;
}

/** 服务端帧（前端只消费用到的字段） */
export type ServerFrame =
  | ({
      v: 1;
      kind: 'hello';
      node_id: string;
      ts: number;
    } & HelloInfo & {
        /**
         * 0.54 B1 时间线段：**线上是平铺的**（不是嵌套对象），见 `HelloTimelineSegment` 的注释；
         * 0.55 起**它的存在就是「这是时间线 epoch」的判据**（`timeline_source` 已删除），
         * 形状见 `packages/serve/src/protocol.ts` 的 hello 分支。
         */
        start_seq?: number;
        end_seq?: number;
        count?: number;
        timeline_head?: number;
        wal_head?: number;
        published_head?: number;
        holes?: { from_seq: number; to_seq: number }[];
        tainted?: boolean;
        reset?: boolean;
      })
  | {
      v: 1;
      kind: 'event';
      node_id: string;
      ts: number;
      seq: number;
      job_id?: string;
      event: RunEvent;
    }
  /** 0.55：时间线 epoch 的显式结束标记（能力位 `timeline.epoch-end`；未知 kind 的老客户端静默忽略）。 */
  | ({
      v: 1;
      node_id: string;
      ts: number;
    } & TimelineEpochEndFrame)
  | { v: 1; kind: 'res'; node_id: string; ts: number; id: string; ok: true; result: unknown }
  | {
      v: 1;
      kind: 'res';
      node_id: string;
      ts: number;
      id: string;
      ok: false;
      error: { code: string; message: string; details?: unknown };
    }
  | { v: 1; kind: 'ping'; node_id: string; ts: number };

export interface HealthResponse {
  status: string;
  clients: number;
  latest_seq: number;
  protocol: ProtocolInfo;
  node: NodeInfo;
  started_at: number;
  /** 0.15 E6：旧 gateway 可能缺省。 */
  runtime?: RuntimeHealth;
}
