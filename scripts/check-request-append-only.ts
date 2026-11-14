#!/usr/bin/env bun
/**
 * 请求 messages append-only 门禁（0.52：「请求 messages 只能 append」）。
 *
 * 段模型（两维，不许再劈成「六个事件」）：
 *   pᵢ₊₁ ⊒ pᵢ 或 pᵢ ⊒ pᵢ₊₁ 或 pᵢ₊₁ = ∅（`new`）
 *   —— 段内只能**追加**或**丢弃尾部**；**段内改写一个字节都不行**。
 *   换段只有两个登记过的操作：`new`（开新段）与 `pop`（丢尾），各带一个 cause。
 *
 * 判据：
 *   R1 段内必须逐字节前缀延伸；`pop` 之后，下一次请求必须是 pop 前那次请求的前缀。
 *      **新 run 也必须在段内连续**（`run_boundary` 这个类型已经删掉，见 fixture 4）。
 *   R2 出现差异 ⇒ 必须有一个登记过的段操作，且 cause ↔ 操作匹配、次数在预算内；
 *      否则红，并报「第几条起不同 + 差异字段」。
 *   R3 段操作白名单**恰好**是 `new` / `pop`；cause 词表封闭且每个 cause 只能映射到一个
 *      操作；cause 不许等于操作名（本文件有独立 EXPECTED 表：模块里多一项就红）。
 *   R4 同一段内 `[cleared …]` 占位条数**不得增加**（V1「每轮右移一条」的判据）。
 *   R5 每个 cause 都必须有**可见记录**（tier 不是 internal，或有 notice / card 投影）。
 *   R6 `PrefixChangeReason` 里不许再有 system_revision / tools_changed / model_changed /
 *      resume —— 它们是「重新 seed 出不同前缀」的洗白通道。
 *   R7 resume（S1c 重启卡）必须**追加**、算续段，不是新段。
 *
 * 外加 R0（判据自检）与 W（源码接线断言）。
 *
 * 用法：
 *   bun run scripts/check-request-append-only.ts            # 严格（默认）
 *   bun run scripts/check-request-append-only.ts --phase=1  # 灰度一阶段
 *
 * 灰度只降「现在要不要拦 CI」，**不降判据**：被降级的现场带着 ticket 号原样打印成
 * PENDING 行（见 `known()`），修好之后去掉 `--phase=1` 就自动收紧。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BANNED_PREFIX_REASONS,
  clearedToolCallIds,
  countClearedPlaceholders,
  diffRequestSequence,
  isPrefixSequence,
  isSegmentBoundaryCause,
  isSegmentBoundaryKind,
  MemoryWorkingContext,
  NON_PAYLOAD_FIELDS,
  PAYLOAD_FIELDS,
  projectionProblems,
  type RequestSequenceDiff,
  type RequestSequenceDiffKind,
  SEGMENT_BOUNDARY_KINDS,
  SEGMENT_CAUSE_RECORD_EVENTS,
  SEGMENT_KIND_BY_CAUSE,
  SEGMENT_KIND_BY_PREFIX_REASON,
  SEGMENT_NEW_CAUSES,
  SEGMENT_POP_CAUSES,
  withClearedToolResults,
} from '../packages/core/src/index';
import type { Message } from '../packages/core/src/types/provider';

const REPO = join(import.meta.dir, '..');
const PHASE_ONE = process.argv.includes('--phase=1');

const failures: string[] = [];
const pendings: string[] = [];
const passes: string[] = [];

function ok(label: string): void {
  passes.push(label);
}

function fail(code: string, message: string): void {
  failures.push(`${code}: ${message}`);
}

/**
 * 灰度一阶段：只给「已确认存在、修复单排在后面」的现场用。
 *
 * `--phase=1` 时降级成 PENDING（打印 + 计数，不拦 CI）；默认为 FAIL。
 * 判据本身不弱化 —— 变的只是「现在要不要因此红」，所以每条都必须带 ticket 号，
 * 且只允许出现在 V1（工具结果滑窗占位）/ V2（run 内压缩就地删中段）两处现场。
 */
function known(message: string, ticket: string): void {
  if (PHASE_ONE) pendings.push(`[${ticket}] ${message}`);
  else failures.push(`[${ticket}] ${message}`);
}

function section(title: string): void {
  console.log(`\n── ${title}`);
}

function info(message: string): void {
  console.log(`   ${message}`);
}

// ── fixture 助手 ───────────────────────────────────────────────────────────

function msg(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { role, content, timestamp: 1, run_id: 'run-0', run_segment: 0, ...extra } as Message;
}

const SYSTEM = msg('system', '你是 Vessel 的具身成员。');
const USER = msg('user', '把 a.ts 和 b.ts 都读一遍。');
const CALL_A = msg('assistant', '', {
  tool_calls: [
    { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
  ],
});
const RESULT_A = msg('tool', 'a.ts 的正文', { tool_call_id: 'call_a' });
const BASE: Message[] = [SYSTEM, USER, CALL_A, RESULT_A];
/** 「中段改一个字」：第 3 条 tool 正文被换掉（V1 的形状） */
const MID_CHANGED: Message[] = BASE.map((message, index) =>
  index === 3 ? msg('tool', 'a.ts 的正文!', { tool_call_id: 'call_a' }) : message,
);
/** 「新 run 重新 seed」：前缀（system 环境块）换了，后面的历史还在 */
const RESEEDED: Message[] = [
  msg('system', '你是 Vessel 的具身成员。\n环境块：cwd=/repo，today=2026-02-14'),
  ...BASE.slice(1),
];

// ── R0：判据自检（投影 + diff） ──────────────────────────────────────────────

section('R0 判据自检（toProviderPayload / diffRequestSequence）');

{
  // 字段分类必须覆盖 Message 的全部字段：漏分类 = 悄悄不参与比较。
  const providerSource = readFileSync(join(REPO, 'packages/core/src/types/provider.ts'), 'utf8');
  const fields = messageInterfaceFields(providerSource);
  const payload = new Set<string>(PAYLOAD_FIELDS);
  const nonPayload = new Set<string>(NON_PAYLOAD_FIELDS);
  const overlap = [...payload].filter((field) => nonPayload.has(field));
  const unclassified = fields.filter((field) => !payload.has(field) && !nonPayload.has(field));
  const phantom = [...payload, ...nonPayload].filter((field) => !fields.includes(field));
  if (fields.length === 0) {
    fail('R0', '没从 packages/core/src/types/provider.ts 解析出 Message 字段（源码解析失配）');
  } else if (unclassified.length > 0) {
    fail(
      'R0',
      `Message 字段未分类：${unclassified.join(', ')} —— 新字段要么进 PAYLOAD_FIELDS（参与逐字节比较），要么进 NON_PAYLOAD_FIELDS（并写明为什么）`,
    );
  } else if (overlap.length > 0) {
    fail('R0', `字段同时出现在两份清单里：${overlap.join(', ')}`);
  } else if (phantom.length > 0) {
    fail('R0', `清单里点名了但 Message 上没有的字段：${phantom.join(', ')}`);
  } else {
    ok(`Message 的 ${String(fields.length)} 个字段全部完成投影分类`);
  }
}

{
  // 易变字段变了不算差异（否则每次落盘都假红）；tool 字段变了必须算差异。
  const volatile: Message[] = BASE.map((message, index) => ({
    ...message,
    timestamp: 1000 + index,
    run_id: 'run-9',
    run_segment: 7,
    refs: [{ kind: 'file', path: 'a.ts' }],
  }));
  const volatileDiff = diffRequestSequence(BASE, volatile);
  if (volatileDiff.kind !== 'extension') {
    fail(
      'R0',
      `易变字段（timestamp / run_id / run_segment / refs）变化被判成 ${volatileDiff.kind}：${String(volatileDiff.reason)} —— 投影没剥干净`,
    );
  } else {
    ok('易变字段不参与比较（无假红）');
  }

  const argsChanged: Message[] = BASE.map((message, index) =>
    index === 2
      ? msg('assistant', '', {
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"a.ts "}' },
            },
          ],
        })
      : message,
  );
  const argsDiff = diffRequestSequence(BASE, argsChanged);
  if (argsDiff.kind !== 'diverged' || argsDiff.atIndex !== 2) {
    fail(
      'R0',
      `tool_calls 的 arguments 改了一个空格却没判成第 2 条 diverged（判成 ${argsDiff.kind}）`,
    );
  } else if (!(argsDiff.fields ?? []).includes('tool_calls')) {
    fail('R0', `tool_calls 差异没有点名字段：${(argsDiff.fields ?? []).join(', ')}`);
  } else {
    ok('tool_calls / tool_call_id 参与比较（工具字段被改一定看得见）');
  }

  const missingToolCallId = [
    ...BASE.slice(0, 3),
    { role: 'tool', content: '没有 tool_call_id 的 tool 消息', timestamp: 1 } as Message,
  ];
  const invalidDiff = diffRequestSequence(BASE, missingToolCallId);
  if (invalidDiff.kind !== 'invalid') {
    fail('R0', `非法载荷没判成 invalid（判成 ${invalidDiff.kind}）`);
  } else {
    ok('非法载荷单独归入 invalid（不和「真差异」混在一起）');
  }

  if (projectionProblems(BASE).length !== 0) {
    fail('R0', `正常的历史被判成不可投影：${JSON.stringify(projectionProblems(BASE))}`);
  }
}

// ── 段判定（R1 / R2 / R4 共用一份实现） ────────────────────────────────────

interface BoundaryRecord {
  kind: string;
  cause: string;
  note?: string;
}

interface RequestStep {
  label: string;
  run: string;
  turn: number;
  prev: readonly Message[];
  next: readonly Message[];
  boundaries: readonly BoundaryRecord[];
}

interface StepVerdict {
  label: string;
  diff: RequestSequenceDiff;
  tailDrop: boolean;
  boundary?: BoundaryRecord;
  problems: string[];
}

/** 每个 cause 在一个 run 里的预算。加预算和加 cause 一样要过门禁（这是故意的）。 */
const CAUSE_BUDGET: Readonly<Record<string, number>> = {
  branch: 1,
  compaction: 1,
  context_trim: 1,
  rewind: 1,
  session_switch: 1,
};

const CAUSE_BUDGET_NOTE: Readonly<Record<string, string>> = {
  branch: '一个 run 只能分支一次；再分支就换 run',
  compaction: '0.52 裁定：压缩 = 开新会话；一个 run 里反复压缩就是就地改写历史（V2）',
  context_trim: '超限裁剪必须一次到位，不许每轮右移（V1）',
  rewind: '一个 run 只能回退一次；再回退就换 run',
  session_switch: '一个 run 只属于一个会话；切换会话应当结束这个 run',
};

interface PickResult {
  record?: BoundaryRecord;
  rejected: string[];
}

function pickBoundary(
  step: RequestStep,
  tailDrop: boolean,
  used: ReadonlyMap<string, number>,
): PickResult {
  const rejected: string[] = [];
  for (const record of step.boundaries) {
    if (!isSegmentBoundaryKind(record.kind)) {
      rejected.push(`段操作「${record.kind}」不在白名单（只有 new / pop）`);
      continue;
    }
    if (!isSegmentBoundaryCause(record.cause)) {
      rejected.push(`cause「${record.cause}」没登记（不许现编原因）`);
      continue;
    }
    const expected = SEGMENT_KIND_BY_CAUSE[record.cause];
    if (expected !== record.kind) {
      rejected.push(
        `cause「${record.cause}」属于「${String(expected)}」，不能用「${record.kind}」登记`,
      );
      continue;
    }
    if (record.kind === 'pop' && !tailDrop) {
      rejected.push(
        'pop 只能解释「丢弃尾部」；这次是段内改写（中段或尾部正文变了），pop 洗不白 —— 段内改一个字节都不行',
      );
      continue;
    }
    const key = `${step.run}/${record.cause}`;
    const usedCount = used.get(key) ?? 0;
    const budget = CAUSE_BUDGET[record.cause] ?? 1;
    if (usedCount >= budget) {
      rejected.push(
        `${record.cause} 本 run 已用过 ${String(usedCount)} 次（预算 ${String(budget)}：${CAUSE_BUDGET_NOTE[record.cause] ?? '每 run 一次'}）`,
      );
      continue;
    }
    return { record, rejected };
  }
  return { rejected };
}

function judgeSteps(steps: readonly RequestStep[]): StepVerdict[] {
  const used = new Map<string, number>();
  const verdicts: StepVerdict[] = [];
  const first = steps[0];
  let segmentBase: readonly Message[] = first ? first.prev : [];

  for (const step of steps) {
    const diff = diffRequestSequence(step.prev, step.next);
    const tailDrop =
      diff.kind === 'diverged' &&
      step.next.length < step.prev.length &&
      isPrefixSequence(step.next, step.prev);
    const problems: string[] = [];
    let boundary: BoundaryRecord | undefined;

    if (diff.kind === 'invalid') {
      problems.push(`R1 ${step.label}：请求不是合法 provider payload —— ${String(diff.reason)}`);
    }

    if (diff.kind === 'diverged') {
      const picked = pickBoundary(step, tailDrop, used);
      if (picked.record !== undefined) {
        boundary = picked.record;
        const key = `${step.run}/${picked.record.cause}`;
        used.set(key, (used.get(key) ?? 0) + 1);
      } else {
        const fields = diff.fields ?? [];
        const where =
          `第 ${String(diff.atIndex)} 条起不再前缀延伸` +
          (fields.length > 0
            ? `（差异字段：${fields.join(', ')}）`
            : `（${String(diff.reason)}）`) +
          (tailDrop ? '，且这是丢弃尾部' : '');
        const why =
          picked.rejected.length > 0 ? picked.rejected.join('；') : '本步没有任何段操作事件';
        problems.push(`R1 ${step.label}：${where}`);
        problems.push(`R2 ${step.label}：差异没有合法的段操作 —— ${why}`);
      }
    }

    const base = countClearedPlaceholders(segmentBase);
    const nextCleared = countClearedPlaceholders(step.next);
    if (boundary !== undefined) segmentBase = step.next;
    if (nextCleared > base) {
      const ids = clearedToolCallIds(step.next);
      problems.push(
        `R4 ${step.label}：同一段内 [cleared …] 占位从 ${String(base)} 条涨到 ${String(nextCleared)} 条` +
          `（V1 判据：占位每轮右移 / 超限裁剪没有一次到位；点名的 tool_call_id：${ids.join(', ') || '(无)'}）`,
      );
    }

    verdicts.push(
      boundary === undefined
        ? { label: step.label, diff, tailDrop, problems }
        : { label: step.label, diff, tailDrop, boundary, problems },
    );
  }
  return verdicts;
}

function step(
  label: string,
  prev: readonly Message[],
  next: readonly Message[],
  boundaries: readonly BoundaryRecord[] = [],
  run = 'run-1',
  turn = 0,
): RequestStep {
  return { label, run, turn, prev, next, boundaries };
}

interface JudgeCase {
  name: string;
  steps: readonly RequestStep[];
  expect: 'red' | 'green';
  contains?: readonly string[];
}

function runJudgeCases(code: string, cases: readonly JudgeCase[]): void {
  for (const testCase of cases) {
    const problems = judgeSteps(testCase.steps).flatMap((verdict) => verdict.problems);
    const joined = problems.join(' | ');
    if (testCase.expect === 'red') {
      const missing = (testCase.contains ?? []).filter((text) => !joined.includes(text));
      if (problems.length === 0) {
        fail(code, `fixture「${testCase.name}」该红却没红`);
      } else if (missing.length > 0) {
        fail(
          code,
          `fixture「${testCase.name}」红了但没说到点上（缺「${missing.join('」「')}」）：${joined}`,
        );
      }
    } else if (problems.length > 0) {
      fail(code, `fixture「${testCase.name}」该放行却红了：${joined}`);
    }
  }
}

// ── R1：前缀延伸（含「新 run 也必须在段内连续」） ────────────────────────────

section('R1 段内逐字节前缀延伸（fixture）');

{
  const fixtures: readonly {
    name: string;
    prev: readonly Message[];
    next: readonly Message[];
    expect: RequestSequenceDiffKind;
    expectIndex?: number;
  }[] = [
    {
      name: '纯追加',
      prev: BASE,
      next: [...BASE, msg('assistant', '两个文件都读完了。')],
      expect: 'extension',
    },
    { name: '中段改一个字', prev: BASE, next: MID_CHANGED, expect: 'diverged', expectIndex: 3 },
    { name: '尾部删一条', prev: BASE, next: BASE.slice(0, 3), expect: 'diverged', expectIndex: 3 },
    { name: '新 run 重新 seed', prev: BASE, next: RESEEDED, expect: 'diverged', expectIndex: 0 },
  ];
  let extensionCount = 0;
  for (const fixture of fixtures) {
    const diff = diffRequestSequence(fixture.prev, fixture.next);
    if (diff.kind === 'extension') extensionCount += 1;
    const indexOk = fixture.expectIndex === undefined || diff.atIndex === fixture.expectIndex;
    if (diff.kind !== fixture.expect || !indexOk) {
      fail(
        'R1',
        `fixture「${fixture.name}」判成了 ${diff.kind}（第 ${String(diff.atIndex)} 条），期望 ${fixture.expect}` +
          (fixture.expectIndex === undefined ? '' : ` / 第 ${String(fixture.expectIndex)} 条`),
      );
    }
  }
  if (extensionCount !== 1) {
    fail('R1', `四组 fixture 里只有「纯追加」该判成 extension，实际 ${String(extensionCount)} 组`);
  } else if (!failures.some((item) => item.startsWith('R1'))) {
    ok('纯追加过；中段改写 / 尾部删除 / 新 run 重新 seed 都被认出来');
  }

  if (isPrefixSequence(BASE, [...BASE, msg('assistant', 'x')]) !== true) {
    fail('R1', 'isPrefixSequence 把纯追加判成了「非前缀」');
  }
  if (isPrefixSequence(BASE, MID_CHANGED) !== false) {
    fail('R1', 'isPrefixSequence 把中段改写判成了前缀');
  }
}

// ── R2：段操作白名单 + cause 匹配 + 预算 ───────────────────────────────────

section('R2 差异必须有登记过的段操作（fixture）');

runJudgeCases('R2', [
  {
    name: '中段改写 + 没有任何段操作',
    steps: [step('中段改写', BASE, MID_CHANGED)],
    expect: 'red',
    contains: ['第 3 条起不再前缀延伸', 'content', '没有任何段操作事件'],
  },
  {
    name: '中段改写 + pop（拿裁剪解释改写）',
    steps: [step('中段改写 + pop', BASE, MID_CHANGED, [{ kind: 'pop', cause: 'context_trim' }])],
    expect: 'red',
    contains: ['pop 只能解释「丢弃尾部」'],
  },
  {
    name: '新 run 重新 seed + 没有段操作',
    steps: [step('新 run 重新 seed', BASE, RESEEDED)],
    expect: 'red',
    contains: ['第 0 条起不再前缀延伸'],
  },
  {
    name: '中段改写 + 自造段操作',
    steps: [
      step('自造段操作', BASE, MID_CHANGED, [{ kind: 'run_boundary', cause: 'session_switch' }]),
    ],
    expect: 'red',
    contains: ['不在白名单'],
  },
  {
    name: '中段改写 + 现编 cause',
    steps: [step('现编 cause', BASE, MID_CHANGED, [{ kind: 'new', cause: 'just_because' }])],
    expect: 'red',
    contains: ['没登记'],
  },
  {
    name: 'cause / 操作不匹配（compaction 记成 pop）',
    steps: [step('错配', BASE, BASE.slice(0, 3), [{ kind: 'pop', cause: 'compaction' }])],
    expect: 'red',
    contains: ['属于「new」'],
  },
  {
    name: '中段改写 + new(session_switch)',
    steps: [step('换会话', BASE, MID_CHANGED, [{ kind: 'new', cause: 'session_switch' }])],
    expect: 'green',
  },
  {
    name: '新 run 重新 seed + new(compaction)',
    steps: [step('压缩换段', BASE, RESEEDED, [{ kind: 'new', cause: 'compaction' }])],
    expect: 'green',
  },
  {
    name: '尾部丢弃 + pop(context_trim)',
    steps: [
      step('裁剪', BASE, BASE.slice(0, 3), [{ kind: 'pop', cause: 'context_trim' }]),
      step(
        '裁剪后继续追加',
        BASE.slice(0, 3),
        [...BASE.slice(0, 3), msg('user', '只读 a.ts 就行')],
        [],
        'run-1',
        1,
      ),
    ],
    expect: 'green',
  },
  {
    name: '同一 run 第二次 pop(context_trim)',
    steps: [
      step(
        '第一次裁剪',
        BASE,
        BASE.slice(0, 3),
        [{ kind: 'pop', cause: 'context_trim' }],
        'run-2',
        0,
      ),
      step(
        '第二次裁剪',
        BASE.slice(0, 3),
        BASE.slice(0, 2),
        [{ kind: 'pop', cause: 'context_trim' }],
        'run-2',
        1,
      ),
    ],
    expect: 'red',
    contains: ['预算'],
  },
  {
    name: '同一 run 中段改写后再换会话第二个 new',
    steps: [
      step('换会话', BASE, MID_CHANGED, [{ kind: 'new', cause: 'session_switch' }], 'run-3', 0),
      step(
        '又换一次',
        MID_CHANGED,
        RESEEDED,
        [{ kind: 'new', cause: 'session_switch' }],
        'run-3',
        1,
      ),
    ],
    expect: 'red',
    contains: ['预算'],
  },
]);

// ── R4：同一段内占位条数不得增加 ───────────────────────────────────────────

section('R4 同一段内 [cleared …] 占位条数不得增加（fixture）');

function clearedAt(seed: number): string {
  return `[cleared read: a.ts -> exit 0, ${String(seed + 3)} lines]`;
}

const ONE_CLEARED: Message[] = BASE.map((message, index) =>
  index === 3 ? msg('tool', clearedAt(0), { tool_call_id: 'call_a' }) : message,
);
const TWO_CLEARED: Message[] = [
  ...ONE_CLEARED,
  msg('tool', clearedAt(1), { tool_call_id: 'call_b' }),
];

{
  if (countClearedPlaceholders(ONE_CLEARED) !== 1) {
    fail('R4', 'fixture 里的 [cleared …] 正文没被计数（形状与 cleared-tool-result.ts 不一致？）');
  }
  runJudgeCases('R4', [
    {
      name: '同一段内占位 0 → 1（没有段操作）',
      steps: [step('占位增加', BASE, ONE_CLEARED)],
      expect: 'red',
      contains: ['占位从 0 条涨到 1 条'],
    },
    {
      name: '占位本来就在段内 + 之后纯追加（条数不涨）',
      steps: [
        step('追加', ONE_CLEARED, [...ONE_CLEARED, msg('user', '再读 c.ts')], [], 'run-4', 0),
      ],
      expect: 'green',
    },
  ]);
  if (countClearedPlaceholders(TWO_CLEARED) !== 2) {
    fail('R4', '占位计数把两条 [cleared …] 正文算错了');
  }
}

// ── live 探针 A：V1 工具结果滑窗占位（当前产品代码） ────────────────────────

section('live 探针 A：V1 工具结果滑窗占位（当前产品代码）');

{
  const maxTokens = 1000; // 保留预算 = 5% ≈ 50 token ⇒ 只留最新 1 条工具结果
  const bodies = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
  const stored: Message[] = [SYSTEM, USER];
  const previousRunTail = withClearedToolResults(
    [SYSTEM, USER, msg('assistant', '上一轮收尾。')],
    maxTokens,
  );
  const steps: RequestStep[] = [];
  let previousRequest: readonly Message[] | undefined;

  bodies.forEach((body, index) => {
    const id = `call_${String(index)}`;
    stored.push(
      msg('assistant', '', {
        tool_calls: [
          { id, type: 'function', function: { name: 'read', arguments: `{"path":"${body}"}` } },
        ],
      }),
    );
    stored.push(msg('tool', `${body} 的真实正文 ${'x'.repeat(400)}`, { tool_call_id: id }));

    const request = withClearedToolResults(stored, maxTokens);
    const rewritten = request.some((message, at) => message !== stored[at]);
    const boundaries: BoundaryRecord[] = rewritten
      ? [
          {
            kind: 'pop',
            cause: 'context_trim',
            note: 'EU：prepared != normalized ⇒ pendingPrefixReason ??= context_trim',
          },
        ]
      : [];
    if (previousRequest === undefined) {
      steps.push(
        step(
          `run-1 第 ${String(index + 1)} 次请求`,
          previousRunTail,
          request,
          [{ kind: 'new', cause: 'session_switch' }],
          'run-1',
          index,
        ),
      );
    } else {
      steps.push(
        step(
          `run-1 第 ${String(index + 1)} 次请求`,
          previousRequest,
          request,
          boundaries,
          'run-1',
          index,
        ),
      );
    }
    previousRequest = request;
  });

  const verdicts = judgeSteps(steps);
  info(
    steps
      .map(
        (item, index) =>
          `${item.label}：${String(verdicts[index]?.diff.kind ?? '?')}，占位 ${String(countClearedPlaceholders(item.next))} 条`,
      )
      .join(' → '),
  );
  const problems = verdicts.flatMap((verdict) => verdict.problems);
  if (problems.length === 0) {
    ok('V1 不再出现（工具结果占位没有在段内改写已落盘正文）');
  } else {
    for (const problem of problems) known(problem, 'V1');
  }
}

// ── live 探针 B：V2 run 内压缩就地删中段（当前产品代码） ────────────────────

section('live 探针 B：V2 run 内压缩就地删中段（当前产品代码）');

{
  const maxTokens = 400;
  const context = new MemoryWorkingContext({ maxTokens, maxMessages: 5, autoCompact: true });
  context.setSessionId('s-v2');
  context.add(SYSTEM);
  context.add(USER);

  const steps: RequestStep[] = [];
  let previousRequest: readonly Message[] | undefined = withClearedToolResults(
    context.messages,
    maxTokens,
  );
  let compactionCount = 0;
  for (let index = 0; index < 6; index += 1) {
    const id = `call_v2_${String(index)}`;
    context.add(
      msg('assistant', '', {
        tool_calls: [
          {
            id,
            type: 'function',
            function: { name: 'read', arguments: `{"path":"f${String(index)}.ts"}` },
          },
        ],
      }),
    );
    context.add(msg('tool', `f${String(index)}.ts 正文 ${'y'.repeat(300)}`, { tool_call_id: id }));
    const request = withClearedToolResults(context.messages, maxTokens);
    const report = context.lastCompaction;
    const compactedNow = report !== undefined && report.removed > 0 && report.id > compactionCount;
    if (compactedNow && report !== undefined) compactionCount = report.id;
    const boundaries: BoundaryRecord[] = compactedNow
      ? [{ kind: 'new', cause: 'compaction', note: 'EU：压缩后就地改写当前会话（没有换会话）' }]
      : [];
    if (previousRequest !== undefined) {
      steps.push(
        step(
          `run-v2 第 ${String(index + 1)} 次请求`,
          previousRequest,
          request,
          boundaries,
          'run-v2',
          index,
        ),
      );
    }
    previousRequest = request;
  }

  const verdicts = judgeSteps(steps);
  info(`压缩报告 id=${String(compactionCount)}（会话数=1，压缩就地发生在这个 run 里）`);
  const problems = verdicts.flatMap((verdict) => verdict.problems);
  if (problems.length === 0) {
    ok('V2 不再出现（run 内压缩没有绕过段边界）');
  } else {
    for (const problem of problems) known(problem, 'V2');
  }
}

// ── R3：白名单恰好 new / pop ───────────────────────────────────────────────

section('R3 段操作白名单恰好是 new / pop（本文件有独立的 EXPECTED 表）');

const EXPECTED_KINDS = ['new', 'pop'];
const EXPECTED_NEW_CAUSES = ['session_switch', 'compaction'];
const EXPECTED_POP_CAUSES = ['rewind', 'branch', 'context_trim'];

{
  const actual: string[] = [...SEGMENT_BOUNDARY_KINDS];
  const extra = actual.filter((kind) => !EXPECTED_KINDS.includes(kind));
  const missing = EXPECTED_KINDS.filter((kind) => !actual.includes(kind));
  if (extra.length > 0) {
    fail(
      'R3',
      `段操作白名单多了 ${extra.join(', ')} —— 加操作必须同时改本文件的 EXPECTED 表并说明理由`,
    );
  } else if (missing.length > 0) {
    fail('R3', `段操作白名单少了 ${missing.join(', ')}`);
  } else {
    ok(`段操作恰好 ${String(actual.length)} 个：${actual.join(' / ')}`);
  }

  const newCauses: string[] = [...SEGMENT_NEW_CAUSES];
  const popCauses: string[] = [...SEGMENT_POP_CAUSES];
  const newExtra = newCauses.filter(
    (cause) => !(EXPECTED_NEW_CAUSES as readonly string[]).includes(cause),
  );
  const newMissing = EXPECTED_NEW_CAUSES.filter((cause) => !newCauses.includes(cause as string));
  const popExtra = popCauses.filter(
    (cause) => !(EXPECTED_POP_CAUSES as readonly string[]).includes(cause),
  );
  const popMissing = EXPECTED_POP_CAUSES.filter((cause) => !popCauses.includes(cause as string));
  if (newExtra.length + newMissing.length + popExtra.length + popMissing.length > 0) {
    fail(
      'R3',
      `cause 词表与判据不一致：new 多[${newExtra.join(',')}] 少[${newMissing.join(',')}]；pop 多[${popExtra.join(',')}] 少[${popMissing.join(',')}]`,
    );
  } else {
    ok(`cause 词表封闭：new{${newCauses.join(',')}} pop{${popCauses.join(',')}}`);
  }

  const danglingCauses = Object.keys(SEGMENT_KIND_BY_CAUSE).filter(
    (cause) => !newCauses.includes(cause) && !popCauses.includes(cause),
  );
  const misMapped = [...newCauses, ...popCauses].filter((cause) => {
    const expected = newCauses.includes(cause) ? 'new' : 'pop';
    return SEGMENT_KIND_BY_CAUSE[cause] !== expected;
  });
  const causeNamedAsKind = [...newCauses, ...popCauses].filter((cause) =>
    (SEGMENT_BOUNDARY_KINDS as readonly string[]).includes(cause),
  );
  if (danglingCauses.length > 0) {
    fail('R3', `SEGMENT_KIND_BY_CAUSE 里有词表外的 cause：${danglingCauses.join(', ')}`);
  } else if (misMapped.length > 0) {
    fail('R3', `cause 映射到的操作不对：${misMapped.join(', ')}`);
  } else if (causeNamedAsKind.length > 0) {
    fail('R3', `cause 不许等于段操作名：${causeNamedAsKind.join(', ')}`);
  } else {
    ok('每个 cause 都唯一映射到一个段操作，且 cause ≠ 操作名');
  }

  const noRecord = [...newCauses, ...popCauses].filter(
    (cause) =>
      (SEGMENT_CAUSE_RECORD_EVENTS[cause as keyof typeof SEGMENT_CAUSE_RECORD_EVENTS] ?? [])
        .length === 0,
  );
  if (noRecord.length > 0) {
    fail('R3', `这些 cause 没声明可见记录事件：${noRecord.join(', ')}`);
  } else {
    ok('每个 cause 都声明了可见记录事件');
  }
}

{
  // 既有词表 PrefixChangeReason：只许留下登记过的、且必须归类。
  const guardSource = readFileSync(
    join(REPO, 'packages/core/src/runtime/prompt-prefix-guard.ts'),
    'utf8',
  );
  const reasons = prefixChangeReasons(guardSource);
  // 被删的 reason（R6 的目标）不算「没归类」—— 它们不是在等归类，是在等删除。
  const unclassified = reasons.filter(
    (reason) =>
      SEGMENT_KIND_BY_PREFIX_REASON[reason] === undefined &&
      BANNED_PREFIX_REASONS[reason] === undefined,
  );
  if (reasons.length === 0) {
    fail('R3', '没从 prompt-prefix-guard.ts 解析出 PrefixChangeReason 词表（源码解析失配）');
  } else if (unclassified.length > 0) {
    fail(
      'R3',
      `PrefixChangeReason 里没归类的 reason：${unclassified.join(', ')}（R6 会要求删掉洗白用的那几个）`,
    );
  } else {
    ok(
      `PrefixChangeReason 剩下的 ${String(reasons.length - Object.keys(BANNED_PREFIX_REASONS).filter((reason) => reasons.includes(reason)).length)} 个 reason 全部归类（其余待删，见 R6）`,
    );
  }
}

// ── R6：洗白用的 reason 必须从词表消失 ─────────────────────────────────────

section('R6 PrefixChangeReason 里不许有洗白用的 reason');

{
  const guardSource = readFileSync(
    join(REPO, 'packages/core/src/runtime/prompt-prefix-guard.ts'),
    'utf8',
  );
  const reasons = prefixChangeReasons(guardSource);
  const banned = Object.keys(BANNED_PREFIX_REASONS);
  const stillThere = banned.filter((reason) => reasons.includes(reason));
  if (stillThere.length > 0) {
    known(
      `词表里还留着：${stillThere.map((reason) => `${reason}（${BANNED_PREFIX_REASONS[reason] ?? '无理由'}）`).join('；')}`,
      'R6',
    );
  } else {
    ok(`词表里没有 ${banned.join(' / ')}`);
  }

  const literalHits: string[] = [];
  for (const reason of banned) {
    // 词表本身（prompt-prefix-guard.ts 的联合类型）由上面的解析负责，这里只看调用点。
    literalHits.push(
      ...findCallSites(join(REPO, 'packages/core/src'), quoteLiteral(reason), [
        'prompt-prefix-guard.ts',
      ]),
    );
  }
  if (literalHits.length > 0) {
    known(`源码里还在用被删的 reason：${literalHits.join(', ')}`, 'R6');
  } else {
    ok('源码里没有被删 reason 的字面量调用点');
  }
}

// ── R7：resume 必须追加（续段），不是新段 ──────────────────────────────────

section('R7 resume（S1c 重启卡）是追加，不是新段');

{
  const resumeSource = readFileSync(join(REPO, 'src/node-resume.ts'), 'utf8');
  const rewrites: string[] = [];
  if (!resumeSource.includes('announce(')) rewrites.push('没有走 announce（排进下一次请求）');
  if (!resumeSource.includes('restartCardText(')) rewrites.push('卡片文案不是 restartCardText');
  for (const needle of [
    'pendingPrefixReason',
    'compactMessagesForSeed',
    'withClearedToolResults',
  ]) {
    if (resumeSource.includes(needle))
      rewrites.push(`resume 路径上出现了 ${needle}（在重造 seed / 换段）`);
  }
  if (rewrites.length > 0) {
    fail('R7', `resume 不是纯追加：${rewrites.join('；')}`);
  } else {
    ok('resume 只往尾部排一张卡（不重造 seed、不设 prefix reason）');
  }

  // 行为侧：卡插在尾部 ⇒ 必须仍是前缀延伸；插在开头 / 改 system ⇒ 红。
  const card = msg('user', 'restart: 网关在你工作时重启了（run=r1）\n· 先核对现状再继续', {
    name: 'vessel:notice',
  });
  const appended = diffRequestSequence(BASE, [...BASE, card]);
  if (appended.kind !== 'extension') {
    fail('R7', `重启卡追加在尾部却判成 ${appended.kind}：${String(appended.reason)}`);
  } else {
    ok('重启卡追加在尾部 ⇒ 续段（extension）');
  }
  const prepended = diffRequestSequence(BASE, [card, ...BASE]);
  if (prepended.kind !== 'diverged') {
    fail('R7', '重启卡插在开头却被判成段内延伸（R1 的前缀判据有问题）');
  } else {
    ok('重启卡插在开头 ⇒ 红（所以 resume 只能追加）');
  }
}

// ── R5：每个 cause 都必须可见 ──────────────────────────────────────────────

section('R5 每个 cause 都必须有可见记录（tier 表）');

{
  const visibilitySource = readFileSync(
    join(REPO, 'apps/web/src/state/event-visibility.ts'),
    'utf8',
  );
  const table = parseEventTiers(visibilitySource);
  const causes = [...SEGMENT_NEW_CAUSES, ...SEGMENT_POP_CAUSES];
  let unseen = 0;
  for (const cause of causes) {
    const events = SEGMENT_CAUSE_RECORD_EVENTS[cause] ?? [];
    const verdicts: string[] = [];
    for (const event of events) {
      const entry = table.get(event);
      if (entry === undefined) {
        verdicts.push(`${event} 不在 tier 表里（事件不存在 ⇒ 没人能看见）`);
        continue;
      }
      if (entry.tier === 'internal' && entry.carrier !== 'notice' && entry.carrier !== 'card') {
        verdicts.push(`${event} 是 internal 且没有 notice/card 投影`);
      }
    }
    if (verdicts.length === 0) continue;
    unseen += 1;
    const message = `段操作原因「${cause}」用户看不到：${verdicts.join('；')} —— 断段必须可见`;
    // `context_trim` 今天之所以不可见，是因为 V1 的滑窗占位就活在这条路径上；
    // 修 V1 时一并给它 notice 投影（或让它不再发生），届时这里自动转 FAIL。
    if (cause === 'context_trim') known(message, 'V1');
    else fail('R5', message);
  }
  if (unseen === 0) ok('每个 cause 都有非 internal（或带 notice/card）的记录事件');
}

// ── W：源码接线断言 ───────────────────────────────────────────────────────

section('W 源码接线断言');

{
  const contextIndex = readFileSync(join(REPO, 'packages/core/src/context/index.ts'), 'utf8');
  const coreIndex = readFileSync(join(REPO, 'packages/core/src/index.ts'), 'utf8');
  const names = [
    'toProviderPayload',
    'diffRequestSequence',
    'isPrefixSequence',
    'SEGMENT_BOUNDARY_KINDS',
    'SEGMENT_KIND_BY_CAUSE',
    'BANNED_PREFIX_REASONS',
  ];
  const missingFromContext = names.filter((name) => !contextIndex.includes(name));
  const missingFromCore = names.filter((name) => !coreIndex.includes(name));
  if (missingFromContext.length > 0) {
    fail('W1', `context/index.ts 没有导出判据：${missingFromContext.join(', ')}`);
  } else if (missingFromCore.length > 0) {
    fail('W1', `core/src/index.ts 没有转出判据：${missingFromCore.join(', ')}`);
  } else {
    ok('判据从 context 与 core 两处导出（产品侧和门禁共用同一套）');
  }
}

const CORE_SRC = join(REPO, 'packages/core/src');

{
  // V3：读侧脱敏已迁到 append 侧 ⇒ 请求路径不许再调 withReadSideMask。
  const callSites = findCallSites(CORE_SRC, 'withReadSideMask(', [
    'read-side-mask.ts',
    'context/index.ts',
  ]);
  if (callSites.length > 0) {
    fail('W2', `请求期脱敏还在（V3 已迁 append 侧）：${callSites.join(', ')}`);
  } else {
    ok('读侧脱敏没有调用点（V3 落在 append 侧）');
  }
}

{
  const executionUnit = readFileSync(
    join(REPO, 'packages/core/src/runtime/execution-unit.ts'),
    'utf8',
  );
  if (!executionUnit.includes('maskForAppend(')) {
    fail('W3', 'execution-unit 里没有 maskForAppend 调用 —— append 侧脱敏接线断了');
  } else if (!executionUnit.includes('buildRequestMessages')) {
    fail('W3', 'execution-unit 里找不到 buildRequestMessages（请求装配点改名了？判据要跟着改）');
  } else {
    ok('append 侧脱敏在位，请求装配点是 buildRequestMessages');
  }

  // 请求路径里出现的每个 reason 字面量都必须归类过；被删的那几个更不许出现（R6 也查）。
  const literals = [...executionUnit.matchAll(/pendingPrefixReason \?\?= '([a-z_]+)'/g)].map(
    (match) => match[1] as string,
  );
  const unknown = [...new Set(literals)].filter(
    (reason) =>
      SEGMENT_KIND_BY_PREFIX_REASON[reason] === undefined &&
      BANNED_PREFIX_REASONS[reason] === undefined,
  );
  if (literals.length === 0) {
    fail('W4', '没从 execution-unit 解析出 pendingPrefixReason 字面量（源码解析失配）');
  } else if (unknown.length > 0) {
    fail('W4', `请求路径现编了没归类的 reason：${unknown.join(', ')}`);
  } else {
    ok(`请求路径的 ${String(new Set(literals).size)} 个 reason 全部归类过`);
  }
}

{
  const pkg = readFileSync(join(REPO, 'package.json'), 'utf8');
  const expected = '"check:request-append-only": "bun run scripts/check-request-append-only.ts"';
  if (!pkg.includes(expected)) {
    fail('W5', `package.json 里没有 ${expected}`);
  } else {
    ok('package.json 挂了 check:request-append-only');
  }
}

// ── 汇总 ───────────────────────────────────────────────────────────────────

console.log('\n── 汇总');
console.log(`   通过 ${String(passes.length)} 项`);
for (const item of passes) console.log(`   ok  ${item}`);

if (pendings.length > 0) {
  console.log(`\n   灰度一阶段（--phase=1）：${String(pendings.length)} 项已确认的违规暂不拦 CI`);
  for (const item of pendings) console.log(`   PENDING  ${item}`);
}

if (failures.length > 0) {
  console.log(`\n   红 ${String(failures.length)} 项`);
  for (const item of failures) console.log(`   FAIL  ${item}`);
  console.log(
    '\ncheck:request-append-only 失败：请求序列在段内被改写了，或者换段没有登记/没有可见记录。\n' +
      '判据见 docs/architecture/message-invariants.md 与 docs/dev/research/invariant-audit-appendonly.md。',
  );
  process.exitCode = 1;
} else {
  console.log('\ncheck:request-append-only 通过（段内只追加或丢尾，换段有登记且可见）');
}

// ── 解析助手 ───────────────────────────────────────────────────────────────

/** 从 `types/provider.ts` 里取 `Message` 的字段名（只认 2 空格缩进的顶层字段）。 */
function messageInterfaceFields(source: string): string[] {
  const start = source.indexOf('export interface Message {');
  if (start < 0) return [];
  const end = source.indexOf('\n}', start);
  if (end < 0) return [];
  const body = source.slice(start, end);
  const fields = new Set<string>();
  for (const match of body.matchAll(/^ {2}([a-z][A-Za-z0-9_]*)\??:/gm)) {
    fields.add(match[1] as string);
  }
  return [...fields];
}

/** 从 `prompt-prefix-guard.ts` 里取 `PrefixChangeReason` 联合类型的所有成员。 */
function prefixChangeReasons(source: string): string[] {
  const match = /export type PrefixChangeReason =([\s\S]*?);/.exec(source);
  if (!match || match[1] === undefined) return [];
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((item) => item[1] as string);
}

interface EventTierEntry {
  tier: string;
  carrier: string | undefined;
}

/** 解析 `event-visibility.ts` 的 tier 表（同名后出现者覆盖先出现者，与对象字面量一致）。 */
function parseEventTiers(source: string): Map<string, EventTierEntry> {
  const table = new Map<string, EventTierEntry>();
  for (const line of source.split('\n')) {
    const match = /^ {2}'([^']+)': \{([^}]*)\}/.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) continue;
    const tier = /tier: '([a-z]+)'/.exec(match[2]);
    const carrier = /承接: '([a-z-]+)'/.exec(match[2]);
    if (!tier || tier[1] === undefined) continue;
    table.set(match[1], { tier: tier[1], carrier: carrier?.[1] });
  }
  return table;
}

/** 把一个词包成源码里的单引号字面量（找调用点时用）。 */
function quoteLiteral(word: string): string {
  return `'${word}'`;
}

/** 在目录里找某个字面量的出现位置（排除给定文件），回报 `相对路径:行号`。 */
function findCallSites(root: string, needle: string, exclude: readonly string[]): string[] {
  const hits: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (exclude.includes(entry.name)) continue;
      const lines = readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
        if (line.includes(needle)) hits.push(`${full.slice(REPO.length + 1)}:${String(index + 1)}`);
      });
    }
  };
  walk(root);
  return hits;
}
