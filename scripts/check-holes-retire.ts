#!/usr/bin/env bun

/**
 * 0.54 洞退役门禁：`hole_retired` 声明 + last-wins（冻结面第二刀）。
 *
 * ## 修的是什么
 *
 * `holes.ndjson` 过去只增不减 ⇒ 一个洞**后来被修好了**，`tainted` 却永远回不到 false
 * （「损坏已恢复」的会话永久顶着污点条）。这与刚修掉的 `tainted` 粘性 bug 同构：
 * 把一个「历史事实」当成了「当前状态」。
 *
 * ## 落地形态（与同族先例 `tainted_cleared` 逐条对齐）
 *
 * | 概念 | 载体 | 语义 |
 * | --- | --- | --- |
 * | 登记一个洞 | `holes.ndjson`（历史形状，**没有** `kind`） | 事实，append-only 不改历史行 |
 * | 退役一个洞 | `holes.ndjson` 追加 `kind:'hole_retired'` | 事实，**必须自证**才允许写 |
 * | 会话级 `tainted` | 写者派生值 | 「**未退役**洞集合非空」或 manifest last-wins `tainted` |
 *
 * **退役前提 = 区间重读自证（本单选的是 ①，不是人工签字 ②）**：`HoleRegistry.retire()`
 * 先把 `[from_seq,to_seq]` 从 `timeline.ndjson` / `wal.blocks/*.wblk` / `wal.log` 三处重读，
 * 区间内**每个 seq 都必须逐条 CRC 通过**；缺一条或坏一条 ⇒ 拒绝退役、一个字节都不写。
 * 为什么选 ①：人工签字（`--retire-holes` + 理由）只能证明「操作者认为好了」，而 ① 让**盘上
 * 的字节**自己作证；`tainted` 是唯一的健康信号，一个能靠签字洗白的信号等于没有信号。
 * 理由仍要人给（落到退役行的 `reason`），但它只是**审计**，不是放行条件。
 *
 * **触发方式 = 显式 API**：`TimelineWriter.retireHoles({from_seq,to_seq,reason})`。生产上的
 * 运维命令/CLI 接线在装配层 `src/**`（本切片禁止改），所以今天「怎么触发」= 显式调用这个
 * 方法。**没有任何自动退役**：`open()` 不做全量重读、不写退役行 —— 那会让启动变慢，
 * 还会把坏块悄悄洗白（本门禁的 G 就钉这一条）。
 *
 * | # | 断言 | 为什么必须这样 |
 * | --- | --- | --- |
 * | ① | 登记洞 ⇒ `tainted=true`；**真丢失**的区间退役被拒（记录确实不在，重读通不过） | 退役不是「清一下」，是「已证明可读」 |
 * | ② | 可退役的洞 ⇒ 追加 `hole_retired`、无别的存活洞 ⇒ `tainted=false`；`holes` 上报为空 | 修好的洞不许继续压制健康位 |
 * | ③ | 重启后仍 `false`（且 `holes.ndjson` / manifest 逐字节不变） | last-wins 必须落在盘上，不能只是内存 |
 * | ④ | **还有别的存活洞时**，退役一个 ⇒ 仍 `true`，且**不写** `tainted_cleared` | 防「清一个就把所有污点洗掉」 |
 * | ⑤ | 连续退役 / 退役后又登记同区间 ⇒ last-wins 取**物理行序最后一条** | 与 `tainted_cleared` 同一形态 |
 * | ⑥ | 旧 reader 读含 `hole_retired` 的文件：**不抛错**、且保守认为洞仍在、不截断 | 兼容只能往安全方向偏 |
 * | ⑦ | 区间里改一个字节 ⇒ CRC 不过 ⇒ **拒绝退役**、`tainted` 仍 true、不写退役行 | 自证必须是真自证（不许只看长度/条数） |
 * | F | 补充（更严）：退役行的 `at` 更小但物理在最后 ⇒ 仍是 `false`；反过来仍 `true` | 定序依据是物理写入顺序，**严禁按 `at`** |
 * | G | 打开写者**不会**自动退役（可退役的洞在 `open()` 之后仍然是洞） | 「打开时自动扫全量重读」是明确禁止的 |
 *
 * ## 注入手段（全部用既有测试缝 / 文件夹具）
 *
 * - 造真洞：`TimelineWriterOptions.beforeSync('wal')`（与 `check-timeline-holes` 同口径）；
 * - 造「误登记/已修复」的洞：直接在 `holes.ndjson` 追加一条历史形状的登记行（夹具就是
 *   「该区间其实可读」这一情形：数据在、但当时被判成坏）；
 * - 造 CRC 不过：把 `wal.log` 里某条记录的 `data` 改一个值（JSON 仍合法、CRC 必然不符）。
 *
 * ## 已知边界（本单不修，别顺手改）
 *
 * 1. `wal.ts#readHoles()` **逐字节未改**，它不认 `kind` ⇒ 仍把退役行当成「又一条洞」，
 *    `packages/core/src/timeline/index.ts` 与 `src/timeline-dual-write.ts#readHeadsOnDisk`
 *    走它 ⇒ 那两处对 retired 会话仍报「有洞 / tainted」（**保守方向**，不会误清）。
 *    它们要跟上的话是各自一张单；本门禁的 ⑥ 就把这条兼容性钉住。
 * 2. 不支持「半段退役」：退役必须精确匹配一条存活登记区间（半段会把区间语义拆碎）。
 * 3. 退役不改 `maxSeq()`：seq 号永不回收（`nextSeq` 沿用），只从存活洞集合里消失。
 * 4. 同一区间的**重复登记行**现在折叠成一条（`list()` 按 last-wins 折叠）。旧行为会把
 *    `[2,2]` 数两次，客户端按 `Σ|holes ∩ range|` 减就多减了 —— 折叠顺带修掉这个双计。
 *
 * 用法：`bun run scripts/check-holes-retire.ts`
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HoleRegistry, verifyHoleIntervalReadable } from '../packages/core/src/timeline/holes';
import { TIMELINE_LAYOUT, type TimelineSyncKind } from '../packages/core/src/timeline/types';
import { parseWithCrc, readHoles, withCrc } from '../packages/core/src/timeline/wal';
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

function assertStartsWith(name: string, actual: unknown, prefix: string): void {
  assertTrue(
    name,
    typeof actual === 'string' && actual.startsWith(prefix),
    `actual=${String(actual)} prefix=${prefix}`,
  );
}

function fact(index: number): { run_id: string; type: string; ts: number; data: unknown } {
  return { run_id: 'run-retire', type: 'assistant.message', ts: NOW + index, data: { index } };
}

function covers(holes: ReadonlyArray<{ from_seq: number; to_seq: number }>, seq: number): boolean {
  return holes.some((hole) => seq >= hole.from_seq && seq <= hole.to_seq);
}

type RawLine = Record<string, unknown>;

// ---------------------------------------------------------------- 文件夹具

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '');
}

async function rawLines(path: string): Promise<RawLine[]> {
  const text = await readText(path);
  const lines: RawLine[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    lines.push(JSON.parse(line) as RawLine);
  }
  return lines;
}

function holesPath(sessionDir: string): string {
  return join(sessionDir, TIMELINE_LAYOUT.holes);
}

function manifestPath(sessionDir: string): string {
  return join(sessionDir, TIMELINE_LAYOUT.timelineManifest);
}

function countKind(lines: readonly RawLine[], kind: string): number {
  return lines.filter((line) => line.kind === kind).length;
}

/** 登记行（历史形状：**没有** `kind`）写进 `holes.ndjson`。 */
async function appendHoleRegistration(
  sessionDir: string,
  fromSeq: number,
  toSeq: number,
  reason: string,
  at = NOW,
): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  const line = withCrc({ v: 1, from_seq: fromSeq, to_seq: toSeq, reason, at });
  await appendFile(holesPath(sessionDir), `${JSON.stringify(line)}\n`, 'utf8');
}

/** 物理顺序上最后一条状态声明（manifest 的 `tainted` / `tainted_cleared`）。 */
function lastManifestState(lines: readonly RawLine[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const kind = lines[index]?.kind;
    if (kind === 'tainted' || kind === 'tainted_cleared') return kind;
  }
  return undefined;
}

/** 把 `wal.log` 里 `seq` 那条记录的载荷改一个值：JSON 仍合法，CRC 必然不符。 */
async function corruptRecordPayload(sessionDir: string, seq: number): Promise<void> {
  const path = join(sessionDir, TIMELINE_LAYOUT.walLog);
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as RawLine;
    if (parsed.seq !== seq) continue;
    parsed.data = { index: 999 };
    lines[index] = JSON.stringify(parsed);
    await writeFile(path, lines.join('\n'), 'utf8');
    return;
  }
  throw new Error(`wal_record_not_found: ${String(seq)}`);
}

function openWriter(input: {
  sessionId: string;
  sessionDir: string;
  beforeSync?: (kind: TimelineSyncKind) => void;
}): Promise<TimelineWriter> {
  return TimelineWriter.open({
    sessionId: input.sessionId,
    sessionDir: input.sessionDir,
    now: () => NOW,
    ...(input.beforeSync !== undefined ? { beforeSync: input.beforeSync } : {}),
  });
}

/** 造一个「1..count 全部可读」的会话，用于手搓声明行的夹具。 */
async function sessionWithFacts(
  workDir: string,
  name: string,
  count: number,
): Promise<{ sessionId: string; sessionDir: string }> {
  const sessionId = name;
  const sessionDir = join(workDir, name);
  const writer = await openWriter({ sessionId, sessionDir });
  for (let index = 1; index <= count; index += 1) await writer.append(fact(index));
  await writer.close();
  return { sessionId, sessionDir };
}

// ---------------------------------------------------------------- 旧 reader（逐字抄自基线）

/**
 * 0.54 之前的 `holes.ndjson` 行校验：**只有历史形状**（`v/from_seq/to_seq/reason/at`）。
 *
 * 与真实基线一致的关键行为：它**不看** `kind`（多出来的字段不影响校验）⇒ 退役行会被
 * 当成**又一条登记** ⇒ 旧 reader 认为洞仍在（安全方向）；既不抛错，也不会设 `truncateTo`
 * （只有末尾无换行才设），所以退役行不会被旧 reader 吃掉。
 */
function oldValidateHoleLine(parsed: unknown): RawLine | undefined {
  const line = parseWithCrc<RawLine>(parsed);
  if (line === undefined || line.v !== 1) return undefined;
  if (!Number.isSafeInteger(line.from_seq) || (line.from_seq as number) < 1) return undefined;
  if (!Number.isSafeInteger(line.to_seq) || (line.to_seq as number) < (line.from_seq as number)) {
    return undefined;
  }
  if (typeof line.reason !== 'string' || typeof line.at !== 'number') return undefined;
  return line;
}

/**
 * 更严的旧 reader：**只认历史字面字段集**（`kind` 出现即视为未知行 ⇒ 忽略）。
 *
 * 这一种代表「将来某个知道 `kind` 但还不认识 `hole_retired` 的读者」。它忽略退役行 ⇒
 * 洞仍在（保守方向），同样不抛错。
 */
const LEGACY_HOLE_KEYS = new Set(['v', 'from_seq', 'to_seq', 'reason', 'at', 'crc']);

function strictOldValidateHoleLine(parsed: unknown): RawLine | undefined {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  for (const key of Object.keys(parsed as RawLine)) {
    if (!LEGACY_HOLE_KEYS.has(key)) return undefined;
  }
  return oldValidateHoleLine(parsed);
}

/** 用旧口径读一遍 `holes.ndjson`（不截断、不改文件）。 */
async function oldReaderVerdict(sessionDir: string): Promise<{
  threw?: string;
  holes: Array<{ from_seq: number; to_seq: number }>;
  ignored: number;
}> {
  try {
    const text = await readText(holesPath(sessionDir));
    const holes: Array<{ from_seq: number; to_seq: number }> = [];
    let ignored = 0;
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = undefined;
      }
      const accepted = parsed === undefined ? undefined : oldValidateHoleLine(parsed);
      if (accepted === undefined) {
        ignored += 1;
        continue;
      }
      holes.push({ from_seq: accepted.from_seq as number, to_seq: accepted.to_seq as number });
    }
    return { holes, ignored };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error), holes: [], ignored: 0 };
  }
}

/** 同上，但用「只认历史字段集」的更严读者。 */
async function strictOldReaderVerdict(sessionDir: string): Promise<{
  threw?: string;
  holes: Array<{ from_seq: number; to_seq: number }>;
  ignored: number;
}> {
  try {
    const text = await readText(holesPath(sessionDir));
    const holes: Array<{ from_seq: number; to_seq: number }> = [];
    let ignored = 0;
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = undefined;
      }
      const accepted = parsed === undefined ? undefined : strictOldValidateHoleLine(parsed);
      if (accepted === undefined) {
        ignored += 1;
        continue;
      }
      holes.push({ from_seq: accepted.from_seq as number, to_seq: accepted.to_seq as number });
    }
    return { holes, ignored };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error), holes: [], ignored: 0 };
  }
}

// ---------------------------------------------------------------- 场景

const roots: string[] = [];

/** ① 真丢失的洞不许退役；不许退役没登记过的区间。 */
async function genuineLossCannotBeRetired(workDir: string): Promise<void> {
  console.log('');
  console.log('— 场景 A：真丢失的洞拒绝退役（①）');
  const sessionId = 'genuine-loss';
  const sessionDir = join(workDir, sessionId);
  let walSyncs = 0;
  const writer = await openWriter({
    sessionId,
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

  const before = writer.heads();
  assertTrue('① 前置：注入的写失败已抛 timeline_write_failed', threw);
  assertTrue('① 前置：失败区间已登记成洞', covers(before.holes, 2), JSON.stringify(before.holes));
  assertEqual('① 前置：有洞 ⇒ tainted=true', before.tainted, true);

  const beforeText = await readText(holesPath(sessionDir));
  const refused = await writer.retireHoles({ from_seq: 2, to_seq: 2, reason: 'ops_thinks_ok' });
  assertEqual('① 真丢失区间退役 ⇒ 被拒（ok=false）', refused.ok, false);
  assertEqual(
    '① 拒绝 code = hole_interval_not_readable（上层可映射，不解析文本）',
    refused.code,
    'hole_interval_not_readable',
  );
  assertStartsWith(
    '① 拒绝细节写明「区间重读没通过」（不是偷偷放过）',
    refused.reason,
    'reread_failed:2-2',
  );
  assertTrue(
    '① 拒绝原因列出了读不回来的 seq',
    typeof refused.reason === 'string' && refused.reason.includes('missing=2'),
    String(refused.reason),
  );
  assertEqual('① 拒绝后 tainted 仍为 true', writer.heads().tainted, true);
  assertTrue(
    '① 拒绝后洞仍在',
    covers(writer.heads().holes, 2),
    JSON.stringify(writer.heads().holes),
  );
  const afterText = await readText(holesPath(sessionDir));
  assertEqual('① 被拒时 holes.ndjson 一个字节都不写', afterText, beforeText);
  assertEqual(
    '① 被拒时没有写入任何 hole_retired 行',
    countKind(await rawLines(holesPath(sessionDir)), 'hole_retired'),
    0,
  );

  const unregistered = await writer.retireHoles({
    from_seq: 99,
    to_seq: 99,
    reason: 'nothing_here',
  });
  assertEqual('① 退役一段没登记过的区间 ⇒ 被拒', unregistered.ok, false);
  assertEqual('① 拒绝 code 是 hole_not_registered', unregistered.code, 'hole_not_registered');
  assertEqual(
    '① 没登记过的区间也不会留下退役行',
    countKind(await rawLines(holesPath(sessionDir)), 'hole_retired'),
    0,
  );
  await writer.close();
}

/** ② ③ ⑤-append-only + G 打开不自动退役。 */
async function retirementClearsTaint(workDir: string): Promise<void> {
  console.log('');
  console.log('— 场景 B：可退役的洞 ⇒ 退役后 tainted=false，重启仍 false（② ③ G）');
  const sessionId = 'retired-ok';
  const sessionDir = join(workDir, sessionId);
  const writer = await openWriter({ sessionId, sessionDir });
  for (let index = 1; index <= 3; index += 1) await writer.append(fact(index));
  await writer.close();

  // 夹具：一条「误登记 / 已修复」的洞 —— 数据在盘上逐条可读，但当时被判成坏。
  await appendHoleRegistration(sessionDir, 2, 2, 'false_alarm_repaired');
  const textWithHole = await readText(holesPath(sessionDir));

  const reopened = await openWriter({ sessionId, sessionDir });
  const afterOpen = reopened.heads();
  assertEqual('G 打开写者不会自动退役：洞仍在', afterOpen.holes.length, 1);
  assertEqual('G 打开写者不会自动退役：tainted 仍为 true', afterOpen.tainted, true);
  assertEqual(
    'G 打开写者不写任何退役行（不许「顺手腾一下」）',
    countKind(await rawLines(holesPath(sessionDir)), 'hole_retired'),
    0,
  );
  assertEqual(
    'G 打开写者不改 holes.ndjson（纯读）',
    await readText(holesPath(sessionDir)),
    textWithHole,
  );

  const retired = await reopened.retireHoles({
    from_seq: 2,
    to_seq: 2,
    reason: 'interval_reread_ok',
  });
  assertEqual('② 退役成功（区间重读逐条 CRC 通过）', retired.ok, true);
  assertStartsWith('② 退役返回自证摘要', retired.evidence, 'reread_ok:2-2:verified=1/1');
  const afterRetire = reopened.heads();
  assertEqual('② 无别的存活洞 ⇒ tainted=false', afterRetire.tainted, false);
  assertEqual('② 上报的 holes 为空（已退役区间不再算不可读）', afterRetire.holes.length, 0);

  const textAfterRetire = await readText(holesPath(sessionDir));
  assertTrue(
    '② holes.ndjson 只追加：退役时刻之前的字节全部还在（已有行一个字都不改）',
    textAfterRetire.startsWith(textWithHole),
    `prefix-lost at ${String(textWithHole.length)} / ${String(textAfterRetire.length)}`,
  );
  const lines = await rawLines(holesPath(sessionDir));
  assertEqual('② 只追加了一条 hole_retired 行', countKind(lines, 'hole_retired'), 1);
  assertEqual('② 原来的登记行还在（审计不丢）', lines.length, 2);
  const retiredLine = lines.find((line) => line.kind === 'hole_retired');
  assertEqual('② 退役行 v=1', retiredLine?.v, 1);
  assertEqual('② 退役行 kind=hole_retired', retiredLine?.kind, 'hole_retired');
  assertEqual('② 退役行 from_seq', retiredLine?.from_seq, 2);
  assertEqual('② 退役行 to_seq', retiredLine?.to_seq, 2);
  assertEqual('② 退役行 reason 是操作者给的理由', retiredLine?.reason, 'interval_reread_ok');
  assertTrue('② 退役行 at 是数字', typeof retiredLine?.at === 'number', String(retiredLine?.at));
  assertEqual('② 退役行带自证摘要 evidence', retiredLine?.evidence, retired.evidence);
  assertTrue(
    '② 退役行带 crc（坏行可识别）',
    typeof retiredLine?.crc === 'string' && retiredLine.crc.length === 8,
    String(retiredLine?.crc),
  );
  assertEqual(
    '② 退役后 manifest 最后一条状态声明是 cleared（last-wins 收口）',
    lastManifestState(await rawLines(manifestPath(sessionDir))),
    'tainted_cleared',
  );
  const clearedLine = (await rawLines(manifestPath(sessionDir))).find(
    (line) => line.kind === 'tainted_cleared',
  );
  assertEqual('② cleared 行的 reason 指明是退役造成的', clearedLine?.reason, 'holes_retired');

  const again = await reopened.retireHoles({ from_seq: 2, to_seq: 2, reason: 'twice' });
  assertEqual('② 重复退役已退役区间 ⇒ 被拒（幂等、不多写行）', again.ok, false);
  assertEqual('② 重复退役的拒绝 code', again.code, 'hole_not_registered');
  assertEqual(
    '② 重复退役没有再多写退役行',
    countKind(await rawLines(holesPath(sessionDir)), 'hole_retired'),
    1,
  );
  const textBeforeClose = await readText(holesPath(sessionDir));
  const manifestBeforeClose = await readText(manifestPath(sessionDir));
  const headBeforeClose = reopened.heads();
  await reopened.close();

  const restarted = await openWriter({ sessionId, sessionDir });
  const afterRestart = restarted.heads();
  assertEqual('③ 重启后 tainted 仍为 false（last-wins 落在盘上）', afterRestart.tainted, false);
  assertEqual('③ 重启后 holes 仍为空', afterRestart.holes.length, 0);
  assertTrue(
    '③ 重启后 wal_head 不回退',
    afterRestart.wal_head >= headBeforeClose.wal_head,
    `before=${String(headBeforeClose.wal_head)} after=${String(afterRestart.wal_head)}`,
  );
  assertEqual(
    '③ 重启不改 holes.ndjson（不重写、不截断）',
    await readText(holesPath(sessionDir)),
    textBeforeClose,
  );
  assertEqual('③ 重启不改 manifest', await readText(manifestPath(sessionDir)), manifestBeforeClose);
  const appended = await restarted.append(fact(4));
  assertTrue(
    '③ 退役不退号：重启后新事件的 seq > 已退役区间',
    appended.seq > 2,
    `seq=${String(appended.seq)}`,
  );
  await restarted.close();

  // ⑥ 旧 reader 实测（同一个目录：登记行 + 退役行都在盘上）
  const bytesBeforeOldReader = await readText(holesPath(sessionDir));
  const old = await oldReaderVerdict(sessionDir);
  assertTrue('⑥ 旧 reader（基线口径）读新文件不抛错', old.threw === undefined, String(old.threw));
  assertEqual('⑥ 旧 reader 把退役行也当登记行（共 2 条）', old.holes.length, 2);
  assertTrue(
    '⑥ 旧 reader 因此仍认为 [2,2] 是洞（保守方向：不误清）',
    covers(old.holes, 2),
    JSON.stringify(old.holes),
  );
  assertEqual('⑥ 旧 reader 没有把任何行判成坏行', old.ignored, 0);
  assertEqual(
    '⑥ 旧 reader 不截断、不改文件（退役行还完整在盘上）',
    await readText(holesPath(sessionDir)),
    bytesBeforeOldReader,
  );
  const strictOld = await strictOldReaderVerdict(sessionDir);
  assertTrue(
    '⑥ 更严的旧 reader（只认历史字段集）也不抛错',
    strictOld.threw === undefined,
    String(strictOld.threw),
  );
  assertEqual('⑥ 更严的旧 reader 只忽略退役那一条', strictOld.ignored, 1);
  assertEqual('⑥ 更严的旧 reader 仍报出登记行', strictOld.holes.length, 1);
  assertTrue(
    '⑥ 更严的旧 reader 同样保守认为 [2,2] 是洞',
    covers(strictOld.holes, 2),
    JSON.stringify(strictOld.holes),
  );
  const baseline = await readHoles(sessionDir).catch((error: unknown) => String(error));
  const baselineHoles = Array.isArray(baseline) ? baseline : [];
  assertTrue(
    '⑥ 仓库里真实的旧解析器 wal.ts#readHoles()（逐字节未改）读新文件也不抛错',
    Array.isArray(baseline),
    JSON.stringify(baseline),
  );
  assertEqual('⑥ wal.ts#readHoles() 同样保守：2 条都算洞', baselineHoles.length, 2);
  assertTrue(
    '⑥ wal.ts#readHoles() 报出的区间仍覆盖 [2,2]（旧 reader 不会误清）',
    covers(baselineHoles, 2),
    JSON.stringify(baselineHoles),
  );
  console.log(
    `   实测输出 old=${JSON.stringify(old.holes)} strict_ignored=${String(strictOld.ignored)} ` +
      `wal.ts#readHoles=${JSON.stringify(baselineHoles)}`,
  );
}

/** ④ 还有别的存活洞时，退役一个不洗白整体。 */
async function otherLiveHolesKeepTaint(workDir: string): Promise<void> {
  console.log('');
  console.log('— 场景 C：还有别的存活洞 ⇒ 退役一个也仍 tainted（④）');
  const sessionId = 'one-of-two';
  const sessionDir = join(workDir, sessionId);
  let walSyncs = 0;
  const writer = await openWriter({
    sessionId,
    sessionDir,
    beforeSync: (kind) => {
      if (kind !== 'wal') return;
      walSyncs += 1;
      if (walSyncs === 2) throw new Error('injected_wal_fsync_failure');
    },
  });
  await writer.append(fact(1));
  await writer.append(fact(2)).catch(() => undefined);
  for (let index = 3; index <= 5; index += 1) await writer.append(fact(index));
  await writer.close();

  // 夹具：seq 5 其实可读（误登记），seq 2 是真丢失。
  await appendHoleRegistration(sessionDir, 5, 5, 'false_alarm');
  const reopened = await openWriter({ sessionId, sessionDir });
  const before = reopened.heads();
  assertEqual('④ 前置：两条存活洞', before.holes.length, 2);
  assertEqual('④ 前置：tainted=true', before.tainted, true);
  const manifestBefore = await rawLines(manifestPath(sessionDir));

  const retired = await reopened.retireHoles({ from_seq: 5, to_seq: 5, reason: 'seq5_ok' });
  assertEqual('④ 可读的那条退役成功', retired.ok, true);
  const after = reopened.heads();
  assertEqual('④ 仍有真丢失的洞 ⇒ tainted 仍为 true', after.tainted, true);
  assertEqual('④ 存活洞只剩真丢失那条', after.holes.length, 1);
  assertTrue('④ 剩下的是 [2,2]', covers(after.holes, 2), JSON.stringify(after.holes));
  assertTrue(
    '④ 已退役的 [5,5] 不再上报',
    !after.holes.some((hole) => hole.from_seq === 5),
    JSON.stringify(after.holes),
  );
  assertEqual(
    '④ 有别的存活洞时**不许**写 tainted_cleared',
    countKind(await rawLines(manifestPath(sessionDir)), 'tainted_cleared'),
    countKind(manifestBefore, 'tainted_cleared'),
  );
  assertEqual(
    '④ manifest 的最后一条状态声明仍不是 cleared',
    lastManifestState(await rawLines(manifestPath(sessionDir))),
    lastManifestState(manifestBefore),
  );
  const afterNext = await reopened.append(fact(6));
  assertEqual('④ 退役不退号：新事件 seq 接着 6（没有回收 5）', afterNext.seq, 6);
  await reopened.close();

  const restarted = await openWriter({ sessionId, sessionDir });
  assertEqual('④ 重启后仍 tainted=true（真丢失还没好）', restarted.heads().tainted, true);
  assertEqual('④ 重启后存活洞仍只有一条', restarted.heads().holes.length, 1);
  await restarted.close();
}

/** ⑤ last-wins：物理行序最后一条声明说了算；F：`at` 不定序。 */
async function lastWinsByPhysicalOrder(workDir: string): Promise<void> {
  console.log('');
  console.log('— 场景 D：last-wins + 时钟回退（⑤ F）');

  // D1：退役行的 at 更小，但物理在最后 ⇒ 仍算已退役。
  const d1 = await sessionWithFacts(workDir, 'last-wins-retired', 7);
  await appendHoleRegistration(d1.sessionDir, 7, 7, 'registered_later_clock', NOW + 1_000_000);
  await mkdir(d1.sessionDir, { recursive: true });
  await appendFile(
    holesPath(d1.sessionDir),
    `${JSON.stringify(
      withCrc({
        v: 1,
        kind: 'hole_retired',
        from_seq: 7,
        to_seq: 7,
        reason: 'reread_ok',
        at: NOW,
        evidence: 'reread_ok:7-7:verified=1/1:timeline=0,blocks=0,wal=1',
      }),
    )}\n`,
    'utf8',
  );
  const d1Writer = await openWriter({ sessionId: d1.sessionId, sessionDir: d1.sessionDir });
  assertEqual(
    'F 退役行的 at 更小、物理在最后 ⇒ tainted=false（严禁按 at 排序）',
    d1Writer.heads().tainted,
    false,
  );
  assertEqual('F 该区间不再上报为洞', d1Writer.heads().holes.length, 0);
  await d1Writer.close();

  // D2：退役之后又登记同区间 ⇒ 最后一条是登记 ⇒ 洞重新存活。
  const d2 = await sessionWithFacts(workDir, 'last-wins-reregistered', 7);
  const d2Lines = [
    { v: 1, from_seq: 7, to_seq: 7, reason: 'registered', at: NOW },
    { v: 1, kind: 'hole_retired', from_seq: 7, to_seq: 7, reason: 'reread_ok', at: NOW + 1 },
    { v: 1, from_seq: 7, to_seq: 7, reason: 'corrupt_again', at: NOW - 1 },
  ];
  await mkdir(d2.sessionDir, { recursive: true });
  await writeFile(
    holesPath(d2.sessionDir),
    d2Lines.map((line) => `${JSON.stringify(withCrc(line))}\n`).join(''),
    'utf8',
  );
  const d2Writer = await openWriter({ sessionId: d2.sessionId, sessionDir: d2.sessionDir });
  assertEqual(
    '⑤ 退役后又登记同区间 ⇒ last-wins 取最后一条（登记）⇒ tainted=true',
    d2Writer.heads().tainted,
    true,
  );
  assertEqual('⑤ 该区间重新上报为洞', d2Writer.heads().holes.length, 1);
  assertTrue(
    '⑤ 上报的正是 [7,7]',
    covers(d2Writer.heads().holes, 7),
    JSON.stringify(d2Writer.heads().holes),
  );
  await d2Writer.close();
  const d2Registry = await HoleRegistry.open(d2.sessionDir);
  assertEqual('⑤ 折叠后同区间只有一条状态（不重复上报）', d2Registry.declarations().length, 1);
  assertEqual('⑤ isRetired 反映最后一条声明', d2Registry.isRetired(7, 7), false);
  assertEqual('⑤ maxSeq 仍覆盖已声明区间（seq 号不回收）', d2Registry.maxSeq(), 7);
  await d2Registry.close();

  // D3：连续两条退役行（人工/重试造成）⇒ 仍算已退役；再一条登记 ⇒ 又存活。
  const d3 = await sessionWithFacts(workDir, 'double-retired', 4);
  const d3Lines = [
    { v: 1, from_seq: 4, to_seq: 4, reason: 'registered', at: NOW },
    { v: 1, kind: 'hole_retired', from_seq: 4, to_seq: 4, reason: 'reread_ok', at: NOW + 1 },
    { v: 1, kind: 'hole_retired', from_seq: 4, to_seq: 4, reason: 'reread_ok', at: NOW + 2 },
  ];
  await mkdir(d3.sessionDir, { recursive: true });
  await writeFile(
    holesPath(d3.sessionDir),
    d3Lines.map((line) => `${JSON.stringify(withCrc(line))}\n`).join(''),
    'utf8',
  );
  const d3Registry = await HoleRegistry.open(d3.sessionDir);
  assertEqual('⑤ 连续退役两条 ⇒ 仍是已退役（last-wins 幂等）', d3Registry.isRetired(4, 4), true);
  assertEqual('⑤ 连续退役不产生两条存活洞', d3Registry.list().length, 0);
  assertEqual('⑤ 结束态 maxSeq 仍含退役区间', d3Registry.maxSeq(), 4);
  await d3Registry.close();
  const d3Writer = await openWriter({ sessionId: d3.sessionId, sessionDir: d3.sessionDir });
  assertEqual('⑤ 连续退役后 tainted=false', d3Writer.heads().tainted, false);
  await d3Writer.close();

  // D4：将来版本的**未知 kind** ⇒ 新 reader 也只忽略、不抛错（对称的向前兼容）。
  const d4 = await sessionWithFacts(workDir, 'unknown-kind', 3);
  await mkdir(d4.sessionDir, { recursive: true });
  await writeFile(
    holesPath(d4.sessionDir),
    [
      { v: 1, from_seq: 3, to_seq: 3, reason: 'registered', at: NOW },
      {
        v: 1,
        kind: 'hole_resurrected_by_future',
        from_seq: 3,
        to_seq: 3,
        reason: 'x',
        at: NOW + 1,
      },
    ]
      .map((line) => `${JSON.stringify(withCrc(line))}\n`)
      .join(''),
    'utf8',
  );
  let d4Error: string | undefined;
  try {
    const d4Registry = await HoleRegistry.open(d4.sessionDir);
    assertEqual('补 未知 kind 的行被忽略（状态不变，不抛错）', d4Registry.isRetired(3, 3), false);
    assertEqual('补 未知 kind 不影响存活洞集合', d4Registry.list().length, 1);
    await d4Registry.close();
  } catch (error) {
    d4Error = error instanceof Error ? error.message : String(error);
  }
  assertTrue(
    '补 新 reader 遇到未知 kind 不抛错（保守方向）',
    d4Error === undefined,
    String(d4Error),
  );

  // D5：同一区间重复登记（恢复期补登记是常态）⇒ 折叠成一条，不上报两次。
  const d5 = await sessionWithFacts(workDir, 'duplicate-registration', 3);
  await mkdir(d5.sessionDir, { recursive: true });
  await writeFile(
    holesPath(d5.sessionDir),
    [
      { v: 1, from_seq: 3, to_seq: 3, reason: 'wal_append_failed', at: NOW },
      { v: 1, from_seq: 3, to_seq: 3, reason: 'missing_seq_on_recovery', at: NOW + 1 },
    ]
      .map((line) => `${JSON.stringify(withCrc(line))}\n`)
      .join(''),
    'utf8',
  );
  const d5Writer = await openWriter({ sessionId: d5.sessionId, sessionDir: d5.sessionDir });
  assertEqual(
    '补 同一区间重复登记折叠成一条（客户端不会多减一次）',
    d5Writer.heads().holes.length,
    1,
  );
  assertEqual('补 重复登记仍算存活洞 ⇒ tainted=true', d5Writer.heads().tainted, true);
  assertEqual(
    '补 折叠后保留最后一条声明的 reason',
    d5Writer.heads().holes[0]?.reason,
    'missing_seq_on_recovery',
  );
  await d5Writer.close();
}

/** ⑦ 区间里有 CRC 不过的字节 ⇒ 拒绝退役；修好后 ⇒ 允许退役。 */
async function corruptIntervalRefusesRetirement(workDir: string): Promise<void> {
  console.log('');
  console.log('— 场景 E：区间重读失败 ⇒ 拒绝退役（⑦）');
  const sessionId = 'corrupt-interval';
  const sessionDir = join(workDir, sessionId);
  const writer = await openWriter({ sessionId, sessionDir });
  for (let index = 1; index <= 3; index += 1) await writer.append(fact(index));
  await writer.close();

  const originalWal = await readText(join(sessionDir, TIMELINE_LAYOUT.walLog));
  await appendHoleRegistration(sessionDir, 2, 2, 'looked_corrupt_then');
  await corruptRecordPayload(sessionDir, 2);

  const reopened = await openWriter({ sessionId, sessionDir });
  const before = reopened.heads();
  assertEqual('⑦ 前置：坏行在打开时被重新登记成洞 ⇒ tainted=true', before.tainted, true);
  assertTrue('⑦ 前置：洞覆盖 [2,2]', covers(before.holes, 2), JSON.stringify(before.holes));

  const verdictOk = await verifyHoleIntervalReadable(sessionDir, 1, 1);
  assertEqual('⑦ 逐条自证：可读区间 [1,1] 通过', verdictOk.ok, true);
  assertEqual(
    '⑦ 逐条自证：[1,1] 的 evidence 是 reread_ok',
    verdictOk.evidence.startsWith('reread_ok'),
    true,
  );
  const verdictBad = await verifyHoleIntervalReadable(sessionDir, 1, 3);
  assertEqual('⑦ 逐条自证：含坏字节的 [1,3] 不通过', verdictBad.ok, false);
  assertEqual(
    '⑦ 逐条自证：缺的正是 seq 2',
    JSON.stringify(verdictBad.missing),
    JSON.stringify([2]),
  );
  assertStartsWith('⑦ 逐条自证的 evidence 说明失败', verdictBad.evidence, 'reread_failed:1-3');

  const textBefore = await readText(holesPath(sessionDir));
  const refused = await reopened.retireHoles({
    from_seq: 2,
    to_seq: 2,
    reason: 'try_after_corruption',
  });
  assertEqual('⑦ CRC 不过 ⇒ 拒绝退役', refused.ok, false);
  assertEqual(
    '⑦ 拒绝 code = hole_interval_not_readable',
    refused.code,
    'hole_interval_not_readable',
  );
  assertStartsWith('⑦ 拒绝细节是重读失败的自证摘要', refused.reason, 'reread_failed:2-2');
  assertTrue(
    '⑦ 拒绝原因指出缺 seq 2',
    typeof refused.reason === 'string' && refused.reason.includes('missing=2'),
    String(refused.reason),
  );
  assertEqual(
    '⑦ 被拒时 holes.ndjson 一个字节都不写',
    await readText(holesPath(sessionDir)),
    textBefore,
  );
  assertEqual(
    '⑦ 被拒时没有写入退役行',
    countKind(await rawLines(holesPath(sessionDir)), 'hole_retired'),
    0,
  );
  assertEqual('⑦ 被拒后 tainted 仍为 true', reopened.heads().tainted, true);
  assertTrue('⑦ 被拒后洞仍在', covers(reopened.heads().holes, 2));
  await reopened.close();

  // 损坏被修复（运维把那一行还原）之后，同一个区间就允许退役了 —— 这正是「洞被修好」的正路。
  await writeFile(join(sessionDir, TIMELINE_LAYOUT.walLog), originalWal, 'utf8');
  const repaired = await openWriter({ sessionId, sessionDir });
  const afterRepair = await repaired.retireHoles({
    from_seq: 2,
    to_seq: 2,
    reason: 'restored_from_backup',
  });
  assertEqual('⑦ 字节还原后同一区间可以退役（自证通过）', afterRepair.ok, true);
  assertEqual('⑦ 还原后退役 ⇒ tainted=false', repaired.heads().tainted, false);
  assertEqual('⑦ 还原后退役 ⇒ 上报的洞为空', repaired.heads().holes.length, 0);
  const repairedText = await readText(holesPath(sessionDir));
  const repairedLines = await rawLines(holesPath(sessionDir));
  assertEqual('⑦ 还原后只追加了一条退役行', countKind(repairedLines, 'hole_retired'), 1);
  assertTrue(
    '⑦ 还原前的字节全部还在（append-only）',
    repairedText.startsWith(textBefore),
    `prefix-lost at ${String(textBefore.length)} / ${String(repairedText.length)}`,
  );
  await repaired.close();
}

const workDir = await mkdtemp(join(tmpdir(), 'vessel-holes-retire-'));
roots.push(workDir);
console.log('0.54 洞退役：hole_retired 声明 + last-wins + 区间重读自证（老 reader 保守）');
console.log(`work-dir: ${workDir}`);

try {
  await genuineLossCannotBeRetired(workDir);
  await retirementClearsTaint(workDir);
  await otherLiveHolesKeepTaint(workDir);
  await lastWinsByPhysicalOrder(workDir);
  await corruptIntervalRefusesRetirement(workDir);
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
    '结论：FAIL（洞退役要么不可自证、要么洗掉了别的污点、要么改了历史行、要么旧 reader 被炸）',
  );
  process.exit(1);
}
console.log(
  '结论：PASS（真丢失不许退役 / 自证后可退役且 tainted 复位 / 重启保持 / 别的洞仍压着污点 / last-wins 按物理行序 / 旧 reader 保守不炸 / CRC 不过即拒绝）',
);
