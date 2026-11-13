/**
 * 0.52：body「上下文占用」的实时读数源 —— rotate 确认文案与界面必须是同一个数。
 *
 * 为什么要单独一层：同一次 rotate 里出现了两个说法，界面报 51%，提示说
 * 「Context usage is unknown」。原因是提示读 `execution.lastContextRatio`，而这个值
 * 只在 run **结束**时由 `execution-unit` 写入；工具恰恰在 run 进行中被调用，所以它要么
 * 是上一轮的旧值，要么（本轮就是首次 run 时）压根没有。
 *
 * 这里的口径固定成界面那一份，**不另算**：
 *   分子 = 该会话最近一条 `context.changed.token_count`，也就是
 *          `ContextManager.tokenCount`（`packages/core/src/context/context-manager.ts`）
 *          的原值 —— 有真实用量锚点时它已按锚点校正过；TUI 状态栏和 web 实时百分比
 *          读的是同一个字段。
 *   分母 = 该会话最近一次真值（`context.pressure.max` / `prompt.system_context.context_max`，
 *          两者都来自 `workingContext.maxTokens`）；真值还没到过时用装配层给的窗口上限，
 *          最后才是 `ContextManager.maxTokens` 的同一个兜底。
 *
 * 本模块**不做任何 token 估算**：只搬运界面已经收到的两个数，所以两边不可能算出两个值。
 */

/**
 * `ContextManager.maxTokens` 的兜底（`config.maxTokens ?? 1_000_000`）。界面侧同一个数，
 * 改这里等于改界面口径 —— 只有连窗口上限都没传下来时才会用到它。
 */
const DEFAULT_CONTEXT_MAX_TOKENS = 1_000_000;

/** 长驻进程里只留最近这么多会话的读数；老会话再发事件时会重新记上。 */
const MAX_SESSIONS = 256;

export interface ContextRatioSource {
  /** 收一条父流事件；只认 `context.changed` / `context.pressure` / `prompt.system_context`。 */
  observe(event: { type?: string; data?: unknown }): void;
  /** 0–1 水位。undefined 只剩一种情况：本进程没见过该会话的任何上下文事件。 */
  ratio(sessionId: string): number | undefined;
  /** 界面同一个整数百分比（`Math.round(ratio * 100)`，与 TUI 状态栏 / core 预警同口径）。 */
  percent(sessionId: string): number | undefined;
}

interface Reading {
  used: number;
  max?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function field(data: unknown, key: string): unknown {
  if (typeof data !== 'object' || data === null) return undefined;
  return (data as Record<string, unknown>)[key];
}

export function createContextRatioSource(
  options: { fallbackMaxTokens?: number } = {},
): ContextRatioSource {
  const fallbackMax = finiteNumber(options.fallbackMaxTokens) ?? DEFAULT_CONTEXT_MAX_TOKENS;
  const readings = new Map<string, Reading>();

  /**
   * 记一条读数：分子（`used`）必须先有过一次才建条目 —— 没有 token 数就没有水位可谈；
   * 分母（`max`）按最近一次真值覆盖。重新 `set` 一次是把 Map 的插入顺序当「最近使用」
   * 用，淘汰时先丢最老的。
   */
  const remember = (
    sessionId: string | undefined,
    used: number | undefined,
    max: number | undefined,
  ): void => {
    if (sessionId === undefined) return;
    const previous = readings.get(sessionId);
    const nextUsed = used ?? previous?.used;
    const nextMax = max ?? previous?.max;
    if (nextUsed === undefined) return;
    readings.delete(sessionId);
    readings.set(
      sessionId,
      nextMax === undefined ? { used: nextUsed } : { used: nextUsed, max: nextMax },
    );
    if (readings.size > MAX_SESSIONS) {
      const oldest = readings.keys().next();
      if (!oldest.done) readings.delete(oldest.value);
    }
  };

  /**
   * 0–1 水位。undefined 只剩一种触发条件：本进程没见过该会话的任何上下文事件
   * （= 没有 token 数），不是「没窗口上限」。
   */
  const ratioOf = (sessionId: string): number | undefined => {
    const reading = readings.get(sessionId);
    if (reading === undefined || !Number.isFinite(reading.used)) return undefined;
    const max = reading.max ?? fallbackMax;
    // 只有「连窗口上限都不知道」才算不出来。有上限就必须给数：界面此刻画得出百分比，
    // 提示就必须报同一个百分比 —— 「unknown」正是这一单要消灭的东西。
    if (!Number.isFinite(max) || max <= 0) return undefined;
    return reading.used / max;
  };

  return {
    observe(event: { type?: string; data?: unknown }): void {
      const data = event.data;
      const rawSessionId = field(data, 'session_id');
      const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined;
      switch (event.type) {
        case 'context.changed': {
          // 界面那个数：每条消息进上下文都会发，所以它永远比「run 末才写」的旧值新。
          remember(sessionId, finiteNumber(field(data, 'token_count')), undefined);
          return;
        }
        case 'context.pressure': {
          // 成对真值（used / max 都直接取自 workingContext），最可信，直接覆盖。
          remember(sessionId, finiteNumber(field(data, 'used')), finiteNumber(field(data, 'max')));
          return;
        }
        case 'prompt.system_context': {
          // 只取窗口上限：`estimated_tokens` 会因去重钉在首次请求的值上，比 token_count 陈旧。
          remember(sessionId, undefined, finiteNumber(field(data, 'context_max')));
          return;
        }
        default:
          return;
      }
    },

    ratio: ratioOf,

    percent(sessionId: string): number | undefined {
      const ratio = ratioOf(sessionId);
      // 与界面同一个取整：TUI 状态栏 / 会话列表 / core 的 context.pressure 全是 Math.round。
      // 用 floor 会出现「界面 90%、提示 89%」，比不给数更糟。
      return ratio === undefined ? undefined : Math.round(ratio * 100);
    },
  };
}

export interface ContextRatioPort {
  contextRatio?(sessionId: string): number | undefined;
}

/**
 * 把实时读数接到宿主端口的 `contextRatio` 上（其余成员原样委托给宿主）。
 *
 * 为什么用 `Object.create` 而不是 `{ ...host, contextRatio }`：宿主的方法全部靠 `this`
 * 读自己的内部状态（entries / 每具 body 的 runtime / 配置），展开复制会把 `this` 指向
 * 一个没有这些状态的空壳，第一次调用就炸。原型链共享同一个宿主实例，`this` 解析不变，
 * 只覆盖 `contextRatio` 一个键。
 *
 * 兜底链：实时读数 → 宿主原来的值（run 末写的旧值）。旧值在「事件没经过这条流」时还有用
 * （比如外部进程喂进来的会话），它至少比 unknown 更接近真相。
 */
export function withLiveContextRatio<P extends ContextRatioPort>(
  host: P,
  source: ContextRatioSource,
): P {
  const wrapper = Object.create(host) as P;
  Object.defineProperty(wrapper, 'contextRatio', {
    value: (sessionId: string): number | undefined =>
      source.ratio(sessionId) ?? host.contextRatio?.(sessionId),
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return wrapper;
}
