/**
 * 0.49 G1：Platform Gateway 的独立鉴权链。
 *
 * 与 node 的 `resolveNodeAuth` 不共享 principal：平台 token 只表示“平台入口已认证”，
 * 不映射成任何 node principal。token 不进 URL/query，错误体不回显 token。
 *
 * @module @vessel-agent/serve/platform/auth
 */

import { timingSafeEqual } from 'node:crypto';
import { isLoopbackAddress, proxySecretAllowed } from '../gateway/auth.js';

/** 平台凭据模式：token = 平台 bearer；anonymous = 回环只读。 */
export type PlatformAuthMode = 'token' | 'anonymous';

/** 鉴权结果；`ok:false` 时由调用方回 401。 */
export interface PlatformAuthResult {
  ok: boolean;
  mode: PlatformAuthMode;
  /** 请求来源 socket 是否回环（credentials 端点额外要求）。 */
  loopback: boolean;
  /**
   * 0.55 P0：反代密钥头是否成立。未配置 `proxySecret` 时恒为 `true`。
   * 用来把 401 的文案分成「缺反代密钥」与「缺平台 token」两种可操作提示。
   */
  proxySecretOk: boolean;
  /**
   * 部署是否**配置**了平台 token（与本次请求带没带对无关）。
   *
   * 0.55.1：用来做「迁移安全」——未配置 token 的部署不能因为 0.55 的收紧而把本地 WebUI
   * 直接锁死（升级即掉线）。此时回环仍然放行 `platform.nodes.credentials`，但 doctor 会
   * 报警、日志会提示；**一旦配置了 token，回环不再豁免**。
   */
  tokenConfigured: boolean;
}

export interface ResolvePlatformAuthInput {
  req: Request;
  /** `server.requestIP(req)?.address`；缺失视为非回环（fail-closed）。 */
  address: string | null | undefined;
  /** 未配置 = undefined。 */
  platformToken?: string;
  /**
   * 0.55 P0：反代共享密钥（`gateway.proxy_secret_env` 解析结果）。
   * 未配置 → `loopback` 只看 socket 地址（旧行为）；配置后 → 还必须带密钥头，
   * 否则一律按「非回环」处理（`platform.nodes.credentials` 因此不再被匿名取走）。
   */
  proxySecret?: string;
  /**
   * 0.56：平台 token 是否来自**显式配置**（`gateway.token` / `gateway.token_env`）。
   *
   * 派生值（`root-secret` → `vessel:platform`）不算「配置」：用户什么都没写，
   * 就不能因为他没写而收紧回环 —— 否则一次升级又会把本地 WebUI 锁死
   * （前端拿不到 node token ⇒ 整页掉线，症状只表现为「连不上」）。
   *
   * 缺省 `true`：只有明确传 `false` 才走「未配置」语义（向后兼容）。
   */
  explicitPlatformToken?: boolean;
}

/**
 * 0.55 P0：401 文案必须能直接照做 —— 分清「缺反代密钥」与「缺平台 token」。
 * 错误码仍然是 CONTRACT §7 的 `platform_unauthorized`（Web 端据此弹「需要 token」）。
 */
export function platformUnauthorizedMessage(auth: PlatformAuthResult): string {
  if (!auth.proxySecretOk) {
    return (
      'proxy_secret_missing: 请求没带（或带错）反代密钥头 X-Vessel-Proxy-Secret。' +
      '请让同机反代覆盖注入这个头，值取自 gateway.proxy_secret_env 指向的环境变量；' +
      '反代 snippet: proxy_set_header X-Vessel-Proxy-Secret $vessel_proxy_secret; ' +
      '本机直连请改用 Authorization: Bearer <gateway.token>。'
    );
  }
  return (
    'platform_token_required: 需要 Authorization: Bearer <gateway.token>（浏览器请在连接设置里' +
    '粘贴同一个值；0.56 P2 起 `#token=` 只用于一次性引导码）。令牌来自 gateway.token 或 ' +
    'gateway.token_env 指向的环境变量；' +
    '生成: export VESSEL_PLATFORM_TOKEN=$(openssl rand -hex 32) 然后 gateway.token_env: ' +
    'VESSEL_PLATFORM_TOKEN。'
  );
}

/** 从 Authorization: Bearer 取 token；空串视为未提供。 */
export function bearerToken(req: Request): string | null {
  const authorization = req.headers.get('authorization');
  if (authorization === null || !authorization.startsWith('Bearer ')) return null;
  const value = authorization.slice('Bearer '.length);
  return value === '' ? null : value;
}

/** 定长比较，避免按字节提前返回。 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 0.58：平台 token 是否匹配（供**首帧** token 校验用）。
 *
 * 为什么需要单独一个函数：浏览器 WS 握手带不了 `Authorization` 头，平台代理因此接受
 * 「首帧 `{kind:'auth',token}`」这种形状（与 node 同形）。校验的必须是**平台 token**，
 * 而且比较要定长常量时间 —— 不能让这个入口成为比 HTTP 更松的那一处。
 */
export function platformTokenMatches(provided: string, expected: string): boolean {
  if (expected === '') return false;
  if (provided === '') return false;
  return constantTimeEqual(provided, expected);
}

/**
 * 平台鉴权矩阵（契约 §3.2）：
 * - 配置了 `platformToken`：必须匹配，回环也不例外。
 * - 未配置：仅回环 socket → 匿名只读；非回环 → 拒绝（即使未配置）。
 * - 0.55 P0：配置了 `proxySecret` 时，「回环」还要求请求带反代密钥头。
 */
export function resolvePlatformAuth(input: ResolvePlatformAuthInput): PlatformAuthResult {
  const proxySecretOk = proxySecretAllowed(input.req, input.proxySecret);
  const loopback = isLoopbackAddress(input.address) && proxySecretOk;
  const expected = input.platformToken;
  const explicit = input.explicitPlatformToken ?? true;
  if (typeof expected === 'string' && expected !== '') {
    const provided = bearerToken(input.req);
    const matches = provided !== null && constantTimeEqual(provided, expected);
    if (!explicit) {
      // 派生 token（用户没配任何东西）：**回环匿名保持不变**（迁移安全），
      // 非回环仍然必须带对这个值 —— 凭据存在，但不拿它去收紧本地。
      return {
        ok: matches || loopback,
        mode: matches ? 'token' : 'anonymous',
        loopback,
        proxySecretOk,
        tokenConfigured: false,
      };
    }
    return {
      ok: matches,
      mode: matches ? 'token' : 'anonymous',
      loopback,
      proxySecretOk,
      tokenConfigured: true,
    };
  }
  return { ok: loopback, mode: 'anonymous', loopback, proxySecretOk, tokenConfigured: false };
}
