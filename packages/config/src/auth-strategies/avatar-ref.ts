/**
 * 「公开头像地址」的归一（GitHub / Gitee 的 `avatar_url`）。
 *
 * 三条约束，都是为了让 `/auth/avatar` 的代取是安全的：
 * 1. 只接受 **http(s)**：`data:` / `javascript:` / `file:` 一律丢弃 —— 它们进了 `<img src>`
 *    就是一条注入面；
 * 2. 只接受**绝对**地址（provider 有时给相对路径，那对我们没有意义）；
 * 3. 丢掉 `#fragment` 与空串。
 *
 * 这里**不**判断「是不是内网地址」：那是 `/auth/avatar` 代取时的 SSRF 闸（`isPublicHttpUrl`），
 * 因为只有在真的要发请求时才需要那一层。
 *
 * @module @vessel-agent/config/auth-strategies/avatar-ref
 */

import type { AuthAvatarRef } from './types.js';

/** 单条字段 → `{kind:'url'}`；不合格返回 null。 */
export function publicAvatarRef(value: unknown): AuthAvatarRef | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '') return null;
  // fragment 对图片没有意义，去掉更利于缓存键稳定。
  url.hash = '';
  return { kind: 'url', url: url.toString() };
}

/** 从 provider 的用户对象里取某个公开头像字段。 */
export function avatarRefFrom(profile: unknown, field: string): AuthAvatarRef | null {
  if (typeof profile !== 'object' || profile === null) return null;
  return publicAvatarRef((profile as Record<string, unknown>)[field]);
}
