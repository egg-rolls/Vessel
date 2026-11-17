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
 *
 * ## seq 当时间序用的地方（0.55 逐处核过一遍）
 *
 * 背景事实：`seq` 由 `TimelineWriter` 在写 WAL 那一刻分配（`enqueue()` 串行队列，
 * ADR-105 §3 I1），所以它的**语义是到达序**，不是事件自报的 `ts`。两者在真机上同序
 * （会话 `09f82ac6`：105,667 条记录按 seq 逐对比 ts，倒退 0 次、相等 71,280 次），
 * 但「同序」不是被断言的 —— 派发链有一次 `await`（`src/timeline-dual-write.ts#record`
 * 先等 `writerFor()` 再 `append`）。下面是全部依赖点与逐处判断：
 *
 * | # | 位置 | 用途 | 判断 |
 * | --- | --- | --- | --- |
 * | 1 | `state/events.ts#orderEntriesByEventTime` | fold 前按 ts 重排 | **已退化**：默认原样（到达序 = seq 序），ts 真的倒退时喊话并退回旧行为 |
 * | 2 | `state/live-items.ts#byAnchor` + 合并后的 sort | live item 的合并顺序 = anchor seq 升序 | 保留。流式期 ts 大量相等（67% 的相邻对），seq 是唯一全序；它表达的是「到达序」 |
 * | 3 | `state/live-items.ts#ingest` 的 `ingestedSeq` 水位 | seq ≤ 水位 ⇒ 丢弃（I5 去重） | 保留。用途是去重而不是排序；隐含前提「seq 单调 = 到达单调」写在这里，靠 1 的喊话看住 |
 * | 4 | 本文件 `compareTimelineEntries` | 展示顺序 | 已经是 ts 主序、seq 只做同 ts 的回退，不需要改 |
 * | 5 | `transcript-items.ts` 的组内 `itemTs` 单调钳制 | 补偿「推入序 ≠ 时间序」 | 保留（幂等、代价 0）。前提被 1 看住；1 恒等时它是空操作 |
 * | 6 | `state/event-store.ts#truncateAfter` 的二分 | 按 seq 定位区间边界 | 保留。这是**区间**语义，与时间无关 |
 * | 7 | `state/events.ts#buildGroup` 的 `group.firstSeq` | 组起始 seq（无锚点 item 的序号） | 注意：它是「按 ts 规整后第一条」的 seq，不是最小 seq。1 恒等时两者相同；断言响了就会不同 —— 别把它当最小值用 |
 * | 8 | `packages/core/src/session/project-messages.ts#projectMessages` | 事件 → messages 的顺序 | 保留。这是**语义**（到达序就是发生序）；它和 3、6 是同一个前提的不同侧面 |
 * | 9 | 服务端区间读（`sessions.events` 的 `since_seq`、时间线分页） | 区间边界 | 保留，与时间序无关 |
 *
 * 结论：真正把 seq 当「时间」用的只有 1 和 2（一个已经退化成断言，一个是唯一全序下的
 * 最优近似）；其余都是身份 / 区间 / 去重。所以不需要把任何一处改成按事件时间排序 ——
 * 需要的是**前提破了能被看见**，那件事由 1 的 `console.warn` 承担。
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
