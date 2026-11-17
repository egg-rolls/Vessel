/** 会话列表的纯选择器/更新函数（可单测，无 React 依赖）。 */
import { localDayKey, localDayLabel } from '../format';
import type { SessionInfo } from '../gateway/types';

export const MAX_SESSION_TITLE = 512;
export const SESSION_PAGE_SIZE = 50;

/** 一条会话的「在飞」状态：`running` = 有 run 正在跑；`queued` = 有 run 在排队。 */
export type SessionInflightState = 'running' | 'queued';

/**
 * `session_id → 在飞状态` 的**权威**快照。
 *
 * 唯一来源是 `health.get` 的 `runtime.scheduler.running` / `.queued`（调度器自己的账本，
 * 每条带 `run_id` / `session_id` / `status`）。**不要**用 `SessionInfo.status`：那是会话壳里
 * 上一次 run 的**镜像字段**，进程被杀后就停在 `running`，正是「假运行态」的来源；也不要用
 * 前端从事件流推出来的 run 表（同一份错误换个地方）。见 `inflightFromScheduler`。
 */
export type SessionInflightMap = ReadonlyMap<string, SessionInflightState>;

export interface SessionOrderInput {
  /** 权威在飞状态；缺省 = 全部空闲（等价于纯 `updated_at` 排序）。 */
  inflight?: SessionInflightMap;
  /**
   * 当前时刻，只用来**夹住未来时间戳**（服务端 / 客户端时钟偏移时 `updated_at` 可能
   * 比 `now` 还新，不夹的话那张卡会被永久顶在最上面）。
   */
  now?: number;
}

/**
 * 一张卡片的排序键（纯数据）：`rank` 越小越靠前，同 `rank` 按 `activity` 降序，
 * 再按 `id` 升序。
 *
 * 为什么是这三个键、而不是更强的业务键：会话卡与 Team 卡的一级键分别是「有 run 在跑」/
 * 「有成员在跑」，二级键都是「最近活动时间」，末键都是**服务端主键**（会话 `session_id` /
 * 团队 `team_id`）。三键合起来在同一份输入上是**全序**，所以同一输入两次调用逐字节一致，
 * 也与调用方给的数组顺序无关。
 */
export interface OrderKey {
  /** 越小越靠前（0 = 最优先）；非有限值按「最后」处理。 */
  rank: number;
  /** 越大越靠前（毫秒时间戳）；非有限值按 0 处理。 */
  activity: number;
  /** 完全并列时的稳定兜底：升序码元比较（不用 localeCompare，跨环境结果一致）。 */
  id: string;
}

/**
 * 通用列表排序（**纯函数**，无 React / 无 IO）：`rank` 升序 → `activity` 降序 → `id` 升序。
 *
 * 会话卡（`orderSessions`）与 Team 卡（`state/team-order.ts#orderTeams`）共用这一个实现，
 * 免得同一个「三级键 + 稳定兜底」的语义写两遍、日后改一处漏一处。
 *
 * **它只决定「目标顺序」**：不许直接拿去每帧渲染 —— run 起止会让卡片换位（跳动）。
 * 落屏顺序由 `mergeOrder` 在**显式时机**（进入列表 / 手动刷新 / 切范围）才对目标顺序
 * 收敛，见 `app/useStableOrder.ts`。
 */
export function orderBy<T>(list: readonly T[], keyOf: (item: T) => OrderKey): T[] {
  const ranked = list.map((item) => {
    const key = keyOf(item);
    return {
      item,
      rank: Number.isFinite(key.rank) ? key.rank : Number.MAX_SAFE_INTEGER,
      activity: Number.isFinite(key.activity) ? key.activity : 0,
      id: key.id,
    };
  });
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.activity !== b.activity) return b.activity - a.activity;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
  return ranked.map((entry) => entry.item);
}

/**
 * 会话卡片的排序键（**纯函数**，无 React / 无 IO）：
 *
 * 1. **在飞优先**：`running` 在前，其次 `queued`，其余最后 —— 状态来自服务端调度器账本
 *    （`SessionInflightMap`），不猜、不推；
 * 2. **最近活动降序**：用会话摘要里的服务端真值时间 `updated_at`（缺失时回落到创建时间
 *    `started_at`，再缺失按 0），按 `now` 夹住未来值；
 * 3. **完全并列兜底**：`session_id` 升序 —— 同一份输入两次调用结果完全一致。
 *
 * 「空会话 / 没有活动时间」不会掉到「看起来坏了」的位置：它按创建时间参与排序，而创建
 * 时间同样缺失时才落到 0（与 0.55 之前 `updated_at` 单键排序的行为一致，只是多了一层在飞优先）。
 *
 * 排序本身交给通用的 `orderBy`；本函数只负责把会话摘要映射成三键。
 */
export function orderSessions(
  list: readonly SessionInfo[],
  input: SessionOrderInput = {},
): SessionInfo[] {
  const inflight = input.inflight;
  const now = input.now ?? Number.POSITIVE_INFINITY;
  return orderBy(list, (session) => ({
    rank: rankOf(inflight?.get(session.session_id)),
    activity: activityOf(session, now),
    id: session.session_id,
  }));
}

/** 在飞优先级：`running` 0 < `queued` 1 < 空闲 2。 */
function rankOf(state: SessionInflightState | undefined): number {
  if (state === 'running') return 0;
  if (state === 'queued') return 1;
  return 2;
}

/** 最近活动时间（服务端真值）：`updated_at` → `started_at` → 0，并按 `now` 夹住未来值。 */
function activityOf(session: SessionInfo, now: number): number {
  const raw = session.updated_at || session.started_at || 0;
  if (!Number.isFinite(raw)) return 0;
  return raw > now ? now : raw;
}

/**
 * 把「目标顺序」落到屏上，但不让**已经在列表里的卡片**换位（防跳动，纯函数）。
 *
 * 只吃 id 序列，与业务类型无关：会话卡传 `session_id`，Team 卡传
 * `nodeKey:teamId`（见 `state/team-order.ts#teamCardKey`）。两边共用这一个闸门，
 * 语义就不会随域漂移。
 *
 * 规则：`previous` 里还存在的项保持它们**原来的相对顺序**；新出现的项按 `target` 的位置
 * 插到「它在 target 里排前面、且已经在 out 里」的最后一项之后；消失的项丢掉。
 *
 * 于是「某个 run 开始时把卡片顶到最前」这件事只会在下一次显式触发时发生（它等于
 * `previous` 被整体重置为 `target`：调用方在触发点直接传空 `previous` 即可），
 * 而**当前这一屏**永远不因为 run 起止而重排。
 */
export function mergeOrder(previous: readonly string[], target: readonly string[]): string[] {
  const targetRank = new Map<string, number>();
  target.forEach((id, index) => {
    targetRank.set(id, index);
  });
  const previousSet = new Set(previous);
  const survivors = previous.filter((id) => targetRank.has(id));
  const survivorSet = new Set(survivors);
  const fresh = target.filter((id) => !survivorSet.has(id) && !previousSet.has(id));
  if (fresh.length === 0) return survivors;
  const out = [...survivors];
  for (const id of fresh) {
    const rank = targetRank.get(id) ?? Number.POSITIVE_INFINITY;
    let at = 0;
    for (let index = 0; index < out.length; index += 1) {
      const existing = out[index];
      if (existing === undefined) continue;
      const other = targetRank.get(existing);
      if (other !== undefined && other < rank) at = index + 1;
    }
    out.splice(at, 0, id);
  }
  return out;
}

/**
 * `health.get.runtime.scheduler` → `session_id → 在飞状态`（权威账本，零推断）。
 *
 * 同一个会话同时有多个 run（排队 + 正在跑）时取**更强**的那个：`running` 覆盖 `queued`
 * —— 徽标要说的是「它现在正在跑」。
 */
export function inflightFromScheduler(
  scheduler:
    | {
        running?: readonly { session_id?: string }[];
        queued?: readonly { session_id?: string }[];
      }
    | undefined,
): SessionInflightMap {
  const out = new Map<string, SessionInflightState>();
  for (const run of scheduler?.queued ?? []) {
    if (typeof run.session_id === 'string' && run.session_id !== '')
      out.set(run.session_id, 'queued');
  }
  for (const run of scheduler?.running ?? []) {
    if (typeof run.session_id === 'string' && run.session_id !== '') {
      out.set(run.session_id, 'running');
    }
  }
  return out;
}

/** 行标题回退：title > preview > session_id。 */
export function sessionTitle(session: SessionInfo): string {
  return session.title?.trim() || session.preview?.trim() || session.session_id;
}

/** 校验并归一化重命名输入；空白/超长返回 null。 */
export function normalizeSessionTitle(raw: string): string | null {
  const title = raw.trim();
  if (!title || title.length > MAX_SESSION_TITLE) return null;
  return title;
}

export interface SessionFilter {
  query?: string;
}

/** 大小写不敏感地匹配 title / preview / session_id。 */
export function filterSessions(
  list: readonly SessionInfo[],
  { query = '' }: SessionFilter = {},
): SessionInfo[] {
  const needle = query.trim().toLowerCase();
  return list.filter((session) => {
    if (!needle) return true;
    return [session.title, session.preview, session.session_id].some((value) =>
      (value ?? '').toLowerCase().includes(needle),
    );
  });
}

export interface SessionDayGroup {
  key: string;
  label: string;
  sessions: SessionInfo[];
}

/**
 * 按本地日历日分组（保持传入顺序；调用方已按 updated_at 倒序）。
 * 只影响渲染，不改变窗口/“显示更多”计数。
 */
export function groupSessionsByDay(
  list: readonly SessionInfo[],
  now: number = Date.now(),
): SessionDayGroup[] {
  const groups: SessionDayGroup[] = [];
  for (const session of list) {
    const key = localDayKey(session.updated_at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.sessions.push(session);
      continue;
    }
    groups.push({ key, label: localDayLabel(session.updated_at, now), sessions: [session] });
  }
  return groups;
}

/** 窗口化：先渲染 `limit` 条，返回被隐藏的数量。 */
export function takeSessions(
  list: readonly SessionInfo[],
  limit: number,
): { shown: SessionInfo[]; hiddenCount: number } {
  if (limit <= 0) return { shown: [], hiddenCount: list.length };
  if (limit >= list.length) return { shown: list.slice(), hiddenCount: 0 };
  return { shown: list.slice(0, limit), hiddenCount: list.length - limit };
}

/** 乐观重命名；失败时由调用方用旧 title 回滚。 */
export function renameSessionInList(
  list: readonly SessionInfo[],
  sessionId: string,
  title: string,
): SessionInfo[] {
  return list.map((session) =>
    session.session_id === sessionId ? { ...session, title } : session,
  );
}

export function removeSessionFromList(
  list: readonly SessionInfo[],
  sessionId: string,
): SessionInfo[] {
  return list.filter((session) => session.session_id !== sessionId);
}

/**
 * 删除当前会话后的落点：
 * - 删除的不是当前会话 → 保持当前选择；
 * - 删除的是当前会话或当前草稿 → 回到无选择的 Chat 空态。
 */
export function selectionAfterDelete(
  currentId: string | null,
  draftId: string | null,
  deletedId: string,
): { selectedId: string | null; draftId: string | null } {
  if (currentId === deletedId) return { selectedId: null, draftId: null };
  if (draftId === deletedId) return { selectedId: currentId, draftId: null };
  return { selectedId: currentId, draftId };
}
