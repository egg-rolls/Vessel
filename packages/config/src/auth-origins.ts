/**
 * `auth.public_origin(s)` 的来源解析 —— **config 层的权威实现**。
 *
 * 为什么单独一个文件：这份语义有两个消费者。
 * 1. 校验器（报错文案要能说清「错哪个字」）；
 * 2. 解析器（`resolveAuthSettings` 要把非法条目**记下来**，不许静默丢掉 ——
 *    「配了却被静默丢弃 ⇒ 白名单为空 ⇒ 谁都登录不了」是本项目已经踩过的坑）。
 *
 * 与 `packages/serve/src/gateway/auth.ts` 的 `parseOriginPattern` 同一口径
 * （http(s) / 无凭据 / 无 path·query·fragment / 小写归一）。
 * **方向约束**：serve 依赖 config，所以规范实现只能在这一侧；serve 侧若要复用，
 * 应从 `@vessel-agent/config` 导入（而不是反过来）。
 *
 * 0.61 语义定死：**端口通配（`http://127.0.0.1:*`）在这里一律拒绝**。
 * `auth.public_origins` 是 OAuth `redirect_uri` 的唯一来源，`redirect_uri` 必须具体；
 * 通配只对**访问控制**有意义（`http.allowed_origins`），两者不是一回事。
 *
 * @module @vessel-agent/config/auth-origins
 */

/** 端口通配后缀（与 serve 侧 `PORT_WILDCARD_SUFFIX` 一致）。 */
const PORT_WILDCARD_SUFFIX = ':*';

/** 只接受 http(s)、无凭据、无 path/query/hash 的绝对 URL。 */
function parseOriginUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url;
}

/**
 * 单条来源被拒的原因；`null` = 合法。
 *
 * 文案面向「手写 YAML 的部署者」：说清错在哪、该写成什么。
 */
export function authOriginRejectReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'must be a string';
  const trimmed = raw.trim();
  if (trimmed === '') return 'must not be empty';
  const wildcard = trimmed.endsWith(PORT_WILDCARD_SUFFIX);
  const base = wildcard ? trimmed.slice(0, -PORT_WILDCARD_SUFFIX.length) : trimmed;
  const url = parseOriginUrl(base);
  if (url === null) {
    // 常见错法各给一句：URL 解析失败的兜底文案最容易看不出问题。
    let parsed: URL | null = null;
    try {
      parsed = new URL(base);
    } catch {
      parsed = null;
    }
    if (parsed === null) return 'must be an absolute origin like https://egg-rolls.top';
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'only http(s) origins are allowed';
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return 'credentials are not allowed in an origin';
    }
    return 'must be a bare origin: no path, query or fragment (write https://host:port)';
  }
  if (wildcard) {
    return (
      'a port wildcard ("host:*") is not allowed here: auth.public_origins is the only source ' +
      'of the OAuth redirect_uri, so every entry must be one concrete origin. ' +
      'Port wildcards belong to http.allowed_origins.'
    );
  }
  return null;
}

/**
 * 归一成规范字符串（小写 host、去默认端口、去尾斜杠）；非法 ⇒ `null`。
 *
 * `new URL().origin` 本身就是「scheme://host[:port]」这一句的规范形式。
 */
export function parseAuthOrigin(raw: unknown): string | null {
  if (authOriginRejectReason(raw) !== null) return null;
  return parseOriginUrl((raw as string).trim())?.origin ?? null;
}
