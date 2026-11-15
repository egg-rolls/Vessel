#!/usr/bin/env bun

/**
 * 0.54 污点复位门禁：`tainted` 是**派生值**（会话级当前健康位），不是「历史出现过的累加」。
 *
 * 修的是什么：`timeline.manifest` 是 append-only，而旧读法把 `tainted` 定义成「**出现过任何**
 * `kind:'tainted'` 行」⇒ 一次瞬时归档失败（磁盘满 / 被杀 / EBUSY）就让该会话**永久** tainted，
 * 重启也清不掉；它又直接冒到 `sessions.get.event_cursor.tainted`（唯一的健康信号）⇒ 信号贬值。
 *
 * 三个概念的分工（本脚本判据全部落在这一行上）：
 *
 * | 概念 | 载体 | 语义 |
 * | --- | --- | --- |
 * | 永久损坏区间 | `holes.ndjson` | 事实，不退役（清理属 0.55+，**不在本单**） |
 * | `tainted` | 写者派生值 | 会话级**当前**健康位 |
 * | 曾经发生什么 | manifest 的 `tainted` / `tainted_cleared` 行 | 审计历史，**全部保留** |
 *
 * | # | 断言 | 为什么必须这样 |
 * | --- | --- | --- |
 * | ① | 注入一次归档失败 ⇒ `tainted === true`、`timeline_head` 冻结、无洞、manifest 一条 `tainted` 行 | 失败必须可见（I3 ④ 不变） |
 * | ② | 之后成功归档一次 ⇒ `tainted === false`，且失败行与 `tainted_cleared` 行**都还在** | 复位只能追加，不许回改历史 |
 * | ③ | 重启（重开 writer）后仍为 `false` | last-wins 必须落在磁盘上，不能只是内存状态 |
 * | ④ | **有洞时**归档成功 ⇒ `tainted` 仍 `true`，且**不写** `tainted_cleared` | 洞 = 真丢失；有洞永不洗白（保守方向） |
 * | ⑤ | 连续两次失败 + 一次成功 ⇒ 只追加一条 cleared，两条失败历史行不丢；后续健康归档不再补 | 不许「为每次归档补一条」，也不许合并/丢历史 |
 * | ⑥ | 旧 manifest（只有历史 `tainted` 行、没有 cleared）⇒ 初值仍 `true`，直到一次合规清退 | 迁移事实：升级不自动洗白 |
 * | ⑦ | **selftest（非门禁）**：`recordFailure()` 连 `holes` 都写不进去时 manifest 追加 `tainted` 的**尽力路径**仍被覆盖 | 那条 `catch` 里的 `appendManifest` 不许是死代码 |
 * | ⑧ | 旧 reader 读新 manifest：**不抛错**、`tainted` 判为 `true`、不截断新行 | 向后兼容只能往安全方向偏 |
 * | F | 补充（更严）：`at` 更小的 cleared 行物理在后 ⇒ 仍 `false`；反过来仍 `true` | 定序依据是**物理写入顺序**，严禁按 `at`（时钟回退会反过来） |
 *
 * ## 注入手段（全部用既有测试缝）
 *
 * - 归档失败：`TimelineWriterOptions.beforeSync('timeline')` —— 归档段 fsync（写入侧自己会重试
 *   3 次，间隔 100/500/2000 ms，所以每个失败场景至少 2.6 s）；
 * - 写失败（造洞）：`beforeSync('wal')`；洞登记失败（⑦）：`beforeSync('holes')`。注意这个缝**只能
 *   让 fsync 失败**（洞行字节可能已经写进文件），所以 ⑦ 的重启断言只要求「缺失 seq 必有声明」，
 *   不规定它是被读回来的、还是恢复期 `findGaps` 补登记的；
 * - 时钟：手搓 manifest（`writeManifestLines()`）造「`at` 与物理顺序矛盾」的夹具，不依赖机器速度。
 *
 * ## 为什么单独一个脚本
 *
 * `check-timeline-archive` 判的是「归档调度有没有接对」（③ 里 `tainted` 的清除口径今天由装配层
 * `src/timeline-dual-write.ts` 的内存补偿实现，重启后即失效 —— 那正是本单要消灭的缺口）；
 * 这里判的是**写入侧自己的污点语义 + manifest 行格式 + 向后兼容**。两者红的原因不同。
 * `package.json` 的 gates 链由主干串（本单禁改）。
 *
 * ## 已知边界（本单明确不修，别顺手改）
 *
 * 1. **`holes` 的退役/修复生命周期不在本单**：洞一旦登记就永远算「存活洞」，因此有过真丢失的会话
 *    永远 `tainted=true`、永远不写 `tainted_cleared`（`check-timeline-holes` 的基线依赖这条语义）。
 * 2. **`holes` 与 manifest 都写不进去**时（⑦ 的病态分支）内存仍是污点，但盘上只有 manifest 的
 *    尽力行、没有洞；同一进程内紧接着一次健康归档**可以**写 `tainted_cleared`（清退前提只有
 *    「无存活洞」）。重启后该缺失 seq 会被恢复期补登记成洞、污点重新成立 —— 窗口因此限制在同一
 *    进程内，且期间 `wal_head` 停在缺失 seq 之前，读侧看不到任何未声明的内容。
 * 3. `src/timeline-dual-write.ts` 的**磁盘口径**（`readHeadsOnDisk`）仍按旧读法判 tainted
 *    （有历史 `tainted` 行 ⇒ true），本单不改装配层；进程内与重启后都由写入侧 last-wins 收口。
 *
 * 用法：`bun run scripts/check-timeline-tainted.ts`
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TIMELINE_LAYOUT, type TimelineSyncKind } from '../packages/core/src/timeline/types';
import { parseWithCrc, readCrcNdjsonFile, withCrc } from '../packages/core/src/timeline/wal';
import { TimelineWriter } from '../packages/core/src/timeline/writer';

const NOW = 1_760_000_000_000;

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
  assertTrue(name, actual === expected, `actual=${String(actual)} expected=${String(expected)}`);
}

function fact(index: number): { run_id: string; type: string; ts: number; data: unknown } {
  return { run_id: 'run-tainted', type: 'assistant.message', ts: NOW + index, data: { index } };
}

function covers(holes: ReadonlyArray<{ from_seq: number; to_seq: number }>, seq: number): boolean {
  return holes.some((hole) => seq >= hole.from_seq && seq <= hole.to_seq);
}

type RawLine = Record<string, unknown>;

/** manifest 的**原始**行（不走任何 validator：本脚本要能看见未知 kind）。 */
async function manifestRawLines(sessionDir: string): Promise<RawLine[]> {
  const text = await readFile(join(sessionDir, TIMELINE_LAYOUT.timelineManifest), 'utf8').catch(
    () => '',
  );
  const lines: RawLine[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    lines.push(JSON.parse(line) as RawLine);
  }
  return lines;
}

async function manifestText(sessionDir: string): Promise<string> {
  return readFile(join(sessionDir, TIMELINE_LAYOUT.timelineManifest), 'utf8').catch(() => '');
}

function countKind(lines: readonly RawLine[], kind: string): number {
  return lines.filter((line) => line.kind === kind).length;
}

/** 物理顺序上最后一条状态声明的 kind（`undefined` = 一条都没有）。 */
function lastStateKind(lines: readonly RawLine[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const kind = lines[index]?.kind;
    if (kind === 'tainted' || kind === 'tainted_cleared') return kind;
  }
  return undefined;
}

/** 手搓一份 manifest（模拟存量会话：升级前就有的历史行）。 */
async function writeManifestLines(sessionDir: string, bodies: readonly RawLine[]): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  const text = bodies.map((body) => `${JSON.stringify(withCrc(body))}\n`).join('');
  await writeFile(join(sessionDir, TIMELINE_LAYOUT.timelineManifest), text, 'utf8');
}

function openWriter(input: {
  sessionId: string;
  sessionDir: string;
  beforeSync?: (kind: TimelineSyncKind) => void;
}): Promise<TimelineWriter> {
  return TimelineWriter.open({
    sessionId: input.sessionId,
    sessionDir: input.sessionDir,
    ...(input.beforeSync !== undefined ? { beforeSync: input.beforeSync } : {}),
  });
}

// ---------------------------------------------------------------- 旧 reader（逐字抄自基线）

/**
 * 0.54 之前的 manifest 行联合：**没有** `tainted_cleared`（这正是要验的兼容方向）。
 *
 * 抄自基线 `39e80a1d:packages/core/src/timeline/writer.ts` 的 `TimelineManifestLine`。
 */
type OldManifestLine =
  | { v: 1; kind: 'open'; at: number }
  | { v: 1; kind: 'archive'; from_seq: number; to_seq: number; at: number }
  | { v: 1; kind: 'tainted'; reason: string; from_seq: number; to_seq: number; at: number };

/**
 * 旧 `validateManifestLine()`（逐字抄自基线 `39e80a1d:writer.ts:146-168`）。
 *
 * 关键行为：未知 `kind` 走到最后一行 `return undefined` ⇒ 该行被判为「坏行」并**忽略**，
 * 既不会让读侧抛错，也不会把 `truncateTo` 设上（撕裂尾行才设），所以新行不会被旧 reader 吃掉。
 */
function oldValidateManifestLine(parsed: unknown): (OldManifestLine & { crc: string }) | undefined {
  const line = parseWithCrc<OldManifestLine>(parsed);
  if (line === undefined || line.v !== 1) return undefined;
  if (line.kind === 'open') {
    return typeof line.at === 'number' ? line : undefined;
  }
  if (line.kind === 'archive') {
    return typeof line.from_seq === 'number' &&
      typeof line.to_seq === 'number' &&
      typeof line.at === 'number'
      ? line
      : undefined;
  }
  if (line.kind === 'tainted') {
    return typeof line.reason === 'string' &&
      typeof line.from_seq === 'number' &&
      typeof line.to_seq === 'number' &&
      typeof line.at === 'number'
      ? line
      : undefined;
  }
  return undefined;
}

/** 旧 `readManifest()` 的口径：出现**任何** `tainted` 行就算污点（没有 last-wins）。 */
async function oldReaderVerdict(sessionDir: string): Promise<{
  threw?: string;
  tainted: boolean;
  ignoredLines: number;
  totalLines: number;
  truncated: boolean;
}> {
  try {
    const result = await readCrcNdjsonFile<OldManifestLine>(
      join(sessionDir, TIMELINE_LAYOUT.timelineManifest),
      oldValidateManifestLine,
    );
    let tainted = false;
    for (const line of result.items) {
      if (line.kind === 'tainted') tainted = true;
    }
    return {
      tainted,
      ignoredLines: result.invalid.length,
      totalLines: result.items.length + result.invalid.length,
      truncated: result.truncateTo !== undefined,
    };
  } catch (error) {
    return {
      threw: error instanceof Error ? error.message : String(error),
      tainted: false,
      ignoredLines: 0,
      totalLines: 0,
      truncated: false,
    };
  }
}

// ---------------------------------------------------------------- 场景

const roots: string[] = [];

/** ① 失败可见 → ② 成功复位且历史不丢 → ③ 重启仍 false → ⑧ 旧 reader 兼容。 */
async function resetAfterFailure(workDir: string): Promise<void> {
  console.log('');
  console.log('— 场景 A：瞬时归档失败 ⇒ 健康归档复位（① ② ③ ⑧）');
  const sessionDir = join(workDir, 'reset');
  let failTimeline = true;
  const writer = await openWriter({
    sessionId: 'reset',
    sessionDir,
    beforeSync: (kind) => {
      if (failTimeline && kind === 'timeline') {
        throw new Error('injected_timeline_fsync_failure');
      }
    },
  });
  await writer.appendMany([fact(1), fact(2), fact(3)]);

  const failed = await writer.archive();
  const afterFailure = writer.heads();
  assertEqual('① 注入归档失败：archive() 返回 ok=false', failed.ok, false);
  assertEqual('① 注入归档失败：tainted === true', afterFailure.tainted, true);
  assertEqual('① 注入归档失败：timeline_head 冻结在 0', afterFailure.timeline_head, 0);
  assertEqual('① 注入归档失败：wal_head 照常前进', afterFailure.wal_head, 3);
  assertEqual('① 注入归档失败：不产生洞（洞只属于真丢失）', afterFailure.holes.length, 0);

  const afterFailureLines = await manifestRawLines(sessionDir);
  assertEqual(
    '① 注入归档失败：manifest 里有且只有一条 tainted 行',
    countKind(afterFailureLines, 'tainted'),
    1,
  );
  assertEqual(
    '① 注入归档失败：还没有 tainted_cleared 行',
    countKind(afterFailureLines, 'tainted_cleared'),
    0,
  );
  const textAfterFailure = await manifestText(sessionDir);

  failTimeline = false;
  await writer.appendMany([fact(4), fact(5)]);
  const recovered = await writer.archive();
  const afterClear = writer.heads();
  assertEqual('② 成功归档一次：archive() 返回 ok=true', recovered.ok, true);
  assertEqual('② 成功归档一次：tainted === false', afterClear.tainted, false);
  assertEqual(
    '② 成功归档一次：timeline_head 追平 wal_head',
    afterClear.timeline_head,
    afterClear.wal_head,
  );
  assertTrue(
    '② 成功归档一次：timeline_head > 0',
    afterClear.timeline_head > 0,
    `timeline_head=${String(afterClear.timeline_head)}`,
  );

  const textAfterClear = await manifestText(sessionDir);
  assertTrue(
    '② manifest 只追加：失败时刻的字节全部还在（不回头改历史）',
    textAfterClear.startsWith(textAfterFailure),
    `prefix-lost at ${String(textAfterFailure.length)} / ${String(textAfterClear.length)}`,
  );
  const afterClearLines = await manifestRawLines(sessionDir);
  assertEqual('② 失败那条 tainted 行还在（审计不丢）', countKind(afterClearLines, 'tainted'), 1);
  assertEqual(
    '② 成功一次只追加一条 tainted_cleared',
    countKind(afterClearLines, 'tainted_cleared'),
    1,
  );
  const clearedLine = afterClearLines.find((line) => line.kind === 'tainted_cleared');
  assertTrue(
    '② cleared 行字段齐全（v/kind/at/reason/from_seq/to_seq）',
    clearedLine !== undefined,
    JSON.stringify(clearedLine),
  );
  assertEqual('② cleared 行 v=1', clearedLine?.v, 1);
  assertTrue(
    '② cleared 行 reason 是非空字符串',
    typeof clearedLine?.reason === 'string' && clearedLine.reason.length > 0,
    String(clearedLine?.reason),
  );
  assertTrue(
    '② cleared 行 at 是数字',
    typeof clearedLine?.at === 'number',
    String(clearedLine?.at),
  );
  assertEqual(
    '② cleared 行的 from_seq = 本次归档区间起点',
    clearedLine?.from_seq,
    recovered.from_seq,
  );
  assertEqual('② cleared 行的 to_seq = 本次归档区间终点', clearedLine?.to_seq, recovered.to_seq);
  assertEqual(
    '② 物理顺序上最后一条状态声明是 cleared（last-wins 的收口）',
    lastStateKind(afterClearLines),
    'tainted_cleared',
  );

  await writer.close();
  const textBeforeRestart = await manifestText(sessionDir);
  const reopened = await openWriter({ sessionId: 'reset', sessionDir });
  const afterRestart = reopened.heads();
  assertEqual('③ 重启（重开 writer）后 tainted 仍为 false', afterRestart.tainted, false);
  assertTrue(
    '③ 重启后 timeline_head 不回退',
    afterRestart.timeline_head >= afterClear.timeline_head,
    `before=${String(afterClear.timeline_head)} after=${String(afterRestart.timeline_head)}`,
  );
  const textAfterRestart = await manifestText(sessionDir);
  assertTrue(
    '③ 重开 writer 不重写 manifest（纯追加，一个字节都不改）',
    textAfterRestart === textBeforeRestart,
    `bytes=${String(textBeforeRestart.length)}/${String(textAfterRestart.length)}`,
  );
  await reopened.close();

  // ⑧ 旧 reader 读同一份新 manifest
  const textBeforeOldReader = await manifestText(sessionDir);
  const old = await oldReaderVerdict(sessionDir);
  assertTrue(
    '⑧ 旧 reader 读新 manifest 不抛错（未知 kind 不会炸）',
    old.threw === undefined,
    String(old.threw),
  );
  assertEqual('⑧ 旧 reader 把 cleared 行当坏行忽略（只忽略那一条）', old.ignoredLines, 1);
  assertEqual('⑧ 旧 reader 判 tainted === true（安全方向：宁可多报脏）', old.tainted, true);
  const textAfterOldReader = await manifestText(sessionDir);
  assertTrue(
    '⑧ 旧 reader 不截断新 manifest（cleared 行还完整在盘上）',
    textAfterOldReader === textBeforeOldReader,
    `bytes=${String(textBeforeOldReader.length)}/${String(textAfterOldReader.length)}`,
  );
  assertEqual('⑧ 旧 reader 也不把整份 manifest 判成坏行（只丢未知那一条）', old.totalLines, 4);
}

/** ④ 有洞时永不洗白。 */
async function holesBlockClearing(workDir: string): Promise<void> {
  console.log('');
  console.log('— 场景 B：有存活洞 ⇒ 归档成功也不许写 cleared（④）');
  const sessionDir = join(workDir, 'with-holes');
  let walSyncs = 0;
  const writer = await openWriter({
    sessionId: 'with-holes',
    sessionDir,
    beforeSync: (kind) => {
      if (kind !== 'wal') return;
      walSyncs += 1;
      if (walSyncs === 2) throw new Error('injected_wal_fsync_failure');
    },
  });
  await writer.append(fact(1));
  let threw = false;
  try {
    await writer.append(fact(2));
  } catch (error) {
    threw = /timeline_write_failed/.test(String(error));
  }
  await writer.append(fact(3));

  const beforeArchive = writer.heads();
  assertTrue('④ 前置：注入的写失败已抛 timeline_write_failed', threw);
  assertTrue(
    '④ 前置：失败区间已登记成洞',
    covers(beforeArchive.holes, 2),
    JSON.stringify(beforeArchive.holes),
  );
  assertEqual('④ 前置：有洞 ⇒ tainted=true', beforeArchive.tainted, true);

  const archived = await writer.archive();
  const afterArchive = writer.heads();
  assertEqual('④ 有洞时归档本身成功（空间回收与洞无关）', archived.ok, true);
  assertEqual('④ 有洞时归档成功：tainted 仍为 true', afterArchive.tainted, true);
  assertEqual(
    '④ 有洞时归档成功：timeline_head 推进到 wal_head',
    afterArchive.timeline_head,
    afterArchive.wal_head,
  );
  assertEqual(
    '④ 有洞时归档成功：manifest 里没有 tainted_cleared',
    countKind(await manifestRawLines(sessionDir), 'tainted_cleared'),
    0,
  );

  // 第二次健康归档：仍然不许写（不是「第一次判错」，是「有洞就永远不洗白」）
  await writer.append(fact(4));
  const secondArchive = await writer.archive();
  assertEqual('④ 第二次归档也成功', secondArchive.ok, true);
  assertEqual(
    '④ 第二次健康归档仍不写 tainted_cleared（有洞永不洗白）',
    countKind(await manifestRawLines(sessionDir), 'tainted_cleared'),
    0,
  );
  assertEqual('④ 第二次归档后 tainted 仍为 true', writer.heads().tainted, true);
  await writer.close();

  const reopened = await openWriter({ sessionId: 'with-holes', sessionDir });
  const afterRestart = reopened.heads();
  assertEqual('④ 重启后 tainted 仍为 true（洞还在）', afterRestart.tainted, true);
  assertTrue('④ 重启后洞仍在', covers(afterRestart.holes, 2), JSON.stringify(afterRestart.holes));
  assertEqual(
    '④ 重启后 manifest 里仍然没有 tainted_cleared',
    countKind(await manifestRawLines(sessionDir), 'tainted_cleared'),
    0,
  );
  await reopened.close();
}

/** ⑤ 连续两次失败 + 一次成功：只一条 cleared、历史不丢、后续不补。 */
async function multipleFailures(workDir: string): Promise<void> {
  console.log('');
  console.log('— 场景 C：连续两次归档失败 + 一次成功（⑤）');
  const sessionDir = join(workDir, 'twice');
  let timelineSyncs = 0;
  const writer = await openWriter({
    sessionId: 'twice',
    sessionDir,
    beforeSync: (kind) => {
      if (kind !== 'timeline') return;
      timelineSyncs += 1;
      // 每个 archive() 在 0 / 100 / 500 / 2000 ms 后各试一次 ⇒ 前两次 archive() 共 8 次段 fsync。
      if (timelineSyncs <= 8) throw new Error('injected_timeline_fsync_failure');
    },
  });
  await writer.appendMany([fact(1), fact(2)]);
  const firstFail = await writer.archive();
  const secondFail = await writer.archive();
  assertEqual('⑤ 第一次归档失败：ok=false', firstFail.ok, false);
  assertEqual('⑤ 第二次归档失败：ok=false', secondFail.ok, false);
  assertEqual('⑤ 连续两次失败：tainted=true', writer.heads().tainted, true);
  assertEqual('⑤ 连续两次失败：timeline_head 仍冻结', writer.heads().timeline_head, 0);
  const afterFailsLines = await manifestRawLines(sessionDir);
  assertEqual(
    '⑤ 两次失败各留一条 tainted 行（审计不合并）',
    countKind(afterFailsLines, 'tainted'),
    2,
  );
  assertEqual('⑤ 失败期间一条 cleared 都没有', countKind(afterFailsLines, 'tainted_cleared'), 0);
  const textAfterFails = await manifestText(sessionDir);

  await writer.append(fact(3));
  const recovered = await writer.archive();
  assertEqual('⑤ 之后成功一次：ok=true', recovered.ok, true);
  assertEqual('⑤ 之后成功一次：tainted=false', writer.heads().tainted, false);
  const afterRecoverLines = await manifestRawLines(sessionDir);
  assertEqual('⑤ 两条失败历史行都还在（不丢）', countKind(afterRecoverLines, 'tainted'), 2);
  assertEqual(
    '⑤ 连续两次失败后成功一次只追加一条 cleared',
    countKind(afterRecoverLines, 'tainted_cleared'),
    1,
  );
  assertTrue(
    '⑤ manifest 只追加：失败时刻的字节全部还在',
    (await manifestText(sessionDir)).startsWith(textAfterFails),
    `prefix-lost at ${String(textAfterFails.length)}`,
  );
  assertEqual(
    '⑤ 最后生效的是 cleared（last-wins）',
    lastStateKind(afterRecoverLines),
    'tainted_cleared',
  );

  await writer.append(fact(4));
  const healthy = await writer.archive();
  assertEqual('⑤ 后续健康归档也成功', healthy.ok, true);
  assertEqual(
    '⑤ 后续健康归档不再补 cleared（不为每次归档补一条）',
    countKind(await manifestRawLines(sessionDir), 'tainted_cleared'),
    1,
  );
  await writer.close();

  const reopened = await openWriter({ sessionId: 'twice', sessionDir });
  assertEqual('⑤ 重启后仍为 false', reopened.heads().tainted, false);
  await reopened.close();
}

/** ⑥ 旧 manifest（没有 cleared 行）：升级后不自动洗白。 */
async function legacyManifestStaysTainted(workDir: string): Promise<void> {
  console.log('');
  console.log('— 场景 D：存量旧 manifest ⇒ 初值仍 tainted，直到一次合规清退（⑥）');
  const sessionDir = join(workDir, 'legacy-manifest');
  await writeManifestLines(sessionDir, [
    { v: 1, kind: 'open', at: NOW },
    {
      v: 1,
      kind: 'tainted',
      reason: 'archive_failed: ENOSPC',
      from_seq: 1,
      to_seq: 2,
      at: NOW + 1,
    },
  ]);

  const first = await openWriter({ sessionId: 'legacy', sessionDir });
  const initial = first.heads();
  assertEqual('⑥ 旧 manifest（只有历史 tainted 行）⇒ 初值 tainted=true', initial.tainted, true);
  assertEqual('⑥ 而且此刻没有洞（污点来自历史行，不是因为还丢了数据）', initial.holes.length, 0);
  await first.close();

  const second = await openWriter({ sessionId: 'legacy', sessionDir });
  assertEqual(
    '⑥ 升级后第一次健康归档之前不会自动洗白（重开仍是 true）',
    second.heads().tainted,
    true,
  );
  await second.appendMany([fact(1), fact(2)]);
  assertEqual('⑥ 追加事件也不改污点（只有合规清退才改）', second.heads().tainted, true);

  const cleared = await second.archive();
  assertEqual('⑥ 一次合规清退的归档本身成功', cleared.ok, true);
  assertEqual('⑥ 一次合规清退之后 tainted=false', second.heads().tainted, false);
  const afterClearLines = await manifestRawLines(sessionDir);
  assertEqual('⑥ 清退追加了一条 cleared', countKind(afterClearLines, 'tainted_cleared'), 1);
  assertEqual('⑥ 旧的历史 tainted 行仍在', countKind(afterClearLines, 'tainted'), 1);
  await second.close();

  const third = await openWriter({ sessionId: 'legacy', sessionDir });
  assertEqual('⑥ 清退后重启仍是 false', third.heads().tainted, false);
  await third.close();
}

/** ⑦ selftest：洞写不进去时 manifest `tainted` 行的尽力路径。 */
async function bestEffortManifestWhenHolesUnwritable(workDir: string): Promise<void> {
  console.log('');
  console.log('— 场景 E：[selftest ⑦] holes 写不进去时 manifest 的尽力路径');
  const sessionDir = join(workDir, 'holes-unwritable');
  let walSyncs = 0;
  const writer = await openWriter({
    sessionId: 'holes-unwritable',
    sessionDir,
    beforeSync: (kind) => {
      if (kind === 'holes') throw new Error('injected_holes_fsync_failure');
      if (kind !== 'wal') return;
      walSyncs += 1;
      if (walSyncs === 2) throw new Error('injected_wal_fsync_failure');
    },
  });
  await writer.append(fact(1));
  let threw = false;
  try {
    await writer.append(fact(2));
  } catch (error) {
    threw = /timeline_write_failed/.test(String(error));
  }
  const afterFailure = writer.heads();
  assertTrue('[selftest ⑦] 写失败仍抛 timeline_write_failed', threw);
  assertEqual(
    '[selftest ⑦] 洞登记失败 ⇒ 内存污点照样置位（tainted=true）',
    afterFailure.tainted,
    true,
  );
  assertEqual(
    '[selftest ⑦] 洞登记没成功（内存 holes 为空，写者不假装已声明）',
    afterFailure.holes.length,
    0,
  );
  const bestEffort = (await manifestRawLines(sessionDir)).filter((line) => line.kind === 'tainted');
  assertEqual('[selftest ⑦] 尽力路径：manifest 追加了一条 tainted 行', bestEffort.length, 1);
  const bestEffortReason = bestEffort[0]?.reason;
  assertTrue(
    '[selftest ⑦] 尽力行写明了「holes 也写不进去」',
    typeof bestEffortReason === 'string' && bestEffortReason.includes('holes write failed'),
    String(bestEffortReason),
  );
  // 再落一条更大的 seq：重启时该缺失 seq 才会落进 findGaps 的 knownMax 范围。
  await writer.append(fact(3));
  await writer.close();

  const reopened = await openWriter({ sessionId: 'holes-unwritable', sessionDir });
  const afterRestart = reopened.heads();
  // `beforeSync` 只能让 fsync 失败（行字节可能已写进文件）：重启后要么读回那条洞行，
  // 要么由恢复期的 `findGaps` 补登记。**两条路都不许「无声」** —— 这是本断言的全部要求。
  const restartHole = afterRestart.holes.find((hole) => covers([hole], 2));
  assertTrue(
    '[selftest ⑦] 重启后缺失 seq 必有声明（读回洞行 或 恢复期补登记）',
    restartHole !== undefined,
    JSON.stringify(afterRestart.holes),
  );
  assertTrue(
    '[selftest ⑦] 该声明带着失败原因（不是匿名的洞）',
    typeof restartHole?.reason === 'string' && restartHole.reason.length > 0,
    String(restartHole?.reason),
  );
  assertEqual('[selftest ⑦] 重启后 tainted 仍为 true', afterRestart.tainted, true);
  await reopened.close();
}

/** F 补充：定序依据是物理写入顺序，不是 `at`。 */
async function clockRollbackDoesNotReorder(workDir: string): Promise<void> {
  console.log('');
  console.log('— 场景 F：时钟回退不改 last-wins 结果（补充，更严）');
  const backDir = join(workDir, 'clock-back');
  await writeManifestLines(backDir, [
    { v: 1, kind: 'open', at: NOW },
    {
      v: 1,
      kind: 'tainted',
      reason: 'archive_failed',
      from_seq: 1,
      to_seq: 1,
      at: NOW + 1_000_000,
    },
    {
      v: 1,
      kind: 'tainted_cleared',
      reason: 'archive_recovered',
      from_seq: 1,
      to_seq: 1,
      at: NOW,
    },
  ]);
  const backWriter = await openWriter({ sessionId: 'clock-back', sessionDir: backDir });
  assertEqual(
    'F 时钟回退：cleared 的 at 更小、但物理在最后 ⇒ tainted=false',
    backWriter.heads().tainted,
    false,
  );
  await backWriter.close();

  const forwardDir = join(workDir, 'clock-forward');
  await writeManifestLines(forwardDir, [
    { v: 1, kind: 'open', at: NOW },
    {
      v: 1,
      kind: 'tainted_cleared',
      reason: 'archive_recovered',
      from_seq: 1,
      to_seq: 1,
      at: NOW + 1_000_000,
    },
    {
      v: 1,
      kind: 'tainted',
      reason: 'archive_failed',
      from_seq: 1,
      to_seq: 1,
      at: NOW,
    },
  ]);
  const forwardWriter = await openWriter({ sessionId: 'clock-forward', sessionDir: forwardDir });
  assertEqual(
    'F 反过来：tainted 的 at 更小、但物理在最后 ⇒ tainted=true',
    forwardWriter.heads().tainted,
    true,
  );
  await forwardWriter.close();
}

const workDir = await mkdtemp(join(tmpdir(), 'vessel-timeline-tainted-'));
roots.push(workDir);
console.log('0.54 tainted 复位：当前健康位 vs 历史审计行（last-wins / additive / 向后兼容）');
console.log(`work-dir: ${workDir}`);

try {
  await resetAfterFailure(workDir);
  await holesBlockClearing(workDir);
  await multipleFailures(workDir);
  await legacyManifestStaysTainted(workDir);
  await bestEffortManifestWhenHolesUnwritable(workDir);
  await clockRollbackDoesNotReorder(workDir);
} finally {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

console.log('');
console.log(
  `RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} (checks=${String(checks)} failed=${String(failures)})`,
);
if (failures > 0) {
  console.log(
    '结论：FAIL（tainted 没有按「派生值 + last-wins」复位：要么失败不再可见，要么历史行被回改/丢失，要么旧 reader 被炸）',
  );
  process.exit(1);
}
console.log(
  '结论：PASS（失败可见 / 健康归档复位 / 重启保持 / 有洞永不洗白 / 只补一条 cleared / 旧会话不自动洗白 / 尽力路径在 / 旧 reader 安全降级）',
);
