/**
 * 跨节点地址 `<principal>@<node_id>:<team_id>`（DECISION-037 §2）。
 *
 * - 按**最后一个** `@` 切分，再按 `node:team` 的**恰好一个** `:` 切分。
 * - 三段字符集互斥，解析无歧义；`human` 是 principal 的保留值（形状相同，
 *   是否存在由接收侧 / 本地 roster 判定）。
 * - 纯函数，无 I/O；错误消息不回显原文（避免超长 / 控制字符进入 stderr）。
 *
 * @module vessel/federation-address
 */

/** principal：present 成员名或 `human`；1..64 位字母 / 数字 / `_` / `-` */
export const FEDERATION_PRINCIPAL_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** node_id：与 `resolveNodeId()` 的形状一致 */
export const FEDERATION_NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** team_id：与 Team slug 一致 */
export const FEDERATION_TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 三段最长情形；超过此长度直接拒绝，不进入逐段正则。 */
const MAX_RAW_LENGTH = 64 + 1 + 64 + 1 + 64;

/** 稳定错误码：所有非法地址共用（发送侧 CLI 映射为 exit 2）。 */
export const FEDERATION_INVALID_ADDRESS = 'federation_invalid_address' as const;

export interface FederationAddress {
  principal: string;
  node_id: string;
  team_id: string;
}

export interface FederationAddressError {
  code: typeof FEDERATION_INVALID_ADDRESS;
  message: string;
}

export type FederationAddressParseResult =
  | { ok: true; address: FederationAddress }
  | ({ ok: false } & FederationAddressError);

const INVALID_SHAPE = 'federation address must be <principal>@<node_id>:<team_id>';

function invalid(message: string): { ok: false } & FederationAddressError {
  return { ok: false, code: FEDERATION_INVALID_ADDRESS, message };
}

/**
 * 解析地址；任何结构 / 字符集 / 长度问题都返回同一个错误码。
 *
 * 错误 message 是固定文案，不包含输入原文。
 */
export function parseFederationAddress(raw: string): FederationAddressParseResult {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RAW_LENGTH) {
    return invalid(INVALID_SHAPE);
  }

  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return invalid(INVALID_SHAPE);

  const principal = raw.slice(0, at);
  const rest = raw.slice(at + 1);

  const colon = rest.indexOf(':');
  if (colon <= 0 || colon === rest.length - 1 || colon !== rest.lastIndexOf(':')) {
    return invalid(INVALID_SHAPE);
  }

  const nodeId = rest.slice(0, colon);
  const teamId = rest.slice(colon + 1);

  if (!FEDERATION_PRINCIPAL_RE.test(principal)) {
    return invalid('federation address principal must match ^[A-Za-z0-9_-]{1,64}$');
  }
  if (!FEDERATION_NODE_ID_RE.test(nodeId)) {
    return invalid('federation address node_id must match ^[A-Za-z0-9_-]{1,64}$');
  }
  if (!FEDERATION_TEAM_ID_RE.test(teamId)) {
    return invalid('federation address team_id must match ^[a-z0-9][a-z0-9-]{0,63}$');
  }

  return { ok: true, address: { principal, node_id: nodeId, team_id: teamId } };
}

/** 是否是可解析地址；非法输入不抛错。 */
export function isFederationAddress(raw: string): boolean {
  return parseFederationAddress(raw).ok;
}

/** 格式化地址（不做校验；调用方负责保证三段已通过 parser）。 */
export function formatFederationAddress(address: FederationAddress): string {
  return `${address.principal}@${address.node_id}:${address.team_id}`;
}
