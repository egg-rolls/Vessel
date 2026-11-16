/**
 * 参考真相提取器 —— timeline 迁移 A 阶段的**尺子**（ADR-105；plan-054 §1 判据 A-1）。
 *
 * 为什么必须在我们手里：新链路会拿"与旧链路逐条相等"来自证；如果"旧链路侧"也由实现方
 * 自己写，那就是拿自己的秤称自己的货。所以这一层**只读旧源、只产出可枚举的期望集合**：
 * 不写 timeline 代码、不落盘、不改任何现有读写路径，实现方只能**调用**它。
 *
 * 两份旧源（ADR-105 §0 表格前三行；**只读**）：
 *
 * | 源 | 路径 | 典型内容 |
 * | --- | --- | --- |
 * | 会话事件日志 | `<data>/sessions/<encodeURIComponent(sid)>/events.ndjson` | 结构事实：`run.started` / `user.message` / `llm.*` / `tool.call.*` / `session.created` |
 * | run trace | `<data>/events/<encodeURIComponent(run_id)>.jsonl` | trace-only：`hook.*` / `context.changed` / `run.checkpoint` / `session.saved` / `agent.*` |
 *
 * 路径口径与写侧逐字一致：`packages/core/src/tenant/tenant-paths.ts`（`sessionEventsFilePath`）、
 * `packages/core/src/observability/trace-recorder.ts`（`join(dir, encodeURIComponent(runId) + '.jsonl')`）。
 *
 * ## 合并四条规则（写死在这里，别处不许再定义一套）
 *
 * **① 身份 = `(run_id, type, ts)` 三元组 + 逐键最大重数**
 *
 * 两份源会同时包含同一个逻辑事件（一次 run 的 `tool.call.started` 既进会话日志、又进 trace），
 * 所以必须去重；但**不能用内容 id 四段去重**，因为"同一逻辑事件"的 payload 在两份源里
 * **本来就不同**：
 *   - trace 侧落盘前过 `redact()` + `summarizeLlmRequestEvent()`（`trace-recorder.ts#prepare`），
 *     于是 `llm.request` 丢了 `tools` 全量、多了 `last_message`，`llm.response` 有些条目丢
 *     `reasoning`，`run.completed` 也被改写；
 *   - 本机实测（`check-timeline-reference.ts` 每个样本都打 `digest_conflicts`）：同一
 *     `(run_id, type, ts)` 的 `llm.request` **全部**摘要不同。
 *   ⇒ 拿 `stableEventId` 的四段做跨源去重，会把每个 `llm.request` 都算成两条（凭空几千条假差异）。
 * 三段是唯一两份源同值的组合（`ts` 由生产者在事件对象上盖一次，落盘/广播/trace 都是同一个值）。
 *
 * 三段同毫秒同类型的两条不同事件确实存在（ADR-105 §1 P1），所以重数**不能**塌成 1：
 * 逐键取 `max(会话日志条数, trace 条数)`，成员取**条数多的那一侧**的 digest（相等时取会话日志）。
 * 为什么"多的一侧"当权威：会话日志存的是未脱敏、未摘要的原始 payload（A 阶段新链路要写的
 * 也是原始 payload），trace 侧是它的**有损投影**；两侧条数相等时选会话日志正好把原样留住。
 *
 * **② 归一化 payload：剔除出站侧才有的归属字段**
 *
 * 出站副本会被 `gateway.ts#withSessionAttribution` 往 `data` 里补 `session_id`（订阅侧要靠它
 * 把事件挂回会话），而"这条事件的 payload"不该包含传输层补的归属。判别式与
 * `apps/web/src/gateway/replay-source.ts#payloadForId` 完全一致（只有 `run_id` 非空且不是
 * `manual` 时才抹），因此本模块的 digest **恒等于** `stableEventId` 的第 4 段 —— 两条链路
 * 不会各自漂移。
 *
 * 如实记录（**与 ADR 描述不符，只记录不修**）：`replay-source.ts` 的注释说"磁盘副本是原始
 * 事件、没有 `session_id`"，本机实测**两份磁盘源都带 `data.session_id`**（242 份会话日志 606/606、
 * 1217 个 trace 文件全命中）。所以今天这条归一化对"跨源去重"是空操作；它仍然必要，因为
 * **出站副本**与磁盘副本之间确实差这一个键，而 digest 要能被两侧同时计算。
 *
 * **③ digest = 稳定序列化 + 双 FNV-1a 32 位**
 *
 * 本模块**自带**一份实现（对象键递归排序、`undefined`/非有限数归一、深度截断、两个独立
 * 种子并排）。0.54 B2 之后 web 侧**不再有**内容 id 去重（ADR-105 §6：单游标 + 单 seq 空间，
 * `apps/web/src/gateway/replay-source.ts` 整文件已删），而尺子**必须自己拿着秤** ——
 * 它不能依赖被测实现里的辅助函数（plan-054 §1 判据 A-1 的理由就是这个）。
 *
 * **④ 「旧源不包含、但 timeline 会包含」的类型 —— 0.54 stop-write 之后这条不再需要白名单**
 *
 * 以前这里有一张 `TIMELINE_ONLY_EVENT_TYPES`（恰好 chunk 家族两条），因为「旧源没有」与
 * 「timeline 有」只有在**两份源并存**时才是可比较的事实。`events.ndjson` 停写之后 timeline
 * 是唯一落盘口，白名单没有可表达的语义，已被删除：判据只剩 core 的 `isChunkEventType`
 * （唯一实现），{@link isTimelineOnlyType} 就是它的别名。
 */
import { join } from 'node:path';
import { isChunkEventType } from '../packages/core/src/timeline/types';

/** 稳定 JSON：对象键**递归排序**后序列化（同一份 payload 在任何到达顺序 / 任何进程里同值）。 */
function canonicalJson(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'null';
  const kind = typeof value;
  if (kind === 'number') return Number.isFinite(value as number) ? String(value) : 'null';
  if (kind === 'boolean') return value === true ? 'true' : 'false';
  if (kind === 'string') return JSON.stringify(value);
  if (kind !== 'object') return JSON.stringify(String(value));
  if (depth >= 12) return '"…"';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
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
 * payload 摘要：`<fnv(seed1)>.<fnv(seed2)>`，两个独立 32 位散列并排（单个 32 位在「上万条
 * 同型 payload」量级上的生日碰撞不可忽略）。
 *
 * `undefined` / `null` / `{}` 归一到同一个值：磁盘事件常常没有 `data`，「没有 payload」只有
 * 一个含义。（0.54 之前这段与 web 的 `payloadDigest` 逐字相同；现在只剩这一份。）
 */
export function payloadDigest(data: unknown): string {
  if (!hasPayload(data)) return '0';
  let json: string;
  try {
    json = canonicalJson(data);
  } catch {
    // 循环引用等畸形结构：宁可「所有畸形 payload 同 id」也不要整段失败。
    json = '!';
  }
  return `${fnv1a32(json, 0x811c9dc5)}.${fnv1a32(json, 0x9e3779b9)}`;
}

/**
 * 一条参考事件。**故意没有 `seq`**：三套 seq 互不映射（会话内自增 / 每 run 从 1 / 进程内全局），
 * 跨源比 seq 就是错的（ADR-105 §0 第 2 行）。顺序由 {@link loadSessionReference} 的规范排序给出。
 */
export interface RefEvent {
  /** 归属 run；`null` = 落盘记录里没有可用的 `run_id`。 */
  run_id: string | null;
  type: string;
  /** 生产者盖的毫秒时间戳。 */
  ts: number;
  /** 归一化 payload 的双 FNV-1a 32 位摘要（= `stableEventId` 的第 4 段）。 */
  payload_digest: string;
}

/** 默认数据目录（**WSL 口径**；Windows 版 bun 下由 {@link resolveDataDir} 翻成盘符路径）。 */
export const DEFAULT_DATA_DIR = '/mnt/c/Users/Lirui/.vessel/data';

const WSL_MOUNT = /^\/mnt\/([a-zA-Z])(\/.*)?$/;

/**
 * 数据目录归一化。
 *
 * 本仓库的 bun 是 **Windows 版**：`/mnt/c/...` 在它眼里是 `<当前盘>:\mnt\c\...`（不存在），
 * 所以 WSL 挂载路径必须翻成 `C:/...`。已经是盘符路径 / UNC 的原样返回，只做分隔符与尾斜杠归一。
 */
export function resolveDataDir(dataDir?: string): string {
  const raw = dataDir === undefined || dataDir.length === 0 ? DEFAULT_DATA_DIR : dataDir;
  const match = WSL_MOUNT.exec(raw);
  const drive = (match?.[1] ?? '').toUpperCase();
  const host = match === null ? raw : `${drive}:${match?.[2] ?? '/'}`;
  return host.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 规则 ④（0.54 stop-write 之后**已不存在**）：以前这里有一张
 * `TIMELINE_ONLY_EVENT_TYPES` 白名单，「旧源没有、timeline 会有」的类型（恰好两条：
 * `llm.stream.chunk` 与 `*.llm.stream.chunk`）。
 *
 * 它为什么能被删：白名单的存在前提是**两份源并存** —— 一边写 `events.ndjson`、一边写
 * timeline，才有「差集里哪几条是该有的」。0.54 停写旧源之后 timeline 是唯一落盘口，
 * 「旧源没有它」不再是一个可比较的事实，白名单也就没有可表达的语义。
 *
 * `isTimelineOnlyType` 保留，语义收紧成「**chunk 家族**」（带前缀的转发形态也算）：
 * 对拍脚本还要回答「timeline 里这条 chunk 是不是旧源本来就没有的那一类」，而这件事现在
 * 由 core 的 `isChunkEventType` 一处回答 —— 唯一实现，不再有第二份名单。
 */
export function isTimelineOnlyType(type: string): boolean {
  return isChunkEventType(type);
}

/**
 * 规则 ②：把 payload 里的出站归属字段抹掉，得到"用来算内容摘要的那一份"。
 *
 * 判别式与 `replay-source.ts#payloadForId` 一致（那函数没导出，所以这里按同一规则复述；
 * 摘要本身仍复用 `payloadDigest`，不另写）。`run_id` 为空 / `manual` 时**不抹**：
 * `session.*` 这类没有 run 的事件正是靠 `data.session_id` 才是唯一身份，抹掉会把两个会话
 * 的事件并成一条 —— 那是吞内容。方向不对称是有意的：宁可多一条重复，不可少一条内容。
 */
function payloadForDigest(payload: unknown, runId: string | null): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (runId === null || runId === 'manual') return payload;
  const record = payload as Record<string, unknown>;
  if (!('session_id' in record)) return payload;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === 'session_id') continue;
    copy[key] = record[key];
  }
  return copy;
}

/**
 * 把一条落盘记录（会话日志的一行 / trace 的一行，两者字段同形）折成 {@link RefEvent}。
 *
 * 形状不合约（`type` 非空字符串、`ts` 有限数）直接 `undefined` —— 不猜、不补 0。
 * 两份源的 envelope 差异（会话日志多 `v` / `session_id` / `fencing_token`，trace 多 `seq`）
 * 都不进摘要：**digest 只覆盖 `data`**。
 */
export function refEventFromRaw(raw: unknown): RefEvent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const type = record.type;
  const ts = record.ts;
  if (typeof type !== 'string' || type.length === 0) return undefined;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined;
  const runId =
    typeof record.run_id === 'string' && record.run_id.length > 0 ? record.run_id : null;
  return {
    run_id: runId,
    type,
    ts,
    payload_digest: payloadDigest(payloadForDigest(record.data, runId)),
  };
}

/** 规则 ① 的桶键：`(run_id, type, ts)`，**不含** digest（理由见文件头 ①）。 */
function bucketKey(event: RefEvent): string {
  return `${event.run_id ?? ''}|${event.type}|${event.ts}`;
}

/** 规范排序：`(run_id, type, ts, digest)`。码点比较（不用 localeCompare，避免环境相关抖动）。 */
function compareRef(a: RefEvent, b: RefEvent): number {
  const runA = a.run_id ?? '';
  const runB = b.run_id ?? '';
  if (runA !== runB) return runA < runB ? -1 : 1;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.payload_digest !== b.payload_digest) return a.payload_digest < b.payload_digest ? -1 : 1;
  return 0;
}

function collect(rows: readonly unknown[]): RefEvent[] {
  const out: RefEvent[] = [];
  for (const row of rows) {
    const event = refEventFromRaw(row);
    if (event !== undefined) out.push(event);
  }
  return out;
}

/**
 * 按出现顺序取 distinct 的非空 `run_id`（会话日志是 run 集合的可靠枚举器：每个 run 都有 `run.started`）。
 *
 * **`run_id` 是重载的，实测形状差异（只记录不修）**：会话级事件的 `run_id` 就是 `session_id`
 * （`session.created` 以及 `agent.spawned` / `agent.message.queued` / `agent.retired` /
 * `agent.closed`），对应 trace 文件 `events/<session_id>.jsonl` —— 本机 242 个会话里 236 个真有
 * 这个文件。所以枚举**不能**把 `run_id === session_id` 当"伪 run"剔掉：那样会静默丢掉整个
 * `agent.*` 家族（正是 ADR-105 §1 P3 说的"一份历史被劈成两半"）。
 */
function distinctRuns(events: readonly RefEvent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const event of events) {
    if (event.run_id === null || seen.has(event.run_id)) continue;
    seen.add(event.run_id);
    out.push(event.run_id);
  }
  return out;
}

function bucketize(events: readonly RefEvent[]): Map<string, RefEvent[]> {
  const map = new Map<string, RefEvent[]>();
  for (const event of events) {
    const key = bucketKey(event);
    const list = map.get(key);
    if (list === undefined) map.set(key, [event]);
    else list.push(event);
  }
  return map;
}

/** 规则 ①：逐键取 `max(日志, trace)` 条，成员取条数多的一侧（相等 → 会话日志）。 */
function mergeByIdentity(
  sessionEvents: readonly RefEvent[],
  traceEvents: readonly RefEvent[],
): RefEvent[] {
  const fromSession = bucketize(sessionEvents);
  const fromTrace = bucketize(traceEvents);
  const keys = new Set<string>([...fromSession.keys(), ...fromTrace.keys()]);
  const merged: RefEvent[] = [];
  for (const key of [...keys].sort()) {
    const sessionBucket = fromSession.get(key) ?? [];
    const traceBucket = fromTrace.get(key) ?? [];
    const authority = sessionBucket.length >= traceBucket.length ? sessionBucket : traceBucket;
    for (const event of authority) merged.push(event);
  }
  return merged.sort(compareRef);
}

/** 读取一个 ndjson / jsonl 文件；不存在 ⇒ 空（缺文件不是错误，缺 run 是事实）。 */
async function readNdjson(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return [];
  }
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // 坏行跳过：尺子只描述**可解析**的事实；坏行由 timeline 侧声明成 holes（ADR-105 §6）。
    }
  }
  return rows;
}

export interface LoadReferenceOptions {
  /** 数据根目录；缺省 {@link DEFAULT_DATA_DIR}（WSL / 盘符两种写法都收）。 */
  dataDir?: string;
  /**
   * 显式 run 列表（trace 侧读哪些文件）。
   *
   * 缺省 = **从会话事件日志推导**（按出现顺序取 distinct 非空 `run_id`）。传空数组 = 只算会话
   * 日志那一份（`check-timeline-reference.ts` 用它算 provenance）。`sources` 只含 `trace` 时
   * 必须提供，否则没有 run 可读、返回空。
   */
  runs?: string[];
  /** 只读哪些源；缺省两份都读。 */
  sources?: Array<'session-log' | 'trace'>;
}

/**
 * 规则 ①–③ 的出口：把两份旧源合并成一份**确定性、可枚举**的参考事件多重集。
 *
 * 确定性保证：输出按 `(run_id, type, ts, payload_digest)` 排序、去重按逐键最大重数、
 * 没有任何时间/路径/哈希顺序依赖 ⇒ 同一份磁盘内容跑两次逐字节相同（`check-timeline-reference.ts`
 * 断言 ①）。
 */
export async function loadSessionReference(
  sessionId: string,
  opts: LoadReferenceOptions = {},
): Promise<RefEvent[]> {
  const dataDir = resolveDataDir(opts.dataDir);
  const sources = opts.sources ?? ['session-log', 'trace'];
  const withLog = sources.includes('session-log');
  const withTrace = sources.includes('trace');

  const logPath = join(dataDir, 'sessions', encodeURIComponent(sessionId), 'events.ndjson');
  const fromLog = withLog ? collect(await readNdjson(logPath)) : [];

  if (!withTrace) return fromLog.sort(compareRef);

  const runIds = opts.runs ?? (withLog ? distinctRuns(fromLog) : []);
  const fromTrace: RefEvent[] = [];
  for (const runId of runIds) {
    const tracePath = join(dataDir, 'events', `${encodeURIComponent(runId)}.jsonl`);
    for (const event of collect(await readNdjson(tracePath))) fromTrace.push(event);
  }
  return mergeByIdentity(fromLog, fromTrace);
}

/**
 * 多重集差集（**不依赖顺序**）：`expected` 比 `actual` 多出来的实例是 `missing`，反之是 `extra`。
 *
 * 按完整四元组计数，所以"同一 key 出现了两次、实际只出现一次"会如实报 `missing = 1`。
 * 两个返回数组都按规范排序，便于逐字节比较输出。
 */
export function multisetDiff(
  expected: RefEvent[],
  actual: RefEvent[],
): { missing: RefEvent[]; extra: RefEvent[] } {
  const index = (events: RefEvent[]): Map<string, RefEvent[]> => {
    const map = new Map<string, RefEvent[]>();
    for (const event of events) {
      const key = `${event.run_id ?? ''}|${event.type}|${event.ts}|${event.payload_digest}`;
      const list = map.get(key);
      if (list === undefined) map.set(key, [event]);
      else list.push(event);
    }
    return map;
  };
  const expectedIndex = index(expected);
  const actualIndex = index(actual);
  const missing: RefEvent[] = [];
  const extra: RefEvent[] = [];
  for (const [key, list] of expectedIndex) {
    const deficit = list.length - (actualIndex.get(key)?.length ?? 0);
    for (let i = 0; i < deficit; i += 1) {
      const event = list[i];
      if (event !== undefined) missing.push(event);
    }
  }
  for (const [key, list] of actualIndex) {
    const surplus = list.length - (expectedIndex.get(key)?.length ?? 0);
    for (let i = 0; i < surplus; i += 1) {
      const event = list[i];
      if (event !== undefined) extra.push(event);
    }
  }
  return { missing: missing.sort(compareRef), extra: extra.sort(compareRef) };
}
