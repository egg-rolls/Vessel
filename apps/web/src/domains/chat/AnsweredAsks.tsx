/**
 * 会话里的「已答」记录：sync 提问答完之后的那张可读答复卡。
 *
 * 现状（为什么必须有这一块）：sync 是工具默认模式，答完**不产生** `ask:answer` 消息，
 * 时间线上只剩一条 ask 工具结果行；服务端 interactions-<tenant>.json 里其实留了完整
 * answered 记录，但 Web 只拉 pending / orphaned，这份记录永远读不回来
 * （docs/dev/reports/0.51/ask-interaction-design.md 1.1-S1 / 1.2-S4）。于是「我问了什么、
 * 我答了什么」在刷新之后既没有卡也没有身份。
 *
 * 数据来源：`interactions.list{status:'answered', session_id}` —— **落盘的真相**，
 * 所以刷新 / 重连 / 换端都能重建，不靠任何前端内存状态（本组件自身状态只有「读回来的
 * 这份列表」与「展开与否」）。
 *
 * 三条取数口径：
 * - 只认本会话（`session_id` 等值过滤交给服务端，前端不再二次猜归属）；
 * - 取数前 250ms 去抖：本端提交成功后 answer 记录的 settle 与 RPC 返回可能有毫秒级先后，
 *   立刻读会读到还没落定的那条；
 * - 失败静默（旧 gateway 没有带 session 过滤的能力 / 断线）：这一块只是「补一张卡」，
 *   不能因为它报错就挡住会话页。
 *
 * 位置：会话滚动区里、时间线之后（由 `TranscriptWindow` 的 `afterItems` 插槽渲染），
 * 不用常驻块占掉输入区上方的空间；默认只画最近几条，更早的收在「展开」里。
 */
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import type { GatewayClient } from '../../gateway/client';
import { t } from '../../i18n';
import {
  ANSWERED_ASKS_VISIBLE,
  type AnsweredAsk,
  answeredAsks,
  recentAnsweredAsks,
} from './ask-answered';
import { AskAnswerCard } from './AskAnswerCard';

/** 一次读回多少条已答记录：默认视图只看最近几条，留一屏余量给「展开」。 */
const FETCH_LIMIT = 50;
/** 去抖：见头注释（settle 与 RPC 返回的毫秒级先后）。 */
const FETCH_DEBOUNCE_MS = 250;

/** 读回来的那份列表 + 它属于哪个会话（切会话时不能拿上一个会话的卡顶一帧）。 */
interface AnsweredState {
  sessionId: string;
  cards: readonly AnsweredAsk[];
}

export function AnsweredAsks({
  sessionId,
  client,
  epoch,
  connected,
  refreshKey,
  defaultOpen = false,
}: {
  /** 当前会话；草稿态（`new`）没有可读记录。 */
  sessionId: string | null;
  client: GatewayClient;
  /** 重连 / 重订阅次数：变了就重新读盘。 */
  epoch: number;
  connected: boolean;
  /** 额外刷新信号（新答复落定、run 数变化）：只当「再读一次」的触发器。 */
  refreshKey: number;
  /** 卡片默认展开（ui.expandCards || verbosity === 'debug'）。 */
  defaultOpen?: boolean;
}) {
  const [state, setState] = useState<AnsweredState | null>(null);
  const [expanded, setExpanded] = useState(false);

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
          if (!cancelled) setState({ sessionId, cards: [] });
        });
    }, FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, connected, sessionId, epoch, refreshKey]);

  const cards = state !== null && state.sessionId === sessionId ? state.cards : [];
  if (cards.length === 0) return null;

  const { shown, hidden } = expanded ? { shown: cards, hidden: 0 } : recentAnsweredAsks(cards);

  return (
    <section className="flex flex-col gap-2" aria-label={t('chat.askAnswered.aria')}>
      <div className="flex flex-wrap items-baseline gap-2 font-mono text-2xs tracking-wider text-faint uppercase">
        <span>{t('chat.askAnswered.label', { count: cards.length })}</span>
        {hidden > 0 && (
          <Button variant="link" size="small" onClick={() => setExpanded(true)}>
            {t('chat.askAnswered.more', { count: hidden })}
          </Button>
        )}
        {expanded && cards.length > ANSWERED_ASKS_VISIBLE && (
          <Button variant="link" size="small" onClick={() => setExpanded(false)}>
            {t('chat.askAnswered.less')}
          </Button>
        )}
      </div>
      {shown.map((item) => (
        <AskAnswerCard
          key={item.requestId}
          card={item.card}
          ts={item.answeredAt}
          defaultOpen={defaultOpen}
          titleLabel={t('chat.askAnswered.title')}
          sourceLabel={t('chat.askAnswered.source')}
          ariaLabel={t('chat.askAnswered.aria')}
        />
      ))}
    </section>
  );
}
