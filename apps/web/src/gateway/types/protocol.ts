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

/** tenant 元数据（0.5） */
export interface TenantInfo {
  tenant_id: string;
  name?: string;
  status: 'active' | 'disabled';
  created_at: number;
  quota?: Record<string, number>;
  usage?: Record<string, number>;
}

export interface TenantResponse {
  tenant: TenantInfo;
}

/** 网关错误信封 */
export interface GatewayErrorBody {
  error: { code: string; message: string };
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

/** hello 帧 */
export interface HelloInfo {
  protocol: ProtocolInfo;
  node: NodeInfo;
  from_seq: number;
  latest_seq: number;
  /** 0.5：token 解析出的 tenant（additive） */
  tenant_id?: string;
  /** 0.24 additive：进程 incarnation；仅当前 WS 节点可读。 */
  incarnation?: string;
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
  commands?: PluginContributionCommand[];
  /**
   * CONTRACT-0.43 E1：canonical 是裸方法名字符串数组（`["summary","logs"]`）。
   * Web 仅用于 postMessage 方法校验，不渲染。旧 gateway 可能仍发 `{name}` 对象，
   * 读侧容忍该形状。
   */
  rpc?: Array<string | { name?: string; description?: string }>;
}

export interface PluginListItem {
  name: string;
  enabled: boolean;
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
  | ({ v: 1; kind: 'hello'; node_id: string; ts: number } & HelloInfo)
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
  | { v: 1; kind: 'res'; node_id: string; ts: number; id: string; ok: true; result: unknown }
  | {
      v: 1;
      kind: 'res';
      node_id: string;
      ts: number;
      id: string;
      ok: false;
      error: { code: string; message: string };
    }
  | { v: 1; kind: 'ping'; node_id: string; ts: number };

export interface HealthResponse {
  status: string;
  clients: number;
  latest_seq: number;
  protocol: ProtocolInfo;
  node: NodeInfo;
  started_at: number;
  tenant_id: string;
  /** 0.15 E6：旧 gateway 可能缺省。 */
  runtime?: RuntimeHealth;
}
