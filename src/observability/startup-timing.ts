/**
 * 启动分期观测（0.57）。
 *
 * 由来（用户原话）：「node 启动 16 秒，我不知道时间花在哪」——`node Soulkiller: ready
 * (after 16272 ms)` 只有一个总数，归因只能靠临时打点。这个模块把启动切成**固定几段**，
 * 每一段都留下「到这一刻为止」的时刻，于是任何一段的耗时都是相邻两个时刻的差。
 *
 * 输出遵守宪法第十四条：**单行 key=value**、不刷屏、一眼能看出哪段慢。
 *
 * - 汇总（default 级别，一行）：`[vessel] node.startup ready=16.3s bun=412ms ... slow=sweep`
 * - 明细（debug 级别，仍是一行）：`[vessel] node.startup.detail sweep.list=690ms ...`
 *
 * 计时原点 = **进程启动**（`performance.now()` 在 Bun 里就是进程启动以来的毫秒数，不依赖
 * 任何一行代码先被执行）。所以 `bun` 这一段量的是「解释器 + 模块图求值」——它必须靠
 * 「第一个语句被执行时 performance.now() 已经很大」来体现，而不是靠自己先记一个零点。
 *
 * 非 serve 入口（REPL / `--run` / doctor）不打这一行：它们没有「ready」这个意义。
 *
 * @module vessel/startup-timing
 */

/** 一段的收口时刻（从进程启动算起的毫秒数） */
interface StartupMark {
  phase: string;
  at: number;
}

const marks: StartupMark[] = [];
/** 明细里的计数 / 子段（`name` → 毫秒数或整数计数），按插入顺序输出 */
const notes = new Map<string, number>();
let emitted = false;

/** 记录「某一段做完了」。重复记录同一段名时保留**最后一次**（后写覆盖前写）。 */
export function markStartup(phase: string): void {
  if (emitted) return;
  const at = performance.now();
  const existing = marks.findIndex((mark) => mark.phase === phase);
  if (existing >= 0) {
    marks[existing] = { phase, at };
    return;
  }
  marks.push({ phase, at });
}

/** 记一个数（毫秒 / 条数 / 字节）。同名累加——同一段在启动里被调多次时得到总量。 */
export function noteStartup(name: string, value: number): void {
  if (emitted) return;
  if (!Number.isFinite(value)) return;
  notes.set(name, (notes.get(name) ?? 0) + value);
}

/** 记一个最大值（例如「最慢的那一次」）。 */
export function noteStartupMax(name: string, value: number): void {
  if (emitted) return;
  if (!Number.isFinite(value)) return;
  notes.set(name, Math.max(notes.get(name) ?? 0, value));
}

/**
 * 计时一段 `await`：包住调用即可。
 *
 * 用法：`const out = await timeStartup('runtime.plugins', doWork())` —— 不改变返回值与
 * 错误语义（拒绝照旧抛出，只是把耗时记下来）。
 */
export async function timeStartup<T>(name: string, work: Promise<T>): Promise<T> {
  if (emitted) return work;
  const startedAt = performance.now();
  try {
    return await work;
  } finally {
    noteStartup(name, performance.now() - startedAt);
  }
}

/** 已经记录过的段 → 从进程启动算起的毫秒数（没有则 undefined）。 */
export function startupAt(phase: string): number | undefined {
  return marks.find((mark) => mark.phase === phase)?.at;
}

/** 数值降噪（第十四条）：<1s 用毫秒，否则一位小数的秒。 */
export function formatStartupMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 渲染汇总行：**一行 key=value**，段按实际发生顺序，末尾 `slow=` 给出最慢的两段。
 *
 * `total` 是最后一段（`ready`）的时刻——也就是用户看到「就绪」的那一秒。
 */
export function renderStartupSummary(): string | undefined {
  if (marks.length === 0) return undefined;
  const parts: string[] = [];
  const spans: Array<{ phase: string; ms: number }> = [];
  let previous = 0;
  for (const mark of marks) {
    const ms = mark.at - previous;
    previous = mark.at;
    if (spans.length === 0 && mark.phase === 'bun') {
      // 第一段（bun）的起点是进程启动，跨度天然是 `at - 0`。
      spans.push({ phase: mark.phase, ms: mark.at });
      parts.push(`${mark.phase}=${formatStartupMs(mark.at)}`);
      continue;
    }
    spans.push({ phase: mark.phase, ms });
    parts.push(`${mark.phase}=${formatStartupMs(ms)}`);
  }
  const total = marks[marks.length - 1]?.at ?? 0;
  const slow = [...spans]
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 2)
    .map((span) => span.phase);
  return (
    `[vessel] node.startup ready=${formatStartupMs(total)} ${parts.join(' ')}` +
    ` slow=${slow.join(',')}`
  );
}

/** 渲染明细行：段耗时之外的全部计数（debug 级别才打）。 */
export function renderStartupDetail(): string | undefined {
  if (notes.size === 0) return undefined;
  const parts: string[] = [];
  for (const [name, value] of notes) parts.push(`${name}=${formatStartupMs(value)}`);
  return `[vessel] node.startup.detail ${parts.join(' ')}`;
}

/**
 * 打印并**冻结**启动分期（之后 `markStartup` / `noteStartup` 变成空操作，运行期计数
 * 不该混进启动账本）。
 *
 * @param print 汇总行出口（stderr；stdout 留给命令结果）
 * @param debug 是否打明细行（`VESSEL_DEBUG` / `VESSEL_LOG_LEVEL=debug`）
 */
export function flushStartupTiming(options: {
  print: (line: string) => void;
  debug: boolean;
}): void {
  if (emitted) return;
  emitted = true;
  const summary = renderStartupSummary();
  if (summary !== undefined) options.print(summary);
  if (!options.debug) return;
  const detail = renderStartupDetail();
  if (detail !== undefined) options.print(detail);
}

/** 只读快照（测试 / 诊断用；不影响冻结语义） */
export function startupTimingSnapshot(): { marks: StartupMark[]; notes: Record<string, number> } {
  return { marks: [...marks], notes: Object.fromEntries(notes) };
}
