/**
 * 0.60：`auth.public_origins` —— 并列的公网来源白名单 + 来源选择。
 *
 * 为什么需要它：同一个部署要同时接受「线上域名」和「回环直连」两种访问方式
 * （本机调试、GitHub OAuth 回调固定、反代验收），而 `redirect_uri` 只能有一个值。
 * 单个 `auth.public_origin` 表达不了这件事，所以白名单并列、**按请求选一个**。
 *
 * 三条红线（任何便利都不能放宽，改动必须逐条对照）：
 *
 * 1. **不按 `Host` 头选来源**。选择只用「受信边缘」事实（`resolveRequestEdge`）：
 *    只有 socket 属受信代理（回环或列在 `auth.trusted_proxies`）且反代密钥成立时，
 *    `X-Forwarded-Host` / `X-Forwarded-Proto` 才被采信；不受信时就是请求自身。
 *    伪造 `Host` / `X-Forwarded-*` 拿不到白名单里的公网身份。
 * 2. **选择结果必须来自白名单**。本模块只会原样返回白名单里的某个字符串，
 *    永不拼接、永不归一化出白名单之外的值 —— 因此 `redirect_uri` 只能是
 *    「白名单来源 + 固定路径」。
 * 3. **state 绑定本次来源**。发起时选中的来源写进在途流程（`OAuthFlowStore`），
 *    回调时用**同一套**受信边缘判定再选一次，两者必须相同且都在白名单内，
 *    否则直接拒绝（防开放重定向的关键一格）。
 *
 * 选择规则（{@link selectPublicOrigin}，纯函数、可单独推理）：
 * - 白名单为空 ⇒ `null`（不启用公网来源，旧行为）；
 * - 只有 1 个来源 ⇒ 就是它（**与今天逐字相同**：redirect_uri 只由配置决定）；
 * - 多个来源 ⇒ 取「生效 Host 与白名单来源 Host 相同」的那一个（Host 相同而
 *   scheme 不同时按生效协议挑）；Host 对不上 ⇒ 只有在**本机直连**
 *   （`edge.localDirect`：回环 socket ∧ 未经受信代理 ∧ Host 指回环）时才退回
 *   白名单里的回环来源，否则 `null`（fail-closed，绝不给白名单外的值）。
 *
 * @module @vessel-agent/serve/auth/origins
 */

import { isLoopbackHostname, type RequestEdge } from '../gateway/auth.js';

/** 选择来源只需要这三点边缘事实；单独成型便于调用方只传它需要的东西。 */
export type OriginEdge = Pick<RequestEdge, 'host' | 'protocol' | 'localDirect'>;

/** 解析后的单个来源：`protocol` 带冒号（与 `URL#protocol` 一致）。 */
interface OriginParts {
  protocol: 'http:' | 'https:';
  host: string;
  hostname: string;
}

function originParts(origin: string): OriginParts | null {
  if (typeof origin !== 'string' || origin.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(origin.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return {
    protocol: url.protocol,
    host: url.host.toLowerCase(),
    hostname: url.hostname.toLowerCase(),
  };
}

/**
 * 宽松归一：非法 / 空 ⇒ `null`（调用方丢弃该条）。
 *
 * 只接受完整 origin（`scheme://host[:port]`，无路径 / 查询 / 凭据），与启动期
 * 的严格校验同口径 —— 能进白名单的字符串，`buildRedirectUri` 拼出来就是它自己 + 固定路径。
 */
export function normalizeOriginOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

/**
 * 合并 + 去重（顺序稳定：`publicOrigin` 在前，`publicOrigins` 依配置顺序跟上）。
 *
 * 两条配置同时出现**不是错误**：`publicOrigin` 的语义就是「只有一个元素的
 * `publicOrigins`」，合并只是把这句话写实。非法条目在这里被静默丢弃 ——
 * 启动期校验（config validator / platform 的 fail-fast）已经在更前面报过错了。
 */
export function mergePublicOrigins(
  publicOrigins: readonly unknown[] | undefined,
  publicOrigin?: unknown,
): string[] {
  const merged: string[] = [];
  const push = (raw: unknown): void => {
    const origin = normalizeOriginOrNull(raw);
    if (origin === null) return;
    if (merged.includes(origin)) return;
    merged.push(origin);
  };
  push(publicOrigin);
  for (const entry of publicOrigins ?? []) push(entry);
  return merged;
}

/** 生效 Host 归一（`egg-rolls.top:443` 与 `egg-rolls.top` 视为同一个 Host）。 */
function canonicalHost(protocol: 'http' | 'https', host: string | null): string | null {
  if (host === null || host === '') return null;
  try {
    return new URL(`${protocol}://${host}`).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 选出本次请求使用的公网来源；选不出来 ⇒ `null`（调用方必须拒绝建 `redirect_uri`）。
 *
 * 参数只有两样：受信边缘事实（`resolveRequestEdge` 的结果）与白名单。
 * **没有** `Request`、没有 `Host` 头 —— 这条签名本身就是第一道防线。
 */
export function selectPublicOrigin(edge: OriginEdge, whitelist: readonly string[]): string | null {
  const list = whitelist
    .map((entry) => normalizeOriginOrNull(entry))
    .filter((entry): entry is string => entry !== null);
  if (list.length === 0) return null;
  // 单来源：redirect_uri 只由配置决定，不看请求（与 0.56 逐字一致）。
  if (list.length === 1) {
    const only = list[0];
    return only === undefined ? null : only;
  }

  const host = canonicalHost(edge.protocol, edge.host);
  if (host !== null) {
    const sameHost = list.filter((entry) => originParts(entry)?.host === host);
    if (sameHost.length === 1) {
      const match = sameHost[0];
      return match === undefined ? null : match;
    }
    if (sameHost.length > 1) {
      // 同一个 Host 配了 http 与 https 两条：按生效协议挑，挑不出就拒绝（歧义 ⇒ fail-closed）。
      const wanted = `${edge.protocol}:`;
      const match = sameHost.find((entry) => originParts(entry)?.protocol === wanted);
      return match ?? null;
    }
  }

  // 本机直连才允许退回白名单里的回环来源：浏览器就在这台机器上，
  // 用 `localhost` / `[::1]` 访问而白名单只写了 `127.0.0.1` 时不必报 500。
  // 退回的仍然是**白名单里的原值**，不是请求里的任何字符串。
  if (edge.localDirect) {
    const loopback = list.find((entry) => {
      const parts = originParts(entry);
      return parts !== null && isLoopbackHostname(parts.hostname);
    });
    return loopback ?? null;
  }
  return null;
}
