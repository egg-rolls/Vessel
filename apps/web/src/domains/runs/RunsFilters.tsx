/**
 * Runs 过滤栏：搜索、状态 chips、agent 下拉与会话/agent 过滤 chip。
 *
 * 纯展示；状态与回调由 useRunsPage / RunsView 提供。
 */

import { Button, cn, SearchInput, Select } from '../../components/ui';
import { t } from '../../i18n';
import type { RunStatusFilter } from '../../state/runs';

export function RunsFilters({
  query,
  onQueryChange,
  status,
  onStatusChange,
  filterList,
  agentId,
  onAgentIdChange,
  agentOptions,
  sessionId,
  onClearSession,
  onClearAgent,
  onRefresh,
  hasToken,
  hidden,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  status: RunStatusFilter;
  onStatusChange: (value: RunStatusFilter) => void;
  filterList: readonly { id: RunStatusFilter; labelKey: string }[];
  agentId: string;
  onAgentIdChange: (value: string) => void;
  agentOptions: readonly string[];
  sessionId?: string;
  onClearSession: () => void;
  onClearAgent: () => void;
  onRefresh: () => void;
  hasToken: boolean;
  hidden: boolean;
}) {
  return (
    <div className={cn('mt-3.5 flex flex-wrap items-center gap-2', hidden && 'max-wide:hidden')}>
      <SearchInput
        value={query}
        onChange={onQueryChange}
        placeholder={t('runs.searchPlaceholder')}
        ariaLabel={t('runs.searchLabel')}
        className="grow basis-60 max-w-search"
      />
      <fieldset className="flex flex-wrap gap-1">
        <legend className="sr-only">{t('runs.statusLegend')}</legend>
        {filterList.map((filter) => (
          <Button
            key={filter.id}
            variant="chip"
            size="small"
            aria-pressed={filter.id === status}
            onClick={() => onStatusChange(filter.id)}
          >
            {t(filter.labelKey)}
          </Button>
        ))}
      </fieldset>
      <Select
        className="net-select h-control w-auto min-w-32 py-0"
        value={agentId}
        aria-label={t('runs.filterByAgent')}
        onChange={(event) => onAgentIdChange(event.target.value)}
      >
        <option value="">{t('common.all')}</option>
        {agentOptions.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
      {sessionId && (
        <Button
          variant="chip"
          size="small"
          className="bg-accent-soft text-accent-ink"
          onClick={onClearSession}
          title={t('runs.clearSessionFilter')}
        >
          {t('runs.sessionChip', { session: sessionId.slice(0, 12) })} ×
        </Button>
      )}
      {agentId && (
        <Button
          variant="chip"
          size="small"
          className="bg-accent-soft text-accent-ink"
          onClick={onClearAgent}
          title={t('runs.clearAgentFilter')}
        >
          {t('runs.agentChip', { agent: agentId.slice(0, 12) })} ×
        </Button>
      )}
      <Button size="small" onClick={onRefresh} disabled={!hasToken}>
        {t('common.refresh')}
      </Button>
    </div>
  );
}
