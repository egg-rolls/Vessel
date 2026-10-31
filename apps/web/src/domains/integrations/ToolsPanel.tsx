import { useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { JsonView } from '../../components/JsonView';
import { ModalShell } from '../../components/Modal';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { Badge, Button, SearchInput } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { ToolInfo } from '../../gateway/types';
import { t } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';
import { mcpServerOf } from './mcp-server';
import { ToolPolicyControl } from './ToolPolicyControl';
import {
  hasScopedNever,
  type PermissionLists,
  policyLabelKey,
  readPermissionLists,
  toolPolicyOf,
} from './tool-policy';

/** 从 `config.get` 的权限数组推导卡片徽章（不再使用 `has_permission_check`）。 */
function ToolPolicyBadge({ tool, lists }: { tool: string; lists: PermissionLists }) {
  const policy = toolPolicyOf(lists, tool);
  const scoped = hasScopedNever(lists, tool);
  const tone = policy === 'auto' ? 'success' : policy === 'never' ? 'warn' : 'neutral';
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={tone}>{t(policyLabelKey(policy))}</Badge>
      {scoped && <Badge tone="warn">{t('integrations.tools.policyScopedNever')}</Badge>}
    </span>
  );
}

export function ToolsPanel() {
  const { client, connectionState, hasToken, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const [query, setQuery] = useState('');
  const [onlyConfirm, setOnlyConfirm] = useState(false);
  /** 详情弹窗展示的是点击时的工具快照；搜索 / 过滤始终基于 name + description。 */
  const [detail, setDetail] = useState<ToolInfo | null>(null);
  const resource = useResource({
    load: () => client.listTools(),
    enabled: hasToken,
    deps: [epoch],
  });
  // Shared with the tool-policy dialog: no second config.get for the badges.
  const { config: configState, reloadConfig } = useConfigStoreApi();
  useRefreshSignal(resource.reload);
  useRefreshSignal(reloadConfig);
  const tools = useMemo(() => resourceData(resource.state) ?? [], [resource.state]);
  const config = resourceData(configState);
  const permissionLists = useMemo(() => readPermissionLists(config?.config), [config]);
  /** config 不可用时不给策略徽章，也不推断“需确认”。 */
  const policyKnown = config !== undefined;
  const confirmCount = useMemo(
    () =>
      policyKnown
        ? tools.filter((tool) => toolPolicyOf(permissionLists, tool.name) !== 'auto').length
        : 0,
    [tools, permissionLists, policyKnown],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tools.filter((tool) => {
      if (onlyConfirm && policyKnown && toolPolicyOf(permissionLists, tool.name) === 'auto') {
        return false;
      }
      if (!needle) return true;
      return (
        tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle)
      );
    });
  }, [tools, query, onlyConfirm, permissionLists, policyKnown]);
  const error = resource.state.status === 'error' ? resource.state.error : null;
  const detailServer = detail ? mcpServerOf(detail.name) : undefined;

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('common.notConnected')}
        reason={t('integrations.tools.noTokenReason')}
      />
    );
  }
  if (error && tools.length === 0) {
    return <ErrorState message={error} onRetry={resource.reload} />;
  }
  if (
    resource.state.status === 'idle' ||
    (resource.state.status === 'loading' && tools.length === 0)
  ) {
    return <LoadingState label={t('integrations.tools.loading')} />;
  }

  return (
    <div className="flex flex-col gap-6">
      {!connected && tools.length > 0 && (
        <StaleNotice message={t('integrations.tools.stale')} onRetry={resource.reload} />
      )}
      {error && tools.length > 0 && (
        <StaleNotice message={t('common.staleData', { detail: error })} onRetry={resource.reload} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t('integrations.tools.searchPlaceholder')}
          ariaLabel={t('integrations.tools.searchLabel')}
          className="grow basis-60 max-w-search"
        />
        {policyKnown && (
          <Button
            variant="chip"
            size="small"
            aria-pressed={onlyConfirm}
            onClick={() => setOnlyConfirm((value) => !value)}
          >
            {t('integrations.tools.onlyConfirm', { count: confirmCount })}
          </Button>
        )}
        <span className="ml-1.5 inline-block rounded-full bg-sunken px-1.5 py-0.5 font-mono text-xs text-muted">
          {filtered.length}/{tools.length}
        </span>
      </div>
      {tools.length === 0 ? (
        <EmptyState title={t('integrations.tools.empty')} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={t('integrations.tools.noMatch')}
          action={
            <Button
              onClick={() => {
                setQuery('');
                setOnlyConfirm(false);
              }}
            >
              {t('common.clearFilters')}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((tool) => {
            const server = mcpServerOf(tool.name);
            return (
              <article className="flex" key={tool.name}>
                <button
                  type="button"
                  className="flex min-h-control w-full items-center gap-2 rounded-md bg-raised px-3 py-2.5 text-left text-muted shadow-elev-1 transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface pointer-coarse:min-h-touch forced-colors:border"
                  aria-haspopup="dialog"
                  title={t('integrations.tools.openDetails', { name: tool.name })}
                  onClick={() => setDetail(tool)}
                >
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words font-mono text-sm font-medium text-ink">
                      {tool.name}
                    </span>
                    {policyKnown && <ToolPolicyBadge tool={tool.name} lists={permissionLists} />}
                    {server && <Badge>MCP · {server}</Badge>}
                  </span>
                  <span
                    className="flex-none font-mono text-sm leading-none text-faint"
                    aria-hidden="true"
                  >
                    ›
                  </span>
                  <span className="sr-only">
                    {t('integrations.tools.openDetails', { name: tool.name })}
                  </span>
                </button>
              </article>
            );
          })}
        </div>
      )}
      {detail && (
        <ModalShell
          label={t('integrations.tools.dialogLabel', { name: detail.name })}
          onClose={() => setDetail(null)}
          closeLabel={t('common.close')}
          size="md"
        >
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <h2 className="m-0 min-w-0 break-words font-mono text-lg font-medium text-ink">
              {detail.name}
            </h2>
            {policyKnown && <ToolPolicyBadge tool={detail.name} lists={permissionLists} />}
            {detailServer && <Badge>MCP · {detailServer}</Badge>}
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-xs uppercase tracking-wide text-faint">
              {t('integrations.tools.details')}
            </span>
            {detail.description && (
              <p className="m-0 text-md leading-relaxed text-muted">{detail.description}</p>
            )}
          </div>
          <ToolPolicyControl tool={detail} />
          <JsonView
            value={detail.input_schema}
            label={t('integrations.tools.schema')}
            maxHeight={320}
            open
          />
        </ModalShell>
      )}
    </div>
  );
}
