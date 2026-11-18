/**
 * Vessel 插件 SDK（plugin-embed 契约 §7，P2 最小面）。
 *
 * 内嵌档（embedded）的宿主 API 契约 + 薄运行时：`createPluginHost(adapter)`
 * 把 apps/web 提供的适配器包成冻宿主对象，每个方法内部再校验一次 manifest
 * 白名单。**白名单只防误用，不是沙箱**：embedded 等同授予该插件对 Web 控制台
 * 的全部权限（含会话凭据），见契约 §1。
 *
 * P3 再加 router / dialog / actions / iframe transport / vesselEmbedGuard。
 * 按源码消费（apps/web vite alias + tsconfig paths；插件构建 external 化）。
 *
 * @module @vessel-agent/plugin-sdk
 */

export {
  type ComparatorOperator,
  compareSemver,
  isValidSemver,
  parseRangeVersion,
  parseSemver,
  parseVersionRange,
  type SemverParts,
  satisfiesComparator,
  satisfiesVersionRange,
  type VersionComparator,
} from './semver';

/** 宿主主题快照（mode 是已解析的亮/暗，不是用户的 system 选择）。 */
export interface PluginHostTheme {
  mode: 'light' | 'dark';
  lang: string;
}

/** 插件可订阅的事件（payload 是宿主事件的 data 面）。 */
export interface PluginHostEvent {
  type: string;
  payload?: unknown;
}

/**
 * 内嵌插件拿到的宿主对象（P2 面）。由 `createPluginHost` 构造并冻结；
 * 不暴露 client / token / eventStore 原对象。
 */
export interface VesselPluginHost {
  readonly pluginId: string;
  readonly sdkVersion: string;
  /** 裸名必须在 manifest `contributes.rpc` 内；宿主补 `plugin.<id>.` 前缀。 */
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** type 必须在 manifest `permissions.events` 子集内（支持 `llm.*` 模式）。 */
  events: {
    subscribe(type: string, cb: (e: PluginHostEvent) => void): () => void;
  };
  theme: {
    get(): PluginHostTheme;
    subscribe(cb: (t: PluginHostTheme) => void): () => void;
  };
  toast(msg: { kind: 'info' | 'success' | 'error'; text: string }): void;
  i18n: { t(key: string, vars?: Record<string, string | number>): string };
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
  permissions: { has(permission: string): boolean };
}

/** 挂载点属性（P2 只有 page；mounts 在 P3）。 */
export interface PluginMountProps {
  host: VesselPluginHost;
  mount: 'page';
  context: { pageId: string; run?: string; session?: string };
}

/** embed 模块形状：具名导出组件 + 可选 dispose（热更新切换前调用）。 */
export type PluginModule = Record<string, unknown> & { dispose?: () => void };

/** manifest `permissions` 的声明面（permissions.has 的数据源）。 */
export interface PluginPermissionDeclaration {
  fs?: readonly string[];
  net?: readonly string[];
  process?: boolean;
  secrets?: boolean;
  events?: readonly string[];
  rpc?: readonly string[];
}

/**
 * apps/web 提供的宿主适配器：原始能力 + manifest 白名单。
 * `rpc` 收 **canonical 方法名**（`plugin.<id>.<name>`，前缀由 SDK 补好）；
 * 其余面与 `VesselPluginHost` 同形，白名单复核在 `createPluginHost` 内做。
 */
export interface PluginHostAdapter {
  pluginId: string;
  sdkVersion: string;
  /** manifest `contributes.rpc` 裸名白名单。 */
  rpcMethods: readonly string[];
  /** manifest `permissions.events` 模式（支持 `llm.*`）。 */
  eventPatterns: readonly string[];
  permissions: PluginPermissionDeclaration;
  rpc(method: string, params?: unknown): Promise<unknown>;
  subscribeEvent(type: string, cb: (e: PluginHostEvent) => void): () => void;
  theme: VesselPluginHost['theme'];
  toast: VesselPluginHost['toast'];
  i18n: VesselPluginHost['i18n'];
  log: VesselPluginHost['log'];
}

/** 与 serve 侧 `eventSubsetOfPermissions` 同一套模式语义。 */
function eventAllowed(type: string, patterns: readonly string[]): boolean {
  return patterns.some(
    (pattern) =>
      pattern === '*' ||
      pattern === type ||
      (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1))),
  );
}

/** 能力名级别的声明检查：布尔能力看 true，数组能力看非空。 */
function hasPermission(permissions: PluginPermissionDeclaration, permission: string): boolean {
  switch (permission) {
    case 'process':
      return permissions.process === true;
    case 'secrets':
      return permissions.secrets === true;
    case 'fs':
      return (permissions.fs?.length ?? 0) > 0;
    case 'net':
      return (permissions.net?.length ?? 0) > 0;
    case 'events':
      return (permissions.events?.length ?? 0) > 0;
    case 'rpc':
      return (permissions.rpc?.length ?? 0) > 0;
    default:
      return false;
  }
}

/**
 * 构造冻宿主对象。每个方法内部再校验一次白名单（rpc 裸名 / events type）；
 * 违规 fail-closed：rpc reject `plugin_rpc_denied`，subscribe 抛
 * `plugin_permission_denied`。白名单只防误用，不是安全边界（契约 §1）。
 */
export function createPluginHost(adapter: PluginHostAdapter): VesselPluginHost {
  const host: VesselPluginHost = {
    pluginId: adapter.pluginId,
    sdkVersion: adapter.sdkVersion,
    rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
      // 白名单每次调用时读 adapter 现值（catalog 可能异步到达）。
      if (!adapter.rpcMethods.includes(method)) {
        return Promise.reject(
          new Error(`plugin_rpc_denied: "${method}" is not declared in contributes.rpc`),
        );
      }
      return adapter.rpc(`plugin.${adapter.pluginId}.${method}`, params) as Promise<T>;
    },
    events: Object.freeze({
      subscribe(type: string, cb: (e: PluginHostEvent) => void): () => void {
        if (!eventAllowed(type, adapter.eventPatterns)) {
          throw new Error(
            `plugin_permission_denied: event "${type}" is not allowed by permissions.events`,
          );
        }
        return adapter.subscribeEvent(type, cb);
      },
    }),
    theme: Object.freeze({
      get: (): PluginHostTheme => adapter.theme.get(),
      subscribe: (cb: (t: PluginHostTheme) => void): (() => void) => adapter.theme.subscribe(cb),
    }),
    toast: (msg): void => adapter.toast(msg),
    i18n: Object.freeze({
      t: (key: string, vars?: Record<string, string | number>): string => adapter.i18n.t(key, vars),
    }),
    log: (level, message, data): void => adapter.log(level, message, data),
    permissions: Object.freeze({
      has: (permission: string): boolean => hasPermission(adapter.permissions, permission),
    }),
  };
  return Object.freeze(host);
}
