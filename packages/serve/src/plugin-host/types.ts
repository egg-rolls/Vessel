/**
 * 体验型 plugin 宿主契约的结构镜像（CONTRACT-0.43）。
 *
 * 这里**不** import `src/`（loader / manifest parser）也不 import core 的 plugin 类型：
 * assembly 把已解析、已校验的 descriptor 注入进来，serve 只消费结构字段。
 * 做法与 `metrics.ts` 的 `MetricsSnapshot` 镜像一致。
 *
 * @module @vessel-agent/serve/plugin-host
 */

import type { RpcDynamicMethodSource } from '../rpc.js';
import type { PluginHttpDeclaration } from './http.js';

/** 错误码（CONTRACT-0.43 §8；日志 / 状态用，不是 RPC 信封 code） */
export type PluginErrorCode =
  | 'plugin_manifest_invalid'
  | 'plugin_id_conflict'
  | 'plugin_version_incompatible'
  | 'plugin_dependency_missing'
  | 'plugin_cycle'
  | 'plugin_activation_failed'
  | 'plugin_timeout'
  | 'plugin_crashed'
  | 'plugin_payload_too_large'
  | 'plugin_permission_denied'
  | 'plugin_rpc_denied'
  | 'plugin_config_invalid'
  | 'plugin_event_dropped';

/** 运行状态（`vessel plugin list` 的 status 列） */
export type PluginRuntimeStatus =
  | 'disabled'
  | 'invalid'
  | 'inactive'
  | 'starting'
  | 'active'
  | 'unhealthy'
  | 'stopped';

/** manifest 的 side 字段 */
export type PluginSide = 'backend' | 'ui' | 'both';

/**
 * 核心导航分组 key（稳定，不随 i18n 变化）；plugin 不可占用这些 id。
 * E6：chat / network / runs / integrations / status 也是核心分组。
 */
export const PLUGIN_BUILTIN_NAV = [
  'chat',
  'network',
  'runs',
  'integrations',
  'status',
  'top',
  'plugins',
  'observe',
  'settings',
] as const;

/** 内置导航分组 id */
export type PluginBuiltinNav = (typeof PLUGIN_BUILTIN_NAV)[number];

/**
 * 页面导航分区：内置分组或本 plugin 自己的 `plugin:<pluginId>`。
 * 跨 plugin 分组由运行时校验拒绝（`plugin_manifest_invalid`）。
 */
export type PluginNav = PluginBuiltinNav | `plugin:${string}`;

/** web 现有图标白名单（CONTRACT-0.43 §2.9；不接受任意 SVG）。 */
export const PLUGIN_ICON_NAMES = [
  'chat',
  'hub',
  'gateway',
  'nodes',
  'teams',
  'agents',
  'runs',
  'tools',
  'mcp',
  'channels',
  'plugins',
  'observe',
  'settings',
] as const;

/** 白名单图标名 */
export type PluginIconName = (typeof PLUGIN_ICON_NAMES)[number];

/** 支持的插件私有 i18n locale（CONTRACT-0.43 §2.11 E9）。 */
export const PLUGIN_I18N_LOCALES = ['en', 'zh-CN'] as const;

export type PluginLocale = (typeof PLUGIN_I18N_LOCALES)[number];

/** 插件私有字典：按 locale 保存，不合并宿主 catalog。 */
export type PluginI18n = Partial<Record<PluginLocale, Record<string, string>>>;

/** `contributes.navGroups[]`（v1 每个 plugin 最多一个） */
export interface PluginNavGroup {
  /** 必须是 `plugin:<pluginId>`。 */
  id: string;
  title: string;
  /** i18n key（可选）；title 仍是 fallback。 */
  titleKey?: string;
  icon?: PluginIconName;
  order?: number;
}

/** 静态 UI 挂载点 */
export interface PluginStaticMount {
  /** manifest id */
  id: string;
  /** 已解析的绝对路径；资产只从这里向下取。 */
  uiDir: string;
}

/** `contributes.pages[]` */
export interface PluginPageContribution {
  id: string;
  title: string;
  /** i18n key（可选）；与 title 一起透传到 plugins.list contributions。 */
  titleKey?: string;
  nav?: PluginNav;
  icon?: PluginIconName;
  order?: number;
  /** 相对 `ui.dir` 的入口文件。 */
  entry: string;
}

/** `contributes.panels[]` */
export interface PluginPanelContribution {
  slot: string;
  id: string;
  title?: string;
  order?: number;
  entry: string;
}

/** `contributes.commands[]` */
export interface PluginCommandContribution {
  name: string;
  title: string;
}

/** `contributes.rpc[]` */
export interface PluginRpcContribution {
  /** 只能是 `[a-z][a-z0-9_-]*`；宿主拼接为 `plugin.<id>.<name>`。 */
  name: string;
  description?: string;
  /** 调用方权限；缺省 read（contract §2.4 / §2.12 E10）。 */
  permission?: 'read' | 'write';
}

/** `contributes`（只保留宿主需要的键） */
export interface PluginManifestContributions {
  /** 插件私有字典；只允许 en / zh-CN。 */
  i18n?: PluginI18n;
  /** v1 最多一个自定义分组：`plugin:<pluginId>`。 */
  navGroups?: PluginNavGroup[];
  pages?: PluginPageContribution[];
  panels?: PluginPanelContribution[];
  commands?: PluginCommandContribution[];
  rpc?: PluginRpcContribution[];
  events?: string[];
  settings?: Record<string, unknown>;
  /** 0.48 M1：插件 HTTP 路由声明（CONTRACT-0.48 §2）。 */
  http?: PluginHttpDeclaration[];
}

/** `permissions` */
export interface PluginPermissions {
  fs?: string[];
  net?: string[];
  process?: boolean;
  secrets?: boolean;
  events?: string[];
  rpc?: string[];
}

/** 依赖声明（校验由 loader 负责，宿主只读取覆盖顺序） */
export interface PluginDependencies {
  plugins?: string[];
  ordering?: { after?: string[]; before?: string[] };
}

/**
 * 已由 loader 解析 / 校验的 plugin 描述。
 *
 * `pluginDir` / `entry` / `uiDir` 都是**绝对路径**，由 loader 经 realpath 解析；
 * 宿主仍会对 entry / uiDir 做 containment 复检（fail-closed）。
 */
export interface PluginDescriptor {
  id: string;
  name: string;
  version: string;
  side?: PluginSide;
  /** 子进程入口（绝对路径，Bun 可直接执行的 TS / JS）。 */
  entry: string;
  /** plugin 包根目录（绝对路径，作为子进程 cwd）。 */
  pluginDir: string;
  /** 静态 UI 目录（绝对路径，可选）。 */
  uiDir?: string;
  activationEvents?: string[];
  contributes?: PluginManifestContributions;
  permissions?: PluginPermissions;
  dependencies?: PluginDependencies;
  /** 初始启用状态；缺省 true。 */
  enabled?: boolean;
  /** 内置插件（随 release 发布，可信）；`auth: none/plugin` 只允许内置。 */
  builtin?: boolean;
}

/** `plugins.list` 的 E1 渲染字段（contract §2.7） */
export interface PluginRenderContributions {
  /** E5：自定义分组（v1 最多一个），按 order 升序。 */
  navGroups: Array<{
    id: string;
    title: string;
    titleKey?: string;
    icon?: PluginIconName;
    order: number;
  }>;
  /** 校验后的插件私有字典（原样透传；插件作用域，不合并宿主 catalog）。 */
  i18n?: PluginI18n;
  pages: Array<{
    id: string;
    title: string;
    titleKey?: string;
    nav: PluginNav;
    icon?: PluginIconName;
    order: number;
    entry: string;
    route: string;
  }>;
  panels: Array<{
    slot: string;
    id: string;
    title?: string;
    order: number;
    entry: string;
    route: string;
  }>;
  commands: Array<{ name: string; title: string }>;
  /** E1 amendment：bare RPC 方法名，供 web iframe bridge 做白名单。 */
  rpc: string[];
}

/** `plugins.reload` 的单项失败（只影响该 plugin）。 */
export interface PluginReloadError {
  id: string;
  code: PluginErrorCode;
  message: string;
}

/** `plugins.reload` 结果（CONTRACT-0.43 §2.8）。 */
export interface PluginReloadResult {
  added: string[];
  removed: string[];
  changed: string[];
  /** reload 结束后处于 active 的 plugin id。 */
  active: string[];
  errors: PluginReloadError[];
  /** 同时发现 in-process 能力插件时由 assembly 置位；不谎报已重载。 */
  restart_required?: boolean;
}

/** `plugin.changed` 的 payload：`plugins.list` 形状的贡献快照。 */
export interface PluginContributionsSnapshot {
  plugins: Array<{
    name: string;
    enabled: boolean;
    contributions?: PluginRenderContributions;
  }>;
}

/** 插件运行模式（E10 元数据）。 */
export type PluginMode = 'in-process' | 'child';

/** `plugins.list[].status` 允许的对外值（不含瞬态 starting/stopped）。 */
export type PluginListStatus = 'inactive' | 'active' | 'unhealthy' | 'disabled' | 'invalid';

/** `plugins.list` 每项的运行时元数据（additive）。 */
export interface PluginListMetadata {
  version?: string;
  mode?: PluginMode;
  status?: PluginListStatus;
}

/** 单个 plugin 的可观测状态 */
export interface PluginStatusEntry {
  id: string;
  status: PluginRuntimeStatus;
  enabled: boolean;
  /** manifest version（E10）。 */
  version?: string;
  /** 体验型 plugin 在宿主内始终是 child（E10）。 */
  mode?: PluginMode;
  /** 最近一次失败码；成功启动 / 停止后清理。 */
  error?: PluginErrorCode;
  /** 最近一次失败的说明（不含密钥 / 事件正文）。 */
  message?: string;
  /** 限流丢弃的事件总数（CONTRACT-0.43 §2.5）。 */
  events_dropped: number;
  /** 当前 restart 窗口内已重启次数。 */
  restarts: number;
}

/** 已脱敏、已 DTO 化的事件（`plugin.event` 的 params） */
export interface PluginEventDto {
  type: string;
  ts: number;
  data: Record<string, unknown>;
}

/** 可注入的单流事件源（gateway hub / 测试 fake） */
export interface PluginEventSource {
  subscribe(handler: (event: PluginEventDto) => void): () => void;
}

/**
 * gateway 只依赖这个窄接口；实现见 `PluginHostManager`。
 * `rpc` 接入 canonical dispatcher 的动态解析面。
 */
export interface PluginHostManagerLike {
  readonly rpc: RpcDynamicMethodSource;
  /** 运行时状态；gateway 用 version/mode/status 填充 plugins.list 元数据。 */
  statuses(): PluginStatusEntry[];
  /**
   * 懒激活：首次页面 / RPC 访问时调用；active 时 no-op，
   * disabled / invalid 抛契约错误。v1 不做预激活。
   */
  ensureActive(id: string): Promise<void>;
  /** plugin id → 渲染字段；只含 enabled 的体验型 plugin。 */
  contributionsFor(): Record<string, PluginRenderContributions>;
  /** 当前 enabled、且声明了 ui.dir 的静态挂载。 */
  staticMounts(): PluginStaticMount[];
  /** 由 gateway 用 hub 构造的事件源注入；替换旧源并重订阅 active plugin。 */
  attachEventSource(source: PluginEventSource): void;
}
