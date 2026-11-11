/**
 * Runs 工具条：搜索框 + Live / Recoverable 来源切换。
 *
 * 0.45：状态与 agent 过滤下沉到表头（RunsTable 的 headerFilter），
 * 会话过滤只保留路由参数，不再占顶部 chip。
 */

import { TableToolbar } from '@vessel-agent/plugin-ui';
import { SegmentedTabs } from '../../components/Tabs';
import { SearchInput } from '../../components/ui';
import { t } from '../../i18n';

type RunTab = 'live' | 'durable';

export function RunsFilters({
  query,
  onQueryChange,
  tab,
  onTabChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  tab: RunTab;
  onTabChange: (tab: RunTab) => void;
}) {
  return (
    <TableToolbar label={t('runs.searchLabel')}>
      <SearchInput
        value={query}
        onChange={onQueryChange}
        placeholder={t('runs.searchPlaceholder')}
        ariaLabel={t('runs.searchLabel')}
        className="grow basis-60 max-w-search"
      />
      <SegmentedTabs
        className="mt-0 ml-auto"
        label={t('runs.sourceLabel')}
        tabs={[
          { id: 'live', label: t('runs.source.live') },
          { id: 'durable', label: t('runs.source.durable') },
        ]}
        value={tab}
        onChange={onTabChange}
        panelId="runs-panel"
      />
    </TableToolbar>
  );
}
