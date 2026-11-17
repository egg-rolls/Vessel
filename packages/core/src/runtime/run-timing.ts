/**
 * 单个 run 的分段耗时（0.57）。
 *
 * 由来（用户原话）：「agent 请求间隔有点长——是模型慢，还是我们中间那段慢？」。
 * 现有的 `llm.request` / `tool.call.*` 是**事实事件**（发生了什么），不是**耗时**
 * （花了多久），所以归因只能靠临时打点。这个模块补的就是那一层：一条 run 一行
 * `run.timing`，每一轮请求之间一行 `run.llm.gap`。
 *
 * 输出遵守宪法第十四条：**单行 key=value**、数值降噪（12082ms → 12.1s）、
 * 空字段省略（没发生的段打 `—` 而不是编一个 0）、不许把对象交给 console 打成多行。
 *
 * 归因口径（gap 那一行是重点）：
 *
 *     gap = 上一轮响应结束 → 本轮请求发出
 *         = tools_ms（工具真跑的时间）+ us（其余：hook / 组请求 / 前缀校验 / 权限）
 *
 * 于是「模型慢」看 `model=`，「我们中间慢」看 `us=`，不用猜。
 *
 * 开关：`VESSEL_RUN_TIMING=0` 关掉（默认开）。默认开是因为它是**账**不是噪声：
 * 一次 run 一条，一轮工具一条。
 *
 * @module @vessel-agent/core/runtime/run-timing
 */

/** 计时器的最小面（便于测试注入 clock） */
export interface RunTimingClock {
  now(): number;
}

/** 一轮请求的耗时账（由调用方填）。 */
export interface RoundTiming {
  /** 本 run 内的第几轮请求（1 起）。 */
  round: number;
  /** 本次请求（模型侧）从发出到响应结束的毫秒数。 */
  modelMs: number;
  /** 上一轮响应结束到本轮请求发出之间的毫秒数（第一轮没有这个值）。 */
  gapMs?: number;
  /** 上一轮的工具调用数（没有工具轮 = 0 / 省略）。 */
  toolCalls?: number;
  /** 上一轮工具总耗时（毫秒）；与 `toolCalls` 一起给出才能把 gap 拆开。 */
  toolsMs?: number;
  /** 本次请求的首 token（首个流式增量）耗时；没有流式增量 = 省略。 */
  firstTokenMs?: number;
}

/** run 级结束信息 */
export interface RunTimingFinish {
  outcome: 'completed' | 'failed' | 'cancelled';
  /** 总耗时（毫秒）；缺省用 now - startedAt。 */
  totalMs?: number;
}

export interface RunTiming {
  readonly runId: string;
  readonly startedAt: number;
  /** 记录一个阶段收口时刻（同一名字后写覆盖） */
  mark(phase: string): void;
  /** 记录一段耗时（同名累加，按毫秒渲染） */
  note(name: string, ms: number): void;
  /** 记录一个计数（同名累加，按整数渲染 —— 不要拿毫秒格式化器去渲染条数） */
  count(name: string, value: number): void;
  /** 记录一个文本读数（如 `history=tail` / `compact=yes`） */
  text(name: string, value: string | number | boolean): void;
  /** 一轮请求收口：打印 `run.llm.gap`（第一轮也打，gap 省略） */
  round(timing: RoundTiming): void;
  /** run 收口：打印 `run.timing` */
  finish(result: RunTimingFinish): void;
  /** 只读快照（测试 / 诊断） */
  snapshot(): {
    marks: Record<string, number>;
    notes: Record<string, number>;
    counts: Record<string, number>;
    texts: Record<string, string>;
  };
}

/** 数值降噪（第十四条）：<1s 用毫秒，≥1s 一位小数秒。 */
export function formatTimingMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** run id 只留前 8 位（第十四条：长字段截断）。 */
function shortId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

/** 默认出口：stderr（stdout 留给命令结果 / JSON）。 */
function defaultPrint(line: string): void {
  console.error(line);
}

/** `VESSEL_RUN_TIMING=0` 关闭；其它任何值（含未设）都开。 */
function defaultEnabled(): boolean {
  const raw = (process.env.VESSEL_RUN_TIMING ?? '').trim();
  return raw !== '0' && raw.toLowerCase() !== 'false' && raw.toLowerCase() !== 'off';
}

export interface RunTimingOptions {
  /** 打印出口；缺省 console.error */
  print?: (line: string) => void;
  /** 是否启用；缺省读 `VESSEL_RUN_TIMING` */
  enabled?: boolean;
  /** 时钟；缺省 Date.now */
  clock?: RunTimingClock;
}

/**
 * 建一个 run 的计时账本。
 *
 * 起点取「调用这一刻」：`ExecutionUnit` 在 run 真正开始执行时建它，所以
 * `run.timing` 的 `total` 是 run 自身的耗时，**不含**排队 / 准入（那段时间在
 * `admit=` 里单独给）。
 */
export function createRunTiming(runId: string, options: RunTimingOptions = {}): RunTiming {
  const clock = options.clock ?? { now: () => Date.now() };
  const print = options.print ?? defaultPrint;
  const enabled = options.enabled ?? defaultEnabled();
  const startedAt = clock.now();
  const marks = new Map<string, number>();
  const notes = new Map<string, number>();
  const counters = new Map<string, number>();
  const texts = new Map<string, string>();
  let finished = false;

  return {
    runId,
    startedAt,
    mark(phase: string): void {
      if (!enabled || finished) return;
      // **保留第一次**：`first_token` / `llm` / `compact` 这类段在多轮 run 里会被多次
      // 触摸，账上要的是「第一次发生在什么时候」（第二轮的 token 不是「首 token」）。
      if (marks.has(phase)) return;
      marks.set(phase, clock.now() - startedAt);
    },
    note(name: string, ms: number): void {
      if (!enabled || finished || !Number.isFinite(ms)) return;
      notes.set(name, (notes.get(name) ?? 0) + ms);
    },
    count(name: string, value: number): void {
      if (!enabled || finished || !Number.isFinite(value)) return;
      counters.set(name, (counters.get(name) ?? 0) + value);
    },
    text(name: string, value: string | number | boolean): void {
      if (!enabled || finished) return;
      texts.set(name, String(value));
    },
    round(timing: RoundTiming): void {
      if (!enabled || finished) return;
      // 字段序固定（宪法第十四条：按事件定义，不按对象字面量顺序）。
      const parts = [`round=${timing.round}`, `model=${formatTimingMs(timing.modelMs)}`];
      if (timing.gapMs !== undefined) parts.push(`gap=${formatTimingMs(timing.gapMs)}`);
      if (timing.toolCalls !== undefined) parts.push(`tools=${timing.toolCalls}`);
      if (timing.toolsMs !== undefined) parts.push(`tools_ms=${formatTimingMs(timing.toolsMs)}`);
      if (timing.gapMs !== undefined) {
        // `us` = 我们自己那一段（组请求 / hook / 前缀校验 / 权限），把工具时间扣掉。
        const ours = Math.max(0, timing.gapMs - (timing.toolsMs ?? 0));
        parts.push(`us=${formatTimingMs(ours)}`);
      }
      if (timing.firstTokenMs !== undefined) {
        parts.push(`first_token=${formatTimingMs(timing.firstTokenMs)}`);
      }
      print(`[vessel] run.llm.gap run=${shortId(runId)} ${parts.join(' ')}`);
    },
    finish(result: RunTimingFinish): void {
      if (!enabled || finished) return;
      finished = true;
      const totalMs = result.totalMs ?? clock.now() - startedAt;
      const parts: string[] = [`run=${shortId(runId)}`];
      // 阶段按发生顺序；没发生的段不出现（不打 0，不编字段）。
      const order = [
        'admit',
        'spawn',
        'history',
        'compact',
        'llm',
        'first_token',
        'tools',
        'total',
      ];
      for (const phase of order) {
        if (phase === 'total') continue;
        const at = marks.get(phase);
        if (at !== undefined) {
          parts.push(`${phase}=${formatTimingMs(at)}`);
          continue;
        }
        // `admit` / `spawn` 是**上游**才知道的两段（准入排队、成员身体派生）。没测到不等于
        // 没发生——打 `—` 明确表达「这一段这次没有」，而不是让读者以为被吞了。
        if (phase === 'admit' || phase === 'spawn') parts.push(`${phase}=—`);
      }
      for (const [name, ms] of notes) parts.push(`${name}=${formatTimingMs(ms)}`);
      for (const [name, value] of counters) parts.push(`${name}=${Math.round(value)}`);
      for (const [name, value] of texts) parts.push(`${name}=${value}`);
      parts.push(`outcome=${result.outcome}`, `total=${formatTimingMs(totalMs)}`);
      print(`[vessel] run.timing ${parts.join(' ')}`);
    },
    snapshot() {
      return {
        marks: Object.fromEntries(marks),
        notes: Object.fromEntries(notes),
        counts: Object.fromEntries(counters),
        texts: Object.fromEntries(texts),
      };
    },
  };
}
