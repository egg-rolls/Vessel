/**
 * 重连退避（S1d）：0.5s 起、指数翻倍、8s 封顶，±20% 抖动。
 *
 * 取值理由：服务端就绪判定粒度 100ms，平台层重启的不可用窗口约 0.6s，node 重启
 * 1–2.5s。首档 0.5s 让 0.6s 的平台层窗口最多多等一档；8s 封顶保证长断线期间不刷屏，
 * 又不会让长时间停机后的恢复等待过久。
 *
 * 为什么单独一个文件：退避是纯算术，探针要直接 import 生产实现做确定性断言；留在
 * `reconnect.ts` 里会被 `../i18n`（→ react）牵连，探针就被迫摸 React 运行时。
 * 本文件**不引入任何依赖**，也不要往里加。
 */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 8_000;
/** 抖动区间（乘性）：最终延迟落 [0.8×base, 1.2×base]，之后仍被 8s 封顶。 */
export const RECONNECT_JITTER_MIN = 0.8;
export const RECONNECT_JITTER_MAX = 1.2;

/** 第 n 档的标称延迟（不含抖动），已封顶。 */
export function reconnectBaseDelay(attempt: number): number {
  const finite = Number.isFinite(attempt) ? attempt : 0;
  const step = Math.min(16, Math.max(0, Math.floor(finite)));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** step);
}

/**
 * 第 n 档的实际延迟（含抖动、含封顶）。
 * random 可注入，探针用它做确定性断言；生产用 Math.random。
 */
export function nextReconnectDelay(attempt: number, random: () => number = Math.random): number {
  const raw = random();
  const unit = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
  const jitter = RECONNECT_JITTER_MIN + unit * (RECONNECT_JITTER_MAX - RECONNECT_JITTER_MIN);
  return Math.min(RECONNECT_MAX_MS, Math.round(reconnectBaseDelay(attempt) * jitter));
}
