/**
 * 块名枚举的进程内计数（0.56 尾部读的**固定定位开销**那一单的自证面）。
 *
 * 与 `read-port.ts#timelineRangeReadCounters` 同一个用途，只是把「枚举走了哪条路」
 * 单独拎出来 —— 那一单的判据就是「同一页的 `readdir` 调用次数从 1 降到 0」，
 * 没有计数就只能靠耗时推断（而耗时在任何机器上都有一堆别的变量）。
 *
 * 为什么不放进 `wal.ts` / `blocks.ts`：两个模块互相 import（`wal ↔ blocks`），
 * 计数对象放哪一边都会让另一边在模块求值期读到未初始化的绑定。单独一个模块最干净，
 * 谁都能在**调用期**拿它。
 *
 * 全部字段都**不落盘、不进 wire**（`sessions.events` 的返回里没有它们）。
 *
 * @module @vessel-agent/core/timeline
 */

/** 进程内的块名枚举计数（读快照用 {@link timelineBlockEnumerationCounters}）。 */
export const blockEnumerationCounters = {
  /** 走了 manifest 快路径的页数（不枚举全量块名） */
  manifest: 0,
  /** 回退到 `listBlockFiles`（readdir）兜底的页数 */
  readdirFallback: 0,
  /** 累计 `readdir(wal.blocks)` 调用次数 —— **这一单的核心指标** */
  readdirCalls: 0,
  /** 累计 `stat` 探测的块号数（manifest 尾部核对，不算 readdir） */
  tailProbes: 0,
  /** 「manifest 读完」被尾部核对推翻、改由按块号 stat 接上的次数 */
  tailExtended: 0,
};

/** 读一份块名枚举计数快照。 */
export function timelineBlockEnumerationCounters(): Readonly<typeof blockEnumerationCounters> {
  return { ...blockEnumerationCounters };
}
