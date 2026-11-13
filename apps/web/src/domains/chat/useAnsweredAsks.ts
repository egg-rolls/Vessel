/**
 * 「已答提问」的取数（会话页）：读服务端 answered 记录，交给时间线按 answered_at 落位。
 *
 * 为什么需要：sync（工具默认模式）答完之后**不产生** ask:answer 消息，时间线上只剩一条
 * ask 工具结果行；服务端 interactions-<tenant>.json 里其实留了完整 answered 记录，但 Web
 * 只拉 pending / orphaned，这份记录永远读不回来
 * （docs/dev/reports/0.51/ask-interaction-design.md 1.1-S1 / 1.2-S4）。于是「我问了什么、
 * 我答了什么」在刷新之后既没有卡也没有身份。
 *
 * 数据来源：interactions.list{status:'answered', session_id} —— **落盘的真相**，所以刷新 /
 * 重连 / 换端都能重建，不靠任何前端内存状态（本 hook 自身状态只有「读回来的这份列表」）。
 *
 * 三条取数口径：
 * - 只认本会话（session_id 等值过滤交给服务端，前端在 answeredAsks 里再断一次）；
 * - 取数前 250ms 去抖：本端提交成功后 answer 记录的 settle 与 RPC 返回可能有毫秒级先后，
 *   立刻读会读到还没落定的那条；
 * - 失败静默（旧 gateway 没有带 session 过滤的能力 / 断线）：这块只是「补几张卡」，不能
 *   因为它报错就挡住会话页。
 *
 * 位置（0.51 用户裁决）：拿到的记录不再是会话滚动区末尾的额外一段，而是作为
 * TranscriptBuildInput.answeredAsks 进时间线（item kind ask-answered）。所以这里不折叠、
 * 不截断「只显示最近几条」—— 那是底部区块的产物。
 */
import { useEffect, useState } from 'react';
import type { GatewayClient } from '../../gateway/client';
import { type AnsweredAsk, answeredAsks } from './ask-answered';

/** 一次读回多少条已答记录：时间线本身会滚动，这里只防「超长会话一次读回几万条」。 */
const FETCH_LIMIT = 50;
/** 去抖：见头注释（settle 与 RPC 返回的毫秒级先后）。 */
const FETCH_DEBOUNCE_MS = 250;

/** 空结果：同一个引用（每次渲染新建数组会让下游 memo 每帧失效）。 */
const EMPTY: readonly AnsweredAsk[] = [];

/** 读回来的那份列表 + 它属于哪个会话（切会话时不能拿上一个会话的卡顶一帧）。 */
interface AnsweredState {
  sessionId: string;
  cards: readonly AnsweredAsk[];
}

/**
 * 本会话的已答记录（按 answeredAt 升序）。
 *
 * 返回引用只在真正读回新数据时变化：TranscriptWindow 的 items useMemo 依赖它，
 * 每帧给一个新空数组等于每帧重建整条时间线。
 */
export function useAnsweredAsks({
  sessionId,
  client,
  epoch,
  connected,
  refreshKey,
}: {
  /** 当前会话；草稿态（new）/ 子 agent 详情态没有可读记录。 */
  sessionId: string | null;
  client: GatewayClient;
  /** 重连 / 重订阅次数：变了就重新读盘。 */
  epoch: number;
  connected: boolean;
  /** 额外刷新信号（新答复落定、run 数变化）：只当「再读一次」的触发器。 */
  refreshKey: number;
}): readonly AnsweredAsk[] {
  const [state, setState] = useState<AnsweredState | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch / refreshKey 是**有意的触发器**（重连、新答复落定各读一次盘），不是读盘本身的输入 —— 与 tool-catalog / useChatTranscript 同一写法。
  useEffect(() => {
    if (!connected || sessionId === null || sessionId === '') return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      client
        .listInteractions({ session_id: sessionId, status: 'answered', limit: FETCH_LIMIT })
        .then((items) => {
          if (!cancelled) setState({ sessionId, cards: answeredAsks(items, sessionId) });
        })
        .catch(() => {
          // 旧 gateway / 断线：当成「没有记录」，不弹错、不挡住会话页。
          if (!cancelled) setState({ sessionId, cards: EMPTY });
        });
    }, FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, connected, sessionId, epoch, refreshKey]);

  if (state === null || state.sessionId !== sessionId) return EMPTY;
  return state.cards;
}
