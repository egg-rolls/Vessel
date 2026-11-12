/**
 * @deprecated 渲染路径已改读物化的 item 流（`state/live-items.ts` 的 `LiveItemStore`）。
 *
 * 原来它做三件事：用单调 seq 切出追加段、只对脏 run 重跑 `buildGroup`、按
 * `truncatedSince` 做局部重建。这三件事的前提都是「渲染每 50ms 从 `entries` 重投影」，
 * 而那个前提已经被移除：事件到达时 `EventStore.push` 就把它折进 `LiveItemStore`，
 * 渲染读 `items.getSnapshot()`。保留 `buildGroup` 的重算路径只会变成**第二次投影**
 * （与 I1 冲突），所以这里退化成「`groupEvents` 的按引用 memo 包装」。
 *
 * **谁还在用**：只有 `scripts/check-transcript-items.ts` 的旧 fixture（F16 / F21 / F22）
 * 按「给一批 entries、要一组 RunGroup」的形状对拍。生产代码里**不许**再 import 它
 * （`check-live-items` 的 T1 tripwire 守这条）；那些 fixture 迁到 `check-live-items`
 * 之后这个文件应当整体删除。
 */
import type { ErrorVisibility } from './error-visibility';
import { groupEvents, type RunGroup, type StoredEvent } from './events';

function optionKey(showInternal: boolean, errorLevel: ErrorVisibility): string {
  return `${showInternal ? '1' : '0'}:${errorLevel}`;
}

export class EventGroupCache {
  private entries: readonly StoredEvent[] | null = null;
  private key = '';
  private result: RunGroup[] = [];

  /**
   * 返回按开始时间排序的 run 分组。
   *
   * 同一份 entries + 同一组可见性设置再次调用时直接返回缓存数组（引用稳定，旧 fixture
   * 依赖这一点）。`_truncatedRuns` 参数保留只为旧调用点签名兼容 —— 裁剪已经不影响
   * 渲染，没有任何局部重建要做。
   */
  group(
    entries: readonly StoredEvent[],
    showInternal: boolean,
    errorLevel: ErrorVisibility = 'user',
    _truncatedRuns: ReadonlySet<string> = new Set(),
  ): RunGroup[] {
    const key = optionKey(showInternal, errorLevel);
    if (this.entries === entries && this.key === key) return this.result;
    this.result = groupEvents(entries, showInternal, errorLevel);
    this.entries = entries;
    this.key = key;
    return this.result;
  }
}
