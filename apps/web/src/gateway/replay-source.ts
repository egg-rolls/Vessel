/**
 * 重放来源适配器（`ReplaySource` / `ReplaySink`）与编排（`recoverReplay`）。
 *
 * 契约出处：`docs/dev/handoff/replay-gap-findings.md` §8（`scripts/check-replay-merge.ts`
 * 按同一份契约断言）。三个来源、三套 seq 空间，**不可混**：
 *
 * | 阶段 | 来源 | RPC | seq 空间 | 覆盖什么 |
 * |---|---|---|---|---|
 * | 一 | 会话事件日志 | `sessions.events`（`since_seq` 排他） | **session 全局**（每会话自增，跨 run） | 落盘的全部结构事实（含 `run.started` / `user.message`） |
 * | 二 | run trace | `events.list`（逐 `run_id`） | **per-run** | trace-only：`hook.*` / `context.changed` / `run.checkpoint` / `runtime.notice` |
 * | 快速 | 环回放 | `events.subscribe{since:0}` | **hub 进程全局**（重启归零） | 尾部窗口（含不落盘的 `llm.stream.chunk`） |
 *
 * 两条硬约束（为什么只能这么做）：
 * 1. **跨源去重必须用内容 id**（`stableEventId = run_id|type|ts`），**禁用 seq 去重** ——
 *    三套 seq 之间不存在任何映射，拿数字比大小就是错的（一次会话里 session seq=366 与
 *    hub seq=7 可以是同一条事件）。
 * 2. **阶段二必须逐 run**：`events.list` 的 `since_seq` 是 per-run 的，一个游标跨 run
 *    会漏（run B 的 seq 1 永远小于 run A 的 last）。
 *
 * 全部来源 **fail-open**：报错 / 超时只 `warn`，不抛、不清空已渲染数据、不动游标。
 * 页数有硬上限（每阶段独立计数），超限 `warn` 而不无限翻页。
 */

import type { GatewayClient } from './client';

/** 一条可重放的事件（与 wire 上的事件同形；`seq` 的**语义随来源变化**）。 */
export interface ReplayEvent {
  seq: number;
  type: string;
  run_id?: string;
  ts: number;
  data?: unknown;
}

/**
 * 游标快照（`sessions.get.event_cursor`）。缺 `derived_upto_seq` 时按 0 处理（= 投影
 * 还没覆盖任何事件，整份日志都要回填）。
 */
export interface ReplayCursor {
  last_seq: number;
  derived_upto_seq: number;
}

export interface ReplaySource {
  getCursor(): Promise<ReplayCursor>;
  /** 阶段一：session 日志。`sinceSeq` **排他**，返回按 seq 升序的一页。 */
  fetchSessionLogSegment(sinceSeq: number, limit: number): Promise<ReplayEvent[]>;
  /** 阶段二（可选）：run trace，**按 run_id 作用域**、per-run seq。 */
  fetchTraceSegment?(runId: string, sinceRunSeq: number, limit: number): Promise<ReplayEvent[]>;
  /** 快速路径：环里已经能拿到的段（Web 侧已经在 `EventStore` 里时返回空）。 */
  fetchRingSegment(): Promise<ReplayEvent[]>;
}

export interface ReplaySink {
  /** 幂等合并（按 `stableEventId` 去重），返回 distinct 总数。 */
  apply(events: readonly ReplayEvent[]): number;
  /** fail-open 的可观测警告（不弹窗、不清数据）。 */
  warn(message: string): void;
  /**
   * 分段记号（可选）：`apply` 的下一批属于哪个来源。
   *
   * 为什么需要：三套 seq 空间要落进本地**不同的负数带**（`state/disk-replay.ts`），
   * 而 `apply` 只看得到事件、看不到「这页是从哪个 RPC 来的」。实现方可以在换段时
   * 把上一段攒下的批次一次性并入（也顺手把「逐页重折叠」压成「按段重折叠」）。
   */
  beginSegment?(segment: 'session-log' | 'trace' | 'ring'): void;
}

export interface RecoverOptions {
  /**
   * 阶段二要回填的 run：缺省 = **只做阶段一**。
   *
   * 允许传函数：驱动的调用方往往要先看阶段一拿到哪些 run（当前正在跑的 run 可能还没
   * 进任何本地窗口），再决定逐哪些 run 拉 trace。
   */
  runs?: readonly string[] | ((sessionEvents: readonly ReplayEvent[]) => readonly string[]);
}

export interface RecoverResult {
  sessionCalls: number;
  traceCalls: number;
  ringCount: number;
  /** 阶段一实际交出的事件条数（去重前）。 */
  sessionEvents: number;
  /** 阶段二实际交出的事件条数（去重前）。 */
  traceEvents: number;
  /** 阶段一是否**完整**走到了 `last_seq`（false = 出错 / 页数上限先到）。 */
  sessionOk: boolean;
  /** 阶段一失败原因（fail-open 已生效）。 */
  sessionError?: string;
  /** 请求回填的 run 数（阶段二想覆盖几个）。 */
  traceRunsRequested: number;
  /** 真正拉到的 run 数（部分失败时小于 requested ⇒ 要在 UI 上说明「细节不全」）。 */
  traceRunsFetched: string[];
  /** 是否因为页数上限提前收手（尾部可能有没拿到的事件）。 */
  truncated: boolean;
  /**
   * 阶段一是否**恰好**卡在页数硬上限（`REPLAY_MAX_SESSION_PAGES`）。
   *
   * 与 `truncated` 的区别：后者还包含「RPC 失败 / 游标不前进 / 阶段二部分失败」，而
   * 这条只回答一个可行动的问题 —— **早于最近 3 个 run 的那一段，这次是不是根本没去拿**
   * （见 `EventStore#diskBackfill.stage1HitCap`）。别把「没触顶」读成「没缺口」。
   */
  sessionPageCap: boolean;
}

/**
 * 稳定 JSON：对象键**递归排序**后序列化（同一份 payload 在任何到达顺序 / 任何进程里
 * 都得到同一串字节）。不引依赖 —— 这里只需要「确定性」，不需要「可逆」。
 *
 * 与 `JSON.stringify` 的差异（都是**故意的**）：`undefined` / 非有限数当 `null` 处理
 * （同 JSON 的成员语义），对象里的 `undefined` 成员跳过；超深结构（> 12 层）截断成
 * `"…"` 而**不抛**（回填是 fail-open 路径，不能因为一条畸形 payload 就整段不进）。
 */
function canonicalJson(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'null';
  const kind = typeof value;
  if (kind === 'number') return Number.isFinite(value as number) ? String(value) : 'null';
  if (kind === 'boolean') return value === true ? 'true' : 'false';
  if (kind === 'string') return JSON.stringify(value);
  if (kind !== 'object') return JSON.stringify(String(value));
  if (depth >= 12) return '"…"';
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJson(item, depth + 1));
    return `[${items.join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

/** 32 位 FNV-1a（轻量、无依赖；一次线性扫描）。 */
function fnv1a32(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(36);
}

/** 「这条事件到底有没有 payload」：`undefined` / `null` / `{}` / `[]` 都算没有。 */
function hasPayload(data: unknown): boolean {
  if (data === null || data === undefined) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === 'object') return Object.keys(data as Record<string, unknown>).length > 0;
  return true;
}

/**
 * payload 摘要（内容 id 的第四段）：`<fnv(seed1)>.<fnv(seed2)>`，两个独立 32 位散列
 * 并排 —— 单个 32 位散列在「上万条同型 payload」量级上的生日碰撞不可忽略，两个并排
 * 之后是 ~64 位，工程上够用；真的撞了也只会少一条重复行（与旧的三段口径同级），
 * 而**不会**再出现「同一毫秒里两条不同内容被并成一条」。
 *
 * `undefined` / `null` / `{}` 归一到同一个值：磁盘事件常常没有 `data`，而经过
 * `toRunEvent` 之后同一个事件的 `data` 是 `{}` —— 两侧必须算同一个 id，否则跨源去重
 * 立刻失效（反而制造重复行）。「没有 payload」本就只有一个含义。
 */
export function payloadDigest(data: unknown): string {
  if (!hasPayload(data)) return '0';
  let json: string;
  try {
    json = canonicalJson(data);
  } catch {
    // 循环引用等畸形结构：宁可「所有畸形 payload 同 id」也不要整段回填失败。
    json = '!';
  }
  return `${fnv1a32(json, 0x811c9dc5)}.${fnv1a32(json, 0x9e3779b9)}`;
}

/**
 * 内容 id 用的 payload：**抹平传输层补的归属字段**。
 *
 * `gateway.ts#withSessionAttribution` 往**出站副本**的 `data` 里补一个 `session_id`
 * （`llm.stream.chunk` / `tool.call.*` 本体不带它，订阅侧要靠它把事件挂回会话），而磁盘
 * 副本是**原始事件**、没有这个字段。同一个逻辑事件在「磁盘段」与「已收到的那一份」之间
 * 因此只差这一个键 —— 内容 id 必须把它抹平，否则跨源去重永远配不上对，回填会把每条
 * 工具 / LLM 事件都再并一遍（那是**制造重复**，比少一条更糟）。
 *
 * 只在「run 自己就能定位会话」时抹平（`run_id` 非空且不是 `manual`）：`session.*` 这类
 * 没有 run 的事件正是靠 `data.session_id` 才是唯一身份，抹掉会把两个会话的事件并成一条
 * —— 那才是吞内容。方向不对称是有意的：宁可多一条重复行，不可少一条内容。
 */
function payloadForId(event: ReplayEvent): unknown {
  const data = event.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
  const runId = event.run_id ?? '';
  if (runId === '' || runId === 'manual') return data;
  const record = data as Record<string, unknown>;
  if (!('session_id' in record)) return data;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === 'session_id') continue;
    copy[key] = record[key];
  }
  return copy;
}

/**
 * 跨源内容 id：`run_id|type|ts|<payload 摘要>`（契约 §8 第 3 条的**补强**）。
 *
 * 为什么不是 seq：三个 seq 空间互不映射（session 全局 / per-run / hub 全局），同一逻辑
 * 事件在三处的数字完全不同，且磁盘 seq 在重启后与 hub seq 的「纪元」没有任何共同起点。
 * `run_id + type + ts` 是唯一三源同值的组合（`ts` 由生产者在事件对象上盖一次，落盘、
 * 广播、trace 都是同一个值）。
 *
 * 为什么要加第四段（payload 摘要）：`ts` 只到毫秒，而同 run 同类型的两条事件落在同一
 * 毫秒是**真实存在**的（1ms 内两次 `hook.started`、批量 `context.changed`）。三段口径
 * 下它们会被当成一条、**后到的那条被丢掉** —— 那是吞内容，不是去重。加上 payload 摘要
 * 之后：内容相同 ⇒ 同 id（仍然去重）；同 run/type/ts 但 payload 不同 ⇒ 不同 id
 * （两条都留下，屏上多一张卡，而不是少一条内容）。跨源语义不变：仍按内容 id 比对，
 * 绝不比 seq。归属字段的抹平见 `payloadForId`。
 */
export function stableEventId(event: ReplayEvent): string {
  return `${event.run_id ?? ''}|${event.type}|${event.ts}|${payloadDigest(payloadForId(event))}`;
}

/** 单页条数：`sessions.events` / `events.list` 的服务端硬顶都是 500。 */
export const REPLAY_PAGE_LIMIT = 500;

/**
 * **阶段一**（session 日志）的总页数硬上限：20 页 = 10 000 条。
 *
 * 从 `derived_upto_seq` 翻到 `last_seq`：一次刷新最多要补「一个 run 的那些结构事件」，
 * 10 000 条远超这个量级，同时又**有界**（远程 / WAN 上不能把首屏拖死 —— 宁可少补一点也
 * 不能卡住时间线）。超限 `truncated = true` + `warn`，只并入已拿到的部分。
 */
export const REPLAY_MAX_SESSION_PAGES = 20;

/** **阶段二**（run trace）单 run 页数上限：10 页 = 5 000 条。 */
export const REPLAY_MAX_TRACE_PAGES = 10;

/** **阶段二**最多逐几个 run 拉 trace（从最新往前数）。 */
export const REPLAY_MAX_TRACE_RUNS = 3;

/** 远程场景下的 trace 并发上限：实现是**串行**（1），远低于这个上限。 */
export const REPLAY_MAX_TRACE_CONCURRENCY = 2;

/** 单次 RPC 超时：回填是增强，不能拖住订阅循环（客户端默认 30s 太长）。 */
export const REPLAY_REQUEST_TIMEOUT_MS = 8_000;

/** 形状校验：不像事件的条目直接丢（不猜、不补 0）。 */
export function normalizeReplayEvent(raw: unknown): ReplayEvent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const seq = record.seq;
  const type = record.type;
  const ts = record.ts;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return undefined;
  if (typeof type !== 'string' || type.length === 0) return undefined;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined;
  return {
    seq,
    type,
    ts,
    ...(typeof record.run_id === 'string' ? { run_id: record.run_id } : {}),
    ...(record.data !== undefined ? { data: record.data } : {}),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 编排三段回填（契约实现，fail-open 逐段兜住）。
 *
 * 每段都单独 try/catch：某一段失败只 `warn` + 跳过该段，**已有数据与其它段照常**。
 * 阶段一是主体（`[derived+1..last]` 那段 session 日志），阶段二是补 trace-only 类型，
 * 环是快速路径（Web 侧通常已经收到，`fetchRingSegment` 返回空）。
 */
export async function recoverReplay(
  source: ReplaySource,
  sink: ReplaySink,
  opts: RecoverOptions = {},
): Promise<RecoverResult> {
  const result: RecoverResult = {
    sessionCalls: 0,
    traceCalls: 0,
    ringCount: 0,
    sessionEvents: 0,
    traceEvents: 0,
    sessionOk: false,
    traceRunsRequested: 0,
    traceRunsFetched: [],
    truncated: false,
    sessionPageCap: false,
  };
  let cursor: ReplayCursor;
  try {
    cursor = await source.getCursor();
  } catch (error) {
    // 拿不到游标 = 不知道从哪开始补。**不能**退化成「从 0 全拉」：那是另一套行为，
    // 而且大概率是旧 gateway。fail-open 到今天（只有环）。
    result.sessionError = `replay cursor unavailable (old gateway or empty session log): ${errorText(error)}`;
    sink.warn(result.sessionError);
    return result;
  }
  // 区间分工（契约 §8 第 5 条）：`[1..derived]` 由消息投影覆盖，`[derived+1..last]`
  // 由阶段一覆盖 —— 所以游标从 `derived_upto_seq` 起，不从头拉。
  sink.beginSegment?.('session-log');
  let since = Math.max(0, Math.floor(cursor.derived_upto_seq));
  const last = Math.max(since, Math.floor(cursor.last_seq));
  const sessionEvents: ReplayEvent[] = [];
  // 「完整走完」的判据只有一条：游标追上 `last_seq`。任何 break 出去都算不完整。
  result.sessionOk = since >= last;
  let pages = 0;
  for (let page = 0; page < REPLAY_MAX_SESSION_PAGES && since < last; page += 1) {
    pages += 1;
    let rows: ReplayEvent[];
    try {
      const raw = await source.fetchSessionLogSegment(since, REPLAY_PAGE_LIMIT);
      result.sessionCalls += 1;
      rows = raw.filter((event) => event.seq > since);
    } catch (error) {
      result.sessionError = `sessions.events failed/timeout, fail-open: ${errorText(error)}`;
      sink.warn(result.sessionError);
      break;
    }
    if (rows.length === 0) break;
    sessionEvents.push(...rows);
    sink.apply(rows);
    const maxSeq = rows.reduce((top, event) => Math.max(top, event.seq), since);
    // 游标必须真的前进，否则停手（服务端异常 / 日志被截，别在这里转圈）。
    if (maxSeq <= since) break;
    since = maxSeq;
    if (since >= last) {
      result.sessionOk = true;
      break;
    }
    if (rows.length < REPLAY_PAGE_LIMIT) break;
  }
  result.sessionEvents = sessionEvents.length;
  // 「触顶」= 页预算用完时游标还没追上 `last_seq`。失败 / 页空 / 游标不前进都不算触顶
  // （那些是别的原因，`truncated` 一并兜住）。
  if (!result.sessionOk && since < last && pages >= REPLAY_MAX_SESSION_PAGES) {
    result.sessionPageCap = true;
  }
  if (!result.sessionOk) {
    result.truncated = true;
    sink.warn(`sessions.events incomplete (page cap or gap): covered up to ${since} of ${last}`);
  }

  // 阶段二：trace（逐 run，per-run seq）。缺 `fetchTraceSegment` 或没给 runs = 只做阶段一。
  const runsOption = opts.runs;
  const requested =
    typeof runsOption === 'function' ? runsOption(sessionEvents) : (runsOption ?? []);
  // 归属校验：`runs` 只来自**本会话的 session 日志**（`newestRunIds(sessionEvents)`），
  // 校验不了就不拉 —— 宁可不补，也不把别的会话的 run trace 拉进这个会话。
  const runs = requested.slice(0, REPLAY_MAX_TRACE_RUNS);
  result.traceRunsRequested = runs.length;
  if (source.fetchTraceSegment !== undefined && runs.length > 0) {
    sink.beginSegment?.('trace');
    for (const runId of runs) {
      // 串行（并发 1）：远程 / WAN 上逐 run 并发会把连接打爆，见
      // `REPLAY_MAX_TRACE_CONCURRENCY`。
      let runSeq = 0;
      let fetched = true;
      for (let page = 0; page < REPLAY_MAX_TRACE_PAGES; page += 1) {
        let rows: ReplayEvent[];
        try {
          const raw = await source.fetchTraceSegment(runId, runSeq, REPLAY_PAGE_LIMIT);
          result.traceCalls += 1;
          rows = raw.filter((event) => event.seq > runSeq);
        } catch (error) {
          sink.warn(`events.list failed for ${runId}, fail-open: ${errorText(error)}`);
          fetched = false;
          break;
        }
        if (rows.length === 0) break;
        result.traceEvents += rows.length;
        sink.apply(rows);
        const maxSeq = rows.reduce((top, event) => Math.max(top, event.seq), runSeq);
        if (maxSeq <= runSeq) break;
        runSeq = maxSeq;
        if (rows.length < REPLAY_PAGE_LIMIT) break;
      }
      if (fetched) result.traceRunsFetched.push(runId);
    }
  }
  if (result.traceRunsRequested > result.traceRunsFetched.length) result.truncated = true;

  // 快速路径：环（Web 侧通常已经由订阅帧送进 `EventStore`，此时这里是空的）。
  try {
    sink.beginSegment?.('ring');
    const ring = await source.fetchRingSegment();
    result.ringCount = ring.length;
    if (ring.length > 0) sink.apply(ring);
  } catch (error) {
    sink.warn(`ring replay failed, fail-open: ${errorText(error)}`);
  }
  return result;
}

/** `recoverReplay` 的 run 选择器：从出现顺序里取**最新**的 N 个 run id（去重）。 */
export function newestRunIds(
  events: readonly ReplayEvent[],
  limit = REPLAY_MAX_TRACE_RUNS,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let index = events.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const runId = events[index]?.run_id;
    if (typeof runId !== 'string' || runId === '' || seen.has(runId)) continue;
    seen.add(runId);
    out.push(runId);
  }
  return out;
}

/**
 * 网关实现：把三套 RPC 翻译成 `ReplaySource`。
 *
 * **这是 `apps/web` 里唯一读磁盘事件日志的地方**（`scripts/check-replay-wiring.ts` 的
 * A1 门禁钉的就是这一点：服务端有 `sessions.events`，前端就必须真有一个 request 调用点，
 * 注释 / 字符串常量不算）。
 *
 * `fetchRingSegment` 返回空数组是**如实**的：Web 侧的环段在订阅帧到达时就已经 `push`
 * 进 `EventStore` 了，这里再拉一遍只会多一次重放；编排层的去重对此也不敏感（同一批
 * 内容 id 会被 sink 挡掉）。真正需要「从环里补」的场景是服务端内部回放，不在这一层。
 */
export class GatewayReplaySource implements ReplaySource {
  constructor(
    private readonly client: GatewayClient,
    private readonly sessionId: string,
    private readonly timeoutMs = REPLAY_REQUEST_TIMEOUT_MS,
  ) {}

  async getCursor(): Promise<ReplayCursor> {
    // `message_limit: 1`：只要 `event_cursor`，不要把整份消息窗口拖下来。
    const body = await this.client.request<{
      session?: { event_cursor?: { last_seq?: number; derived_upto_seq?: number } };
    }>('sessions.get', { session_id: this.sessionId, message_limit: 1 }, this.timeoutMs);
    const cursor = body?.session?.event_cursor;
    if (cursor === undefined || typeof cursor.last_seq !== 'number') {
      // 旧 gateway / 该会话没有事件日志：没有游标就没有阶段一，**明确失败**让编排层
      // fail-open（而不是假装 last_seq=0 然后空转）。
      throw new Error('event_cursor unavailable');
    }
    return {
      last_seq: cursor.last_seq,
      derived_upto_seq: typeof cursor.derived_upto_seq === 'number' ? cursor.derived_upto_seq : 0,
    };
  }

  async fetchSessionLogSegment(sinceSeq: number, limit: number): Promise<ReplayEvent[]> {
    const body = await this.client.request<{ events?: unknown[] }>(
      'sessions.events',
      { session_id: this.sessionId, since_seq: sinceSeq, limit },
      this.timeoutMs,
    );
    const rows: ReplayEvent[] = [];
    for (const raw of body?.events ?? []) {
      const event = normalizeReplayEvent(raw);
      if (event !== undefined) rows.push(event);
    }
    return rows;
  }

  async fetchTraceSegment(
    runId: string,
    sinceRunSeq: number,
    limit: number,
  ): Promise<ReplayEvent[]> {
    const body = await this.client.request<{ events?: unknown[] }>(
      'events.list',
      { run_id: runId, since_seq: sinceRunSeq, limit },
      this.timeoutMs,
    );
    const rows: ReplayEvent[] = [];
    for (const raw of body?.events ?? []) {
      const event = normalizeReplayEvent(raw);
      if (event !== undefined) rows.push(event);
    }
    return rows;
  }

  async fetchRingSegment(): Promise<ReplayEvent[]> {
    return [];
  }
}
