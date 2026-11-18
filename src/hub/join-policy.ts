/**
 * join 的「要不要邀请码」判定（0.61，纯函数）。
 *
 * 规则只表达一件事：**接管一个已存在的 node 身份，需要证明你被授权**。
 * 证据只有两种，都写进这里，避免散落在 HTTP handler 里：
 *
 * 1. 一次性邀请码（`vessel hub join-code` 在本机生成）——跨机场景唯一途径；
 * 2. 同机回环 peer + 该 node_id 仍有未吊销未过期的 token —— 单人开发机的自助重连。
 *
 * 反向规则同样重要：token 已全过期 / 全吊销时**不能**无条件放行，否则任何猜到
 * node_id（或从日志里读到）的人都能把记录顶掉；那时必须重新出码。
 *
 * @module vessel/hub/join-policy
 */

import type { HubNodeTokenRecord } from './types.js';

export type JoinRegistrationRefusal = 'code_required' | 'node_exists';

export type JoinRegistrationDecision =
  | { ok: true; rotate: boolean }
  | { ok: false; code: JoinRegistrationRefusal; message: string };

export interface JoinRegistrationFacts {
  /** 请求体里是否带了 `code`。 */
  hasCode: boolean;
  /** registry 里是否已有该 node_id（只用于日志/诊断，不单独决定放行）。 */
  hasRecord?: boolean;
  /** 该 node_id 是否还有「未吊销且未过期」的 token。 */
  hasLiveToken: boolean;
  /** 请求对端是否回环（`srv.requestIP()` 判定；`::ffff:127.x` 已归一）。 */
  loopbackPeer: boolean;
}

/** 该 node 是否还有可用 token（判断「身份已被授权过」）。 */
export function hasLiveNodeToken(
  tokens: readonly HubNodeTokenRecord[],
  nodeId: string,
  now: number,
): boolean {
  return tokens.some(
    (token) =>
      token.node_id === nodeId &&
      token.revoked_at === undefined &&
      Number.isFinite(token.expires_at) &&
      token.expires_at > now,
  );
}

/**
 * 判定本次 join 是否需要 / 允许走无码路径。
 *
 * 注意返回值里的 `rotate` 只表示「这次 join 会替换旧 token」，实际吊销仍由
 * server 在签发后调用 `revokeNode(nodeId, except)` 完成（保留既有语义）。
 */
export function decideJoinRegistration(facts: JoinRegistrationFacts): JoinRegistrationDecision {
  if (facts.hasCode) return { ok: true, rotate: facts.hasLiveToken };

  if (!facts.hasLiveToken) {
    return {
      ok: false,
      code: 'code_required',
      message: 'code is required for a node without a live token',
    };
  }
  if (facts.loopbackPeer) return { ok: true, rotate: true };

  return {
    ok: false,
    code: 'node_exists',
    message:
      'node already has a live token; re-join from another machine requires a fresh join code ' +
      '(vessel hub join-code)',
  };
}
