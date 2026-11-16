/**
 * 尺子自检 —— 「参考真相提取器」本身是否可信（0.54 A 阶段，ADR-105 / plan-054 §1 A-1 的配套）。
 *
 * 尺子坏了没人会知道，所以先让尺子验自己：
 *   ① 确定性 —— 同一会话跑两次，输出逐字节相同；
 *   ② 稳定性 —— 输出已按 `(run_id, type, ts, digest)` 规范排序；
 *   ③ 自反性 —— `multisetDiff(x, x)` 两边空（且不依赖顺序）；
 *   ④ 真实样本 —— 至少 3 个会话（含一个多 run），打 `events=/runs=/types=`、类型 top10、
 *      provenance（会话日志 vs trace 各贡献多少）与跨源 digest 冲突统计；
 *   ⑤ attribution 归一化 —— 同一事件"带 `data.session_id` 副本 vs 不带副本"归一后 digest 相等，
 *      且 digest 恒等于 `stableEventId` 的第 4 段；
 *   ⑥ 反向用例 —— 人为改掉一条 digest ⇒ `missing=1 extra=1`。
 *
 * 只读：默认数据目录 `/mnt/c/Users/Lirui/.vessel/data`（WSL 写法，内部翻成 `C:/...`），
 * 可用 `--data-dir` 换；`--sessions a,b` 指定样本。本脚本**不写任何文件**。
 *
 * 用法（脚本参数用相对路径 —— 本仓库的 bun 是 Windows 版，看不到 `/mnt/...`）：
 *   bun run scripts/check-timeline-reference.ts
 *   bun run scripts/check-timeline-reference.ts --data-dir C:/Users/Lirui/.vessel/data
 *   bun run scripts/check-timeline-reference.ts --sessions <sid>[,<sid>]
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_DATA_DIR,
  isTimelineOnlyType,
  loadSessionReference,
  multisetDiff,
  payloadDigest,
  type RefEvent,
  refEventFromRaw,
  resolveDataDir,
} from './timeline-reference';

/**
 * 独立复算「内容 id 的第 4 段」（= payload 摘要，抹掉出站才补的 `session_id`）。
 *
 * 为什么在这里再写一遍：0.54 B2 删掉了 web 侧的 `stableEventId`（客户端不再有内容 id 去重，
 * ADR-105 §6），尺子若继续引用被测实现的辅助函数就等于自己称自己。这里用**独立实现**
 * 复算同一条口径 —— 断言从「复用同一实现」升级成「两条独立实现结论相同」。
 */
function fourthSegment(event: {
  type: string;
  run_id?: string;
  ts: number;
  data?: unknown;
}): string {
  const runId = event.run_id ?? '';
  let payload = event.data;
  if (runId !== '' && runId !== 'manual' && typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    if ('session_id' in record) {
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        if (key === 'session_id') continue;
        copy[key] = record[key];
      }
      payload = copy;
    }
  }
  return payloadDigest(payload);
}

/** 样本个数（任务单要求 ≥3，验收要看 4 个）。 */
const SAMPLE_COUNT = 4;
/** 样本下限：太小的事件数说明不了"两份源合并"，也会让类型分布全空。 */
const MULTI_RUN_MIN_EVENTS = 100;
const SINGLE_RUN_MIN_EVENTS = 100;
const FALLBACK_MIN_EVENTS = 20;
/** top 类型分布打几条。 */
const TOP_TYPES = 10;

let checkCount = 0;
let failureCount = 0;

function pass(name: string, detail = ''): void {
  checkCount += 1;
  console.log(`[PASS] ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string): void {
  checkCount += 1;
  failureCount += 1;
  console.log(`[FAIL] ${name} — ${detail}`);
}

function assertTrue(name: string, condition: boolean, detail = ''): void {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  assertTrue(name, ok, `actual=${String(actual)} expected=${String(expected)}`);
}

/** 码点比较（不用 localeCompare：它按环境变化，会毁掉确定性）。 */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** ② 的独立实现：故意不复用库里的私有比较器 —— 用它验它自己就没意义了。 */
function compareRef(a: RefEvent, b: RefEvent): number {
  const runA = a.run_id ?? '';
  const runB = b.run_id ?? '';
  if (runA !== runB) return compareText(runA, runB);
  if (a.type !== b.type) return compareText(a.type, b.type);
  if (a.ts !== b.ts) return a.ts - b.ts;
  return compareText(a.payload_digest, b.payload_digest);
}

function formatRef(event: RefEvent): string {
  return `${event.run_id ?? '-'}|${event.type}|${event.ts}|${event.payload_digest}`;
}

function renderRefs(events: readonly RefEvent[]): string {
  return events.map((event) => formatRef(event)).join('\n');
}

interface Args {
  dataDir?: string;
  sessions: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { sessions: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--data-dir') {
      args.dataDir = argv[index + 1];
      index += 1;
    } else if (arg === '--sessions') {
      const value = argv[index + 1] ?? '';
      args.sessions = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      index += 1;
    }
  }
  return args;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch {
    return undefined;
  }
}

interface SessionScan {
  sid: string;
  /** 会话事件日志里的可解析行数（选择样本用的规模指标）。 */
  events: number;
  /** 按出现顺序的 distinct 非空 run_id（= trace 侧要读的文件名，**含**会话级桶）。 */
  run_ids: string[];
  /** 去掉会话级桶（`run_id === session_id`）之后的 run 数 —— 采样池按它分。 */
  real_runs: number;
}

/** 扫一遍所有会话目录，只读 `events.ndjson`（本机 ~291 MB / 242 份，约 1 s）。 */
async function scanSessions(dataDir: string): Promise<SessionScan[]> {
  const root = join(dataDir, 'sessions');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return [];
  const scans: SessionScan[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const text = await readText(join(root, entry.name, 'events.ndjson'));
    if (text === undefined) continue;
    const sid = decodeURIComponent(entry.name);
    let events = 0;
    const seen = new Set<string>();
    const runIds: string[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let row: unknown;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue;
      }
      events += 1;
      const runId = (row as Record<string, unknown>).run_id;
      if (typeof runId === 'string' && runId.length > 0 && !seen.has(runId)) {
        seen.add(runId);
        runIds.push(runId);
      }
    }
    scans.push({
      sid,
      events,
      run_ids: runIds,
      real_runs: runIds.filter((runId) => runId !== sid).length,
    });
  }
  scans.sort((a, b) => compareText(a.sid, b.sid));
  return scans;
}

/**
 * 采样规则（确定性，写清在这里）：
 *   1. 多 run 池 = `real_runs ≥ 2 且 event 数 ≥ 100`，按 `(event 数升序, sid)` 取前 2（最小的先跑得快）；
 *   2. 单 run 池 = `real_runs == 1 且 event 数 ≥ 100`，同规则取前 2；
 *   3. 不足 4 个时从剩余会话按 `(event 数升序, sid)` 补齐；
 *   4. 输出顺序 = 多 run 池先、单 run 池后（本身也是确定性的）。
 */
function pickSamples(scans: readonly SessionScan[]): SessionScan[] {
  const byCost = (a: SessionScan, b: SessionScan): number =>
    a.events - b.events || compareText(a.sid, b.sid);
  const multi = scans
    .filter((scan) => scan.real_runs >= 2 && scan.events >= MULTI_RUN_MIN_EVENTS)
    .slice()
    .sort(byCost)
    .slice(0, 2);
  const single = scans
    .filter((scan) => scan.real_runs === 1 && scan.events >= SINGLE_RUN_MIN_EVENTS)
    .slice()
    .sort(byCost)
    .slice(0, 2);
  const picked = [...multi, ...single];
  if (picked.length < SAMPLE_COUNT) {
    const chosen = new Set(picked.map((scan) => scan.sid));
    const rest = scans
      .filter((scan) => !chosen.has(scan.sid) && scan.events >= FALLBACK_MIN_EVENTS)
      .slice()
      .sort(byCost);
    for (const scan of rest) {
      if (picked.length >= SAMPLE_COUNT) break;
      picked.push(scan);
    }
  }
  return picked;
}

/** 跨源 payload 冲突：同一 `(run_id, type, ts)` 在两侧的 digest 对不上的条数，按 type 汇总。 */
function digestConflicts(
  fromLog: readonly RefEvent[],
  fromTrace: readonly RefEvent[],
): Map<string, number> {
  const group = (events: readonly RefEvent[]): Map<string, { type: string; digests: string[] }> => {
    const map = new Map<string, { type: string; digests: string[] }>();
    for (const event of events) {
      const key = `${event.run_id ?? ''}|${event.type}|${event.ts}`;
      const slot = map.get(key);
      if (slot === undefined) map.set(key, { type: event.type, digests: [event.payload_digest] });
      else slot.digests.push(event.payload_digest);
    }
    for (const slot of map.values()) slot.digests.sort();
    return map;
  };
  const logGroups = group(fromLog);
  const traceGroups = group(fromTrace);
  const conflicts = new Map<string, number>();
  for (const [key, logSlot] of logGroups) {
    const traceSlot = traceGroups.get(key);
    if (traceSlot === undefined) continue;
    const shared = Math.min(logSlot.digests.length, traceSlot.digests.length);
    let hits = 0;
    for (let index = 0; index < shared; index += 1) {
      if (logSlot.digests[index] !== traceSlot.digests[index]) hits += 1;
    }
    if (hits === 0) continue;
    conflicts.set(logSlot.type, (conflicts.get(logSlot.type) ?? 0) + hits);
  }
  return conflicts;
}

function renderCounts(counts: Map<string, number>): string {
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]));
  if (entries.length === 0) return 'none';
  const shown = entries.slice(0, TOP_TYPES).map(([key, count]) => `${key}=${count}`);
  const tail = entries.length > TOP_TYPES ? ` (+${entries.length - TOP_TYPES} more)` : '';
  return `${shown.join(' ')}${tail}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = resolveDataDir(args.dataDir);
  console.log(`data-dir: ${dataDir}  (default: ${DEFAULT_DATA_DIR})`);
  // 0.54 stop-write：`TIMELINE_ONLY_EVENT_TYPES` 白名单已删除（两份源并存结束）——
  // 只剩一条判据：chunk 家族。这里报的是它，不是一张名单。
  console.log('timeline-only predicate: chunk 家族（llm.stream.chunk / *.llm.stream.chunk）');
  console.log('');

  const scans = await scanSessions(dataDir);
  if (scans.length === 0) {
    fail('scan sessions', `no ${join(dataDir, 'sessions')}/*/events.ndjson — wrong --data-dir?`);
    console.log('');
    console.log(`RESULT: FAIL (checks=${checkCount} failed=${failureCount})`);
    process.exitCode = 1;
    return;
  }
  console.log(`scanned sessions: ${scans.length}`);

  // 样本选择
  let samples: SessionScan[];
  if (args.sessions.length > 0) {
    const byId = new Map(scans.map((scan) => [scan.sid, scan]));
    samples = args.sessions.map(
      (sid) => byId.get(sid) ?? { sid, events: 0, run_ids: [] as string[], real_runs: 0 },
    );
  } else {
    samples = pickSamples(scans);
  }
  console.log(`sampled sessions: ${samples.length}`);
  console.log('');

  interface Sample {
    scan: SessionScan;
    merged: RefEvent[];
    fromLog: RefEvent[];
    types: Map<string, number>;
    runs: number;
    /** `run_id === session_id` 的会话级桶（`session.created` / `agent.*`）里的事件数。 */
    sessionBucketEvents: number;
    /** 枚举出来但磁盘上没有 trace 文件的 run 数（信息不全的诚实信号）。 */
    runsWithoutTrace: number;
    lostFromSession: number;
    traceOnly: number;
    conflicts: Map<string, number>;
  }

  const analysed: Sample[] = [];
  for (const scan of samples) {
    const merged = await loadSessionReference(scan.sid, { dataDir });
    const fromLog = await loadSessionReference(scan.sid, { dataDir, runs: [] });
    const fromTrace = await loadSessionReference(scan.sid, {
      dataDir,
      sources: ['trace'],
      runs: scan.run_ids,
    });
    const types = new Map<string, number>();
    const runs = new Set<string>();
    let sessionBucketEvents = 0;
    for (const event of merged) {
      types.set(event.type, (types.get(event.type) ?? 0) + 1);
      if (event.run_id === null) continue;
      runs.add(event.run_id);
      if (event.run_id === scan.sid) sessionBucketEvents += 1;
    }
    let runsWithoutTrace = 0;
    for (const runId of scan.run_ids) {
      const tracePath = join(dataDir, 'events', `${encodeURIComponent(runId)}.jsonl`);
      if (!existsSync(tracePath)) runsWithoutTrace += 1;
    }
    // provenance：merged 相对「只算会话日志」多出来的（= trace 贡献）与丢掉的（必须为 0）。
    const provenance = multisetDiff(merged, fromLog);
    analysed.push({
      scan,
      merged,
      fromLog,
      types,
      runs: runs.size,
      sessionBucketEvents,
      runsWithoutTrace,
      lostFromSession: provenance.extra.length,
      traceOnly: provenance.missing.length,
      conflicts: digestConflicts(fromLog, fromTrace),
    });
  }

  // ---- ④ 真实样本 ----
  for (const sample of analysed) {
    console.log(
      `session=${sample.scan.sid} events=${sample.merged.length} runs=${sample.runs} types=${sample.types.size}`,
    );
    console.log(
      `  attribution: run_ids=${sample.runs} (real_runs=${sample.scan.real_runs} + session 级桶 run_id==session_id events=${sample.sessionBucketEvents}) runs_without_trace=${sample.runsWithoutTrace}`,
    );
    console.log(
      `  provenance: session_log=${sample.fromLog.length} trace_only=${sample.traceOnly} lost_from_session=${sample.lostFromSession}`,
    );
    console.log(`  digest_conflicts: ${renderCounts(sample.conflicts)}`);
    console.log(`  top${TOP_TYPES}: ${renderCounts(sample.types)}`);
  }
  console.log('');

  const multiRun = analysed.filter((sample) => sample.scan.real_runs >= 2);
  const singleRun = analysed.filter((sample) => sample.scan.real_runs === 1);
  assertTrue('④ 样本数 >= 3', analysed.length >= 3, `samples=${analysed.length} (>=3 required)`);
  assertTrue(
    '④ 含多 run 会话',
    multiRun.length >= 1,
    `multi_run_sessions=${multiRun.length} of ${analysed.length}`,
  );
  assertTrue(
    '④ 含单 run 会话（覆盖"trace 补充"最少的形态）',
    singleRun.length >= 1,
    `single_run_sessions=${singleRun.length} of ${analysed.length}`,
  );
  for (const sample of analysed) {
    const name = `④ ${sample.scan.sid}`;
    assertTrue(`${name} events>0`, sample.merged.length > 0, `events=${sample.merged.length}`);
    assertTrue(
      `${name} 无事件被合并丢弃`,
      sample.lostFromSession === 0,
      `lost_from_session=${sample.lostFromSession}`,
    );
    assertTrue(
      `${name} run 数覆盖会话日志`,
      sample.runs >= sample.scan.run_ids.length,
      `merged_runs=${sample.runs} session_log_runs=${sample.scan.run_ids.length}`,
    );
    const offline = sample.merged.filter((event) => isTimelineOnlyType(event.type));
    assertTrue(
      `${name} 参考集不含 timeline-only 类型`,
      offline.length === 0,
      `offenders=${offline.map((event) => event.type).join(',') || 'none'}`,
    );
  }

  // ---- ① 确定性：同一会话跑两次，输出逐字节相同 ----
  const cheapest = analysed
    .slice()
    .sort((a, b) => a.merged.length - b.merged.length || compareText(a.scan.sid, b.scan.sid))[0];
  if (cheapest === undefined) {
    fail('① 确定性', 'no sample available');
  } else {
    const first = renderRefs(await loadSessionReference(cheapest.scan.sid, { dataDir }));
    const second = renderRefs(await loadSessionReference(cheapest.scan.sid, { dataDir }));
    assertTrue(
      '① 确定性（两次加载逐字节相同）',
      first === second,
      `session=${cheapest.scan.sid} bytes=${first.length}`,
    );
    const third = renderRefs(await loadSessionReference(cheapest.scan.sid, { dataDir }));
    assertTrue('① 确定性（第三次仍相同）', first === third, `session=${cheapest.scan.sid}`);
  }

  // ---- ② 稳定性：输出已按规范顺序 ----
  for (const sample of analysed) {
    const resorted = sample.merged.slice().sort(compareRef);
    const stable = renderRefs(resorted) === renderRefs(sample.merged);
    assertTrue(
      `② 稳定性 ${sample.scan.sid}`,
      stable,
      `elements=${sample.merged.length} sorted_by=(run_id,type,ts,digest)`,
    );
  }

  // ---- ③ 自反性（含顺序无关） ----
  const reflexive = analysed[0];
  if (reflexive === undefined) {
    fail('③ 自反性', 'no sample available');
  } else {
    const self = multisetDiff(reflexive.merged, reflexive.merged);
    assertTrue(
      '③ 自反 multisetDiff(x,x) 两边空',
      self.missing.length === 0 && self.extra.length === 0,
      `missing=${self.missing.length} extra=${self.extra.length}`,
    );
    const reversed = multisetDiff(reflexive.merged, reflexive.merged.slice().reverse());
    assertTrue(
      '③ 顺序无关（反转输入仍两边空）',
      reversed.missing.length === 0 && reversed.extra.length === 0,
      `missing=${reversed.missing.length} extra=${reversed.extra.length}`,
    );
  }

  // ---- ⑤ attribution 归一化（构造用例） ----
  const ts = 1_794_494_350_072;
  const normalized = refEventFromRaw({
    type: 'tool.call.started',
    run_id: 'run-constructed',
    ts,
    data: { tool_name: 'bash', session_id: 'sess-constructed' },
  });
  const denormalized = refEventFromRaw({
    type: 'tool.call.started',
    run_id: 'run-constructed',
    ts,
    data: { tool_name: 'bash' },
  });
  assertTrue(
    '⑤ 带 session_id 副本 vs 不带副本 digest 相等',
    normalized !== undefined &&
      denormalized !== undefined &&
      normalized.payload_digest === denormalized.payload_digest,
    `with=${normalized?.payload_digest ?? '-'} without=${denormalized?.payload_digest ?? '-'}`,
  );
  const fourth = fourthSegment({
    type: 'tool.call.started',
    run_id: 'run-constructed',
    ts,
    data: { tool_name: 'bash', session_id: 'sess-constructed' },
  });
  assertEqual(
    '⑤ digest == 独立复算的第 4 段（两条独立实现同口径）',
    normalized?.payload_digest ?? '',
    fourth,
  );
  const manualWith = refEventFromRaw({
    type: 'session.created',
    run_id: 'manual',
    ts,
    data: { session_id: 'sess-constructed' },
  });
  const manualWithout = refEventFromRaw({
    type: 'session.created',
    run_id: 'manual',
    ts,
    data: {},
  });
  assertTrue(
    '⑤ manual / 无 run 时不抹（与 payloadForId 同口径，反面对照）',
    manualWith !== undefined &&
      manualWithout !== undefined &&
      manualWith.payload_digest !== manualWithout.payload_digest,
    `with=${manualWith?.payload_digest ?? '-'} without=${manualWithout?.payload_digest ?? '-'}`,
  );

  // ---- ⑥ 反向用例：改掉一条 digest ⇒ missing=1 extra=1 ----
  const target = analysed[0];
  if (target === undefined || target.merged.length === 0) {
    fail('⑥ 反向用例', 'no sample available');
  } else {
    const original = target.merged;
    const mutated = original.map((event, index) =>
      index === 0 ? { ...event, payload_digest: 'deadbeef.deadbeef' } : event,
    );
    const diff = multisetDiff(original, mutated);
    assertEqual('⑥ 反向 missing', diff.missing.length, 1);
    assertEqual('⑥ 反向 extra', diff.extra.length, 1);
    assertEqual(
      '⑥ 反向 missing 就是被改的那条',
      diff.missing[0] === undefined ? '-' : formatRef(diff.missing[0]),
      formatRef(original[0] as RefEvent),
    );
    assertEqual(
      '⑥ 反向 extra 就是伪造的那条 digest',
      diff.extra[0]?.payload_digest ?? '-',
      'deadbeef.deadbeef',
    );
  }

  console.log('');
  if (failureCount === 0) {
    console.log(`RESULT: PASS (checks=${checkCount} failed=0)`);
    process.exitCode = 0;
  } else {
    console.log(`RESULT: FAIL (checks=${checkCount} failed=${failureCount})`);
    process.exitCode = 1;
  }
}

await main();
