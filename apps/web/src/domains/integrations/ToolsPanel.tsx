import { TableToolbar } from '@vessel-agent/plugin-ui';
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
import { Badge, Button, SearchInput, Select } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { AgentSummary, ToolInfo, ToolListResponse, ToolSurface } from '../../gateway/types';
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

/** `agents.list` 条目的稳定 id（旧 gateway 只带 `agent_id`）。 */
function memberIdOf(member: AgentSummary): string {
  return member.id ?? member.agent_id ?? '';
}

/** 成员选择器的展示名：优先 name，其次 id（不为了好看再造一个字段）。 */
function memberLabelOf(member: AgentSummary): string {
  const name = member.name?.trim();
  return name ? `${name} (${memberIdOf(member)})` : memberIdOf(member);
}

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

/**
 * 「来源」徽章：只在成员视图里出现。
 *
 * `member` = 成员运行期注入（`inbox`），**不在节点插件面里** —— 节点视图永远看不到它，
 * 这正是这个面板要能一眼说清的事；`plugin` 则来自父宿主（节点插件面）。
 */
function ToolSourceBadge({ tool }: { tool: ToolInfo }) {
  if (tool.source === undefined || tool.source === 'plugin') return null;
  return <Badge tone="accent">{t('integrations.tools.sourceMember')}</Badge>;
}

/** 成员工具面的取值档位：`live` = 活身体实取，`derived` = 无身体时按规则推导。 */
function SurfaceBadge({ surface }: { surface: ToolSurface | undefined }) {
  if (surface === undefined) {
    return <Badge tone="warn">{t('integrations.tools.surfaceUnavailable')}</Badge>;
  }
  return (
    <Badge tone={surface === 'live' ? 'success' : 'neutral'}>
      {t(
        surface === 'live' ? 'integrations.tools.surfaceLive' : 'integrations.tools.surfaceDerived',
      )}
    </Badge>
  );
}

export function ToolsPanel() {
  const { client, connectionState, hasToken, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const [query, setQuery] = useState('');
  const [onlyConfirm, setOnlyConfirm] = useState(false);
  /** 视图口径：空串 = 节点插件面（今天的默认），否则 = 该成员的真实工具面。 */
  const [agentId, setAgentId] = useState('');
  /** 详情弹窗展示的是点击时的工具快照；搜索 / 过滤始终基于 name + description。 */
  const [detail, setDetail] = useState<ToolInfo | null>(null);
  // 可选成员清单。旧 gateway / 权限不足时为空：选择器只剩节点口径，行为与今天一致。
  const membersResource = useResource({
    load: () => client.listAgents(),
    enabled: hasToken,
    deps: [epoch],
  });
  const members = useMemo<AgentSummary[]>(() => {
    const list = resourceData(membersResource.state) ?? [];
    return list.filter((member) => memberIdOf(member).length > 0);
  }, [membersResource.state]);
  // 两种口径共用一条加载路径：`agent_id` 为空 = 节点插件面（不传参数，旧行为）。
  const resource = useResource({
    load: async (): Promise<ToolListResponse> => {
      if (agentId === '') return { tools: await client.listTools() };
      return await client.listToolsForAgent(agentId);
    },
    enabled: hasToken,
    deps: [epoch, agentId],
  });
  // Shared with the tool-policy dialog: no second config.get for the badges.
  const { config: configState, reloadConfig } = useConfigStoreApi();
  useRefreshSignal(resource.reload);
  useRefreshSignal(reloadConfig);
  const catalog = resourceData(resource.state);
  const tools = useMemo(() => catalog?.tools ?? [], [catalog]);
  /**
   * 成员口径的档位。`undefined` 有两种情况：节点口径（本就没有这个字段），或
   * 旧 gateway 忽略了 `agent_id`（照旧回了插件面）—— 界面按「未知」展示，不假装是实取。
   */
  const surface = agentId === '' ? undefined : catalog?.surface;
  const selectedMember = members.find((member) => memberIdOf(member) === agentId);
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
  const agentLabel = selectedMember ? memberLabelOf(selectedMember) : agentId;
  /**
   * 视图说明：两种口径的区别 + 成员口径这一份是实取还是推导。
   *
   * 旧 gateway 会忽略 `agent_id`（响应里没有 `surface`）：那时候明说「未知」，
   * 不把插件面冒充成成员实取的快照。
   */
  const scopeHint =
    agentId === ''
      ? t('integrations.tools.scopeNodeHint')
      : t(
          surface === 'live'
            ? 'integrations.tools.scopeMemberLiveHint'
            : surface === 'derived'
              ? 'integrations.tools.scopeMemberDerivedHint'
              : 'integrations.tools.scopeMemberUnknownHint',
          { agent: agentLabel, count: tools.length },
        );

  if (!hasToken) {
    return (
      <NotEnabledState
        variant="page"
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
      <TableToolbar label={t('integrations.tools.searchLabel')}>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t('integrations.tools.searchPlaceholder')}
          ariaLabel={t('integrations.tools.searchLabel')}
          className="grow basis-60 max-w-search"
        />
        <Select
          className="w-auto min-w-40"
          value={agentId}
          aria-label={t('integrations.tools.scopeLabel')}
          onChange={(event) => {
            setAgentId(event.target.value);
            setDetail(null);
          }}
        >
          <option value="">{t('integrations.tools.scopeNode')}</option>
          {members.map((member) => (
            <option key={memberIdOf(member)} value={memberIdOf(member)}>
              {memberLabelOf(member)}
            </option>
          ))}
        </Select>
        {agentId !== '' && <SurfaceBadge surface={surface} />}
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
      </TableToolbar>
      {/* 两种视图必须一眼分得开：节点口径不按成员权限收窄、也不含成员内置工具；
          成员口径是「这具身体实际能调什么」，`derived` 还额外说明是推导值。 */}
      <p className="m-0 -mt-3 text-sm text-muted">{scopeHint}</p>
      {tools.length === 0 ? (
        <EmptyState
          title={
            agentId === ''
              ? t('integrations.tools.empty')
              : t('integrations.tools.emptyMember', { agent: agentLabel })
          }
        />
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
                  className="flex min-h-control w-full items-center gap-2 rounded-md border border-transparent bg-raised px-3 py-2.5 text-left text-muted transition-colors duration-150 hover:border-line hover:bg-surface-hover hover:shadow-elev-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface pointer-coarse:min-h-touch forced-colors:border"
                  aria-haspopup="dialog"
                  title={t('integrations.tools.openDetails', { name: tool.name })}
                  onClick={() => setDetail(tool)}
                >
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words font-mono text-sm font-medium text-ink">
                      {tool.name}
                    </span>
                    {agentId !== '' && <ToolSourceBadge tool={tool} />}
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
            {agentId !== '' && <ToolSourceBadge tool={detail} />}
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
