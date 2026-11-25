/**
 * 时长（毫秒）→ 中文人话（协作实验 exp-a）。
 * @module
 *
 * 规则：
 * - < 1 分钟：`X秒`
 * - < 1 小时：`X分Y秒`
 * - ≥ 1 小时：`X小时Y分`
 *
 * 秒/分一律向下取整（宁可少报一秒，不多报）；非法输入（NaN/Infinity/负数）按 0 处理。
 * 纯函数，无副作用，UI 层直接 import。
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/** 把毫秒时长格式化成中文「X秒」/「X分Y秒」/「X小时Y分」。 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (total >= HOUR_MS) {
    const hours = Math.floor(total / HOUR_MS);
    const minutes = Math.floor((total % HOUR_MS) / MINUTE_MS);
    return `${hours}小时${minutes}分`;
  }
  if (total >= MINUTE_MS) {
    const minutes = Math.floor(total / MINUTE_MS);
    const seconds = Math.floor((total % MINUTE_MS) / SECOND_MS);
    return `${minutes}分${seconds}秒`;
  }
  return `${Math.floor(total / SECOND_MS)}秒`;
}
