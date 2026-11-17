/**
 * Team 卡片的排序键（**纯函数**，无 React / 无 IO）。
 *
 * 与会话卡同一套三级键（`state/sessions.ts#orderBy`），只是把业务语义换成 Team 的：
 *
 * 1. **有成员在跑置顶**：`health.get.runtime.scheduler.running` 里出现该 Team 任一成员的
 *    `agent_id` 就算 —— 和服务端调度器是同一份账本，**不新增任何请求**（health 本来就在
 *    轮询，会话卡也在用同一份）。刻意**没有**「排队中」这一级：Team 卡的徽标只有「有成员
 *    在跑」一种（一个 Team 里有人排队并不说明这个 Team 在干活），多一级只会让卡片因为
 *    一个不显眼的状态换位。
 * 2. **最近活动降序**：`max(成员 last_seen)`，见 `memberLastSeen`（`member.last_seen`
 *    是 agent 级真值；body 级用 `ExecutionUnitStatus.last_active_at`，两者取最新）。
 *    一个时间都没有（成员为空 / 旧 gateway 不带时间）就用 Team 的 `created_at` 兜底 ——
 *    空 Team 也要能排进列表，不能因为「没有活动」掉到看起来坏了的位置。
 * 3. **完全并列兜底**：卡片 key 升序（`team_id` 只在节点内唯一，所以 key 带节点前缀）。
 *    码元比较而不是 `localeCompare`：同一份输入两次调用结果逐字节一致，也与调用方给的
 *    数组顺序无关。
 *
 * **它只决定「目标顺序」**：不许直接拿去每帧渲染 —— 成员 run 起止会让卡片换位（跳动）。
 * 落屏顺序由同一个闸门（`app/useStableOrder.ts`）在**显式时机**收敛，见
 * `domains/teams/useStableTeamOrder.ts`。
 */
import type { ExecutionUnitStatus, TeamMember, TeamSummary } from '../gateway/types';
import { type OrderKey, orderBy } from './sessions';

/**
 * Team 卡片的稳定身份：`${nodeKey}:${team_id}`。
 *
 * `team_id` 只在节点内唯一（跨节点可能撞车），而 Team 栏是跨节点分组展示的，
 * 所以身份必须带节点前缀 —— 排序兜底、落屏闸门的快照都用它。
 */
export function teamCardKey(nodeKey: string, teamId: string): string {
  return `${nodeKey}:${teamId}`;
}

/** 成员的稳定身份：`${nodeKey}:${agent_id}`（与 `teamCardKey` 同构，供在飞集合对齐用）。 */
export function teamAgentKey(nodeKey: string, agentId: string): string {
  return `${nodeKey}:${agentId}`;
}

/** 调度器账本里的条目只要这一个字段（`SchedulerRunSummary` 的子集，便于纯函数驱动）。 */
export interface SchedulerRunLike {
  agent_id?: string;
}

/**
 * `health.get.runtime.scheduler.running` → 该节点「正在跑」的 `agent_id` 集合。
 *
 * 只认 `running`：`queued` 不算「有成员在跑」（见文件头的取舍）。条目缺 `agent_id`
 * （旧 gateway / 脏数据）就跳过，绝不猜。
 */
export function runningAgentsFromScheduler(
  scheduler: { running?: readonly SchedulerRunLike[] } | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const run of scheduler?.running ?? []) {
    if (typeof run.agent_id === 'string' && run.agent_id !== '') out.add(run.agent_id);
  }
  return out;
}

/**
 * 一个 Team 的 roster 成员快照（`membersByTeam` 的值）。
 *
 * `nodeKey` 与被 `teamsWithRunningMember` 拿去拼 agent key —— 存下来而不是从卡片 key 里
 * 切字符串：team_id 理论上可以含 `:`，切串是最容易悄悄错的那种做法。
 */
export interface TeamMembersBucket {
  nodeKey: string;
  members: readonly TeamMember[];
}

/** Team 卡片的稳定身份 → roster 成员。 */
export type TeamMembersByTeam = ReadonlyMap<string, TeamMembersBucket>;

/**
 * 哪些 Team 有成员正在跑：roster 与在飞 agent 集合对齐。
 *
 * `runningAgents` 是**带节点前缀**的 agent key（`teamAgentKey`）：同一个 agent id 在不同
 * 节点上是不同成员，只按 id 对齐会串台。
 */
export function teamsWithRunningMember(
  membersByTeam: TeamMembersByTeam,
  runningAgents: ReadonlySet<string>,
): ReadonlySet<string> {
  const out = new Set<string>();
  if (runningAgents.size === 0) return out;
  for (const [teamKey, bucket] of membersByTeam) {
    for (const member of bucket.members) {
      if (runningAgents.has(teamAgentKey(bucket.nodeKey, member.agent_id))) {
        out.add(teamKey);
        break;
      }
    }
  }
  return out;
}

/** 一个 body 的最后活动时间：`last_active_at` → `created_at` → 无。 */
function bodyActivity(body: ExecutionUnitStatus): number | undefined {
  if (typeof body.last_active_at === 'number' && Number.isFinite(body.last_active_at)) {
    return body.last_active_at;
  }
  if (typeof body.created_at === 'number' && Number.isFinite(body.created_at)) {
    return body.created_at;
  }
  return undefined;
}

/**
 * 一个成员的最后活动时间 = 服务端给它的所有时间戳里最新的那个：
 * `member.last_seen`（agent 级真值）与各 body 的 `last_active_at`（body 级）。
 *
 * 为什么两个都认、取 max：
 * - 真 gateway 的 `teams.get.members[]` 目前只带 `last_seen`（registry 的 `lastSeen`），
 *   只有成员起过 body 时才会有 `bodies[]`；只读其中一边都会让另一类节点/旧数据「没有活动」；
 * - 轮换身体（rotate）后旧 body 的 `last_active_at` 仍然代表「这个成员最后一次干活」，
 *   取 max 才不会让刚 rotate 的成员看起来「很久没动」。
 */
export function memberLastSeen(member: TeamMember): number | undefined {
  let best: number | undefined;
  if (typeof member.last_seen === 'number' && Number.isFinite(member.last_seen)) {
    best = member.last_seen;
  }
  for (const body of member.bodies ?? []) {
    const value = bodyActivity(body);
    if (value === undefined) continue;
    if (best === undefined || value > best) best = value;
  }
  return best;
}

/** 一个 Team 的最后活动时间 = `max(成员 last_seen)`；成员为空 / 全无时间 → undefined。 */
export function teamLastSeen(members: readonly TeamMember[] | undefined): number | undefined {
  let best: number | undefined;
  for (const member of members ?? []) {
    const value = memberLastSeen(member);
    if (value === undefined) continue;
    if (best === undefined || value > best) best = value;
  }
  return best;
}

/** 一张 Team 卡片的入参（`nodeKey` 提供身份前缀，`team` 是 `teams.list` 原样返回的摘要）。 */
export interface TeamOrderCard {
  nodeKey: string;
  team: TeamSummary;
}

export interface TeamOrderInput {
  /** 有成员正在跑的 Team key（`teamsWithRunningMember` 的结果）。缺省 = 全部没有在跑。 */
  runningTeams?: ReadonlySet<string>;
  /** Team key → roster 成员；缺省 = 成员不明（活动时间直接走 `created_at`）。 */
  membersByTeam?: TeamMembersByTeam;
  /** 当前时刻，只用来**夹住未来时间戳**（客户端 / 服务端时钟偏移时不至于永久置顶）。 */
  now?: number;
}

/** Team 卡片的三键；`activity` 按 `now` 夹住未来值，缺失时回落 `created_at` → 0。 */
function teamOrderKeyOf(card: TeamOrderCard, input: TeamOrderInput, now: number): OrderKey {
  const key = teamCardKey(card.nodeKey, card.team.team_id);
  const rank = input.runningTeams?.has(key) === true ? 0 : 1;
  const seen = teamLastSeen(input.membersByTeam?.get(key)?.members);
  const created = card.team.created_at;
  const raw = seen ?? (Number.isFinite(created) ? created : 0);
  return { rank, activity: raw > now ? now : raw, id: key };
}

/** Team 卡片的目标顺序（纯函数）；三键语义见文件头。 */
export function orderTeams(
  cards: readonly TeamOrderCard[],
  input: TeamOrderInput = {},
): TeamOrderCard[] {
  const now = input.now ?? Number.POSITIVE_INFINITY;
  return orderBy(cards, (card) => teamOrderKeyOf(card, input, now));
}
