/**
 * 子 agent transcript（0.14 P0）。
 *
 * `?agent=` 深链时显示：默认只给摘要（状态 / task / 当前工具 / usage），
 * 下方用 `buildGroup` 把 child run 的 `subagent.*` 事件归一成普通 run 事件，
 * 复用 `RunItems` 的文本 / tool card / 思考块渲染。
 */
import { useMemo } from 'react';
import { StatusChip } from '../../components/StatusChip';
import { Tooltip } from '../../components/Tooltip';
import type { RunEvent } from '../../gateway/types';
import { t } from '../../i18n';
import type { AgentNode } from '../../state/agents';
import { type ErrorVisibility, isEventVisible } from '../../state/error-visibility';
import { buildGroup, type StoredEvent } from '../../state/events';
import type { Verbosity } from '../../state/visibility';
import { RunItems } from './StreamItems';

/** `subagent.<type>` → `<type>`；只归一 run / tool / llm 三类可渲染事件。 */
export function normalizeChildEvent(event: RunEvent): RunEvent {
  if (!event.type.startsWith('subagent.')) return event;
  const type = event.type.slice('subagent.'.length);
  if (type.startsWith('run.') || type.startsWith('tool.call.') || type.startsWith('llm.')) {
    return { ...event, type };
  }
  return event;
}

export function childEntriesFor(
  entries: readonly StoredEvent[],
  agent: AgentNode,
  errorLevel: ErrorVisibility = 'user',
): StoredEvent[] {
  if (!agent.runId) return [];
  return entries
    .filter((entry) => entry.event.run_id === agent.runId)
    .filter((entry) => isEventVisible(entry.event, errorLevel, false))
    .map((entry) => ({ ...entry, event: normalizeChildEvent(entry.event) }));
}

export function SubagentTranscript({
  agent,
  entries,
  errorLevel = 'user',
  verbosity = 'normal',
}: {
  agent: AgentNode;
  entries: readonly StoredEvent[];
  errorLevel?: ErrorVisibility;
  verbosity?: Verbosity;
}) {
  const childEntries = useMemo(
    () => childEntriesFor(entries, agent, errorLevel),
    [entries, agent, errorLevel],
  );
  const group = useMemo(
    () => (agent.runId ? buildGroup(agent.runId, childEntries) : undefined),
    [agent.runId, childEntries],
  );

  return (
    <section
      className="subagent-transcript my-2.5 ml-3 flex flex-col gap-2"
      aria-label={t('chat.subagents.title')}
    >
      <div className="subagent-summary">
        <StatusChip status={agent.state} />
        <strong className="subagent-summary-task">{agent.task?.trim() || agent.id}</strong>
        {agent.currentTool && <span className="font-mono text-muted">{agent.currentTool}</span>}
        {agent.queuePosition !== undefined && (
          <span className="text-muted tabular-nums">
            {t('chat.subagents.queuePosition', { position: agent.queuePosition })}
          </span>
        )}
        {agent.waitReason && <span className="text-muted">{agent.waitReason}</span>}
        {agent.contextUsed !== undefined && agent.contextMax !== undefined && (
          <span className="text-muted tabular-nums">
            {t('chat.subagents.context', { used: agent.contextUsed, max: agent.contextMax })}
          </span>
        )}
        {agent.usage?.total_tokens !== undefined && (
          <span className="text-muted tabular-nums">{agent.usage.total_tokens} tok</span>
        )}
        <Tooltip label={agent.id}>
          <span className="subagent-summary-id font-mono text-muted">{agent.id}</span>
        </Tooltip>
      </div>
      {group ? (
        <RunItems group={group} verbosity={verbosity} />
      ) : (
        <p className="subagent-empty text-muted">{t('chat.subagents.emptyRun')}</p>
      )}
    </section>
  );
}
