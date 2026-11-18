/**
 * 头像的候选图源（纯函数）。
 *
 * 优先级：`identity.avatarUrl`（契约里的可选字段）→ `GET /auth/avatar` → 首字母。
 * 这个模块只负责**排好序 + 过滤掉不该发出去的 URL**；谁失败、失败后落到哪一层由
 * 组件按顺序试（每一层失败都静默跳到下一层，最终一定是首字母）。
 *
 * 为什么不用 fetch + blob：`<img>` 就是浏览器现成的取图通道（缓存、解码、并发都由它管），
 * `onError` 足以覆盖 404 / 网络错 / 不是图片三种失败，不需要再加一层网络封装。
 *
 * @module web/domains/auth/avatar-source
 */

/** 同源头像端点：未登录或没设头像时返回 **404**（不是 401），所以失败是常态。 */
export const AVATAR_ENDPOINT = '/auth/avatar';

/**
 * 只放行能安全塞进 `<img src>` 的地址：
 * - `http:` / `https:` 绝对地址（GitHub 之类的第三方 CDN 是正常的）；
 * - 站点内绝对路径（`/auth/avatar`、`/uploads/…`）与相对路径；
 * - 其它 scheme（`javascript:` / `data:` / `blob:`）与协议相对地址（`//host/x`）一律丢掉。
 *
 * 丢掉不等于报错：它只是不进候选列表，头像继续往下落到下一层。
 */
export function safeAvatarUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  if (value.startsWith('//')) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (scheme === null) return value;
  const name = (scheme[1] ?? '').toLowerCase();
  return name === 'http' || name === 'https' ? value : null;
}

/**
 * 有序候选列表（已去重、已过滤）。
 *
 * `endpoint` 由调用方按登录态给：未登录时问 `/auth/avatar` 必定 404，没必要发这一枪。
 */
export function avatarCandidates({
  avatarUrl,
  endpoint,
}: {
  avatarUrl: string | null | undefined;
  endpoint: boolean;
}): string[] {
  const candidates: string[] = [];
  const direct = safeAvatarUrl(avatarUrl);
  if (direct !== null) candidates.push(direct);
  if (endpoint && !candidates.includes(AVATAR_ENDPOINT)) candidates.push(AVATAR_ENDPOINT);
  return candidates;
}
