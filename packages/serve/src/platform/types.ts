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

/**
 * 0.60：后台构建状态的**快照**（平台侧的类型镜像，避免 `packages/serve` 反向依赖
 * `src/`）。
 *
 * 字段与 `src/web-dist.ts#WebBuildState` 一一对应；组合根只做 `() => webDistBuildState()`
 * 的转发，平台不自己判断「在不在建」。
 */
export interface WebBuildSnapshot {
  phase: 'idle' | 'running' | 'done' | 'failed' | 'interrupted';
  /** 本次构建开始时刻（epoch ms） */
  startedAt?: number;
  /** 为什么建：产物缺失 / 落后于源码 */
  reason?: 'missing' | 'stale';
  /** 谁叫起来的：startup / probe / timer（0.61） */
  trigger?: 'startup' | 'probe' | 'timer';
  pid?: number;
  /** 构建输出文件（用户要照着去翻的那份） */
  logPath?: string;
  /** 上一次构建的终态 */
  last?: {
    phase: 'done' | 'failed' | 'interrupted';
    at: number;
    durMs: number;
    exitCode?: number;
    signal?: string;
    assets?: number;
    bytes?: number;
    logPath?: string;
  };
}

/** 构建状态读取口（同步、零成本；省略 = 本平台不管构建）。 */
export type WebBuildProbe = () => WebBuildSnapshot;

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
  /**
   * 0.61：`http.allowed_origins`（**访问控制**）。未配置（`undefined`）= 回落到
   * `auth.public_origins` + 三条回环通配；显式配置 = 就是它（空数组 = 不再补通配）。
   */
  httpAllowedOrigins?: string[];
  /**
   * 0.63：`auth.allow_loopback_anonymous`（缺省 **false**）。
   *
   * `true` 时「回环 socket + 回环 Host + 未被证明是受信反代」的请求算本机直连
   * （`edge.localDirect`），数据面不再要求身份 —— 同机任何进程都能免登录访问。
   * 只影响**是否要求身份**，不绕过 origin 闸 / 凭据闸 / CSRF。
   */
  allowLoopbackAnonymous?: boolean;
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
  /**
   * 0.60：**构建这件事**的唯一读取口（组合根注入，读 `src/web-dist.ts` 的内存态）。
   *
   * 为什么不是「一个布尔」：`building` 只回答「在不在建」，而用户还要知道「建成了
   * 没有、上次为什么失败、日志在哪」。同一份状态里塞一个布尔出去，另一边就会自己
   * 再拼一句「正在构建」，两句话迟早对不上 —— 所以注射器只给快照，文案由本包统一
   * 从快照派生（见 `buildJsonPayload`）。
   *
   * 省略 = 永远认为没有构建在进行（`building: false`），老行为。
   */
  webBuild?: WebBuildProbe;
  /**
   * 0.61：**运行中自查**（低频定时 + `/build.json` 观测到 `stale` 时各叫一次）。
   *
   * 为什么需要：启动时的自建只跑一次，之后「源码改了、产物还是旧的」没人管 ——
   * 只要没人开浏览器拉 `/build.json`，就永远不会重建。这个回调让组合根在**没有
   * 浏览器**的时候也能自愈。
   *
   * 平台只管「什么时候叫」，判据、限频、互斥全部在组合根那一侧（复用启动时那一套，
   * 不是第二套实现）。省略 = 平台不自查（老行为）。
   */
  webBuildCheck?: (trigger: 'probe' | 'timer') => void | Promise<void>;
  /**
   * 自查间隔（ms，缺省 60s）。下限 5s：再密就是在用 `tsc --noEmit` 烧 CPU。
   */
  webBuildCheckMs?: number;
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
  /**
   * 0.58：平台代理 node（`/nodes/:nodeId/**`）。省略 = 关闭（老直连路径照旧）。
   *
   * 打开后浏览器/CLI 只连平台：node 的 HTTP 与 WS 都由平台按**平台会话语义**鉴权后转发，
   * node token 只存在于平台进程内。关掉它 = 保留的显式回退开关
   * （`gateway.proxy_nodes: false`），前端据 `platform.whoami.proxy.enabled` 自动改走直连。
   */
  proxy?: PlatformProxyOptions | undefined;
}

/**
 * 0.58：代理的注入参数（组合根提供真相，平台只做路由/白名单/转发）。
 *
 * 三条硬约束在这里体现为参数形状：
 * - 目标地址只能来自注册表（`nodes`），客户端只提供 `node_id`；
 * - node 凭据只经 `resolveNodeCredential` 读，**不缓存、不落盘、不进响应体**；
 * - 能力开关显式（`enabled`），关掉就是一个干净的老行为。
 */
export interface PlatformProxyOptions {
  /** false = 不提供 `/nodes/*`（保留了的老直连路径）。缺省 true。 */
  enabled?: boolean;
  /** 可选的更严上限；缺省见 `DEFAULT_PLATFORM_PROXY_LIMITS`。 */
  limits?: Partial<import('./proxy-config.js').PlatformProxyLimits>;
}

/** 已启动的平台监听。 */
export interface PlatformGateway {
  /** 实际监听端口（支持传入 0 由系统分配）。 */
  port: number;
  stop(): Promise<void>;
}
