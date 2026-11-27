/**
 * agent 级收件箱的一行（P1-B，q-inbox-agent-view）。
 *
 * 表面口径与看板卡同款（共享默认表面：raised 被动卡，`KanbanCard.tsx` 先例）；
 * 身份 / 状态 / 归属 / 动作全部来自 `agents.inbox{agent_id}` 那一次读 —— 本组件
 * 不发任何 RPC，写操作与 peek 都由视图（InboxView）落地。
 *
 * **归属标注是防串台的关键**（审计 §5 P1-B 风险项）：agent 级视图天然含所有会话
 * 的条目，有 `session_id` 的给「去会话」链接（短 id + title 全量），缺省的标
 * 「无归属（wake/quiet）」—— 不误导「都是给我的」，也不隐藏（用户裁定：agent 级
 * 全量可见，会话级过滤是条带的事，不是收件箱的事）。
 *
 * 写操作按来源分档（与条带 / 服务端 `agents.recall` 同一判据）：
 * - human 源：「取消」（recall 真删）+「我已处理」（claim，不可逆）；
 * - 非 human 源且 held：「留档（取消 hold）」（recall → unhold，条目退回 unread）；
 * - 不给「收回编辑」：本页没有草稿槽（设计审计 §1）。
 */

import { Badge, Button } from '../../components/ui';
import { formatTimestamp } from '../../format';
import type { GatewayClient } from '../../gateway/client';
import type { AgentInboxEntry } from '../../gateway/types';
import { t } from '../../i18n';
import { canUnhold, HUMAN_SOURCE, shortSenderId } from '../chat/pending-strip';
import { AsyncJobCard } from './AsyncJobCard';

export function InboxRow({
  entry,
  identity,
  busy,
  expanded,
  entering = false,
  text,
  peeking,
  peekError,
  onToggleExpand,
  onCancel,
  onClaim,
  onUnhold,
  onOpenSession,
  client,
}: {
  entry: AgentInboxEntry;
  /** 网关客户端（bash 作业卡的 log tail 按需读 jobs.log）；缺省 = 不渲染作业卡日志键。 */
  client?: GatewayClient;
  /** 卡头身份（human / agent:<name> / 短 id）；undefined = 不渲染身份槽。 */
  identity?: string;
  /** 这一条有写操作在途：全部动作键禁用（同一条同时只允许一次）。 */
  busy: boolean;
  expanded: boolean;
  /** 入场动画（motion.css 契约 ①）：调用方按 useEnteringItemKeys 判定，
   *  首屏历史不播，live 追加才挂 `.motion-appear`。 */
  entering?: boolean;
  /** peek 到的全文（视图缓存；正文不可变，缓存安全）。 */
  text?: string;
  peeking: boolean;
  peekError?: string;
  onToggleExpand: (messageId: string) => void;
  onCancel: (messageId: string) => void;
  onClaim: (messageId: string) => void;
  onUnhold: (messageId: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  // 异步作业占位回调卡（q-async-bash-viz，kind 无关）：AsyncJobCard 按 kind 分派专属渲染
  // （bash 科技蓝命令卡 + log tail；ask 未来问题卡），不走通用消息卡。无 client 时退回通用卡。
  if (entry.async_job !== undefined && client !== undefined) {
    return <AsyncJobCard entry={entry} client={client} />;
  }
  const human = entry.from === HUMAN_SOURCE;
  const sessionId = entry.session_id;
  return (
    <article
      className={`flex flex-col gap-2 rounded-md bg-raised px-4 py-3.5 shadow-elev-1 forced-colors:border${
        entering ? ' motion-appear' : ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={entry.status === 'held' ? 'warn' : 'neutral'}>
          {entry.status === 'held' ? t('inbox.status.held') : t('inbox.status.unread')}
        </Badge>
        {identity !== undefined && <span className="font-mono text-xs text-faint">{identity}</span>}
        <span className="text-xs text-faint tabular-nums">{formatTimestamp(entry.ts)}</span>
        <span className="flex-1" />
        {sessionId !== undefined ? (
          <Button
            variant="link"
            className="font-mono text-xs"
            title={sessionId}
            onClick={() => onOpenSession(sessionId)}
          >
            {t('inbox.openSession')} · {shortSenderId(sessionId)}
          </Button>
        ) : (
          <Badge title={t('inbox.noSessionHint')}>{t('inbox.noSession')}</Badge>
        )}
      </div>

      <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
        {entry.summary}
      </p>

      {expanded && (
        <div className="rounded-sm bg-sunken px-3 py-2">
          {peeking ? (
            <p className="m-0 text-xs text-faint">{t('inbox.peeking')}</p>
          ) : peekError !== undefined ? (
            <p className="m-0 text-xs text-danger">{peekError}</p>
          ) : text !== undefined ? (
            <p className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted">
              {text}
            </p>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="link"
          className="text-xs"
          aria-expanded={expanded}
          onClick={() => onToggleExpand(entry.message_id)}
        >
          {expanded ? t('inbox.collapse') : t('inbox.expand')}
        </Button>
        <span className="flex-1" />
        {human && (
          <>
            <Button
              variant="dangerGhost"
              size="small"
              disabled={busy}
              onClick={() => onCancel(entry.message_id)}
            >
              {t('inbox.cancel')}
            </Button>
            <Button
              variant="plain"
              size="small"
              disabled={busy}
              onClick={() => onClaim(entry.message_id)}
            >
              {t('chat.pending.claim')}
            </Button>
          </>
        )}
        {!human && canUnhold(entry) && (
          <Button
            variant="plain"
            size="small"
            disabled={busy}
            onClick={() => onUnhold(entry.message_id)}
          >
            {t('chat.pending.unhold')}
          </Button>
        )}
      </div>
    </article>
  );
}
