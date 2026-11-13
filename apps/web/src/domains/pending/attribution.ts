/**
 * 待处理交互（permission / ask）的**归属解析**（0.51）：纯函数，无 React / 无 store。
 *
 * 为什么需要这一层：一条 ask 有三个「身份」字段，语义完全不同 ——
 *
 * | 字段 | 是什么 | 谁写 |
 * |---|---|---|
 * | `sessionId` | 发起请求的那个 **run 所在会话**（成员 bridge 里是成员自己的会话） | 生产侧 |
 * | `parentAgentId` | 父 **agent** id —— **唯一**归属维度 | 成员 bridge |
 * | `parentSessionId` | legacy：只读。0.19 起装的是父 agent id，0.51 起装过真会话 id | 旧事件 / 旧快照 |
 *
 * 两条硬约束（用户裁定，别在这里「优化」掉）：
 *
 * 1. **会话页只渲染「属于当前会话自己 run」的请求** —— 判据是 `sessionId` 等值，
 *    `parent*` 一概不参与（见 `pendingOwnedBySession`）。contractor 的 ask 属于待批页，
 *    不允许在父 agent 的会话页里冒出来；归属字段修正的是「算谁的 / 跳到哪」，
 *    不是「在哪儿渲染」。
 * 2. **父会话不是事实，是算出来的**：生产侧只发父 agent id，父会话由本模块沿 roster
 *    的 `parent_id` 链上溯到那具 primary body（0.28 的不变量让「agent → 它的会话」
 *    是单值的）。历史记录里的 `parentSessionId`（装的是 agent id）作为**兜底输入**：
 *    能靠 roster 认出「这是个 agent id」就照样上溯，认不出才当会话 id 原样用。
 *    不迁移数据，读侧向后兼容即可。
 *
 * 本模块**不 import 任何东西**（纯结构类型）：它同时被会话页、待批页、顶部条与
 * `src/ask-attribution.test.ts` 消费，多一条依赖就多一处跑不起来的可能。
 */

/** 上溯要用的最小 roster 投影（`agents.list` / `teams.get` 的成员条目都长这样）。 */
export interface AttributionAgent {
  /** `agents.list` 用 `agent_id`；个别旧形状用 `id`。 */
  agent_id?: string;
  id?: string;
  /** 父 agent id（历史归属甄别的唯一钥匙）。 */
  parent_id?: string;
  /** 该 agent 的当前 primary body（`body_id ≡ session_id`）。 */
  session_id?: string;
}

/** agent id → 节点。空索引 = 兑底不可用（roster 没加载 / 旧 gateway），退回旧行为。 */
export type AttributionIndex = ReadonlyMap<string, AttributionAgent>;

export const EMPTY_ATTRIBUTION_INDEX: AttributionIndex = new Map();

/**
 * 上溯层数上限：正常只需要一跳（父 agent 自己有 primary body）。留几层是为了
 * 「父 agent 恰好没有 live body（退役中 / rotate 窗口）」这种情况还得再往上找一级。
 * 有上限才有终止保证 —— 脏 roster 里的环不能被当成无限递归。
 */
const MAX_ASCEND_DEPTH = 8;

/** 一批 agent 条目 → 索引；`agent_id` / `id` 都缺的条目直接跳过（不可寻址）。 */
export function attributionIndexOf(entries: Iterable<AttributionAgent>): AttributionIndex {
  const index = new Map<string, AttributionAgent>();
  for (const entry of entries) {
    const id = entry.agent_id ?? entry.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    index.set(id, entry);
  }
  return index;
}

/** 跨节点 roster 的形状（只取 `agents` 与每个 Team 的 `members`；结构类型，不 import NodeRoster）。 */
export interface AttributionRosterSource {
  agents?: readonly AttributionAgent[];
  rosters: readonly { members: readonly AttributionAgent[] }[];
}

/** 所有节点的 roster → 一个扁平索引（多节点同 id 时先到先得：当前节点在首位）。 */
export function rosterAttributionIndex(
  rosters: readonly AttributionRosterSource[],
): AttributionIndex {
  const entries: AttributionAgent[] = [];
  for (const roster of rosters) {
    for (const agent of roster.agents ?? []) entries.push(agent);
    for (const entry of roster.rosters) {
      for (const member of entry.members) entries.push(member);
    }
  }
  return attributionIndexOf(entries);
}

/**
 * 从一个 agent id 沿 `parent_id` 链上溯，取第一个有会话的祖先的 primary body。
 *
 * 为什么不直接 `index.get(id).session_id`：父 agent 可能正在 rotate / 已退役，
 * 它的条目暂时没有 `session_id`；再上一级（grandparent）仍然是「这次提问该归到谁」的
 * 可接受答案。环与超深链一律返回 undefined（宁可不归，不归错）。
 */
export function ascendToSession(
  agentId: string | undefined,
  index: AttributionIndex,
): string | undefined {
  if (agentId === undefined || agentId.length === 0 || index.size === 0) return undefined;
  const seen = new Set<string>();
  let current: string | undefined = agentId;
  for (let depth = 0; depth < MAX_ASCEND_DEPTH; depth += 1) {
    if (current === undefined) return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);
    const node = index.get(current);
    if (node === undefined) return undefined;
    const sessionId = node.session_id;
    if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId;
    current = node.parent_id;
  }
  return undefined;
}

/** 归属解析的输入（permission / ask 都满足）。 */
export interface AttributedInteraction {
  sessionId?: string;
  parentSessionId?: string;
  parentAgentId?: string;
  agentId?: string;
  teamId?: string;
}

/**
 * 父**会话** id（展示 / 跳转 / 分组用），带历史脏数据兑底。
 *
 * 顺序：
 * 1. `parentAgentId`（新字段）→ 上溯；
 * 2. `parentSessionId` 在 roster 里能查到同名 agent ⇒ 旧脏数据（是 agent id）→ 上溯；
 * 3. `parentSessionId` 不是任何 agent ⇒ 它本来就是会话 id，原样返回；
 * 4. 都没有 ⇒ undefined（**不拿 `sessionId` 兜底**：那是成员自己的会话，冒充父会话
 *    会让待批页把「归属」写成成员自己）。
 *
 * 索引为空时只剩第 3 条（旧行为）：能认出来就认，认不出不猜。
 */
export function resolveParentSession(
  item: AttributedInteraction,
  index: AttributionIndex = EMPTY_ATTRIBUTION_INDEX,
): string | undefined {
  if (item.parentAgentId !== undefined && item.parentAgentId.length > 0) {
    const resolved = ascendToSession(item.parentAgentId, index);
    if (resolved !== undefined) return resolved;
  }
  const parentSessionId = item.parentSessionId;
  if (parentSessionId === undefined || parentSessionId.length === 0) return undefined;
  // roster 里有同名 agent ⇒ 这条是 0.19 起的脏数据（agent id 被当成会话 id）。
  if (index.has(parentSessionId)) return ascendToSession(parentSessionId, index);
  return parentSessionId;
}

/**
 * 这条请求「归到哪」——只用于展示 / 跳转，不决定在哪儿渲染。
 *
 * - `agent`：**带父级归属**的请求（子成员 bridge 过来的）。它们的应答入口是待批页，
 *   所以顶部条跳待批页；
 * - `session`：其余请求（包括 `main` 自己的 ask）跳它自己的会话页 —— 会话页的守卫
 *   认的就是这个 `sessionId`，跳过去卡片就在那儿；
 * - `unknown`：既没有会话也没有归属（老流），不给跳转、不猜。
 *
 * 判据刻意只看**父级**字段（`parentSessionId` / `parentAgentId`），不看 `agentId` /
 * `teamId`：`main` 自己的 ask 也带 `agent_id` + `team_id`（它本身就是 Team 成员），
 * 按「带 agent_id 就算成员 bridge」分类会把最常见的那个场景也踢到待批页去。
 */
export type PendingHome =
  | { kind: 'session'; sessionId: string }
  | { kind: 'agent'; agentId?: string; sessionId?: string }
  | { kind: 'unknown' };

export function pendingHome(
  item: AttributedInteraction,
  index: AttributionIndex = EMPTY_ATTRIBUTION_INDEX,
): PendingHome {
  const parentSessionId = resolveParentSession(item, index);
  const hasParent =
    (item.parentSessionId !== undefined && item.parentSessionId.length > 0) ||
    (item.parentAgentId !== undefined && item.parentAgentId.length > 0);
  if (hasParent) {
    const agentId =
      item.agentId !== undefined && item.agentId.length > 0 ? item.agentId : item.parentAgentId;
    return {
      kind: 'agent',
      ...(agentId !== undefined && agentId.length > 0 ? { agentId } : {}),
      ...(parentSessionId !== undefined ? { sessionId: parentSessionId } : {}),
    };
  }
  if (item.sessionId !== undefined && item.sessionId.length > 0) {
    return { kind: 'session', sessionId: item.sessionId };
  }
  return { kind: 'unknown' };
}

/**
 * 归属会话（`pendingHome` 的扁平视图）：成员 bridge 取**父**会话，普通请求取自己的会话。
 *
 * 待批页的「本会话有 N 条待批」入口与会话聚焦都用它：父会话能定位到这一簇，
 * 而会话页的渲染守卫与它无关（那是 `pendingOwnedBySession`）。
 */
export function attributedSessionId(
  item: AttributedInteraction,
  index: AttributionIndex = EMPTY_ATTRIBUTION_INDEX,
): string | undefined {
  const home = pendingHome(item, index);
  if (home.kind === 'session') return home.sessionId;
  if (home.kind === 'agent') return home.sessionId;
  return undefined;
}

/**
 * 会话页渲染守卫（唯一判据）：这条请求是不是**属于这个会话自己的 run**。
 *
 * 成员 bridge 的请求即使 `parentSessionId` 正好等于当前会话，也**不算** —— 用户裁定
 * 「contractor 的 ask 不需要在父亲的会话页面渲染，我们有待批页面」。所以这里刻意
 * 不看 `parentSessionId` / `parentAgentId`：谁想在这里加回父级归属，就是在把卡片
 * 塞回父会话。
 *
 * `sessionId` 缺失（旧流 / 旧事件）时才退化为「run 属于当前会话」。
 */
export function pendingOwnedBySession(
  item: { sessionId?: string; runId: string },
  sessionId: string | null,
  sessionRunIds: ReadonlySet<string>,
): boolean {
  if (sessionId === null) return false;
  if (item.sessionId !== undefined && item.sessionId.length > 0) {
    return item.sessionId === sessionId;
  }
  return sessionRunIds.has(item.runId);
}
