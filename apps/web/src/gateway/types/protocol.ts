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
 * hello 帧的时间线段（0.54 B1，ADR-105 §6；只有 `timeline_source === 'timeline'` 时给）。
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
  /** 0.24 additive：进程 incarnation；仅当前 WS 节点可读。 */
  incarnation?: string;
  /**
   * 0.54 B1：本 epoch 的读源。`'timeline'` ⇒ 帧带 `timeline_seq`、且 `timeline` 段一定在；
   * `'legacy'`（回退期 / 旧订阅 / 旧服务端不发这个键）⇒ 帧带 hub seq，老行为。
   *
   * **P1 #4（`PLAN-0.55-backlog`）待决标记 —— 0.55 这一轮不删**：这个帧字段与三支伴生
   * （`subscription.consumeHello` 的 legacy 分支 / `subscription.subscribeOnce` 退回
   * `since` 的那一支 / `connection-handlers.offGap` 的 gap 帧处理）绑在一起，**必须同一个
   * commit 删**。本轮做不到，判据有三条：
   * 1. 生产方在 `packages/serve/**`（`frames.ts` 的 `timeline_source` 字段 + 两个 hello
   *    构造点），不在本单边界内 —— 单删客户端只会让旧服务端的 hello 变成「形状不全」，
   *    老 epoch 的重放帧被 `truncateAfter(from_seq - 1)` 之外的路径丢掉；
   * 2. 老格式会话（冻结只读）仍会走 `session_frozen_readonly` → `legacyScopes` 那条退回
   *    路径，它靠 `'legacy'` 判定「不要做四条校验、游标退到 `from_seq - 1`」；
   * 3. 0.55 的 `timeline-epoch-end` 只在**时间线** epoch 发，客户端「可以依赖结束帧」的
   *    判据就是这里（`timeline_source === 'timeline'` ⇒ `hello.timeline` 在 ⇒ 有 epoch）。
   * 删的顺序应该是：先让服务端停发这个键、客户端改吃「`hello.timeline` 在不在」的形状
   * 判据，再一起删掉三支伴生。
   *
   * **现在删会怎么坏**（两步都是真的，不是理论）：① 老格式会话的重放帧会被当成时间线帧做四条例校验
   * （每帧一条假缺口），且游标不再 `truncateAfter(from_seq - 1)` ⇒ 重放后游标停在远处、后续帧全被判重丢弃；
   * ② 新会话的 hello 会被当成老 epoch ⇒ `timeline-epoch-end` 被静默忽略、`has_more` 失效，
   * 续拉退回「订阅 `res` + 连续前缀」那条单腿（0.54 服务端的处境内核，能用但不是主判据）。
   */
  timeline_source?: 'timeline' | 'legacy';
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
 * CONTRACT-0.47 §3：`plugins.catalog` 的只读条目。
 * 前端不推导字段；`kind` / `restartRequired` 以 gateway 返回值为准。
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
  restartRequired: boolean;
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

/** gap 帧 */
export interface GapFrame {
  kind: 'gap';
  from_seq: number;
  to_seq: number;
}

/** 服务端帧（前端只消费用到的字段） */
export type ServerFrame =
  | ({
      v: 1;
      kind: 'hello';
      node_id: string;
      ts: number;
    } & HelloInfo & {
        timeline_source?: 'timeline' | 'legacy';
        /**
         * 0.54 B1 时间线段：**线上是平铺的**（不是嵌套对象），见 `HelloTimelineSegment` 的注释；
         * 只有 `timeline_source === 'timeline'` 时才出现，形状见
         * `packages/serve/src/protocol.ts` 的 hello 分支。
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
  | ({ v: 1; kind: 'gap'; node_id: string; ts: number } & Omit<GapFrame, 'kind'>)
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
