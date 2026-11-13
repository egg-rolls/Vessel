#!/usr/bin/env bun

/**
 * 「上下文占用」真相源门禁：rotate 确认文案 / 界面 / web 必须是**同一个数**。
 *
 * 这一单的教训：同一次 rotate，界面报 51%，提示说「Context usage is unknown」。根因不是
 * 「没实现」，而是**两条取数路**：界面读 `ContextManager.tokenCount`（有真实用量锚点时已
 * 按锚点校正，否则估算缓存），提示读 `execution.lastContextRatio` —— 后者只在 run **结束**
 * 时写，而 rotate 工具恰恰在 run 进行中被调用。同一个问题两套取数，迟早分叉。
 *
 * 检查项：
 *  A. 恒等式 `ratio(session) * 窗口上限 === token_count`（同一时点、同一 source）；分母走
 *     「事件真值」和「装配兜底」两条路都必须成立 —— 这是防分叉的那条等式。
 *  B. 取整口径：`percent === Math.round(ratio * 100)`，且提示 / 界面 / core 预警三处源码
 *     用的是同一个取整表达式（read-only 断言，一边 round 一边 floor 立刻变红）。
 *  C. 装配接线：`src/agent-service-wiring.ts` 必须把实时读数源挂到端口的 `contextRatio`
 *     上，且订阅的是父事件流（所有 body 的 `context.changed` 都并入这条流）。
 *  D. 单一口径：`service.contextRatio` 只做委托（不许二次估算）；`tool.ts` 的百分比必须
 *     是 round，不是 floor。
 *  E. 包装不破宿主：`withLiveContextRatio` 用原型委托，宿主方法（靠 `this` 读内部状态）
 *     在包装对象上调用必须照旧读到状态 —— 防「顺手改成对象展开」。
 *
 * 用法：bun run scripts/check-context-ratio.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createContextRatioSource, withLiveContextRatio } from '../src/context-ratio-source';

const REPO = join(import.meta.dir, '..');

const failures: string[] = [];
let passed = 0;

function fail(where: string, message: string): void {
  failures.push(`${where} ${message}`);
}

function check(condition: boolean, where: string, message: string): void {
  if (condition) passed += 1;
  else fail(where, message);
}

/** 浮点比较：`x / max * max` 未必精确回原值，但必须在一个极小的相对误差内。 */
function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
}

const cache = new Map<string, string>();

/** 读源码（带缓存）；读不到就是 FAIL —— 门禁不能因为文件消失而静默放行。 */
async function source(path: string): Promise<string> {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  try {
    const text = await readFile(join(REPO, path), 'utf8');
    cache.set(path, text);
    return text;
  } catch {
    fail(path, '[F 文件] 读不到这个文件（改名 / 删除？门禁需要它存在）');
    cache.set(path, '');
    return '';
  }
}

/* ── A. 恒等式：两边同一个数 ───────────────────────────────────────────── */

function checkIdentity(): void {
  // A1：界面那一路 —— `context.changed.token_count` + 窗口上限真值。
  const live = createContextRatioSource();
  live.observe({ type: 'context.changed', data: { session_id: 's1', token_count: 103_456 } });
  live.observe({ type: 'prompt.system_context', data: { session_id: 's1', context_max: 200_000 } });
  const ratioA = live.ratio('s1');
  check(
    ratioA !== undefined && near(ratioA * 200_000, 103_456),
    'A1',
    `ratio * max 必须等于 token_count（${ratioA} × 200000 ≠ 103456）`,
  );
  if (ratioA !== undefined) {
    check(near(ratioA, 103_456 / 200_000), 'A1', 'ratio 必须就是 token_count / max，不许另算一份');
  }

  // A2：成对真值（`context.pressure`）必须覆盖掉更早的窗口上限，而不是相加/取平均。
  live.observe({ type: 'context.changed', data: { session_id: 's2', token_count: 50_000 } });
  live.observe({
    type: 'prompt.system_context',
    data: { session_id: 's2', context_max: 1_000_000 },
  });
  live.observe({
    type: 'context.pressure',
    data: { session_id: 's2', used: 50_000, max: 200_000 },
  });
  const ratioA2 = live.ratio('s2');
  check(
    ratioA2 !== undefined && near(ratioA2 * 200_000, 50_000),
    'A2',
    'pressure 的 used/max 成对真值必须整体生效',
  );

  // A3：装配层给了窗口上限（配置里没写时的兜底也在这一条里）—— 没有 max 事件也要给数。
  const configured = createContextRatioSource({ fallbackMaxTokens: 200_000 });
  configured.observe({ type: 'context.changed', data: { session_id: 's3', token_count: 103_456 } });
  const ratioA3 = configured.ratio('s3');
  check(
    ratioA3 !== undefined && near(ratioA3 * 200_000, 103_456),
    'A3',
    '只有 token_count 时必须用装配层上限，仍然满足 ratio * max === token_count',
  );

  // A4：连配置都没给 ⇒ 用 `ContextManager.maxTokens` 的同一个兜底 1_000_000（界面同一个数）。
  const fallback = createContextRatioSource();
  fallback.observe({ type: 'context.changed', data: { session_id: 's4', token_count: 510_000 } });
  const ratioA4 = fallback.ratio('s4');
  check(
    ratioA4 !== undefined && near(ratioA4 * 1_000_000, 510_000),
    'A4',
    '默认兜底窗口上限必须是 1_000_000（与 ContextManager.maxTokens 同值）',
  );

  // A5：分母真值优先于配置兜底（配置写小 / 写大都不该改写真值）。
  const prefer = createContextRatioSource({ fallbackMaxTokens: 2_000_000 });
  prefer.observe({ type: 'context.changed', data: { session_id: 's5', token_count: 90_000 } });
  prefer.observe({
    type: 'prompt.system_context',
    data: { session_id: 's5', context_max: 200_000 },
  });
  const ratioA5 = prefer.ratio('s5');
  check(
    ratioA5 !== undefined && near(ratioA5 * 200_000, 90_000),
    'A5',
    '窗口上限真值必须优先于装配兜底',
  );

  // A6：undefined 只剩一种触发条件 —— 本进程没见过该会话的任何上下文事件。
  check(live.ratio('never-seen') === undefined, 'A6', '没见过的会话才允许 undefined');
  check(live.percent('never-seen') === undefined, 'A6', 'percent 与 ratio 同生共死');

  // A7：取整只能发生在**上层**。`contextRatio` 必须返回原值，才能反推出整数 token：
  // 若它自己先四舍五入（例如 0.517 或 0.5173），`round(ratio * max)` 就回不到 103456。
  if (ratioA !== undefined) {
    const recovered = Math.round(ratioA * 200_000);
    check(
      recovered === 103_456,
      'A7',
      `ratio * max 必须能反推回整数 token_count（反推到 ${recovered}，应为 103456）`,
    );
  }
  check(
    (live.percent('s1') ?? 0) === Math.round((live.ratio('s1') ?? 0) * 100),
    'A7',
    '取整只在 percent 这一层，ratio 保持原值',
  );
}

/* ── B. 取整口径：round，不是 floor ───────────────────────────────────── */

function checkRounding(): void {
  const reading = createContextRatioSource();
  reading.observe({ type: 'context.changed', data: { session_id: 'r1', token_count: 103_456 } });
  reading.observe({
    type: 'prompt.system_context',
    data: { session_id: 'r1', context_max: 200_000 },
  });
  check(
    reading.percent('r1') === 52,
    'B1',
    `51.728% 必须是 52%（界面同为 round），实际 ${reading.percent('r1')}`,
  );

  // 0.895 是 floor / round 分叉的那个点：界面 round 显示 90%，提示也必须 90%。
  reading.observe({ type: 'context.changed', data: { session_id: 'r2', token_count: 895 } });
  reading.observe({
    type: 'prompt.system_context',
    data: { session_id: 'r2', context_max: 1_000 },
  });
  check(reading.percent('r2') === 90, 'B2', '89.5% 必须与界面一致显示 90%（floor 会显示 89%）');
  check(
    Math.floor((reading.ratio('r2') ?? 0) * 100) === 89,
    'B2',
    '这条样本必须真的能区分 round 与 floor',
  );
}

async function checkRoundingInSources(): Promise<void> {
  // 同一个取整表达式必须同时出现在「提示」「界面」「core 预警」—— 任何一处改成 floor 都红。
  const CANONICAL = 'Math.round(ratio * 100)';
  const spots: Array<[string, string]> = [
    ['packages/agent/src/tool.ts', CANONICAL],
    ['packages/tui/src/repl/project/ui-item.ts', CANONICAL],
    ['packages/core/src/runtime/execution-unit.ts', CANONICAL],
    ['src/context-ratio-source.ts', CANONICAL],
  ];
  for (const [file, needle] of spots) {
    const text = await source(file);
    check(text.includes(needle), file, `[B3] 取整口径必须与界面一致：缺 ${needle}`);
  }
  const statusBar = await source('packages/tui/src/repl/status-snapshot.ts');
  check(
    statusBar.includes('Math.round((snapshot.context.used / snapshot.context.max) * 100)'),
    'packages/tui/src/repl/status-snapshot.ts',
    '[B3] TUI 状态栏百分比必须是 Math.round（它是「界面那个数」的基准）',
  );
}

/* ── C/D. 接线与单一口径 ─────────────────────────────────────────────── */

async function checkWiring(): Promise<void> {
  const wiring = await source('src/agent-service-wiring.ts');
  check(
    wiring.includes('createContextRatioSource('),
    'src/agent-service-wiring.ts',
    '[C1] 必须建实时读数源',
  );
  check(
    wiring.includes('options.parentEvents?.subscribe') &&
      wiring.includes('contextRatioSource.observe'),
    'src/agent-service-wiring.ts',
    '[C2] 读数必须来自父事件流（所有 body 的 context.changed 都并入这条流）',
  );
  check(
    wiring.includes('withLiveContextRatio(innerRuntime'),
    'src/agent-service-wiring.ts',
    '[C3] 端口上的 contextRatio 必须换成实时读数（宿主原值只做兜底）',
  );
  check(
    wiring.includes('runtime: bodyRuntime,'),
    'src/agent-service-wiring.ts',
    '[C4] 传给 service 的必须是包好的端口',
  );

  const service = await source('packages/agent/src/service.ts');
  const reader = await source('src/context-ratio-source.ts');
  // D0：读数源只能搬运事件里的数，不许自己估（`ctx-anchor` 之后 tokenCount 已是锚点
  // 校正值，再估一次就会与界面分叉），也不许 import 任何包 —— 它必须是可单跑的纯模块。
  check(
    !reader.includes('estimateToken') &&
      !reader.includes('realTokens') &&
      !reader.includes("from '"),
    'src/context-ratio-source.ts',
    '[D0] 读数源不许自己估算 token / 不许引依赖（只搬运 context.changed 送来的 token_count）',
  );
  check(
    service.includes('this.runtime.contextRatio?.(sessionId)'),
    'packages/agent/src/service.ts',
    '[D1] service.contextRatio 只能委托端口，取数链不许在这里分叉',
  );
  // 只看 `contextRatio` 这一个方法体：service 的其它方法用 floor 与本单无关，
  // 但这个方法体里一出现估算 / 取整，就说明又造了第二份数。
  const bodyStart = service.indexOf('contextRatio(sessionId: string)');
  const bodyEnd = bodyStart === -1 ? -1 : service.indexOf('\n  }', bodyStart);
  const body = bodyStart === -1 || bodyEnd === -1 ? '' : service.slice(bodyStart, bodyEnd);
  check(
    body !== '',
    'packages/agent/src/service.ts',
    '[D2] 找不到 contextRatio 方法体（改名了？门禁要跟着改）',
  );
  check(
    !body.includes('Math.floor') &&
      !body.includes('Math.round') &&
      !body.includes('contextMaxTokens'),
    'packages/agent/src/service.ts',
    '[D2] service.contextRatio 不许自己估算 / 自己取整（那就会变成第二份数）',
  );

  const tool = await source('packages/agent/src/tool.ts');
  check(
    tool.includes('Math.round(ratio * 100)') && !tool.includes('Math.floor(ratio * 100)'),
    'packages/agent/src/tool.ts',
    '[D3] rotate 提示必须用 round，与界面同一个整数',
  );
  check(
    tool.includes('percent >= warningLine'),
    'packages/agent/src/tool.ts',
    '[D4] 「高于/低于阈值线」必须与显示的整数同源，否则会出现「90%（低于 90% 线）」',
  );
}

/* ── E. 包装不破宿主 ─────────────────────────────────────────────────── */

function checkWrapper(): void {
  class FakeHost {
    private readonly entries = new Map<string, number>([['known', 0.25]]);
    contextRatio(sessionId: string): number | undefined {
      return this.entries.get(sessionId);
    }
    canConfirm(): boolean {
      return this.entries.size > 0;
    }
  }

  const host = new FakeHost();
  const live = createContextRatioSource();
  live.observe({ type: 'context.changed', data: { session_id: 'hot', token_count: 90_000 } });
  live.observe({
    type: 'prompt.system_context',
    data: { session_id: 'hot', context_max: 200_000 },
  });
  const wrapped = withLiveContextRatio(host, live);

  check(wrapped instanceof FakeHost, 'E1', '包装必须仍是原宿主（原型链，不是复制）');
  check(
    wrapped.canConfirm() === true,
    'E2',
    '宿主方法在包装对象上调用时必须仍能读到自己的状态（this 绑定）',
  );
  check(near(wrapped.contextRatio('hot') ?? 0, 90_000 / 200_000), 'E3', '实时读数必须压过宿主旧值');
  check(
    wrapped.contextRatio('known') === 0.25,
    'E4',
    '实时读数缺席时回落到宿主旧值（至少比 unknown 准）',
  );
  check(wrapped.contextRatio('nowhere') === undefined, 'E5', '两边都没有才 undefined');
}

async function main(): Promise<void> {
  checkIdentity();
  checkRounding();
  checkWrapper();
  await checkRoundingInSources();
  await checkWiring();

  if (failures.length > 0) {
    for (const failure of failures) console.log(`FAIL  ${failure}`);
    console.error(`context ratio: ${failures.length} check(s) FAILED（${passed} passed）`);
    process.exit(1);
  }
  console.log(`context ratio: all ${passed} checks passed`);
}

await main();
