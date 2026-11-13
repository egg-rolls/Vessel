/**
 * 「等待被移除」的对象：已归档 Team（`archived_at` 非空）与已停用 agent
 * （引擎 `state === 'closed'`），默认从列表里隐藏（0.51，用户裁决）。
 *
 * 为什么默认隐藏：这两类都是 prune 还没清掉的残留物，留在默认视图里只会拉长
 * 扫描路径。但**隐藏不是删除，也不是不可达**：detail 层不经这里的过滤，直接 URL /
 * 收藏链接照样打开（打开时给一条待移除提示）；`ui.showArchived` 打开后它们回到
 * 列表并带「已归档 / 已停用 · 待移除」标记。
 *
 * 本文件只放纯函数与无可选依赖的类型：门禁探针
 * `scripts/check-archived-visibility.ts` 直接 import 它，不能牵进 React /
 * configStore（分工同 `state/visibility.ts` 与 `state/runtime-visibility.ts`）。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `ui.showArchived`（YAML `show_archived`）：缺失 / 非法一律 false = 隐藏。
 *
 * 兼容 `{config:{ui}}`、已解包的 config 对象与 snake_case，与
 * `state/visibility.ts` 的读取口径一致（同一个 config.get 快照喂两者）。
 */
export function resolveShowArchived(source: unknown): boolean {
  if (!isRecord(source)) return false;
  const config = isRecord(source.config) ? source.config : source;
  const ui = isRecord(config.ui) ? config.ui : undefined;
  const value = ui?.showArchived ?? ui?.show_archived;
  return value === true;
}

/**
 * 已归档 Team。只看 `archived_at` 是否存在：`0` 也是归档时间戳，
 * 不能用 `!== 0` / 真值判断（会漏掉「归档于 epoch 0」这种脏数据）。
 */
export function isArchivedTeam(team: { archived_at?: number } | undefined | null): boolean {
  return team !== undefined && team !== null && team.archived_at !== undefined;
}

/**
 * 已停用 agent：`state` 归一化后等于 `closed`。
 *
 * 与 `domains/team/member-status.ts` 同一口径（trim + 小写），保证「列表按它隐藏」
 * 与「chip 显示它停用」不会各说一套。
 */
export function isClosedAgent(member: { state?: string } | undefined | null): boolean {
  return (member?.state ?? '').trim().toLowerCase() === 'closed';
}

/** 保留 / 滤掉「等待被移除」项；打开开关时原顺序不动（只复制，不改入参）。 */
export function filterPendingRemoval<T>(
  items: readonly T[],
  showArchived: boolean,
  isPending: (item: T) => boolean,
): T[] {
  return showArchived ? [...items] : items.filter((item) => !isPending(item));
}

export function countPendingRemoval<T>(
  items: readonly T[],
  isPending: (item: T) => boolean,
): number {
  return items.reduce((sum, item) => (isPending(item) ? sum + 1 : sum), 0);
}

/** 过滤已归档 Team（`showArchived` 打开时全留）。 */
export function filterArchivedTeams<T extends { archived_at?: number }>(
  teams: readonly T[],
  showArchived: boolean,
): T[] {
  return filterPendingRemoval(teams, showArchived, isArchivedTeam);
}

export function countArchivedTeams<T extends { archived_at?: number }>(
  teams: readonly T[],
): number {
  return countPendingRemoval(teams, isArchivedTeam);
}

/** 过滤已停用 agent（条目形状取 `{ member }`：RosterAgent 与成员行共用）。 */
export function filterClosedAgents<T extends { member: { state?: string } }>(
  agents: readonly T[],
  showArchived: boolean,
): T[] {
  return filterPendingRemoval(agents, showArchived, (agent) => isClosedAgent(agent.member));
}

export function countClosedAgents<T extends { member: { state?: string } }>(
  agents: readonly T[],
): number {
  return countPendingRemoval(agents, (agent) => isClosedAgent(agent.member));
}

/** 过滤已停用成员（Team 成员侧栏 / roster 行）。 */
export function filterClosedMembers<T extends { state?: string }>(
  members: readonly T[],
  showArchived: boolean,
): T[] {
  return filterPendingRemoval(members, showArchived, isClosedAgent);
}

export function countClosedMembers<T extends { state?: string }>(members: readonly T[]): number {
  return countPendingRemoval(members, isClosedAgent);
}

/**
 * 「等待被移除」对象在卡片 / 行内的标记 key。
 *
 * 复用既有 key（`teams.card.archived`）而不是另起一套：同一个事实（这个 Team 归档了）
 * 在卡片与头部只有一处文案，文案本身在本单里改成「已归档 · 待移除」；agent 侧新增
 * `agents.card.closed`，与 `team.state.closed`（状态 chip 只说「已停用」）分工不同。
 */
export function pendingRemovalBadgeKey(kind: 'team' | 'agent'): string {
  return kind === 'team' ? 'teams.card.archived' : 'agents.card.closed';
}

/** 直接打开归档 / 停用对象时的一句话提示；正常对象 undefined（不渲染空条）。 */
export function pendingRemovalNoticeKey(
  kind: 'team' | 'agent',
  pending: boolean,
): string | undefined {
  if (!pending) return undefined;
  return kind === 'team' ? 'archive.notice.team' : 'archive.notice.agent';
}
