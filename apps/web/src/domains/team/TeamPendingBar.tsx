/**
 * Team 待处理条：在 Team 输入框上方集中处理成员会话里的权限 / ask_user。
 *
 * - 归属口径与成员侧栏 attention 一致：只收 `sessionId` 属于当前 Team 成员的请求；
 * - 权限复用 `PermissionCard`（四个动作），ask 复用 `AskCard`；
 * - 应答由父级回调直达 `ConnectionProvider`，成功后全局 pending 刷新会让条目自动消失；
 * - 本组件只负责展示与转发，不维护队列 / 不自动切换会话。
 */
import { useMemo } from 'react';
import { Badge } from '../../components/ui';
import type {
  AskUserAnswer,
  AskUserRequest,
  PermissionRequest,
  PermissionScope,
  TeamMember,
} from '../../gateway/types';
import { t } from '../../i18n';
import { AskCard } from '../chat/AskCard';
import { StreamCard } from '../chat/StreamCard';
import { PermissionCard, serializeInput } from '../chat/PermissionCard';
import { memberDisplayName, shortAgentId } from './mention';

/** 摘要单行上限，避免长参数把成员名挤出可视区。 */
const SUMMARY_CHAR_LIMIT = 120;

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > SUMMARY_CHAR_LIMIT
    ? `${collapsed.slice(0, SUMMARY_CHAR_LIMIT)}…`
    : collapsed;
}

/** 权限输入摘要：复用 PermissionCard 的序列化（含 20k 字符安全上限）。 */
export function permissionInputSummary(input: unknown): string {
  return oneLine(serializeInput(input).text);
}

function askPreview(request: AskUserRequest): string {
  const first = request.questions[0];
  if (!first) return '';
  return oneLine(`${first.header}: ${first.question}`);
}

function memberLabel(member: TeamMember): string {
  return member.name?.trim() ? memberDisplayName(member) : shortAgentId(member.agent_id);
}

export interface TeamPendingBarProps {
  members: readonly TeamMember[];
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  /** 正在提交应答的 requestId；用于禁用按钮，避免重复提交。 */
  responding: ReadonlySet<string>;
  connected: boolean;
  onDecidePermission?: (
    requestId: string,
    decision: 'allow' | 'deny',
    scope: PermissionScope,
  ) => void;
  onRespondAsk?: (requestId: string, answers: AskUserAnswer[]) => void;
}

interface PendingPermissionRow {
  request: PermissionRequest;
  member: TeamMember;
}

interface PendingAskRow {
  request: AskUserRequest;
  member: TeamMember;
}

export function TeamPendingBar({
  members,
  permissions,
  asks,
  responding,
  connected,
  onDecidePermission,
  onRespondAsk,
}: TeamPendingBarProps) {
  const memberBySession = useMemo(() => {
    const map = new Map<string, TeamMember>();
    for (const member of members) {
      if (member.session_id) map.set(member.session_id, member);
    }
    return map;
  }, [members]);

  const permissionRows = useMemo<PendingPermissionRow[]>(
    () =>
      permissions.flatMap((request) => {
        const member = request.sessionId ? memberBySession.get(request.sessionId) : undefined;
        return member ? [{ request, member }] : [];
      }),
    [permissions, memberBySession],
  );

  const askRows = useMemo<PendingAskRow[]>(
    () =>
      asks.flatMap((request) => {
        const member = request.sessionId ? memberBySession.get(request.sessionId) : undefined;
        return member ? [{ request, member }] : [];
      }),
    [asks, memberBySession],
  );

  const count = permissionRows.length + askRows.length;
  if (count === 0) return null;

  return (
    <section
      className="team-pending-bar mb-2 flex min-w-0 flex-col gap-1.5"
      aria-label={t('team.pending.title', { count })}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium text-ink">{t('team.pending.title', { count })}</span>
        <span className="text-xs text-faint">{t('team.pending.hint')}</span>
      </div>

      <ul className="m-0 flex max-h-80 list-none flex-col gap-2 overflow-y-auto overscroll-contain p-0">
        {permissionRows.map(({ request, member }) => {
          const summary = permissionInputSummary(request.input);
          return (
            <li className="flex min-w-0 flex-col" key={`perm:${request.requestId}`}>
              {/* 带可操作控件的卡片一律默认展开（不管 ui.expandCards），
                  否则等于把待确认项藏起来。 */}
              <StreamCard
                className="stream-card-pending"
                defaultOpen
                title={
                  <>
                    <span className="font-sans text-xs font-medium text-ink">
                      {memberLabel(member)}
                    </span>
                    <span className="rounded-full bg-warn-soft px-1.5 py-0.5 text-xs text-warn">
                      {t('team.pending.permission')}
                    </span>
                  </>
                }
                summary={summary}
              >
                <PermissionCard
                  request={request}
                  busy={responding.has(request.requestId)}
                  connected={connected}
                  onDecide={(decision, scope) => {
                    onDecidePermission?.(request.requestId, decision, scope);
                  }}
                />
              </StreamCard>
            </li>
          );
        })}

        {askRows.map(({ request, member }) => {
          const preview = askPreview(request);
          return (
            <li className="flex min-w-0 flex-col" key={`ask:${request.requestId}`}>
              <StreamCard
                className="stream-card-pending"
                defaultOpen
                title={
                  <>
                    <span className="font-sans text-xs font-medium text-ink">
                      {memberLabel(member)}
                    </span>
                    <Badge tone="warn">{t('team.pending.ask')}</Badge>
                  </>
                }
                summary={preview.length > 0 ? preview : undefined}
              >
                <AskCard
                  request={request}
                  busy={responding.has(request.requestId)}
                  onSubmit={(answers) => {
                    onRespondAsk?.(request.requestId, answers);
                  }}
                  onCancel={() => {
                    onRespondAsk?.(request.requestId, []);
                  }}
                />
              </StreamCard>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
