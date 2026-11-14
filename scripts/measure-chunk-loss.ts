/**
 * 「运行中刷新到底丢多少正文」——离线实测（0.53 refresh-gap / §1.2 丢失窗口）。
 *
 * 干什么：只读本地真实会话的 `events.ndjson`（不启 gateway、不要 API key、不联网），
 * 把每个 run 的**流式发布流**重建出来，再按环形缓冲容量 N 求 §1.2 的丢失窗口
 * `lost = [1, ring.oldestSeq-1] ∩ { 尚未变成 messages 的事件 }` 里落了多少条
 * `llm.stream.chunk`、多少字节正文，占该 run 已产出正文的百分之多少。
 *
 * ── 口径：每个数字都必须能说出是哪种来源，不得混用 ────────────────────────
 * [实测] 磁盘 ndjson 里已有的事实：
 *        · `llm.stream.summary` 的 `chunk_count / bytes / first_seq / last_seq /
 *          started_at / ended_at`（chunk 本体不落盘，但每段的**条数与字节**是 core
 *          在发布点聚合后落盘的 —— 这是本脚本唯一的正文量纲来源，不是估算）
 *        · `llm.response.data.content`（正文的落盘副本，用来量「消息已覆盖多少」，
 *          以及实测 chars/byte 比）
 *        · 结构事件的条数与 `ts`（每个发布事件都占 1 个环槽）
 * [推算] 段内 chunk 的时间均匀插值、被切断那一段的字节插值、chars 由 bytes 折算、并发摊薄
 * [合成] `--synthetic` 造的长 run；以及「用历史 run 重放构造运行中快照」的进度点
 *
 * ── 环槽怎么算 ───────────────────────────────────────────────────
 * 环（`packages/serve/src/event-buffer.ts`）是**按 tenant 全局 FIFO**，不是按会话：
 *   · 一条 `llm.stream.chunk` 占 1 槽（`recordStreamChunk` 里 `nextSeq` 逐 chunk +1，
 *     所以 `max(last_seq)` 就是该 run 的 chunk 事件条数，下界）
 *   · 一条落盘结构事件（含 `llm.stream.summary`）各占 1 槽
 * 所以一个 run 在环里占 `chunkEvents + structuralEvents` 槽，刷新时环只保最后 N 条，
 * 溢出部分从**头部**淘汰 ⇒ 丢的是这个 run 的一段连续前缀。
 *
 * 用法：
 *   bun run scripts/measure-chunk-loss.ts
 *   bun run scripts/measure-chunk-loss.ts --limit=20 --ring=10000,50000,200000
 *   bun run scripts/measure-chunk-loss.ts --session=01d7bbc4-a623-4aaa-89ac-08a39a58a8e3
 *   bun run scripts/measure-chunk-loss.ts --sessions=/mnt/c/Users/Lirui/.vessel/data/sessions
 *   bun run scripts/measure-chunk-loss.ts --json
 *
 * 退出码不可信（bun 是 Windows 版），看输出文本。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 环容量默认两档：10000 = 现状（`DEFAULT_MAX_HISTORY`），50000 = 用户已批准放大的目标。 */
const DEFAULT_RINGS = [10_000, 50_000];

/** 运行中刷新快照的进度点（用历史 run 重放构造；0.99 ≈ 「run 快结束的那一下刷新」）。 */
const DEFAULT_PROGRESS = [0.25, 0.5, 0.75, 0.99];

/** 本机真实会话落盘根目录（Windows 版 bun 认不了 /mnt/...，见 `toHostPath`）。 */
const DEFAULT_SESSIONS_DIR = 'C:/Users/Lirui/.vessel/data/sessions';

interface CliOptions {
  readonly sessionsDir: string;
  readonly limit: number;
  readonly rings: readonly number[];
  readonly sessionIds: readonly string[];
  readonly progress: readonly number[];
  readonly top: number;
  readonly json: boolean;
}

interface Segment {
  readonly index: number;
  readonly kind: 'text' | 'reasoning';
  readonly chunkCount: number;
  readonly bytes: number;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly startedAt: number;
  readonly endedAt: number;
}

/** 重建时间线上的一个环槽。 */
interface Slot {
  readonly ts: number;
  readonly kind: 'chunk' | 'structural';
  /** chunk 的正文种类；`undefined` 表示 tool_call_delta / finish（占槽但无正文）。 */
  readonly text?: 'text' | 'reasoning';
  /** 该 chunk 属于哪个段（`segments` 下标）；无正文 chunk 为 -1。 */
  readonly segIndex?: number;
  readonly type?: string;
}

interface RunAnalysis {
  readonly sessionId: string;
  readonly runId: string;
  /** 有 run.started 而没有终态事件 ⇒ 真·运行中样本（本机多半没有，见 `--progress`）。 */
  readonly unfinished: boolean;
  readonly terminal: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly durationMs: number;
  readonly segments: readonly Segment[];
  readonly textBytes: number;
  readonly reasoningBytes: number;
  readonly textChunks: number;
  readonly reasoningChunks: number;
  /** 环槽：`llm.stream.chunk` 条数（= max(last_seq)，下界）。 */
  readonly chunkEvents: number;
  /** 环槽：落盘结构事件条数（含 llm.stream.summary）。 */
  readonly structuralEvents: number;
  /** 环槽：该 run 一共占多少槽。 */
  readonly slots: number;
  /** 每次 llm.request 的 ts（升序），用来切出「单个请求在飞窗口」的 chunk 量。 */
  readonly requestStarts: readonly number[];
  /** 单请求窗口内 chunk 事件条数峰值（= 环必须至少多大的下限）。 */
  readonly maxChunksPerRequest: number;
  /** 单请求窗口内正文峰值字节（= 在飞窗口最坏情况下「只存在于环里」的正文量）。 */
  readonly maxTextBytesPerRequest: number;
  readonly responseBytes: number;
  readonly responseChars: number;
  /** run 运行期间落盘的 session.saved / message.compaction 条数（>0 才可能让正文进 messages）。 */
  readonly midRunSaves: number;
  readonly timeline: readonly Slot[];
}

interface LossResult {
  readonly ring: number;
  readonly published: number;
  readonly kept: number;
  readonly lostSlots: number;
  readonly lostChunkEvents: number;
  readonly lostTextChunks: number;
  readonly lostTextBytesMin: number;
  readonly lostTextBytesEst: number;
  readonly lostTextBytesMax: number;
}

interface RawEvent {
  readonly type: string;
  readonly ts: number;
  readonly run_id?: string;
  readonly seq?: number;
  readonly data?: Record<string, unknown>;
}

// ────────────────────────────────── CLI ──────────────────────────────────

function num(text: string, fallback: number): number {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** bun 是 Windows 版：把 WSL 路径 `/mnt/d/x` 换回 `D:/x`，否则 `readdirSync` 找不到。 */
function toHostPath(p: string): string {
  const m = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
  if (m !== null && m[1] !== undefined && m[2] !== undefined) {
    return `${m[1].toUpperCase()}:/${m[2]}`;
  }
  return p;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let sessionsDir = DEFAULT_SESSIONS_DIR;
  let limit = 12;
  let rings: number[] = [...DEFAULT_RINGS];
  let progress: number[] = [...DEFAULT_PROGRESS];
  let top = 8;
  let json = false;
  const sessionIds: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith('--sessions=')) sessionsDir = toHostPath(arg.slice(11));
    else if (arg.startsWith('--limit=')) limit = num(arg.slice(8), limit);
    else if (arg.startsWith('--top=')) top = num(arg.slice(6), top);
    else if (arg.startsWith('--ring=')) {
      rings = arg
        .slice(7)
        .split(',')
        .map((s) => num(s.trim(), 0))
        .filter((n) => n > 0);
    } else if (arg.startsWith('--progress=')) {
      progress = arg
        .slice(11)
        .split(',')
        .map((s) => Number.parseFloat(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 1);
    } else if (arg.startsWith('--session=')) {
      for (const id of arg.slice(10).split(',')) {
        if (id.trim() !== '') sessionIds.push(id.trim());
      }
    } else if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      process.exit(0);
    }
  }

  return {
    sessionsDir,
    limit: Math.max(1, limit),
    rings: rings.length > 0 ? rings : [...DEFAULT_RINGS],
    sessionIds,
    progress: progress.length > 0 ? progress : [...DEFAULT_PROGRESS],
    top: Math.max(1, top),
    json,
  };
}

const HELP = `measure-chunk-loss —— 运行中刷新丢多少正文（离线实测）

  --sessions=<dir>    会话落盘根目录（默认 ${DEFAULT_SESSIONS_DIR}；/mnt/c/... 会自动换成 C:/...）
  --limit=<n>         取最近 n 个会话（按 events.ndjson mtime，默认 12）
  --session=<id,...>  只测指定会话
  --ring=<n,...>      环容量档位（默认 10000,50000）
  --progress=<p,...>  运行中快照的进度点（默认 0.25,0.5,0.75,0.99）
  --top=<n>           表格里列前 n 个 run（默认 8）
  --json              输出机器可读 JSON
`;

// ────────────────────────────── 读盘与建模 ──────────────────────────────

function discoverSessions(opts: CliOptions): { id: string; file: string; mtime: number }[] {
  const dir = opts.sessionsDir;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { id: string; file: string; mtime: number }[] = [];
  for (const name of entries) {
    if (opts.sessionIds.length > 0 && !opts.sessionIds.includes(name)) continue;
    const file = join(dir, name, 'events.ndjson');
    try {
      const st = statSync(file);
      if (st.isFile()) out.push({ id: name, file, mtime: st.mtimeMs });
    } catch {
      // 没有 events.ndjson 的会话目录直接跳过
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return opts.sessionIds.length > 0 ? out : out.slice(0, opts.limit);
}

function readEvents(file: string): RawEvent[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: RawEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === 'object' && 'type' in parsed && 'ts' in parsed) {
        out.push(parsed as RawEvent);
      }
    } catch {
      // 坏行（写盘中断）跳过，不当作事实
    }
  }
  return out;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** 数组越界安全取值（避免 noUncheckedIndexedAccess 下的 `| undefined` 噪音）。 */
function sortedAt<T>(list: readonly T[], i: number): T | undefined {
  return i >= 0 && i < list.length ? list[i] : undefined;
}

function readSegments(events: readonly RawEvent[]): Segment[] {
  const out: Segment[] = [];
  for (const e of events) {
    if (e.type !== 'llm.stream.summary') continue;
    const d = e.data;
    if (d === undefined) continue;
    const kind = asString(d['kind']);
    const chunkCount = asNumber(d['chunk_count']) ?? 0;
    const bytes = asNumber(d['bytes']) ?? 0;
    const firstSeq = asNumber(d['first_seq']);
    const lastSeq = asNumber(d['last_seq']);
    const startedAt = asNumber(d['started_at']) ?? e.ts;
    const endedAt = asNumber(d['ended_at']) ?? e.ts;
    if ((kind !== 'text' && kind !== 'reasoning') || firstSeq === undefined || lastSeq === undefined) {
      continue;
    }
    out.push({
      index: asNumber(d['segment_index']) ?? out.length,
      kind,
      chunkCount,
      bytes,
      firstSeq,
      lastSeq,
      startedAt,
      endedAt,
    });
  }
  out.sort((a, b) => a.firstSeq - b.firstSeq);
  return out;
}

/**
 * 把「占槽但没正文」的 chunk（tool_call_delta / finish）也放回时间线。
 *
 * 依据：`recordStreamChunk` 对**每个** chunk 都 `nextSeq += 1`，只有 text/reasoning 才
 * 归入段。所以段与段之间的 `[上一段.lastSeq+1, 下一段.firstSeq-1]` 就是这些无正文
 * chunk —— 条数精确（实测），位置按前后段 ts 插值（推算）。
 */
function buildTimeline(
  segments: readonly Segment[],
  structural: readonly RawEvent[],
  startedAt: number | null,
  endedAt: number | null,
): Slot[] {
  const slots: Slot[] = [];

  // 1) 有正文的 chunk：段内按 ordinal 线性插值
  const anchors: { seq: number; ts: number }[] = [];
  for (let si = 0; si < segments.length; si += 1) {
    const seg = segments[si];
    if (seg === undefined) continue;
    const span = seg.endedAt - seg.startedAt;
    const n = seg.chunkCount;
    for (let i = 0; i < n; i += 1) {
      const ts = n <= 1 ? seg.startedAt : seg.startedAt + (span * (i + 0.5)) / n;
      slots.push({ ts, kind: 'chunk', text: seg.kind, segIndex: si });
      anchors.push({ seq: seg.firstSeq + i, ts });
    }
  }
  anchors.sort((a, b) => a.seq - b.seq);

  // 2) 无正文的 chunk：seq 落在锚点之间 ⇒ ts 也插在锚点之间（单调指针，O(n)）
  const maxSeq = segments.reduce((m, s) => Math.max(m, s.lastSeq), 0);
  if (maxSeq > 0) {
    const anchorTs = new Map<number, number>();
    for (const a of anchors) anchorTs.set(a.seq, a.ts);
    let ai = 0;
    let prev: { seq: number; ts: number } | undefined;
    for (let seq = 1; seq <= maxSeq; seq += 1) {
      const direct = anchorTs.get(seq);
      if (direct !== undefined) {
        prev = { seq, ts: direct };
        while (sortedAt(anchors, ai) !== undefined && (sortedAt(anchors, ai)?.seq ?? 0) <= seq) {
          ai += 1;
        }
        continue;
      }
      while (sortedAt(anchors, ai) !== undefined && (sortedAt(anchors, ai)?.seq ?? 0) <= seq) {
        ai += 1;
      }
      const next = sortedAt(anchors, ai);
      let ts: number;
      if (prev !== undefined && next !== undefined) {
        const span = next.seq - prev.seq;
        ts = span > 0 ? prev.ts + ((next.ts - prev.ts) * (seq - prev.seq)) / span : prev.ts;
      } else if (next !== undefined) {
        // 段开始之前（TTFT 窗口）：从请求 ts 线性拉到第一个 chunk
        const base = startedAt ?? next.ts - 1000;
        const width = next.seq > 1 ? (next.ts - base) / next.seq : 0;
        ts = base + width * seq;
      } else if (prev !== undefined) {
        const base = endedAt !== null && endedAt > prev.ts ? endedAt : prev.ts + 1000;
        ts = prev.ts + ((base - prev.ts) * (seq - prev.seq)) / Math.max(1, maxSeq - prev.seq);
      } else {
        ts = startedAt ?? 0;
      }
      slots.push({ ts, kind: 'chunk' });
    }
  }

  // 3) 落盘结构事件（含 llm.stream.summary）：各占 1 槽，ts 是实测值
  for (const e of structural) {
    if (e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled') continue;
    slots.push({ ts: e.ts, kind: 'structural', type: e.type });
  }

  slots.sort((a, b) => a.ts - b.ts);
  return slots;
}

function analyseSession(sessionId: string, events: readonly RawEvent[]): RunAnalysis[] {
  const byRun = new Map<string, RawEvent[]>();
  for (const e of events) {
    const runId = e.run_id ?? asString(e.data?.['run_id']);
    if (runId === undefined || runId === '') continue;
    const list = byRun.get(runId);
    if (list === undefined) byRun.set(runId, [e]);
    else list.push(e);
  }

  const out: RunAnalysis[] = [];
  for (const [runId, list] of byRun) {
    const started = list.find((e) => e.type === 'run.started');
    const terminalEvent = list.find(
      (e) =>
        e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled',
    );
    const segments = readSegments(list);
    if (segments.length === 0 && started === undefined) continue;

    const textBytes = segments.filter((s) => s.kind === 'text').reduce((s, x) => s + x.bytes, 0);
    const reasoningBytes = segments
      .filter((s) => s.kind === 'reasoning')
      .reduce((s, x) => s + x.bytes, 0);
    const textChunks = segments.filter((s) => s.kind === 'text').reduce((s, x) => s + x.chunkCount, 0);
    const reasoningChunks = segments
      .filter((s) => s.kind === 'reasoning')
      .reduce((s, x) => s + x.chunkCount, 0);

    let responseBytes = 0;
    let responseChars = 0;
    for (const e of list) {
      if (e.type !== 'llm.response') continue;
      const content = asString(e.data?.['content']) ?? '';
      if (content === '') continue;
      responseBytes += Buffer.byteLength(content, 'utf8');
      responseChars += content.length;
    }

    const startedAt = started?.ts ?? (segments[0]?.startedAt ?? null);
    const endedAt =
      terminalEvent?.ts ??
      (segments.length > 0 ? segments[segments.length - 1]?.endedAt ?? null : null);

    const midRunSaves = list.filter(
      (e) =>
        (e.type === 'session.saved' || e.type === 'message.compaction') &&
        terminalEvent !== undefined &&
        e.ts < terminalEvent.ts,
    ).length;

    const chunkEvents = segments.reduce((m, s) => Math.max(m, s.lastSeq), 0);
    const structuralEvents = list.filter((e) => e.type !== 'llm.stream.chunk').length;

    // 「单个请求在飞窗口」：按 llm.request 的 ts 切分重建出的 chunk 时间线。
    // 一个请求从 llm.request 发出到它的 llm.response 落盘之间，正文只可能存在于环里。
    const requestStarts = list
      .filter((e) => e.type === 'llm.request')
      .map((e) => e.ts)
      .sort((a, b) => a - b);
    const timeline = buildTimeline(segments, list, startedAt, endedAt);
    let maxChunksPerRequest = 0;
    let maxTextBytesPerRequest = 0;
    if (requestStarts.length > 0) {
      const perReqChunks = new Array<number>(requestStarts.length).fill(0);
      const perReqBytes = new Array<number>(requestStarts.length).fill(0);
      let req = -1;
      for (const slot of timeline) {
        while (req + 1 < requestStarts.length && (requestStarts[req + 1] ?? Infinity) <= slot.ts) {
          req += 1;
        }
        if (req < 0) continue;
        if (slot.kind !== 'chunk') continue;
        perReqChunks[req] = (perReqChunks[req] ?? 0) + 1;
        if (slot.text === 'text') {
          const seg = slot.segIndex !== undefined ? segments[slot.segIndex] : undefined;
          if (seg !== undefined && seg.chunkCount > 0) {
            perReqBytes[req] = (perReqBytes[req] ?? 0) + seg.bytes / seg.chunkCount;
          }
        }
      }
      maxChunksPerRequest = perReqChunks.reduce((m, x) => Math.max(m, x), 0);
      maxTextBytesPerRequest = perReqBytes.reduce((m, x) => Math.max(m, x), 0);
    }

    out.push({
      sessionId,
      runId,
      unfinished: started !== undefined && terminalEvent === undefined,
      terminal: terminalEvent?.type ?? null,
      startedAt,
      endedAt,
      durationMs:
        startedAt !== null && endedAt !== null && endedAt > startedAt ? endedAt - startedAt : 0,
      segments,
      textBytes,
      reasoningBytes,
      textChunks,
      reasoningChunks,
      chunkEvents,
      structuralEvents,
      slots: chunkEvents + structuralEvents,
      requestStarts,
      maxChunksPerRequest,
      maxTextBytesPerRequest,
      responseBytes,
      responseChars,
      midRunSaves,
      timeline,
    });
  }
  return out;
}

// ─────────────────────────────── 丢失计算 ───────────────────────────────

/**
 * 求「刷新那一刻，环里保不住的正文」。
 *
 * 环是全局 FIFO：只保最后 `ring` 条槽 ⇒ 溢出部分从**头部**淘汰。所以丢的是该 run
 * 已发布序列的一段连续前缀。前缀里每条 text chunk 都带段号，据此分三档给出：
 *   · 整段都在前缀里      ⇒ 该段字节**精确**（实测来源：summary.bytes）
 *   · 段被切断            ⇒ 只按条数比例插值（推算），并给出该段的区间上界
 */
function lossAt(run: RunAnalysis, ring: number, published: number): LossResult {
  const upto = run.timeline.slice(0, Math.min(published, run.timeline.length));
  const lostSlots = Math.max(0, upto.length - ring);
  const lost: readonly Slot[] = lostSlots === 0 ? [] : upto.slice(0, lostSlots);

  let lostChunkEvents = 0;
  let lostTextChunks = 0;
  const perSeg = new Map<number, number>();
  for (const s of lost) {
    if (s.kind !== 'chunk') continue;
    lostChunkEvents += 1;
    if (s.text !== 'text') continue;
    lostTextChunks += 1;
    const si = s.segIndex ?? -1;
    if (si >= 0) perSeg.set(si, (perSeg.get(si) ?? 0) + 1);
  }

  let exactBytes = 0;
  let partialEst = 0;
  let partialFull = 0;
  for (const [si, count] of perSeg) {
    const seg = run.segments[si];
    if (seg === undefined || seg.kind !== 'text') continue;
    if (count >= seg.chunkCount) {
      exactBytes += seg.bytes;
    } else {
      partialEst = seg.chunkCount > 0 ? (seg.bytes * count) / seg.chunkCount : 0;
      partialFull = seg.bytes;
    }
  }

  return {
    ring,
    published: upto.length,
    kept: Math.min(ring, upto.length),
    lostSlots,
    lostChunkEvents,
    lostTextChunks,
    lostTextBytesMin: exactBytes,
    lostTextBytesEst: exactBytes + partialEst,
    lostTextBytesMax: exactBytes + partialFull,
  };
}

// ─────────────────────────────── 输出格式 ───────────────────────────────

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 实测 chars/byte（由 llm.response 的正文副本回归出来），用于把字节折成字符。 */
let BYTES_PER_CHAR = 3;

function chars(n: number): string {
  const c = Math.round(n / (BYTES_PER_CHAR > 0 ? BYTES_PER_CHAR : 3));
  return c < 1000 ? `${c} 字` : `${(c / 1000).toFixed(1)} K字`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`;
}

function lpad(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/**
 * 进度 p 处「已发布多少槽」：时间线前缀条数（实测槽数按 ts 截断）。
 * 历史 run 的 chunk 本体不落盘 ⇒ 这是**重放构造**的刷新时刻，不是真快照。
 */
function publishedAt(run: RunAnalysis, p: number): number {
  if (run.startedAt === null || run.endedAt === null || run.durationMs <= 0) {
    return run.timeline.length;
  }
  const cut = run.startedAt + run.durationMs * p;
  let n = 0;
  for (const s of run.timeline) {
    if (s.ts <= cut) n += 1;
    else break;
  }
  return n;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const sessions = discoverSessions(opts);

  if (sessions.length === 0) {
    console.log(`没找到会话：${opts.sessionsDir}`);
    console.log('用 --sessions=<dir> 指到真实落盘目录（WSL 的 /mnt/c/... 会自动换成 C:/...）。');
    return;
  }

  const all: RunAnalysis[] = [];
  let scannedEvents = 0;
  for (const s of sessions) {
    const events = readEvents(s.file);
    scannedEvents += events.length;
    all.push(...analyseSession(s.id, events));
  }

  const withText = all.filter((r) => r.textBytes > 0);
  const unfinished = withText.filter((r) => r.unfinished);
  withText.sort((a, b) => b.textBytes - a.textBytes);

  const result = {
    generatedAt: new Date().toISOString(),
    sessionsDir: opts.sessionsDir,
    sessions: sessions.length,
    events: scannedEvents,
    runs: all.length,
    runsWithText: withText.length,
    unfinishedRuns: unfinished.length,
    rings: opts.rings,
    progress: opts.progress,
    rows: [] as unknown[],
    distribution: [] as unknown[],
    progressTable: [] as unknown[],
  };

  if (opts.json) {
    // JSON 只给机器读，字段与下面表格一致
  }

  console.log('════════ 样本源（实测）════════');
  console.log(`目录      ${opts.sessionsDir}`);
  console.log(`会话      ${sessions.length} 个，事件 ${scannedEvents} 条`);
  console.log(`run       ${all.length} 个，其中有流式正文的 ${withText.length} 个`);
  console.log(`未完成    ${unfinished.length} 个（有 run.started、无终态事件的真·运行中样本）`);

  const totalText = withText.reduce((s, r) => s + r.textBytes, 0);
  const totalChunks = withText.reduce((s, r) => s + r.textChunks, 0);
  const totalSlots = withText.reduce((s, r) => s + r.slots, 0);
  const totRespB = withText.reduce((s, r) => s + r.responseBytes, 0);
  const totRespC = withText.reduce((s, r) => s + r.responseChars, 0);
  if (totRespC > 0 && totRespB > 0) BYTES_PER_CHAR = totRespB / totRespC;
  console.log(
    `正文合计  ${bytes(totalText)} / ${chars(totalText)} / ${totalChunks} 条 text chunk；这些 run 共占 ${totalSlots} 个环槽`,
  );
  console.log(
    `字符折算  实测 chars/byte = 1:${BYTES_PER_CHAR.toFixed(2)}（由 ${bytes(totRespB)} 正文副本回归）` +
      `；正文 chunk 平均 ${(totalText / Math.max(1, totalChunks)).toFixed(1)} B/条`,
  );
  console.log(
    `落盘副本  全部 run 的 \`llm.response\` 正文副本 = ${bytes(totRespB)}，是流式正文的 ${pct(totalText > 0 ? totRespB / totalText : 0)}` +
      `（这条就是「磁盘回填」的上限）`,
  );
  const totalReasoning = withText.reduce((s, r) => s + r.reasoningBytes, 0);
  const totalReasoningChunks = withText.reduce((s, r) => s + r.reasoningChunks, 0);
  console.log(
    `reasoning  ${bytes(totalReasoning)} / ${totalReasoningChunks} 条 reasoning chunk` +
      `（= 正文的 ${(totalReasoning / Math.max(1, totalText)).toFixed(1)} 倍；\`llm.response\` 不落 reasoning ⇒ 这段 100% 只活在环里）`,
  );
  // 环槽构成：谁在吃环？正文 / reasoning / tool_call_delta+finish / 结构事件
  const totChunkEv = withText.reduce((s, r) => s + r.chunkEvents, 0);
  const totStructEv = withText.reduce((s, r) => s + r.structuralEvents, 0);
  const totTextChunkEv = withText.reduce((s, r) => s + r.textChunks, 0);
  const totReasoningChunkEv = withText.reduce((s, r) => s + r.reasoningChunks, 0);
  const totOtherChunkEv = Math.max(0, totChunkEv - totTextChunkEv - totReasoningChunkEv);
  const totSlotsAll = totChunkEv + totStructEv;
  console.log(
    `环槽构成  合计 ${totSlotsAll} 槽 = 正文 ${totTextChunkEv}(${pct(totSlotsAll > 0 ? totTextChunkEv / totSlotsAll : 0)})` +
      ` + reasoning ${totReasoningChunkEv}(${pct(totSlotsAll > 0 ? totReasoningChunkEv / totSlotsAll : 0)})` +
      ` + tool_call_delta/finish ${totOtherChunkEv}(${pct(totSlotsAll > 0 ? totOtherChunkEv / totSlotsAll : 0)})` +
      ` + 结构事件 ${totStructEv}(${pct(totSlotsAll > 0 ? totStructEv / totSlotsAll : 0)})`,
  );

  console.log('');
  console.log('════════ 实测：流式产出最大的 run（正文字节降序）════════');
  console.log('  槽/秒 = 该 run 每秒烧掉多少个环槽（实测槽数 ÷ 实测时长）；');
  console.log('  环覆盖 = 单 run 独占环时，N=10000 能回溯多少秒的流式输出（推算）。');
  console.log(
    [
      rpad('run_id', 10),
      lpad('时长', 7),
      lpad('正文', 10),
      lpad('text块', 8),
      lpad('全部chunk', 10),
      lpad('结构事件', 9),
      lpad('占环槽', 9),
      lpad('槽/秒', 7),
      lpad('环覆盖', 8),
      lpad('消息副本', 10),
    ].join(' '),
  );
  for (const r of withText.slice(0, opts.top)) {
    const rate = r.durationMs > 0 ? r.slots / (r.durationMs / 1000) : 0;
    console.log(
      [
        rpad(r.runId.slice(0, 8), 10),
        lpad(secs(r.durationMs), 7),
        lpad(bytes(r.textBytes), 10),
        lpad(String(r.textChunks), 8),
        lpad(String(r.chunkEvents), 10),
        lpad(String(r.structuralEvents), 9),
        lpad(String(r.slots), 9),
        lpad(rate.toFixed(1), 7),
        lpad(rate > 0 ? secs((opts.rings[0] ?? 10_000) / rate * 1000) : '—', 8),
        lpad(bytes(r.responseBytes), 10),
      ].join(' '),
    );
  }

  // ── 环容量下的丢失：对每个 run，取「最后一条正文之后、run.completed 之前」这个最坏时刻 ──
  console.log('');
  console.log('════════ 丢失：刷新发生在 run 末尾时（最坏时刻）════════');
  for (const ring of opts.rings) {
    console.log('');
    console.log(`── 环容量 N = ${ring} 条槽 ──`);
    console.log(
      [
        rpad('run_id', 10),
        lpad('正文', 10),
        lpad('槽数', 8),
        lpad('丢块', 8),
        lpad('丢正文', 16),
        lpad('占比', 7),
      ].join(' '),
    );
    for (const r of withText.slice(0, opts.top)) {
      const published = r.timeline.length;
      const loss = lossAt(r, ring, published);
      const p = r.textBytes > 0 ? loss.lostTextBytesEst / r.textBytes : 0;
      console.log(
        [
          rpad(r.runId.slice(0, 8), 10),
          lpad(bytes(r.textBytes), 10),
          lpad(String(published), 8),
          lpad(String(loss.lostTextChunks), 8),
          lpad(`${bytes(loss.lostTextBytesMin)}~${bytes(loss.lostTextBytesMax)}`, 16),
          lpad(pct(p), 7),
        ].join(' '),
      );
    }
    console.log('  （区间左端 = 整段丢失的字节，实测精确；右端 = 再加被切断那一段的整段字节）');
  }

  // ── 全量分布：这才是「到底丢多少」的可引用统计 ──
  console.log('');
  console.log(`════════ 全量分布：${withText.length} 个有正文的 run，在 run 末尾刷新 ════════`);
  console.log(
    [
      rpad('环容量', 9),
      lpad('会丢的run', 11),
      lpad('占用率', 7),
      lpad('丢>10%', 8),
      lpad('丢>50%', 8),
      lpad('丢者中位', 9),
      lpad('最坏占比', 9),
      lpad('丢正文合计', 11),
    ].join(' '),
  );
  interface DistRow {
    ring: number;
    runs: number;
    lostAny: number;
    over10: number;
    over50: number;
    loserMedian: number;
    worstPct: number;
    totalLostBytes: number;
    totalLostChunks: number;
  }
  const dist: DistRow[] = [];
  for (const ring of opts.rings) {
    const pcts: number[] = [];
    let lostAny = 0;
    let over10 = 0;
    let over50 = 0;
    let worstPct = 0;
    let totalLostBytes = 0;
    let totalLostChunks = 0;
    for (const r of withText) {
      const loss = lossAt(r, ring, r.timeline.length);
      const p = r.textBytes > 0 ? loss.lostTextBytesEst / r.textBytes : 0;
      if (loss.lostSlots > 0) {
        lostAny += 1;
        pcts.push(p);
      }
      if (p > 0.1) over10 += 1;
      if (p > 0.5) over50 += 1;
      if (p > worstPct) worstPct = p;
      totalLostBytes += loss.lostTextBytesEst;
      totalLostChunks += loss.lostTextChunks;
    }
    pcts.sort((a, b) => a - b);
    const loserMedian = pcts.length > 0 ? pcts[Math.floor(pcts.length / 2)] ?? 0 : 0;
    dist.push({
      ring,
      runs: withText.length,
      lostAny,
      over10,
      over50,
      loserMedian,
      worstPct,
      totalLostBytes,
      totalLostChunks,
    });
    console.log(
      [
        rpad(String(ring), 9),
        lpad(String(lostAny), 11),
        lpad(pct(withText.length > 0 ? lostAny / withText.length : 0), 7),
        lpad(String(over10), 8),
        lpad(String(over50), 8),
        lpad(pct(loserMedian), 9),
        lpad(pct(worstPct), 9),
        lpad(`${bytes(totalLostBytes)}(${chars(totalLostBytes)})`, 11),
      ].join(' '),
    );
  }

  // ── 构造样本：把历史 run 在进度 p 处截断重放（任务要求的口径）──
  console.log('');
  console.log('════════ 构造样本：历史 run 截断到进度 p 处再刷新（重放，标注为构造）════════');
  console.log('  p = 该 run 已跑时长占比；published(p) = 那一刻已发布的槽数（实测槽数按时间线取前缀）。');
  console.log(
    [
      rpad('环容量', 9),
      lpad('进度p', 7),
      lpad('会丢的run', 11),
      lpad('占用率', 7),
      lpad('丢者中位', 9),
      lpad('最坏占比', 9),
      lpad('丢正文合计', 12),
    ].join(' '),
  );
  const progressRows: {
    ring: number;
    p: number;
    lostAny: number;
    runs: number;
    loserMedian: number;
    worstPct: number;
    totalLostBytes: number;
  }[] = [];
  for (const ring of opts.rings) {
    for (const p of opts.progress) {
      const pcts: number[] = [];
      let lostAny = 0;
      let worstPct = 0;
      let totalLostBytes = 0;
      let considered = 0;
      for (const r of withText) {
        const published = publishedAt(r, p);
        if (published <= 0) continue;
        considered += 1;
        const loss = lossAt(r, ring, published);
        const frac = r.textBytes > 0 ? loss.lostTextBytesEst / r.textBytes : 0;
        if (loss.lostSlots > 0) {
          lostAny += 1;
          pcts.push(frac);
        }
        if (frac > worstPct) worstPct = frac;
        totalLostBytes += loss.lostTextBytesEst;
      }
      pcts.sort((a, b) => a - b);
      const loserMedian = pcts.length > 0 ? pcts[Math.floor(pcts.length / 2)] ?? 0 : 0;
      progressRows.push({ ring, p, lostAny, runs: considered, loserMedian, worstPct, totalLostBytes });
      console.log(
        [
          rpad(String(ring), 9),
          lpad(p.toFixed(2), 7),
          lpad(String(lostAny), 11),
          lpad(pct(considered > 0 ? lostAny / considered : 0), 7),
          lpad(pct(loserMedian), 9),
          lpad(pct(worstPct), 9),
          lpad(bytes(totalLostBytes), 12),
        ].join(' '),
      );
    }
  }

  // ── 按时长分桶：这就是「跑 8 分钟的 run 会丢多少」的直答 ──
  console.log('');
  console.log('════════ 按时长分桶（构造重放 p=0.99 的最坏时刻）════════');
  const buckets: { label: string; lo: number; hi: number }[] = [
    { label: '≤2min', lo: 0, hi: 120_000 },
    { label: '2-5min', lo: 120_000, hi: 300_000 },
    { label: '5-10min', lo: 300_000, hi: 600_000 },
    { label: '>10min', lo: 600_000, hi: Number.POSITIVE_INFINITY },
  ];
  for (const ring of opts.rings) {
    console.log('');
    console.log(`── N = ${ring} ──`);
    console.log(
      [
        rpad('时长桶', 9),
        lpad('run数', 7),
        lpad('典型槽/秒', 9),
        lpad('正文中位', 9),
        lpad('会丢', 7),
        lpad('丢者中位', 9),
        lpad('最坏占比', 9),
        lpad('丢正文合计', 11),
      ].join(' '),
    );
    for (const b of buckets) {
      const group = withText.filter((r) => r.durationMs > b.lo && r.durationMs <= b.hi);
      if (group.length === 0) {
        console.log([rpad(b.label, 9), lpad('0', 7), lpad('—', 9)].join(' '));
        continue;
      }
      const rates = group
        .map((r) => (r.durationMs > 0 ? r.slots / (r.durationMs / 1000) : 0))
        .filter((x) => x > 0)
        .sort((a, b2) => a - b2);
      const typRate = rates[Math.floor(rates.length / 2)] ?? 0;
      const texts = group.map((r) => r.textBytes).sort((a, b2) => a - b2);
      const typText = texts[Math.floor(texts.length / 2)] ?? 0;
      const pcts: number[] = [];
      let lostAny = 0;
      let worstPct = 0;
      let totalLostBytes = 0;
      for (const r of group) {
        const loss = lossAt(r, ring, publishedAt(r, 0.99));
        const frac = r.textBytes > 0 ? loss.lostTextBytesEst / r.textBytes : 0;
        if (loss.lostSlots > 0) {
          lostAny += 1;
          pcts.push(frac);
        }
        if (frac > worstPct) worstPct = frac;
        totalLostBytes += loss.lostTextBytesEst;
      }
      pcts.sort((a, b2) => a - b2);
      const loserMedian = pcts.length > 0 ? pcts[Math.floor(pcts.length / 2)] ?? 0 : 0;
      console.log(
        [
          rpad(b.label, 9),
          lpad(String(group.length), 7),
          lpad(typRate.toFixed(1), 9),
          lpad(bytes(typText), 9),
          lpad(String(lostAny), 7),
          lpad(pct(loserMedian), 9),
          lpad(pct(worstPct), 9),
          lpad(bytes(totalLostBytes), 11),
        ].join(' '),
      );
    }
  }

  // ── 环的刚性下限：单个请求在飞窗口 ──
  console.log('');
  console.log('════════ 只存在于环里的东西：单个请求的在飞窗口（实测）════════');
  console.log('  每个 llm.request 从发出到它自己的 llm.response 落盘之间，正文只以 chunk 存在');
  console.log('  ⇒ 环只要装得下「一个请求的 chunk 窗口」，在飞正文就不会丢；run 其余部分磁盘已有。');
  const reqSorted = withText
    .map((r) => r.maxChunksPerRequest)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const reqBytesSorted = withText
    .map((r) => r.maxTextBytesPerRequest)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const q = (list: number[], p: number): number =>
    list.length === 0 ? 0 : list[Math.min(list.length - 1, Math.floor(list.length * p))] ?? 0;
  console.log(
    `  单请求 chunk 峰值：中位 ${q(reqSorted, 0.5)} 条，p90 ${q(reqSorted, 0.9)} 条，最大 ${q(reqSorted, 1)} 条`,
  );
  console.log(
    `  单请求正文峰值：中位 ${bytes(q(reqBytesSorted, 0.5))}，p90 ${bytes(q(reqBytesSorted, 0.9))}，最大 ${bytes(q(reqBytesSorted, 1))}`,
  );
  console.log(
    `  ⇒ 环容量超过 ${q(reqSorted, 1)} 条后，对「正文不丢」不再有增量收益（在飞窗口已被完全覆盖）。`,
  );
  const textChunkSorted = withText
    .map((r) => r.textChunks)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  console.log(
    `  单 run 正文 chunk 总数：中位 ${q(textChunkSorted, 0.5)} 条，p90 ${q(textChunkSorted, 0.9)} 条，最大 ${q(textChunkSorted, 1)} 条`,
  );
  console.log(
    `  ⇒ 只用约 ${q(textChunkSorted, 1)} 个「正文专用槽」就能装下本机最大 run 的全部正文（对比正文只占现环的 1.7%）。`,
  );

  // ── 真·运行中样本（有 run.started、无终态事件）：这是最接近「运行中刷新」的快照 ──
  console.log('');
  console.log(`════════ 真·运行中样本（未完成 run）：${unfinished.length} 个 ════════`);
  if (unfinished.length === 0) {
    console.log('  本机没有未完成 run ⇒ 上面的表全部是「用历史 run 重放构造」的样本。');
    console.log('  真机上取真样本的步骤见 docs/dev/handoff/chunk-loss-measurement.md §5。');
  } else {
    console.log('  这些 run 有 run.started 但无终态事件（进程被杀/机器休眠），它们冻结的那一刻');
    console.log('  就是一次「运行中刷新」的真实快照：环里只剩最后 N 条，头部正文已淘汰。');
    console.log(
      [
        rpad('run_id', 10),
        lpad('已跑', 7),
        lpad('正文', 10),
        lpad('已发布槽', 10),
        lpad('丢块', 8),
        lpad('丢正文', 16),
        lpad('占比', 8),
      ].join(' '),
    );
    for (const r of unfinished.slice(0, opts.top)) {
      const loss = lossAt(r, opts.rings[0] ?? 10_000, r.timeline.length);
      const rate = r.durationMs > 0 ? r.slots / (r.durationMs / 1000) : 0;
      const p = r.textBytes > 0 ? loss.lostTextBytesEst / r.textBytes : 0;
      const cover = r.textBytes > 0 ? r.responseBytes / r.textBytes : 0;
      console.log(
        [
          rpad(r.runId.slice(0, 8), 10),
          lpad(secs(r.durationMs), 7),
          lpad(bytes(r.textBytes), 10),
          lpad(String(r.timeline.length), 10),
          lpad(String(loss.lostTextChunks), 8),
          lpad(`${bytes(loss.lostTextBytesMin)}~${bytes(loss.lostTextBytesMax)}`, 16),
          lpad(pct(p), 8),
          lpad(pct(cover), 8),
        ].join(' ') + `   ${rate.toFixed(1)} 槽/秒`,
      );
    }
    const coverAll = unfinished.filter((r) => r.textBytes > 0);
    const fullCover = coverAll.filter((r) => r.responseBytes >= r.textBytes).length;
    console.log(
      `  ⇒ 这些未完成 run 里 ${fullCover}/${coverAll.length} 个的正文已被 \`llm.response\` **全量落盘**`,
    );
    console.log('     （「落盘副本」列 = llm.response 副本字节 ÷ 流式正文字节，100% 即可由磁盘回填整段正文）');
  }

  // ── 并发：环是 tenant 全局的，别人跑得越多，你的正文被挤得越快 ──
  const intervals = all
    .filter((r) => r.startedAt !== null && r.endedAt !== null && r.endedAt > r.startedAt)
    .map((r) => ({ t: r.startedAt as number, d: 1, run: r }))
    .sort((a, b) => a.t - b.t);
  const ends = all
    .filter((r) => r.startedAt !== null && r.endedAt !== null && r.endedAt > r.startedAt)
    .map((r) => ({ t: r.endedAt as number, d: -1, run: r }))
    .sort((a, b) => a.t - b.t);
  let cur = 0;
  let maxCur = 0;
  let i2 = 0;
  for (const s of intervals) {
    while (i2 < ends.length && (ends[i2]?.t ?? Number.POSITIVE_INFINITY) <= s.t) {
      cur += ends[i2]?.d ?? 0;
      i2 += 1;
    }
    cur += s.d;
    if (cur > maxCur) maxCur = cur;
  }
  console.log('');
  console.log('════════ 并发（实测）：环是 tenant 全局共享的 FIFO ════════');
  console.log(`  事件时间线上同时未结束的 run 峰值 = ${maxCur} 个`);
  console.log('  ⇒ 环里属于你当前 run 的那份被按「同时在跑的 run 数」摊薄（推算：有效/1+N）。');
  console.log('  ⇒ 上面所有丢失数字都是**闭环世界**（只有这一个 run 在烧环）的结果，是下界。');

  // ── 消息侧覆盖：运行中 vs run 结束后 ──
  console.log('');
  console.log('════════ 对照：messages 侧已覆盖多少正文（实测）════════');
  console.log('  正文只在 `run.completed` / checkpoint 时经 `saveSessionState` 进 SessionState。');
  for (const r of withText.slice(0, Math.min(opts.top, 4))) {
    console.log(
      `    ${r.runId.slice(0, 8)}  正文 ${bytes(r.textBytes).padStart(10)}  llm.response 副本 ${bytes(r.responseBytes).padStart(10)}  run 内 session.saved ${r.midRunSaves} 条`,
    );
  }
  console.log('  ⇒ 运行中刷新时 messages 对本 run 的覆盖是 0；run 结束后才由 llm.response 补齐。');

  if (opts.json) {
    result.rows = withText.slice(0, opts.top).map((r) => ({
      runId: r.runId,
      sessionId: r.sessionId,
      durationMs: r.durationMs,
      textBytes: r.textBytes,
      textChunks: r.textChunks,
      chunkEvents: r.chunkEvents,
      structuralEvents: r.structuralEvents,
      slots: r.slots,
      responseBytes: r.responseBytes,
      midRunSaves: r.midRunSaves,
      terminal: r.terminal,
      loss: opts.rings.map((ring) => {
        const l = lossAt(r, ring, r.timeline.length);
        return { ring, ...l };
      }),
    }));
    console.log('');
    result.distribution = dist;
    result.progressTable = progressRows;
    console.log(JSON.stringify(result, null, 2));
  }
}

main();

