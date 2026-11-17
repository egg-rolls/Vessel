/**
 * 0.49 G1：Platform Gateway 的冻结对外形状。
 *
 * 本模块不 import node runtime / node methods；类型只描述平台入口与 registry 投影。
 *
 * @module @vessel-agent/serve/platform/types
 */

import type { AuthSettings } from '../auth/routes.js';

/** 平台侧注入的 node 描述；G3 起一个平台可注入多个本地 node。 */
export interface PlatformNodeDescriptor {
  nodeId: string;
  name: string;
  apiUrl: string;
  version?: string;
}

/**
 * 组合根按 `node_id` 解析 node 生效凭据的结果（0.49 G3b）。
 * `found:false` = registry 无该 node，RPC 映射为 `node_not_found`；
 * `found:true` 且无 token = 该 node 走回环匿名（返回 `{token:null,mode:'none'}`）。
 */
export type PlatformNodeCredential = { found: true; token?: string } | { found: false };

/** registry 投影的健康态；不持久化。 */
export type PlatformNodeStatus = 'up' | 'down' | 'unknown';

/**
 * `platform.nodes.list|get` 的返回项。
 * 永不含 token / token_hash / credential_ref。
 */
export interface PlatformNodeSummary {
  node_id: string;
  name: string;
  api_url: string;
  status: PlatformNodeStatus;
  last_seen?: number;
  version?: string;
}

/**
 * 0.56：WebUI 登录（`auth.backends`）的运行参数。
 *
 * 缺省（不传 `PlatformGatewayOptions.auth`）= 完全禁用：没有任何登录后端，
 * 回环匿名照旧，`/auth/status` 报 `authEnabled:false`，前端不出现登录入口。
 */
export interface PlatformAuthOptions extends AuthSettings {
  /**
   * 受信代理地址（精确地址或 `10.0.` 前缀）。缺省 = 只信回环 socket。
   * 反代的 `Host` / `X-Forwarded-Proto` 只在这里列出的来源上才被采信。
   */
  trustedProxies?: string[];
  /** client_secret 等环境变量解析来源；缺省 `process.env`。 */
  env?: Record<string, string | undefined>;
  /**
   * 0.56 P2：生效的平台 token 值 —— **只**用于 `POST /auth/unlock` 的二次确认
   * （锁定后本机一条命令解锁）。不落盘、不进日志。
   */
  platformToken?: string | undefined;
}

/**
 * 0.57：`/build.json` 的**现场判断**结果（组合根注入，判定逻辑不在这里）。
 *
 * 只描述平台侧需要的两件事：产物是否落后于源码、落后到什么程度（最新那个源文件）。
 * 具体判据复用 `src/web-dist.ts#inspectWebDist`，平台不自己比 mtime —— 两套判据
 * 一旦漂移，就会出现「`gateway status` 说旧、浏览器说新」这种没人能查的矛盾。
 */
export interface WebDistProbeResult {
  stale: boolean;
  /** 比产物新的最新源文件；`stale: true` 时给出 */
  newestSource?: { path: string; mtimeMs: number };
}

/** 组合根注入的实时判定；省略 = `/build.json` 只发磁盘上的静态构建戳。 */
export type WebDistProbe = () => Promise<WebDistProbeResult>;

/** 组合根解析后注入 Platform Gateway 的全部运行参数。 */
export interface PlatformGatewayOptions {
  /** 平台监听端口；由组合根解析（默认 8642）。 */
  port: number;
  /** 平台监听地址；由组合根解析（默认 127.0.0.1）。 */
  hostname: string;
  /** 未配置 = undefined；仅回环匿名只读。 */
  platformToken?: string;
  /**
   * 0.56：`platformToken` 是否来自**显式配置**（缺省 true）。
   *
   * `false` = 这个值是根密钥派生的（用户什么都没配）：平台照旧要求远程客户端
   * 出示它，但**回环匿名保持不变**，避免「没配 token ⇒ 升级即掉线」重演。
   */
  platformTokenConfigured?: boolean;
  /**
   * 0.55 P0：反代共享密钥（opt-in；未配置 = 旧行为）。
   * 配置后，平台只在请求带 `x-vessel-proxy-secret` 时把 socket 回环当成可信来源 ——
   * 同机反代场景下这是唯一还能区分「本机浏览器」与「公网经反代」的信号。
   */
  proxySecret?: string;
  /** `gateway.allowed_origins`；已由组合根解析。 */
  allowedOrigins?: string[];
  /** 用于 CSP `frame-src` / `connect-src` 的 node origin。 */
  nodeOrigins: string[];
  /** 0.50：Hub 页浏览器直连的 Hub origin；只并入 CSP `connect-src`。 */
  hubOrigins?: string[];
  /** `apps/web/dist`；启动时必须存在 `index.html`。 */
  staticDir: string;
  /**
   * 0.57：`/build.json` 的实时增量字段（`stale` / `newestSource`）来源。
   *
   * 为什么需要：产物过期但**没人重建**时，浏览器里那份 bundle 与磁盘上的
   * `build.json` 是同一次构建 —— 前端只看 `builtAt` 永远判不出「旧了」，屏幕上
   * 也就永远没有提示。把「服务端知道 dist 落后于源码」这件事说进响应里，
   * 提示才有得响。省略 = 只发静态字段（老行为 + `no-store`）。
   */
  webDist?: WebDistProbe;
  /** registry 中全部本地 node（`auto_start:false` 也注入，只做健康展示）。 */
  nodes: PlatformNodeDescriptor[];
  /**
   * 组合根按 node_id 解析该 node 生效 token；只读取/透传，不生成、不缓存、不落盘。
   * 省略 nodeId 表示调用方已确认恰好一个节点（RPC 层负责多节点 `invalid_params`）。
   */
  resolveNodeCredential: (nodeId?: string) => PlatformNodeCredential;
  version?: string;
  /** 0.56：WebUI 登录；缺省 = 不启用（行为与 0.55 一致）。 */
  auth?: PlatformAuthOptions | undefined;
}

/** 已启动的平台监听。 */
export interface PlatformGateway {
  /** 实际监听端口（支持传入 0 由系统分配）。 */
  port: number;
  stop(): Promise<void>;
}
