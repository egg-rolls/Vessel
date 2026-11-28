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

/** 宿主通用 attachments 域能力（file-ref-ux；任何 embed 插件可用，非功能专属）。 */
export interface PluginHostAttachments {
  /** 缩略图字节 + 过期探针（canonical attachments.preview，read）。 */
  preview(path: string): Promise<ComposerPreviewResult>;
  /** 浏览器文件 → node 暂存副本（canonical attachments.stage，write）。 */
  stage(files: readonly File[]): Promise<StagedAttachment[]>;
  /**
   * 打开宿主标准附件预览弹窗（宿主决定形态：图片 → 既有 ImageLightbox，
   * 大图 + 完整路径 + 复制）。插件不另造 lightbox，只交路径。
   * 字节不可用（过期 / 拒绝 / 非图片）⇒ reject，调用方自行 toast。
   */
  openPreview(path: string): Promise<void>;
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
  /** 通用 attachments 域能力（宿主未提供时调用 reject，fail-closed）。 */
  attachments: PluginHostAttachments;
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
  /** 通用 attachments 域能力（缺省 = 调用 reject，fail-closed）。 */
  attachments?: PluginHostAttachments;
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
    attachments: Object.freeze({
      preview: (path: string): Promise<ComposerPreviewResult> => {
        if (adapter.attachments === undefined) {
          return Promise.reject(
            new Error('attachments_unavailable: host adapter has no attachments'),
          );
        }
        return adapter.attachments.preview(path);
      },
      stage: (files: readonly File[]): Promise<StagedAttachment[]> => {
        if (adapter.attachments === undefined) {
          return Promise.reject(
            new Error('attachments_unavailable: host adapter has no attachments'),
          );
        }
        return adapter.attachments.stage(files);
      },
      openPreview: (path: string): Promise<void> => {
        if (adapter.attachments === undefined) {
          return Promise.reject(
            new Error('attachments_unavailable: host adapter has no attachments'),
          );
        }
        return adapter.attachments.openPreview(path);
      },
    }),
  };
  return Object.freeze(host);
}
// ── composer 内嵌接缝（file-ref-ux additive）─────────────────────────────
//
// 宿主经 `contributes.composer` 把输入框编辑能力以**类型化端口**交给插件：
// 插件拿不到宿主 DOM / 路由 / 草稿 store 原对象，只有这一面（与 toolbar
// 「插件拿不到宿主回调」同一安全哲学）。宿主不认识「文件引用」这个功能名。

/** 结构化引用（与 core MessageRef 同形；sdk 不 import core，结构类型在此）。 */
export interface ComposerRef {
  kind: 'file' | 'image' | 'document';
  path: string;
  name?: string;
  mime?: string;
  bytes?: number;
  sha256?: string;
  /**
   * 随消息内联投递旗标（core MessageRef.inline 同形，契约驱动非功能名）。
   * 只写 true 键：缺省 / false ≡ 不内联（路径-only）。生产者经
   * `ComposerEditorPort.updateRef` 回写；历史 / 旧草稿无此键 ⇒ 缺省关。
   */
  inline?: boolean;
}

/** 瞬态节点句柄（上传占位 → 落定 / 更新 / 删除；与宿主 RichComposer 同形）。 */
export interface ComposerTransientHandle {
  settle(token: string): void;
  update(data: unknown): void;
  remove(): void;
}

/** 单文件暂存上传结果（宿主 attachments.stage 的逐条投影）。 */
export type StagedAttachment =
  | {
      ok: true;
      name: string;
      path: string;
      sha256: string;
      bytes: number;
      kind: 'file' | 'image' | 'document';
      mime?: string;
      expiresAt: number;
    }
  | { ok: false; name: string; error: string };

/** 预览 / 过期探针结果（宿主 attachments.preview 同形）。 */
export interface ComposerPreviewResult {
  status: 'ok' | 'gone' | 'denied' | 'too_large' | 'not_image';
  staging?: boolean;
  expiresAt?: number;
  mime?: string;
  bytes?: number;
  dataUrl?: string;
}

/** 目录浏览参数（宿主 attachments.list 同形；file-ref P3 additive）。 */
export interface ComposerListParams {
  /** 绝对路径；省略 = 只取 roots。 */
  dir?: string;
  /** 列出点开头 / 隐藏项（缺省 false）。 */
  include_hidden?: boolean;
  /** 条数上限（宿主缺省 200、上限 500）。 */
  limit?: number;
}

/** 目录条目（只有 file / dir 两类；path 是 node 上真实路径）。 */
export interface ComposerListEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  bytes?: number;
  mtime_ms?: number;
}

/** 目录浏览结果（宿主 attachments.list 同形）。 */
export interface ComposerListResult {
  roots: string[];
  dir?: string;
  parent?: string;
  entries: ComposerListEntry[];
  truncated: boolean;
  reason?: 'refs_invalid' | 'refs_denied' | 'refs_outside_roots';
}

/**
 * 输入框编辑端口（宿主通用能力，任何 composer 贡献插件可用）：
 * 读 / 增 / 删草稿引用、插入文本 / 原子节点 / 瞬态节点、取光标、
 * 暂存上传（stage）与预览（preview）——后两者是宿主 attachments 域能力。
 */
export interface ComposerEditorPort {
  refs(): readonly ComposerRef[];
  addRef(ref: ComposerRef): boolean;
  removeRef(index: number): void;
  /**
   * 按下标回写既有引用的旗标（不动顺序 / token 锚点）。patch 只认契约字段：
   * `inline: true` 写键，`inline: false` 删键（≡缺省，与 P1a 闸同口径）。
   * 返回 false = 下标越界。additive：旧宿主无此方法，插件须能力探测。
   */
  updateRef(index: number, patch: { inline?: boolean }): boolean;
  insertText(text: string, at?: number): void;
  insertAtomic(token: string, at?: number): void;
  insertTransient(scheme: string, data: unknown, at?: number): ComposerTransientHandle | null;
  getCaretOffset(): number;
  caretOffsetFromPoint(x: number, y: number): number | null;
  stage(files: readonly File[]): Promise<StagedAttachment[]>;
  preview(path: string): Promise<ComposerPreviewResult>;
  /**
   * 目录浏览（宿主 attachments.list 包一层；file-ref P3 additive）。
   * 数据源是页面所在节点（会话页 = 当前节点；团队页 = 团队所在节点）。
   * additive：旧宿主无此方法，插件须能力探测（缺省 ⇒ 浏览降级提示）。
   */
  listAttachments?(params?: ComposerListParams): Promise<ComposerListResult>;
}

/** drop 槽处理器：OS 文件（drop / 截图粘贴）→ 插件自行上传 + 插卡。 */
export type ComposerDropHandler = (
  files: File[],
  port: ComposerEditorPort,
  at: { offset: number | null },
) => void | Promise<void>;

/**
 * toolbar `action` 档处理器（file-ref P3 additive）：插件自持点击动作。
 * 宿主在用户点击时注入编辑端口 + 插件 host 面调用（与 drop 槽同款接缝，宿主
 * 零功能名）；插件可直调浏览器 API（embed 运行宿主同上下文）并经端口落草稿
 * 引用，host 提供 theme / toast / i18n / rpc 等通用能力。
 */
export type ComposerToolbarActionHandler = (
  port: ComposerEditorPort,
  host: VesselPluginHost,
) => void | Promise<void>;

/** 原子卡片渲染器 props（refs 槽；host 由宿主注入，port 是编辑端口）。 */
export interface ComposerCardProps {
  scheme: string;
  name: string;
  target: string;
  data?: unknown;
  onRemove: () => void;
  port?: ComposerEditorPort;
  host: VesselPluginHost;
}

/** 消息 link 增强器 props（link 槽；href 含 scheme 前缀）。 */
export interface ComposerLinkCardProps {
  href: string;
  text: string;
  host: VesselPluginHost;
}
