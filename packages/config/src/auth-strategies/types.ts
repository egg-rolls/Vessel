/**
 * 登录策略（strategy）的**固定接口**。
 *
 * 一个登录 provider = 一个策略对象；注册表在 `./registry.js`。
 * 加一个 provider 的代价必须是「加一个策略文件 + 注册一行」，而不是回头改
 * validator 里那份 `kind` 白名单 —— 这就是这些类型存在的唯一理由。
 *
 * 不变量：
 * - 用户 id 一律归一成**字符串**，白名单按字符串精确匹配（大小写敏感性由策略声明）；
 * - 展示名只用于界面，**永不**参与身份判定；
 * - 策略里不读密钥：client_secret 由调用方按「环境变量名」解析后传进来。
 *
 * @module @vessel-agent/config/auth-strategies/types
 */

/** 归一后的身份：`userId` 才是身份，`username` 只用于展示。 */
export interface AuthStrategyIdentity {
  /** 身份（精确匹配用）。 */
  userId: string;
  /** 展示名；永不参与身份判定。 */
  username: string;
  /**
   * 额外的**可比较**身份值（仅当 provider 本身把某个可读标识当作稳定身份时才有）。
   *
   * 例：Gitee 的白名单允许写用户名或数值 id，而展示用的 `login` 恰好就是那个用户名。
   * 明确放在这里，是为了不把「展示名也参与身份判定」当成一条普遍规则 ——
   * GitHub / Microsoft 的 `username` 仍然只是展示。
   */
  aliases?: string[];
  /**
   * 头像引用（0.63）。`undefined` = 这个 provider 没给可用头像。
   *
   * 与 `AuthAvatarRef` 一样是**可落盘**的：公开地址不是秘密，`graph-photo` 只是个标记
   * （token 不在里面）。
   */
  avatar?: AuthAvatarRef;
}

/** 稳定失败码：只用于分支与文案，永不携带密钥。 */
export type AuthStrategyFailure =
  | 'state_invalid'
  | 'code_missing'
  | 'secret_missing'
  | 'token_exchange_failed'
  | 'user_fetch_failed'
  | 'not_allowlisted';

/**
 * 头像引用：**只描述「怎么拿到」**，不携带任何秘密，所以可以安全地落盘。
 *
 * 两种真实形状（0.63）：
 * - `url`：provider 给了公开地址（GitHub / Gitee 的 `avatar_url`）。**浏览器不直连它** ——
 *   平台用自己的 `/auth/avatar` 代取，公开地址只在服务端之间流转（前端因此不必放开
 *   `img-src` 到外域）；
 * - `graph-photo`：没有公开地址，必须服务端带 access token 去 Graph
 *   `GET /me/photo/$value` 取二进制（Microsoft）。用户**没设头像**时 Graph 返回 **404**，
 *   那是常态、不是错误。
 */
export type AuthAvatarRef = { kind: 'url'; url: string } | { kind: 'graph-photo' };

/**
 * OAuth 令牌（只在内存里传递，**永不**进会话文件 / 日志 / 响应体）。
 *
 * 为什么需要它：Microsoft 的头像必须在登录**之后**仍然能代表用户去取一次图片。这是
 * 「token 用完即弃」的**唯一**例外，出口只有一个 —— `HandleCallbackParams.onCredentials`
 * 交给内存级 `AvatarService`，由它按需刷新。
 */
export interface OAuthCredentials {
  accessToken: string;
  /** 刷新用；没有 `offline_access` 时不存在。 */
  refreshToken?: string;
  /** epoch ms；provider 没给就省略（按「不知道过期」处理）。 */
  expiresAt?: number;
  scope?: string;
  /**
   * 换新令牌用的 token 端点（由策略的端点表带出来）。
   *
   * 放在这里而不是往策略接口上再加一个成员：端点本来就只属于「那次登录」的上下文，
   * 而且它在内存里传递，不进任何持久化。
   */
  tokenEndpoint?: string;
}

export type AuthStrategyLoginResult =
  | { ok: true; identity: AuthStrategyIdentity }
  | { ok: false; failure: AuthStrategyFailure };

/** OAuth 端点；可覆盖（验收桩 / 私有部署 / GitHub Enterprise）。 */
export interface AuthStrategyEndpoints {
  authorize: string;
  token: string;
  user: string;
}

/** `authorizeUrl(params)` 的入参（全部由通用流程算好，策略只负责拼 URL）。 */
export interface AuthorizeUrlParams {
  clientId: string;
  /** 来源白名单里选中的那个 origin + 固定回调路径；**永不**由请求头推导。 */
  redirectUri: string;
  /** 一次性 state。 */
  state: string;
  /** PKCE S256 challenge。 */
  codeChallenge: string;
  /** 端点覆盖；省略 = 策略自带的正式端点。 */
  endpoints?: AuthStrategyEndpoints | undefined;
}

/** `handleCallback(params)` 的入参。 */
export interface HandleCallbackParams {
  /** 回调里的 `code`；缺失 / 空串 = 没有授权码。 */
  code: string | null;
  /** 与发起时**同一个** redirect_uri（已由 state 绑定）。 */
  redirectUri: string;
  /** PKCE verifier（与服务端在途流程里存的 challenge 配对）。 */
  codeVerifier: string;
  clientId: string;
  /** client_secret **值**（调用方按 env 名解析后传入；不落盘、不进日志）。 */
  clientSecret: string;
  fetchImpl?: typeof fetch | undefined;
  endpoints?: AuthStrategyEndpoints | undefined;
  timeoutMs?: number | undefined;
  /** 诊断输出；只接收非敏感事实（状态码 / provider 错误码 / user id）。 */
  log?: ((message: string) => void) | undefined;
  /**
   * 令牌逃生口（**全仓唯一一处**，见 `OAuthCredentials` 的注释）。
   *
   * 策略在丢弃 token **之前**调用一次；通用流程把它交给内存级 `AvatarService`
   * （不落盘、不进日志）。GitHub / Gitee 永远不会调用它。
   */
  onCredentials?: ((credentials: OAuthCredentials) => void) | undefined;
}

/**
 * `allow_user_ids` 的语义**按策略走**：每个策略声明自己吃什么样的 id。
 *
 * 校验（validator）与归一（resolver）都用同一份声明，避免「校验说合法、解析时丢掉」。
 */
export interface AllowUserIdsShape {
  /** 形状 id（诊断用，如 `github-numeric-id`）。 */
  shape: string;
  /** 该策略是否**根本不吃** allow_user_ids（口令后端 = false）。 */
  applicable: boolean;
  /** 大小写是否敏感（Microsoft 的对象 id 不敏感）。 */
  caseSensitive: boolean;
  /** 一句话的「期望形状」，直接拼进报错文案。 */
  describe: string;
  /** 至少一个正例，直接拼进报错文案。 */
  examples: readonly string[];
  /** 单条校验：null = 合法；否则返回「为什么不行」。 */
  rejectReason(value: unknown): string | null;
  /** 归一成精确匹配用的字符串；null = 不合法（调用方已先 rejectReason）。 */
  normalize(value: unknown): string | null;
}

/**
 * 一个登录策略。
 *
 * `authorizeUrl` / `handleCallback` 对**口令**后端无意义（口令走 `/auth/login`），
 * 所以口令策略在这两个成员上是「显式拒绝」而不是「假装能用」：
 * `authorizeUrl` 返回 null，`handleCallback` 抛错。调用方据此判断该后端是否有 302 起步态。
 */
export interface AuthStrategy {
  /** 浏览器可见的 provider id（同时是路由段 `/auth/<id>/...` 与会话 subject 前缀）。 */
  readonly id: string;
  /** `auth.backends[].kind` 的取值。 */
  readonly kind: string;
  /** 没配 `label` 时的按钮文案。 */
  readonly label: string;
  /** 白名单语义。 */
  readonly allowUserIdsShape: AllowUserIdsShape;
  /** 拼授权跳转 URL；null = 该策略没有授权跳转（口令）。 */
  authorizeUrl(params: AuthorizeUrlParams): string | null;
  /** 用 code 换身份；口令策略抛错（不可达）。 */
  handleCallback(params: HandleCallbackParams): Promise<AuthStrategyLoginResult>;
  /** 归一 provider 返回的用户对象；没有可用身份返回 null。 */
  identityOf(profile: unknown): AuthStrategyIdentity | null;
  /**
   * 头像引用（0.63）：**只回答「怎么拿到」**，不去取。
   *
   * 返回 `url` 的平台侧会代取并缓存；返回 `graph-photo` 的平台侧会带 access token 去取二进制；
   * `null` = 这个 provider 没给可用头像（前端走兜底首字母）。
   *
   * 与 `identityOf` 分开是刻意的：取头像可能失败（404 / 超时 / 没设头像），但那**不是**
   * 登录失败，绝不能让头像问题把登录带下水。
   */
  avatarOf(profile: unknown): AuthAvatarRef | null;
}

/** 口令后端的 kind：**唯一**需要在策略之外特殊对待的字面量（见 registry）。 */
export const PASSWORD_STRATEGY_KIND = 'password';
