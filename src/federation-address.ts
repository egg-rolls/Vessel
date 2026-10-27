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

// ── 本机简化地址（0.27）──────────────────────────────

/**
 * 本机简化地址的两种形态：`human`（无 team）与 `human@<team_id>`。
 *
 * node 段是**跨节点才需要**的信息。本机内部投递时它是噪音，而且是「同一个概念
 * 在两处用了不同值」的根源：展示层只有 hostname，寻址层要的是 node.json 的 UUID。
 * 省略它，两处就不需要对齐。
 *
 * 只认 `human`：成员之间的本机投递走 id / name 解析，从来不需要地址形式。
 */
export const LOCAL_HUMAN_PRINCIPAL = 'human' as const;

/** 本机地址解析结果：canonical 是「无 node 段」形式。 */
export type LocalAddressResolution =
  /** 本机人类；`team_id` 缺失表示调用方要用自己的 Team。 */
  | { kind: 'local_human'; team_id?: string }
  /**
   * 本机成员（三段地址但 node 段指向本机）；node 段已归一化为 canonical nodeId。
   * `team_id` 必定存在（三段形式要求）。
   */
  | { kind: 'local_member'; principal: string; node_id: string; team_id: string }
  /** 跨节点（或未知节点）：必须用全形，透传给 federation。 */
  | { kind: 'remote'; address: FederationAddress }
  | {
      kind: 'invalid';
      code: string;
      message: string;
    };

export interface ResolveNodeAliases {
  /** 本机 canonical node_id */
  nodeId: string;
  /** 本机展示名（hostname 派生 / 配置 / node.json）；未配置时缺省 */
  name?: string;
}

/**
 * 解析一个 `send` 目标地址，判断它指向哪里。
 *
 * **这是「是不是本机」的唯一判断点**：调用方不得自己比对 node 段字符串。
 * `nodeId` 与 `name` 都只代表本机 —— `name` 不是一台节点的全局唯一标识，不能用来
 * 指向别人；指向远端必须用对端的 `node_id`。
 *
 * 三种输入：
 * - `human` / `human@<team>` → 本机人类（无 node 段，canonical 形态）；
 * - `<principal>@<node>:<team>`（三段）→ node 段命中本机别名则归一化为本机，
 *   否则按远端透传；
 * - 其它（含 `human@<team>` 形状歧义、缺段、非法字符）→ invalid。
 *
 * 纯函数，无 I/O。
 */
export function resolveAddress(raw: string, local: ResolveNodeAliases): LocalAddressResolution {
  if (typeof raw !== 'string' || raw === '') {
    return { kind: 'invalid', code: FEDERATION_INVALID_ADDRESS, message: INVALID_SHAPE };
  }

  // 1. 无 `@`：只接受本机人类 principal。
  if (!raw.includes('@')) {
    if (raw !== LOCAL_HUMAN_PRINCIPAL) {
      return {
        kind: 'invalid',
        code: FEDERATION_INVALID_ADDRESS,
        message: `only "${LOCAL_HUMAN_PRINCIPAL}" may omit the node segment`,
      };
    }
    return { kind: 'local_human' };
  }

  // 2. `human@<team>`：两段、无 `:`，是带 Team 的本机人类。
  const at = raw.lastIndexOf('@');
  if (at > 0 && at < raw.length - 1) {
    const principal = raw.slice(0, at);
    const rest = raw.slice(at + 1);
    if (!rest.includes(':')) {
      if (principal !== LOCAL_HUMAN_PRINCIPAL) {
        return {
          kind: 'invalid',
          code: FEDERATION_INVALID_ADDRESS,
          message: `only "${LOCAL_HUMAN_PRINCIPAL}" may omit the node segment`,
        };
      }
      if (!FEDERATION_TEAM_ID_RE.test(rest)) {
        return {
          kind: 'invalid',
          code: FEDERATION_INVALID_ADDRESS,
          message: `local address team must match ${FEDERATION_TEAM_ID_RE}`,
        };
      }
      return { kind: 'local_human', team_id: rest };
    }
  }

  // 3. 全形三段：解析后看 node 段是否指向本机。
  const parsed = parseFederationAddress(raw);
  if (!parsed.ok) {
    return { kind: 'invalid', code: parsed.code, message: parsed.message };
  }
  const address = parsed.address;
  if (isLocalNodeSegment(address.node_id, local)) {
    // 归一化：canonical 是「无 node 段」形式，下游只看到一种写法。node 段归一到
    // 本机之后对路由不再有意义 —— 无论是 `human@<本机>:<team>` 还是简化形态，
    // 都是同一件「发给本机人类」的事。
    if (address.principal === LOCAL_HUMAN_PRINCIPAL) {
      return { kind: 'local_human', team_id: address.team_id };
    }
    return {
      kind: 'local_member',
      principal: address.principal,
      node_id: local.nodeId,
      team_id: address.team_id,
    };
  }
  return { kind: 'remote', address };
}

/**
 * node 段是否指向本机。
 *
 * 大小写不敏感：`name` 常来自 hostname（Windows 全大写）或用户配置（混合大小写），
 * 两者不同源。`nodeId` 也一并比较，因为它才是 canonical 值。
 */
export function isLocalNodeSegment(segment: string, local: ResolveNodeAliases): boolean {
  const needle = segment.toLowerCase();
  if (local.nodeId.toLowerCase() === needle) return true;
  if (local.name !== undefined && local.name !== '' && local.name.toLowerCase() === needle) {
    return true;
  }
  return false;
}
