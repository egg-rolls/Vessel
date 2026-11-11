/**
 * 时间线的排序口径（纯函数：无 React、无 DOM、无 window）。
 *
 * 单一 item 流（domains/chat/transcript-items.ts）是唯一调用方：它把事件流与
 * sessions.get 投影成 item、算好每条的 ts/seq，再交这里做稳定排序。
 *
 * 不变量（见 docs/WEB-UI.md 的「时间线渲染顺序」一节）：
 * 1. ts 主序，缺 ts 的排最后。
 * 2. 同 ts 用 seq 回退（wire seq），再退回插入序（稳定排序）。
 *
 * 这里是唯一实现：其它模块只负责把数据翻译成 (ts, seq) 并给一个稳定的插入序。
 */

/**
 * 稳定排序：ts 主序（缺 ts 排最后），同 ts 先比 seq，再退回插入序。
 */
export function compareTimelineEntries(
  a: { ts?: number | undefined; seq?: number | undefined },
  b: { ts?: number | undefined; seq?: number | undefined },
  aIndex: number,
  bIndex: number,
): number {
  const at = a.ts;
  const bt = b.ts;
  if (at !== undefined && bt !== undefined && at !== bt) return at - bt;
  if (at === undefined && bt !== undefined) return 1;
  if (at !== undefined && bt === undefined) return -1;
  const aseq = a.seq;
  const bseq = b.seq;
  if (aseq !== undefined && bseq !== undefined && aseq !== bseq) return aseq - bseq;
  return aIndex - bIndex;
}
