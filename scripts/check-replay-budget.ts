#!/usr/bin/env bun

/**
 * 回放预算门禁：把「切进大输出 run 就只回放最后一小段」变成 CI FAIL。
 *
 * 唯一实现是 `packages/serve/src/replay-budget.ts`（纯函数、无 IO）；本脚本只用合成事件
 * 断言四组语义 + 两组零回归：
 *
 * F0 清单自检：结构 / 内容分档（含 `subagent.*` 家族前缀）。
 * F1 **结构优先**：最新一轮的结构事件被大量正文夹在中间 → 结构一条不许少，被丢的
 *    只有内容；并用**旧算法复刻**做影子对拍，证明这组 fixture 抓得住旧行为
 *    （同一份数据在旧 `tailReplayWindow`（固定 1 MiB / 2000 条）上会丢 `run.started`）。
 * F2 **动态预算**：结构地板 > 1 MiB → 预算跟着变大、覆盖到最新 `run.started`；
 *    地板 > 硬上限 → 仍然有界、`floorTruncated` 为真、`skippedTo` 正确。
 * F3 **顺序 / 去重 / fromSeq / skippedTo**：保留区是源的连续后缀、按 seq 升序、
 *    无重复、`skippedTo = 首条 - 1`。
 * F4 **单条超大事件**：300 KiB 的 `llm.response` 装得下，并出现在诊断
 *    （`largestEventBytes`）里。
 * F5 零回归：小会话（< 1 MiB）全量保留；无锚点（窗口里没有 `run.started`）时与旧
 *    实现逐字节等价。
 *
 * 用法：bun run scripts/check-replay-budget.ts
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import {
  BUDGET_SAFETY_FACTOR,
  MAX_BUDGET_BYTES,
  MIN_BUDGET_BYTES,
  REPLAY_BUDGET_TUNING,
  type ReplayBudgetRow,
  type ReplayBudgetSelection,
  replayBudgetUnitsOf,
  replayEventTier,
  STRUCTURE_EVENT_TYPES,
  selectReplayBudgetWindow,
} from '../packages/serve/src/replay-budget';

const KIB = 1024;

interface Row extends ReplayBudgetRow {
  /** 合成 seq：与真实回放的 `SeqEvent.seq` 同口径（1 起、升序、无洞）。 */
  seq: number;
}

/** `[类型, 字节数]` → 带 seq 的行。 */
function toRows(list: readonly (readonly [string, number])[]): Row[] {
  return list.map(([type, bytes], index) => ({ seq: index + 1, type, bytes }));
}

function select(source: readonly Row[]): ReplayBudgetSelection {
  return selectReplayBudgetWindow(replayBudgetUnitsOf(source), REPLAY_BUDGET_TUNING);
}

/** 保留区（连续后缀）。 */
function keptRows(source: readonly Row[], selection: ReplayBudgetSelection): Row[] {
  return selection.startIndex < 0 ? [] : source.slice(selection.startIndex);
}

/**
 * 与 `gateway.ts#tailReplayWindow` 同口径的 `skippedTo`：
 * 首条保留事件的 `seq - 1`；保留到源的第一条时不上报（= 无跳过）。
 */
function skippedToOf(source: readonly Row[], selection: ReplayBudgetSelection): number | undefined {
  if (selection.startIndex < 0) return undefined;
  const first = source[selection.startIndex];
  const oldest = source[0];
  if (first === undefined || oldest === undefined) return undefined;
  if (first.seq <= oldest.seq) return undefined;
  return first.seq - 1;
}

// ── 旧实现的影子复刻（用于证明 fixture 抓得住旧行为）────────────
// 与改动前的 `gateway.ts#tailReplayWindow` 逐行等价：固定 1 MiB / 2000 条、从最新
// 往回取、至少留一条。
const LEGACY_BUDGET_BYTES = 1024 * 1024;
const LEGACY_MAX_EVENTS = 2_000;

function legacyTailWindow(source: readonly Row[]): Row[] {
  const kept: Row[] = [];
  let bytes = 0;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const row = source[index];
    if (row === undefined) continue;
    if (
      kept.length > 0 &&
      (bytes + row.bytes > LEGACY_BUDGET_BYTES || kept.length >= LEGACY_MAX_EVENTS)
    ) {
      break;
    }
    bytes += row.bytes;
    kept.push(row);
  }
  return kept.reverse();
}

/** 结构事件（按唯一清单判档，不另写一份黑名单）。 */
function structureRows(source: readonly Row[]): Row[] {
  return source.filter((row) => replayEventTier(row.type) === 'structure');
}

/**
 * 最新一条满足条件的行（`Array#findLast` 是 ES2023，仓库 lib 是 ES2022，不手写就过不了
 * typecheck）。
 */
function lastRowWhere(source: readonly Row[], predicate: (row: Row) => boolean): Row | undefined {
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const row = source[index];
    if (row !== undefined && predicate(row)) return row;
  }
  return undefined;
}

// ── Fixture 1 的数据：最新一轮的结构事件被正文夹在中间 ─────────────
function structureFirstSource(): Row[] {
  const list: [string, number][] = [];
  // 更早的一轮：纯正文（大 `llm.response` 尾部），新实现会整段跳过它的一部分。
  for (let index = 0; index < 20; index += 1) list.push(['llm.response', 60 * KIB]);
  // 最新一轮：`run.started` 在 1.35 MiB 之外，中间每轮结构事件前后都夹着 120 KiB 正文。
  list.push(['run.started', 2 * KIB]);
  list.push(['user.message', 2 * KIB]);
  for (let index = 0; index < 10; index += 1) {
    list.push(['llm.stream.chunk', 1 * KIB]);
    list.push(['tool.call.started', 8 * KIB]);
    list.push(['llm.response', 120 * KIB]);
    list.push(['tool.call.completed', 8 * KIB]);
    list.push(['llm.stream.summary', 512]);
  }
  list.push(['run.completed', 2 * KIB]);
  return toRows(list);
}

/** 长 run：结构地板自己就超过旧的固定 1 MiB 预算。 */
function longRunSource(toolBytes: number, toolCount: number): Row[] {
  const list: [string, number][] = [
    ['run.started', 1 * KIB],
    ['user.message', 1 * KIB],
  ];
  for (let index = 0; index < toolCount; index += 1) {
    list.push(['tool.call.started', 2 * KIB]);
    list.push(['tool.call.completed', toolBytes]);
  }
  list.push(['run.completed', 1 * KIB]);
  return toRows(list);
}

interface Fixture {
  name: string;
  why: string;
  check: () => boolean;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'F0 分档清单：结构 / 内容（含 subagent.* 家族前缀）',
    why: '分档是「结构必留」的唯一判据；清单漂移会让骨架重新被正文挤掉',
    check: () => {
      const structure = [
        'run.started',
        'run.completed',
        'run.failed',
        'run.cancelled',
        'user.message',
        'tool.call.started',
        'tool.call.completed',
        'tool.call.failed',
        'llm.stream.summary',
        'message.compacted',
        'context.compacted',
        'ask.user.requested',
        'ask.user.answered',
        'tool.permission.request',
        'tool.permission.response',
        'session.created',
        'subagent.run.started',
        'subagent.tool.call.completed',
      ];
      const content = [
        'llm.stream.chunk',
        'llm.response',
        'llm.request',
        'context.changed',
        'subagent.llm.stream.chunk',
        'some.brand.new.event',
      ];
      const structureOk = structure.every((type) => replayEventTier(type) === 'structure');
      const contentOk = content.every((type) => replayEventTier(type) === 'content');
      // 清单自身不许把正文类塞进去（防止「全标结构」式的假全绿）。
      const noContentInside = ![
        'llm.stream.chunk',
        'llm.response',
        'llm.request',
        'context.changed',
      ].some((type) => STRUCTURE_EVENT_TYPES.has(type));
      return structureOk && contentOk && noContentInside;
    },
  },
  {
    name: 'F1 结构优先：最新一轮的结构事件一条不许少，被丢的只有内容',
    why: '旧固定预算（1 MiB / 2000 条）在长 run 上把 run.started 挤到窗口外 → 客户端 hasNewestRunStart 恒 false',
    check: () => {
      const source = structureFirstSource();
      const selection = select(source);
      const kept = keptRows(source, selection);
      const keptSeqs = new Set(kept.map((row) => row.seq));
      // (a) 源里每一条结构事件都必须还在（本轮 fixture 的被丢前缀是纯正文）。
      const allStructureKept = structureRows(source).every((row) => keptSeqs.has(row.seq));
      // (b) 最新的 run.started 必须被覆盖（地板不破）。
      const anchor = lastRowWhere(source, (row) => row.type === 'run.started');
      const anchorKept = anchor !== undefined && keptSeqs.has(anchor.seq);
      // (c) 被丢的只有内容。
      const droppedAllContent = selection.droppedStructureEvents === 0;
      const onlyContentDropped = source
        .slice(0, Math.max(0, selection.startIndex))
        .every((row) => replayEventTier(row.type) === 'content');
      // (d) 影子对拍：同一份数据在旧算法上会丢结构（证明这组 fixture 抓得住旧行为）。
      const legacyKept = new Set(legacyTailWindow(source).map((row) => row.seq));
      const legacyDropsStructure = structureRows(source).some((row) => !legacyKept.has(row.seq));
      const legacyDropsAnchor = anchor !== undefined && !legacyKept.has(anchor.seq);
      // (e) 保留区仍是连续后缀（单 gap 语义）。
      const contiguous = kept.length === source.length - Math.max(0, selection.startIndex);
      return (
        allStructureKept &&
        anchorKept &&
        droppedAllContent &&
        onlyContentDropped &&
        legacyDropsStructure &&
        legacyDropsAnchor &&
        contiguous
      );
    },
  },
  {
    name: 'F2 动态预算：长 run 抬预算覆盖到 run.started，超硬上限仍是有界后缀',
    why: '预算不跟着结构地板长大，巨型 run 就永远只剩最后几条；没有硬上限又会一次回放几十 MB',
    check: () => {
      // (a) 地板 ≈ 2 MiB（旧的固定 1 MiB 覆盖不到 run.started）。
      const longRun = longRunSource(20 * KIB, 100);
      const longSelection = select(longRun);
      let longAnchorIndex = -1;
      for (let index = longRun.length - 1; index >= 0; index -= 1) {
        if (longRun[index]?.type === 'run.started') {
          longAnchorIndex = index;
          break;
        }
      }
      const longAnchor = longRun[longAnchorIndex];
      const longCovered =
        longAnchor !== undefined &&
        longSelection.startIndex >= 0 &&
        longSelection.startIndex <= longAnchorIndex;
      const budgetGrew = longSelection.budgetBytes > MIN_BUDGET_BYTES;
      const floorMatches =
        longSelection.budgetBytes ===
        Math.min(
          MAX_BUDGET_BYTES,
          Math.max(MIN_BUDGET_BYTES, Math.ceil(longSelection.floorBytes * BUDGET_SAFETY_FACTOR)),
        );
      // 地板没超上限时字节数是精确值（不许报下界），且等于最新一轮后缀的真实字节数。
      const expectedFloorBytes =
        longAnchorIndex < 0
          ? -1
          : longRun.slice(longAnchorIndex).reduce((sum, row) => sum + row.bytes, 0);
      const floorExact =
        !longSelection.floorBytesIsLowerBound &&
        longSelection.floorBytes === expectedFloorBytes &&
        longSelection.floorIndex === longAnchorIndex;
      const legacyMissesAnchor =
        longAnchor !== undefined &&
        !new Set(legacyTailWindow(longRun).map((row) => row.seq)).has(longAnchor.seq);

      // (b) 地板 ≈ 8 MiB > 硬上限：仍然有界，缺口正确上报。
      const monster = longRunSource(40 * KIB, 200);
      const monsterSelection = select(monster);
      const bounded = monsterSelection.keptBytes <= MAX_BUDGET_BYTES;
      const truncated = monsterSelection.floorTruncated;
      const droppedSomething = monsterSelection.droppedEvents > 0;
      // 超上限后 floorBytes 只是下界（早停），但仍必须已经越过硬上限。
      const lowerBoundHonest =
        monsterSelection.floorBytesIsLowerBound && monsterSelection.floorBytes > MAX_BUDGET_BYTES;
      const skippedTo = skippedToOf(monster, monsterSelection);
      const firstMonsterKept = monster[monsterSelection.startIndex];
      const skippedMatches =
        monsterSelection.startIndex > 0 &&
        skippedTo !== undefined &&
        firstMonsterKept !== undefined &&
        skippedTo === firstMonsterKept.seq - 1;
      return (
        longCovered &&
        budgetGrew &&
        floorMatches &&
        floorExact &&
        legacyMissesAnchor &&
        bounded &&
        truncated &&
        droppedSomething &&
        lowerBoundHonest &&
        skippedMatches
      );
    },
  },
  {
    name: 'F3 顺序 / 去重 / fromSeq / skippedTo：保留区是升序连续后缀',
    why: '客户端靠 skippedTo 决定是否 arm 回填、靠 hello.fromSeq 对齐时间线；顺序或去重一变就整段错位',
    check: () => {
      const list: [string, number][] = [];
      for (let index = 0; index < 15; index += 1) list.push(['llm.response', 50 * KIB]);
      list.push(['run.started', 1 * KIB]);
      for (let index = 0; index < 20; index += 1) list.push(['llm.stream.chunk', 50 * KIB]);
      const source = toRows(list);
      const selection = select(source);
      const kept = keptRows(source, selection);
      const seqs = kept.map((row) => row.seq);
      const ascending = seqs.every((seq, index) => {
        const previous = seqs[index - 1];
        return index === 0 || (previous !== undefined && seq > previous);
      });
      const unique = new Set(seqs).size === seqs.length;
      const contiguous = kept.length === source.length - Math.max(0, selection.startIndex);
      const fromSeq = kept[0]?.seq;
      const skippedTo = skippedToOf(source, selection);
      const skippedMatches =
        skippedTo === undefined
          ? selection.startIndex === 0
          : fromSeq !== undefined && skippedTo === fromSeq - 1;
      // 确定性：同一输入两次结果一致（纯函数，不允许隐藏状态）。
      const again = select(source);
      const deterministic =
        again.startIndex === selection.startIndex && again.keptBytes === selection.keptBytes;
      // 头部确实被跳过（否则这组 fixture 没测到 skippedTo）。
      const headSkipped = selection.startIndex > 0 && skippedTo !== undefined;
      return (
        ascending &&
        unique &&
        contiguous &&
        skippedMatches &&
        deterministic &&
        headSkipped &&
        selection.keptBytes <= selection.budgetBytes
      );
    },
  },
  {
    name: 'F4 单条超大事件：300 KiB 的 llm.response 装得下且出现在诊断里',
    why: '单条超大事件是「预算被哪一条吃掉」的唯一可诊断入口；旧实现无任何诊断字段',
    check: () => {
      const list: [string, number][] = [
        ['run.started', 1 * KIB],
        ['llm.stream.summary', 512],
        ['llm.stream.summary', 512],
        ['llm.response', 300 * KIB],
        ['llm.stream.summary', 512],
      ];
      const source = toRows(list);
      const selection = select(source);
      const hugeIndex = source.findIndex((row) => row.type === 'llm.response');
      const huge = source[hugeIndex];
      const kept = keptRows(source, selection);
      const keptSeqs = new Set(kept.map((row) => row.seq));
      return (
        huge !== undefined &&
        keptSeqs.has(huge.seq) &&
        selection.largestEventBytes === 300 * KIB &&
        selection.largestEventIndex === hugeIndex &&
        selection.budgetBytes === MIN_BUDGET_BYTES &&
        selection.keptBytes === 300 * KIB + 1 * KIB + 512 * 3
      );
    },
  },
  {
    name: 'F5 零回归：小会话全量保留；无锚点时与旧实现逐字节等价',
    why: '绝大多数会话 < 1 MiB，动态预算绝不能改变它们的回放结果',
    check: () => {
      // (a) 小会话：全部保留，skippedTo 不出现。
      const smallList: [string, number][] = [['run.started', 2 * KIB]];
      for (let index = 0; index < 40; index += 1) smallList.push(['llm.stream.chunk', 1 * KIB]);
      smallList.push(['run.completed', 2 * KIB]);
      const small = toRows(smallList);
      const smallSelection = select(small);
      const smallAll =
        smallSelection.startIndex === 0 && skippedToOf(small, smallSelection) === undefined;

      // (b) 无锚点（窗口里既没有 run.started 也没有 user.message）：退化成固定下限预
      // 算的尾部窗口，与旧实现逐字节等价。
      const list: [string, number][] = [];
      for (let index = 0; index < 30; index += 1) list.push(['llm.response', 80 * KIB]);
      list.push(['some.brand.new.event', 4 * KIB]);
      const anchorless = toRows(list);
      const anchorlessSelection = select(anchorless);
      const anchorlessKept = keptRows(anchorless, anchorlessSelection).map((row) => row.seq);
      const legacyKept = legacyTailWindow(anchorless).map((row) => row.seq);
      const sameAsLegacy =
        anchorlessKept.length === legacyKept.length &&
        anchorlessKept.every((seq, index) => seq === legacyKept[index]);
      return (
        smallAll &&
        anchorlessSelection.floorIndex === -1 &&
        anchorlessSelection.budgetBytes === MIN_BUDGET_BYTES &&
        sameAsLegacy
      );
    },
  },
];

const failures: { name: string; why: string }[] = [];
for (const fixture of FIXTURES) {
  let ok = false;
  try {
    ok = fixture.check();
  } catch {
    ok = false;
  }
  if (!ok) failures.push({ name: fixture.name, why: fixture.why });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`FAIL ${failure.name}`);
    console.log(`     why: ${failure.why}`);
  }
  console.error(`replay budget: ${failures.length}/${FIXTURES.length} fixture(s) FAILED`);
  process.exit(1);
}

console.log(`replay budget: ${FIXTURES.length} fixtures passed`);
