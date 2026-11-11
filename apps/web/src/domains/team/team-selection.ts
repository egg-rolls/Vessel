/**
 * 上次打开的 Team：sessionStorage 一条记录，与会话页同口径
 * （domains/chat/session-selection.ts）——读写都吞异常，隐私模式 / SSR / 配额满
 * 只是降级成「没有记录」，不阻塞导航。
 *
 * 坑：key 带 node 槽位（`vessel.team.lastTeam.v1.<nodeKey>`）。多节点下同一份
 * sessionStorage 里的 team_id 各属不同节点，槽位分开才不会串到别的节点上。
 */
import { browserSessionStorage } from '../chat/session-selection';

export { browserSessionStorage };

/** 槽位前缀；末段是 nodeKey（缺省 default，与会话页 key 的 default 段同形）。 */
export const LAST_TEAM_KEY_PREFIX = 'vessel.team.lastTeam.v1.';

export function lastTeamKey(nodeKey?: string): string {
  return `LAST_TEAM_KEY_PREFIX${nodeKey?.trim() || 'default'}`;
}

/** 记录的身份是 nodeKey + team_id（不是名字：同名 Team 与改名都不影响）。 */
export interface LastTeamRecord {
  nodeKey: string;
  teamId: string;
}

export function teamRecordKey(nodeKey: string, teamId: string): string {
  return `${nodeKey}:${teamId}`;
}

/** 空值 / 空白视为无记录。 */
export function readLastTeam(storage: Storage | null, nodeKey: string): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(lastTeamKey(nodeKey));
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * 扫出当前那条记录（同一时刻只有一个 Team 被打开，写入时也只留一个槽位）。
 * 多槽位只可能来自历史残留：按字典序取第一条非空，避免刷新时两次跳不同 Team。
 */
export function readLastTeamRecord(storage: Storage | null): LastTeamRecord | null {
  if (!storage) return null;
  try {
    const slots: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(LAST_TEAM_KEY_PREFIX)) continue;
      slots.push(key);
    }
    slots.sort();
    for (const key of slots) {
      const value = storage.getItem(key)?.trim();
      if (!value) continue;
      return { nodeKey: key.slice(LAST_TEAM_KEY_PREFIX.length), teamId: value };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 只记录真实 Team（空 id / 空 nodeKey 不写），并清掉别的 node 槽位：
 * 恢复的语义是「回到唯一那个上次打开的 Team」，两个槽位同时有效就没有确定答案。
 */
export function writeLastTeam(storage: Storage | null, nodeKey: string, teamId: string): void {
  if (!storage) return;
  const id = teamId.trim();
  const slot = nodeKey.trim();
  if (!id || !slot) return;
  try {
    const key = lastTeamKey(slot);
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const existing = storage.key(index);
      if (!existing || existing === key) continue;
      if (!existing.startsWith(LAST_TEAM_KEY_PREFIX)) continue;
      storage.removeItem(existing);
    }
    storage.setItem(key, id);
  } catch {
    // 配额满 / 隐私模式：恢复能力降级为无记录。
  }
}

export function clearLastTeam(storage: Storage | null, nodeKey: string): void {
  if (!storage) return;
  try {
    storage.removeItem(lastTeamKey(nodeKey));
  } catch {
    // 同 writeLastTeam：失败不阻塞导航。
  }
}

export type TeamRestoreDecision =
  | { kind: 'keep' }
  | { kind: 'wait' }
  | { kind: 'restore'; nodeKey: string; teamId: string }
  | { kind: 'default'; clear: boolean };

/**
 * 口径同 decideSessionRestore：
 * - 路由里已有 teamId（详情 / 编辑深链）一律 keep —— URL 权威，恢复只补默认值；
 * - knownTeams 为 null（列表未加载，或有节点拉列表失败）不能判记录失效，只能 wait；
 * - 记录的 nodeKey + team_id 仍在已加载列表里才 restore；
 * - 否则回落到列表页（Team 页的默认态）并清记录：团队被删 / 归档 / 无权限 /
 *   不在 roster 都落到这一支。
 */
export function decideTeamRestore(input: {
  routeTeamId?: string;
  stored: LastTeamRecord | null;
  knownTeams: readonly string[] | null;
}): TeamRestoreDecision {
  const { routeTeamId, stored, knownTeams } = input;
  if (routeTeamId) return { kind: 'keep' };
  if (!stored) return { kind: 'default', clear: false };
  if (knownTeams === null) return { kind: 'wait' };
  if (knownTeams.includes(teamRecordKey(stored.nodeKey, stored.teamId))) {
    return { kind: 'restore', nodeKey: stored.nodeKey, teamId: stored.teamId };
  }
  return { kind: 'default', clear: true };
}
