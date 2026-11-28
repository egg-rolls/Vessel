/**
 * 好友边自动互记（q-sub-unify-p1 M6，设计 §6.4，lead 裁定）。
 *
 * 同 team create/hire ⇒ 创建者↔新成员自动互记 friend 边。friend 边是**成员级事实**，
 * 记在双方当前 primary body 会话状态的 agent:<对方> 条目上（经现态 MemberPointer
 * 收养机制跨 rotate 携带，无需新机制）。新建条目 origin:'implicit'（系统建、永不自过期）；
 * 已有条目只补 friend 块（origin:'auto'），不改 origin / 游标。
 *
 * 写入走插件**单一 store 实例**的 per-session 串行链（mutate），零竞态；
 * 事件端口由装配层晚绑定注入（agent-events-bridge），插件不 import 宿主 / agent 包。
 *
 * 权限零变化：team visibility 本就互见；friend 是语义标记非新权限（§9）。
 * visibility 闸：只收 team/tenant 事件（private 永不记边）。
 */

import { agentSubscriptionKey, isValidAgentTarget } from './agent.js';
import type { SessionSubscriptionState, SubscriptionEntry, SubscriptionStore } from './store.js';
import { subscriptionId } from './store.js';

/** agent.spawned 事件的结构化形状（零依赖副本；真相在 packages/agent types.ts AgentEvent）。 */
export interface FriendSpawnEvent {
  type: string;
  agent_id?: string;
  session_id?: string;
  team_id?: string;
  visibility?: string;
  spawned_by?: string;
  ts?: number;
}

/** 装配层注入的事件端口（结构化零依赖；subscribe 晚绑定 fan-out，sessionOf 取当前 primary）。 */
export interface AgentEventsPort {
  subscribe(cb: (event: FriendSpawnEvent) => void): () => void;
  /** 成员当前 primary body 的 session（MemberPointer 收养语义）；未知 ⇒ undefined。 */
  sessionOf(memberId: string): Promise<string | undefined> | string | undefined;
}

/** 新建 implicit 条目（系统建好友边；rev='' 首观通知现态，agent 源基线语义）。 */
function implicitFriendEntry(target: string): SubscriptionEntry {
  return {
    id: subscriptionId(target),
    path: target,
    input: target,
    source: 'agent',
    rev: '',
    notified_rev: '',
    seen_rev: '',
    size: 0,
    mtime_ms: 0,
    notified_at: 0,
    seen_at: 0,
    origin: 'implicit',
    reads: [],
  };
}

/** 单侧记边：已有 friend 块不覆盖；无条目建 implicit；有条目补 friend。 */
function addFriendEdge(
  state: SessionSubscriptionState,
  other: string,
  since: number,
): SessionSubscriptionState | undefined {
  if (!isValidAgentTarget(other)) return undefined;
  const key = agentSubscriptionKey(other);
  const existing = state.subscriptions[key];
  if (existing?.friend !== undefined) return undefined; // 已有边（auto/manual）不覆盖
  const base = existing ?? implicitFriendEntry(other);
  state.subscriptions[key] = { ...base, friend: { since, origin: 'auto' } };
  return state;
}

/**
 * 注册好友边 listener。返回 unsubscribe（dispose 调用）。
 * 失败 best-effort：单侧 mutate 失败不打断另一侧（边是语义标记，非关键路径）。
 */
export function registerFriendEdges(store: SubscriptionStore, port: AgentEventsPort): () => void {
  return port.subscribe((event) => {
    if (event.type !== 'agent.spawned') return;
    if (event.team_id === undefined) return; // 同 team 才记边
    if (event.visibility !== 'team' && event.visibility !== 'tenant') return; // private fail-closed
    const child = event.agent_id;
    const creator = event.spawned_by;
    if (child === undefined || creator === undefined || child === creator) return;
    const since = typeof event.ts === 'number' ? event.ts : Date.now();
    void (async () => {
      const childSession = (await port.sessionOf(child)) ?? event.session_id;
      const creatorSession = await port.sessionOf(creator);
      if (childSession === undefined || creatorSession === undefined) return;
      try {
        await store.mutate(childSession, (state) => addFriendEdge(state, creator, since));
      } catch {
        // best-effort
      }
      try {
        await store.mutate(creatorSession, (state) => addFriendEdge(state, child, since));
      } catch {
        // best-effort
      }
    })();
  });
}
