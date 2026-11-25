/**
 * 会话索引竖条的视口追踪 + 点击跳转（会话页 / 团队页 / 成员 body 页共用）。
 *
 * 锚点契约：时间线里只有 **user 消息**（人打的字）的 DOM 带 `data-index-entry-key`
 * （会话页 = item.key，见 Transcript.tsx；团队页 = message_id，见 TeamTranscript.tsx；
 * body 页 = 局部序号 key，见 BodyTranscripts.tsx；过滤判据见 conversation-index.ts）。
 * 索引条目与锚点用同一个字符串，这里只认这个属性，不关心消息身份怎么来 ——
 * 锚点已收窄到 user 消息，30% 线判据天然只落在 user 消息上，逻辑无需感知过滤。
 *
 * 当前项判据：视口顶部往下 30% 处画一条线，最后一条「顶边在线上方」的锚点就是
 * 正在读的那条（阅读位置靠近屏顶，与目录高亮同一口径）。滚到第一条上方时高亮第一条。
 *
 * 只读滚动容器自己的几何（getBoundingClientRect 相对容器顶边），不依赖
 * offsetTop —— 锚点的 offsetParent 不一定是滚动容器（.content-stage 才是
 * position:relative），拿 offsetTop 比 scrollTop 会整体错位。
 *
 * 跳转只滚容器自己（scrollTo smooth），不用 scrollIntoView：后者会连带滚动
 * 祖先容器。向上跳离底部时 useStickyBottom 的 onScroll 自然解除 pinned，
 * 流式跟随不会把人拽回去（程序化 scroll echo 的判定见 sticky-bottom.ts）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** 「当前项」判定线：视口顶部往下 30%。 */
const ACTIVE_LINE_RATIO = 0.3;
/** 跳转落点在目标上方留一点余量，不贴着滚动区顶边。 */
const JUMP_OFFSET_PX = 12;

export function useConversationIndex({
  getElement,
  entryKeys,
  resetKey,
}: {
  /** 滚动容器（与 useStickyBottom 同一个元素）。 */
  getElement: () => HTMLDivElement | null;
  /** 索引条目的 key 列表（顺序 = 时间线顺序）；只用来感知「列表变了」。 */
  entryKeys: readonly string[];
  /** 换会话 / 换团队 / detail 到达的 reset key：变了重新订阅并立即重算。 */
  resetKey: string | null;
}): { activeKey: string | null; jumpTo: (key: string) => void } {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** 最近一次订阅的重算函数：条目列表变化时（DOM 已同帧落地）直接调它。 */
  const computeRef = useRef<() => void>(() => {});

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey 是换会话 / detail 到达时重新订阅的显式触发器
  useEffect(() => {
    const element = getElement();
    if (!element) {
      computeRef.current = () => {};
      setActiveKey(null);
      return;
    }
    const compute = () => {
      const anchors = element.querySelectorAll<HTMLElement>('[data-index-entry-key]');
      if (anchors.length === 0) {
        setActiveKey(null);
        return;
      }
      const line = element.getBoundingClientRect().top + element.clientHeight * ACTIVE_LINE_RATIO;
      let current: string | null = null;
      for (const anchor of anchors) {
        if (anchor.getBoundingClientRect().top > line) break;
        current = anchor.dataset.indexEntryKey ?? null;
      }
      setActiveKey(current ?? anchors[0]?.dataset.indexEntryKey ?? null);
    };
    computeRef.current = compute;

    // scroll / 尺寸 / 内容变化都走同一个 rAF 节流入口：一帧最多重算一次。
    let frame: number | undefined;
    const schedule = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        compute();
      });
    };
    element.addEventListener('scroll', schedule, { passive: true });
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    resizeObserver?.observe(element);
    // 卡片展开 / 流式长高不产生 scroll 事件：内容 DOM 变化也要重算。
    const mutationObserver =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null;
    mutationObserver?.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    compute();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      element.removeEventListener('scroll', schedule);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      computeRef.current = () => {};
    };
  }, [getElement, resetKey]);

  // 条目列表变化（追加 / 回填 / 切会话）：重算一次。effect 在 DOM 提交后跑，
  // 锚点已是新列表。签名取「条数 + 末项身份」，与 followKey 同一口径。
  const signature = `${entryKeys.length}:${entryKeys[entryKeys.length - 1] ?? ''}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: signature 是条目列表变化的显式触发器
  useEffect(() => {
    computeRef.current();
  }, [signature]);

  const jumpTo = useCallback(
    (key: string) => {
      const element = getElement();
      if (!element) return;
      const anchor = element.querySelector<HTMLElement>(
        `[data-index-entry-key="${CSS.escape(key)}"]`,
      );
      if (!anchor) return;
      const top =
        anchor.getBoundingClientRect().top -
        element.getBoundingClientRect().top +
        element.scrollTop -
        JUMP_OFFSET_PX;
      element.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    },
    [getElement],
  );

  return { activeKey, jumpTo };
}
