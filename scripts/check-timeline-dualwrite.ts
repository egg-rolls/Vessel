#!/usr/bin/env bun

/**
 * 0.54 A-4 门禁：timeline **双写接线**（ADR-105 §11 / plan-054 A 阶段判据 A-1 / A-2）。
 *
 * 判的不是「新链路能写」（那是 `check-timeline-conformance` / `-holes` / `-index` 的事），
 * 而是「接线本身没有副作用」：
 *
 * | # | 断言 | 为什么必须逐字节 |
 * | --- | --- | --- |
 * | ① | **开关关**：会话目录下**没有任何 timeline 文件**，旧链路输出与基线**逐字节相同** | 关掉开关就是「回到 0.53」，差一个字节都算改坏了旧链路 |
 * | ② | **开关开**：timeline 存在且 `multisetDiff` 合格（`missing=0`，`extra` **只允许** chunk 家族） | A-1 的差集白名单恰好是那两条（不是「包含」），且开关开也不能改旧链路 |
 * | ③ | **失败隔离**：注入 writer 打不开 ⇒ 旧链路逐字节相同、无异常上抛、指标里有失败计数 | 「新链路坏了不影响旧链路」是这一单的立身之本 |
 * | ④ | **event_cursor**：开关关 ⇒ 四字段缺省；开关开 ⇒ `0 ≤ timeline_head ≤ wal_head`、`holes` 是数组 | 技术字段不许报假零 |
 * | ⑤ | **抽样**：`verify_sample_rate=1` 且人为差异 ⇒ 必须发 `timeline.divergence`；无差异 ⇒ **不发** | A-2 的审计通道必须真的响，也不能乱响 |
 *
 * ## 「合成 run」是什么
 *
 * 一次 run 的落盘路径只有一段是要证明的：`RunJournal.appendFact` → `SessionEventLog.append`
 * （`events.ndjson`）+ 旁路 `timelineWriter.append`。所以本门禁驱动**真 `RunJournal`**
 * （`createRunJournalFactory` + 真 `SessionEventLog` + 内存事件流），按固定脚本发 10 条事件
 * （含 `llm.request` 的正文裁剪与 2 条 chunk）—— 不拉 provider、不跑 `ExecutionUnit`，
 * 因此**确定性**（同一份输入逐字节相同），而经过的代码路径与线上完全一致。
 *
 * 基线（`case ①` 的对照）是**完全不装旁路**的那一次 run：它等于 0.53 的行为。
 *
 * 用法：`bun run scripts/check-timeline-dualwrite.ts`
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunJournalFactory,
  type Logger,
  MemoryEventStream,
  SessionEventLog,
  sessionDirPath,
} from '../packages/core/src/index';
import { isChunkEventType } from '../packages/core/src/timeline/types';
import { readTimelineEvents } from '../packages/core/src/timeline/wal';
import { createSessionMethods } from '../packages/serve/src/gateway/methods/sessions';
import {
  isTimelineOnlyType,
  loadSessionReference,
  multisetDiff,
  type RefEvent,
  refEventFromRaw,
} from '../scripts/timeline-reference';
import { createSessionEventsSource } from '../src/session-events';
import { createTimelineDualWrite, type TimelineDualWrite } from '../src/timeline-dual-write';

let checks = 0;
let failures = 0;

function pass(name: string, detail = ''): void {
  checks += 1;
  console.log(`[PASS] ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string): void {
  checks += 1;
  failures += 1;
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

/**
 * 逐字节比较（**不**把整份日志打出来：几十行 JSON 会把判据刷到看不见）。
 *
 * 失败时只给长度与第一个差异位置 —— 够定位，又不会淹掉上下文。
 */
function assertBytes(name: string, actual: string, expected: string): void {
  if (actual === expected) {
    pass(name, `${String(actual.length)} bytes 完全相同`);
    return;
  }
  let offset = 0;
  while (
    offset < actual.length &&
    offset < expected.length &&
    actual[offset] === expected[offset]
  ) {
    offset += 1;
  }
  fail(
    name,
    `字节不同：actual=${String(actual.length)}B expected=${String(expected.length)}B，第一个差异在 offset=${String(offset)}`,
  );
}

const NOW = 1_760_000_000_000;
const SESSION = 'dual-write-probe';
const RUN = 'run-dual-1';

/** 定长脚本（10 条；2 条 chunk 属于「旧链路故意不落盘」那一类）。 */
const SCRIPT: ReadonlyArray<{ type: string; data: Record<string, unknown> }> = [
  {
    type: 'run.started',
    data: { run_id: RUN, session_id: SESSION, input: 'hello dual write' },
  },
  { type: 'user.message', data: { text: 'hello dual write' } },
  {
    type: 'llm.request',
    data: {
      model: 'probe-model',
      messages: [{ role: 'user', content: 'hello dual write' }],
      tools: [{ type: 'function', function: { name: 'bash' } }],
    },
  },
  { type: 'llm.stream.chunk', data: { delta: 'he' } },
  { type: 'llm.stream.chunk', data: { delta: 'llo' } },
  { type: 'llm.response', data: { content: 'hello dual write', usage: { total_tokens: 7 } } },
  { type: 'tool.call.started', data: { tool_call_id: 'call-1', name: 'bash' } },
  { type: 'tool.call.completed', data: { tool_call_id: 'call-1', output: 'ok' } },
  { type: 'assistant.message', data: { text: 'done' } },
  { type: 'run.completed', data: { run_id: RUN, status: 'completed' } },
];

interface RunOutcome {
  root: string;
  sessionsDir: string;
  sessionDir: string;
  /** `events.ndjson` 的原始字节（旧链路的对外产物）。 */
  legacyBytes: string;
  /** 旧链路依次发布出去的事件类型（顺序也不能变）。 */
  published: string[];
  journal: ReturnType<ReturnType<typeof createRunJournalFactory>['begin']>;
  manager?: TimelineDualWrite;
  log: SessionEventLog;
}

const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface RunOptions {
  /** 旁路模式：不装（= 0.53 基线）/ 装了但开关关 / 装了且开关开。 */
  mode: 'absent' | 'off' | 'on';
  verifySampleRate?: number;
  /** 注入的 writer 打开失败（③ 用）。 */
  breakWriter?: boolean;
  /** 发 `timeline.divergence` 的收集器（⑤ 用）。 */
  emit?: (event: { type: string; data?: unknown }) => void;
}

/** 跑一次「合成 run」：真 journal + 真事件日志（+ 可选的旁路）。 */
async function runSynthetic(options: RunOptions): Promise<RunOutcome> {
  const root = await mkdtemp(join(tmpdir(), `vessel-dualwrite-${options.mode}-`));
  const sessionsDir = join(root, 'sessions');
  const sessionDir = sessionDirPath(sessionsDir, SESSION);
  if (options.breakWriter === true) {
    // ③ 的注入：把 `wal.blocks` 占成一个**文件** ⇒ 写入侧 `ChunkBlockStore.open()` 的
    // `mkdir(<sessionDir>/wal.blocks)` 必然抛 EEXIST（等价于「timeline 目录不可写」这类
    // 真实故障，且跨平台确定）。旧链路完全不碰这个路径 —— 失败被隔离的正是新链路。
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'wal.blocks'), 'not-a-directory\n', 'utf8');
  }

  const log = new SessionEventLog({ dir: sessionsDir, durable: false, logger: quietLogger });
  const events = new MemoryEventStream();
  const published: string[] = [];
  events.subscribe((event) => {
    published.push(event.type);
  });

  let manager: TimelineDualWrite | undefined;
  if (options.mode !== 'absent') {
    manager = createTimelineDualWrite({
      dataDir: root,
      sessionsDir,
      dualWrite: options.mode === 'on',
      verifySampleRate: options.verifySampleRate ?? 0,
      logger: quietLogger,
      ...(options.emit !== undefined
        ? {
            emit: (event) => {
              options.emit?.({ type: event.type, data: event.data });
            },
          }
        : {}),
    });
  }

  const journalFactory = createRunJournalFactory({
    eventLog: log,
    logger: quietLogger,
    ...(manager !== undefined ? { timelineDualWrite: manager } : {}),
  });
  const journal = journalFactory.begin({ runId: RUN, sessionId: SESSION, events });
  for (const [index, item] of SCRIPT.entries()) {
    journal.appendFact({
      type: item.type,
      run_id: RUN,
      ts: NOW + index,
      data: item.data,
    });
  }
  await journal.flush();
  if (manager !== undefined) await manager.flushSession(SESSION);

  const legacyBytes = await readFile(join(sessionDir, 'events.ndjson'), 'utf8').catch(() => '');
  return { root, sessionsDir, sessionDir, legacyBytes, published, journal, manager, log };
}

/** 会话目录里的 timeline 痕迹（只读文件名，不看内容）。 */
async function timelineArtifacts(sessionDir: string): Promise<string[]> {
  const entries = await readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'events.ndjson' || entry.name === 'index.json') continue;
    names.push(entry.name);
  }
  return names.sort();
}

const roots: string[] = [];

try {
  // ── ① 开关关：没有 timeline 文件 + 旧链路逐字节相同 ────────────────────────
  const baseline = await runSynthetic({ mode: 'absent' });
  roots.push(baseline.root);
  const off = await runSynthetic({ mode: 'off' });
  roots.push(off.root);

  assertTrue(
    '① 基线 run 真的落了旧链路日志',
    baseline.legacyBytes.length > 0,
    `${String(baseline.legacyBytes.length)} bytes`,
  );
  assertBytes('① 开关关：旧链路输出与基线逐字节相同', off.legacyBytes, baseline.legacyBytes);
  assertEqual(
    '① 开关关：旧链路发布序列与基线相同',
    off.published.join(','),
    baseline.published.join(','),
  );
  const offArtifacts = await timelineArtifacts(off.sessionDir);
  assertEqual('① 开关关：会话目录下没有任何 timeline 文件', offArtifacts.join(','), '');
  assertEqual('① 开关关：旁路一次都没被调（appended=0）', off.manager?.stats().appended, 0);
  assertEqual('① 开关关：没有打开任何 writer（sessions=0）', off.manager?.stats().sessions, 0);

  // ── ② 开关开：timeline 存在 + 差集合格 ────────────────────────────────────
  const on = await runSynthetic({ mode: 'on' });
  roots.push(on.root);
  const onArtifacts = await timelineArtifacts(on.sessionDir);
  assertTrue(
    '② 开关开：会话目录里有 timeline 文件',
    onArtifacts.includes('wal.log') && onArtifacts.includes('timeline.manifest'),
    onArtifacts.join(','),
  );

  const records = await readTimelineEvents(on.sessionDir);
  assertTrue(
    '② 开关开：timeline 记录了全部事件（含 chunk）',
    records.length === SCRIPT.length,
    `records=${String(records.length)} script=${String(SCRIPT.length)}`,
  );
  const chunkRecords = records.filter((record) => isChunkEventType(record.type));
  assertEqual(
    '② 开关开：chunk 家族真的进了 timeline',
    chunkRecords.length,
    SCRIPT.filter((item) => isChunkEventType(item.type)).length,
  );
  const seqs = records.map((record) => record.seq);
  const contiguous = seqs.every((seq, index) => seq === index + 1);
  assertTrue('② 开关开：timeline seq 从 1 连续（I1 的读侧自证）', contiguous, seqs.join(','));

  const actual: RefEvent[] = [];
  for (const record of records) {
    const event = refEventFromRaw({
      run_id: record.run_id,
      type: record.type,
      ts: record.ts,
      data: record.data,
    });
    if (event !== undefined) actual.push(event);
  }
  const expected = await loadSessionReference(SESSION, {
    dataDir: on.root,
    sources: ['session-log'],
  });
  const diff = multisetDiff(expected, actual);
  assertEqual('② 开关开：missing=0（旧链路有的事件 timeline 都有）', diff.missing.length, 0);
  const badExtra = diff.extra.filter((event) => !isTimelineOnlyType(event.type));
  assertEqual(
    '② 开关开：extra 只允许 chunk 家族（白名单恰好两条）',
    badExtra.map((event) => event.type).join(','),
    '',
  );
  assertEqual(
    '② 开关开：extra 条数 = chunk 条数',
    diff.extra.length,
    SCRIPT.filter((item) => isChunkEventType(item.type)).length,
  );
  assertBytes('② 开关开：旧链路输出仍与基线逐字节相同', on.legacyBytes, baseline.legacyBytes);

  // ── ③ 失败隔离：writer 打不开 ────────────────────────────────────────────
  const broken = await runSynthetic({ mode: 'on', breakWriter: true });
  roots.push(broken.root);
  assertBytes('③ 失败隔离：旧链路输出与基线逐字节相同', broken.legacyBytes, baseline.legacyBytes);
  assertEqual(
    '③ 失败隔离：旧链路发布序列与基线相同（无异常上抛、无缺事件）',
    broken.published.join(','),
    baseline.published.join(','),
  );
  const brokenStats = broken.manager?.stats();
  assertTrue(
    '③ 失败隔离：指标里有失败计数',
    (brokenStats?.failed ?? 0) >= 1,
    JSON.stringify(brokenStats),
  );
  assertEqual(
    '③ 失败隔离：该会话被标成 broken（不再每条都撞一遍）',
    brokenStats?.broken_sessions,
    1,
  );
  let verifyThrew = false;
  let verifyResult: unknown;
  try {
    verifyResult = await broken.manager?.finishRun(SESSION, 'run-broken');
  } catch {
    verifyThrew = true;
  }
  assertTrue(
    '③ 失败隔离：抽样在坏目录上也只返回、不抛',
    !verifyThrew,
    JSON.stringify(verifyResult ?? null),
  );

  // ── ④ event_cursor：四字段缺省 vs 齐全 ───────────────────────────────────
  type Methods = ReturnType<typeof createSessionMethods>;
  type Cursor = Record<string, unknown> | undefined;

  function sessionMethodsFor(outcome: RunOutcome): Methods {
    const eventsFile = (id: string) =>
      join(outcome.sessionsDir, encodeURIComponent(id), 'events.ndjson');
    return createSessionMethods({
      sessionFor: () =>
        ({
          load: async (id: string) => ({ session_id: id, messages: [], status: 'completed' }),
        }) as never,
      sessionEvents: createSessionEventsSource({ log: outcome.log, eventsFile }),
      ...(outcome.manager !== undefined
        ? {
            timelineHeads: {
              lookup: (id: string) => outcome.manager?.heads(id) ?? Promise.resolve(undefined),
            },
          }
        : {}),
    });
  }

  async function cursorOf(outcome: RunOutcome, sessionId: string): Promise<Cursor> {
    const methods = sessionMethodsFor(outcome);
    const method = methods.find((item) => item.name === 'sessions.get');
    if (method === undefined) throw new Error('sessions.get missing');
    const result = (await method.handler({ session_id: sessionId }, {} as never)) as {
      session?: { event_cursor?: Cursor & { last_seq?: number } };
    };
    return result.session?.event_cursor;
  }

  const FOUR = ['timeline_head', 'wal_head', 'holes', 'tainted'] as const;

  const offCursor = await cursorOf(off, SESSION);
  assertTrue(
    '④ 开关关：event_cursor 仍然给（旧字段不变）',
    typeof offCursor?.last_seq === 'number',
    JSON.stringify(offCursor ?? null),
  );
  assertEqual(
    '④ 开关关：timeline 四字段全部缺省（不报假零）',
    FOUR.filter((key) => offCursor !== undefined && key in offCursor).join(','),
    '',
  );

  const onCursor = await cursorOf(on, SESSION);
  assertEqual(
    '④ 开关开：timeline 四字段齐全',
    FOUR.filter((key) => onCursor !== undefined && key in onCursor).join(','),
    FOUR.join(','),
  );
  const timelineHead = onCursor?.timeline_head;
  const walHead = onCursor?.wal_head;
  assertTrue(
    '④ 开关开：0 ≤ timeline_head ≤ wal_head',
    typeof timelineHead === 'number' &&
      typeof walHead === 'number' &&
      timelineHead >= 0 &&
      timelineHead <= walHead,
    `timeline_head=${String(timelineHead)} wal_head=${String(walHead)}`,
  );
  assertTrue(
    '④ 开关开：holes 是数组、tainted 是布尔',
    Array.isArray(onCursor?.holes) && typeof onCursor?.tainted === 'boolean',
    JSON.stringify({ holes: onCursor?.holes, tainted: onCursor?.tainted }),
  );

  // 开关开但该会话没有 timeline ⇒ 仍然四字段缺省（不是全 0）。
  const OTHER = 'dual-write-no-timeline';
  await mkdir(join(on.sessionsDir, encodeURIComponent(OTHER)), { recursive: true });
  await writeFile(
    join(on.sessionsDir, encodeURIComponent(OTHER), 'events.ndjson'),
    `${JSON.stringify({
      v: 1,
      seq: 1,
      session_id: OTHER,
      run_id: OTHER,
      ts: NOW,
      type: 'session.created',
      data: { session_id: OTHER },
    })}\n`,
    'utf8',
  );
  const otherCursor = await cursorOf(on, OTHER);
  assertTrue(
    '④ 开关开但该会话没有 timeline：四字段缺省',
    typeof otherCursor?.last_seq === 'number' &&
      FOUR.every((key) => otherCursor === undefined || !(key in otherCursor)),
    JSON.stringify(otherCursor ?? null),
  );

  // ── ⑤ 抽样：有差异必须发、无差异不发 ─────────────────────────────────────
  const emitted: Array<{ type: string; data?: unknown }> = [];
  const sampled = await runSynthetic({
    mode: 'on',
    verifySampleRate: 1,
    emit: (event) => {
      emitted.push(event);
    },
  });
  roots.push(sampled.root);
  const cleanResult = await sampled.manager?.finishRun(SESSION, 'run-sample-clean');
  assertEqual('⑤ 无差异：比对真的跑了（compared=true）', cleanResult?.compared, true);
  assertEqual('⑤ 无差异：missing=0', cleanResult?.missing, 0);
  assertEqual('⑤ 无差异：不发 timeline.divergence', emitted.length, 0);
  assertTrue(
    '⑤ 无差异：extra 只算 chunk 白名单',
    (cleanResult?.allowed_extra ?? -1) >= 0 && (cleanResult?.unexpected_extra ?? -1) === 0,
    JSON.stringify(cleanResult ?? null),
  );

  // 人为差异：往旧链路日志里追加一条 timeline 不可能有的事件（`missing` 必然 ≥ 1）。
  const injectedTs = NOW + 9_999;
  await appendFile(
    join(sampled.sessionDir, 'events.ndjson'),
    `${JSON.stringify({
      v: 1,
      seq: 999,
      session_id: SESSION,
      run_id: RUN,
      ts: injectedTs,
      type: 'user.message',
      data: { text: 'only in legacy log' },
    })}\n`,
    'utf8',
  );
  const injectedResult = await sampled.manager?.finishRun(SESSION, 'run-sample-injected');
  assertTrue(
    '⑤ 人为差异：missing ≥ 1',
    (injectedResult?.missing ?? 0) >= 1,
    JSON.stringify(injectedResult ?? null),
  );
  assertEqual('⑤ 人为差异：恰好发一条 timeline.divergence', emitted.length, 1);
  const divergence = emitted[0];
  assertEqual(
    '⑤ 人为差异：事件类型是 timeline.divergence',
    divergence?.type,
    'timeline.divergence',
  );
  const divergenceData = (divergence?.data ?? {}) as Record<string, unknown>;
  assertEqual('⑤ 差异事件带 missing_count', divergenceData.missing_count, 1);
  assertEqual(
    '⑤ 差异事件不带正文（只给计数/类型/时间戳）',
    Object.keys(divergenceData)
      .filter((key) => ['content', 'text', 'payload', 'data', 'messages'].includes(key))
      .join(','),
    '',
  );

  for (const outcome of [baseline, off, on, broken, sampled]) {
    try {
      await outcome.log.close();
    } catch {
      // 清理阶段的失败不影响判据
    }
  }
} finally {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

console.log('');
console.log(`检查项 ${String(checks)} 条，失败 ${String(failures)} 条`);
if (failures > 0) {
  console.log('结论：FAIL（新增链路影响了开关关时的旧行为，或抽样通道不工作）');
  process.exit(1);
}
console.log('结论：PASS（开关关逐字节不变 / 开关开差集合格 / 失败隔离 / 四字段 / 抽样通道）');
