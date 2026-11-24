/**
 * 地址解析：`<agent>`、`<agent>@<team>`、`<agent>@<node_id>:<team_id>`（DECISION-037 §2）。
 *
 * - **段数定义语义**，不看「有没有 `@`」：1 段 = 本机 agent，2 段 = 本机 Team 内的
 *   agent（node 恒为本机），3 段 = 跨节点（走 federation）。段数判定见
 *   `addressSegmentCount()`。
 * - 三段形态按**最后一个** `@` 切分，再按 `node:team` 的**恰好一个** `:` 切分；
 *   三段字符集互斥，解析无歧义。
 * - **node 段没有默认值**：裸 `<agent>` 与 `<agent>@<team>` 都只在本机，跨节点必须写
 *   `<agent>@<node>:<team>`。`human` 是 principal 的保留值（形状相同，是否存在由
 *   接收侧 / 本地 roster 判定）。
 * - 纯函数，无 I/O；错误消息不回显原文（避免超长 / 控制字符进入 stderr）。
 *
 * @module vessel/federation-address
 */

import {
  type AddressSegmentCount,
  addressSegmentCount,
  HUMAN_PRINCIPAL,
  MAX_ADDRESS_LENGTH,
} from '@vessel-agent/agent';

/** principal：present 成员名或 `human`；1..64 位字母 / 数字 / `_` / `-` */
export const FEDERATION_PRINCIPAL_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** node_id：与 `resolveNodeId()` 的形状一致 */
export const FEDERATION_NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** team_id：与 Team slug 一致 */
export const FEDERATION_TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * 三段最长情形；超过此长度直接拒绝，不进入逐段正则。
 *
 * 与 `packages/agent` 的 `MAX_ADDRESS_LENGTH` 同一个值 —— 段数判定在两处共用，
 * 长度上限也必须一致，否则会出现「能数出段数却解析失败」的裂缝。
 */
const MAX_RAW_LENGTH = MAX_ADDRESS_LENGTH;

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

// ── 本机地址（0.27）──────────────────────────────────

/**
 * 人类 principal 的保留值。**值由 `@vessel-agent/agent` 的 `HUMAN_PRINCIPAL` 定义**
 * —— 那是保留名词典的唯一归属地，这里 re-export 只为保留本模块的既有调用方。
 *
 * 本机形态有三种写法都合法：`human`（无 team，退回发送者自己的 Team）、
 * `human@<team_id>`、`human@<node>:<team_id>`（node 段命中本机）。
 */
export const LOCAL_HUMAN_PRINCIPAL = HUMAN_PRINCIPAL;

/** 地址解析结果：`local_*` 都不需要出网，`remote` 才走 federation。 */
export type LocalAddressResolution =
  /** 本机人类；`team_id` 缺失表示调用方要用自己的 Team。 */
  | { kind: 'local_human'; team_id?: string }
  /**
   * 裸 agent（1 段，非 `human`）：按 name / id 在本机解析，**不是**可投递地址。
   * 是否需要继续查其它 Team / 可访问节点由调用方的查找阶梯决定（纯函数做不到）。
   */
  | { kind: 'local_agent'; principal: string }
  /**
   * 本机成员（2 段，或 3 段且 node 段指向本机）。
   * 三段时 node 段已归一化为 canonical nodeId；两段恒为本机。
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
 * 按段数分派（`addressSegmentCount`）：
 * - 1 段：`human` → 本机人类；其它 → `local_agent`（裸 name / id，仍需本地查找）；
 * - 2 段 `p@team`：node 恒为本机。`human` → 本机人类，其它 → 本机成员；
 * - 3 段 `p@node:team`：node 段命中本机别名（id 或 name，大小写不敏感）→ 本机
 *   （`human` → 本机人类，其它 → 本机成员）；否则 `remote` 透传给 federation。
 *
 * **node 段没有默认值**：跨节点必须显式写 3 段形态；2 段永远只在本机。
 *
 * 纯函数，无 I/O。
 */
export function resolveAddress(raw: string, local: ResolveNodeAliases): LocalAddressResolution {
  const segments: AddressSegmentCount | undefined = addressSegmentCount(raw);
  if (segments === undefined) {
    return { kind: 'invalid', code: FEDERATION_INVALID_ADDRESS, message: INVALID_SHAPE };
  }

  // 1 段：`human` 是本机人类；其它是裸 agent，交回调用方做本机查找。
  if (segments === 1) {
    if (raw === LOCAL_HUMAN_PRINCIPAL) return { kind: 'local_human' };
    if (!FEDERATION_PRINCIPAL_RE.test(raw)) {
      return {
        kind: 'invalid',
        code: FEDERATION_INVALID_ADDRESS,
        message: `agent name must match ${FEDERATION_PRINCIPAL_RE}`,
      };
    }
    return { kind: 'local_agent', principal: raw };
  }

  // 2 段：node 恒为本机。
  if (segments === 2) {
    const at = raw.indexOf('@');
    const principal = raw.slice(0, at);
    const teamId = raw.slice(at + 1);
    if (!FEDERATION_TEAM_ID_RE.test(teamId)) {
      return {
        kind: 'invalid',
        code: FEDERATION_INVALID_ADDRESS,
        message: `local address team must match ${FEDERATION_TEAM_ID_RE}`,
      };
    }
    if (!FEDERATION_PRINCIPAL_RE.test(principal)) {
      return {
        kind: 'invalid',
        code: FEDERATION_INVALID_ADDRESS,
        message: `agent name must match ${FEDERATION_PRINCIPAL_RE}`,
      };
    }
    if (principal === LOCAL_HUMAN_PRINCIPAL) return { kind: 'local_human', team_id: teamId };
    return { kind: 'local_member', principal, node_id: local.nodeId, team_id: teamId };
  }

  // 3 段：解析后看 node 段是否指向本机。
  const parsed = parseFederationAddress(raw);
  if (!parsed.ok) {
    return { kind: 'invalid', code: parsed.code, message: parsed.message };
  }
  const address = parsed.address;
  if (isLocalNodeSegment(address.node_id, local)) {
    // 归一化：node 段归一到本机之后对路由不再有意义 —— 无论是 `human@<本机>:<team>`
    // 还是两段形态，都是同一件「发给本机」的事。
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
 *
 * **只认本机的 id 与展示名**，对端没有名字可用 —— 这是刻意的，不是遗漏：
 * - `federation.peers[]` 只有人写的 `nodeId` / `teamId` / `url` / `tokenEnv`，
 *   **没有 `name` 字段**；加字段是新增实体，且解决不了根本问题 —— 对端名字应当由
 *   配对流程登记（hub 侧已在存对端自报的 name，两个平面还没打通），不是人手抄。
 * - 一旦这里比较**对端**的名字，「name 命中就算本机」会把发往对端的地址误判成本机
 *   并就地投递 —— 这是本模块最危险的失效模式。何况 node 展示名本来就不是全局唯一
 *   （两台机器可以同名），它没有资格单独作为寻址依据。
 *
 * 因此跨节点必须写 `node_id`。名字只在本机有意义。
 *
 * 已知限制：展示名每次启动现算（`config.host.nodeName` > `node.json` > hostname），
 * 而 `node.json` **不存 name**，所以历史来源行里的旧名字匹配不上。这时行为是
 * 明确报错（远端分支 → `federation_unknown_node`），不是错误投递。修法是让名字
 * 稳定（`node.json` 落 name，或配对登记），属独立立项，不在这里兜底。
 */
export function isLocalNodeSegment(segment: string, local: ResolveNodeAliases): boolean {
  const needle = segment.toLowerCase();
  if (local.nodeId.toLowerCase() === needle) return true;
  if (local.name !== undefined && local.name !== '' && local.name.toLowerCase() === needle) {
    return true;
  }
  return false;
}
