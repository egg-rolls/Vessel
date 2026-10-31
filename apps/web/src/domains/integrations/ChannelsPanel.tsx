import { useRefreshSignal } from '../../app/refresh';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { StatusChip, statusLabel } from '../../components/StatusChip';
import { KeyValueList, Section } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';

export function ChannelsPanel() {
  const { client, connectionState, hasToken, features, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('feishu');
  const resource = useResource({
    load: () => client.getFeishuStatus(),
    enabled: available,
    pollMs: 10_000,
    deps: [epoch],
  });
  useRefreshSignal(resource.reload);
  const channel = resourceData(resource.state);

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('common.notConnected')}
        reason={t('integrations.channels.noTokenReason')}
      />
    );
  }
  if (!features.includes('feishu')) {
    return (
      <NotEnabledState
        title={t('integrations.channels.disabledTitle')}
        reason={t('integrations.channels.disabledReason')}
        hint={t('integrations.channels.disabledHint')}
      />
    );
  }
  const errorState = resource.state.status === 'error' ? resource.state : null;
  const error = errorState?.error ?? null;
  if (error && !channel) {
    // 「渠道未启用」是配置状态，不是故障：`feishu.status` 在 default tenant 未启用时抛
    // `not_found`、其它 tenant 未配置时抛 `forbidden`，REST 兜底是 `channel_disabled`。
    // 画成「加载失败 + 重试」会让人以为重试能修好，而它永远不会成功。
    const code = errorState?.code;
    if (code === 'not_found' || code === 'channel_disabled' || code === 'forbidden') {
      return (
        <NotEnabledState
          title={t('integrations.channels.disabledTitle')}
          reason={t('integrations.channels.disabledReason')}
          hint={t('integrations.channels.disabledHint')}
        />
      );
    }
    return <ErrorState message={error} onRetry={resource.reload} />;
  }
  if (resource.state.status === 'idle' || (resource.state.status === 'loading' && !channel)) {
    return <LoadingState label={t('integrations.channels.loading')} />;
  }
  if (!channel) {
    return <EmptyState title={t('integrations.channels.empty')} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
        {t('integrations.channels.globalDesc')}
      </p>
      {!connected && (
        <StaleNotice message={t('integrations.channels.stale')} onRetry={resource.reload} />
      )}
      {error && (
        <StaleNotice message={t('common.staleData', { detail: error })} onRetry={resource.reload} />
      )}
      <Section
        title={t('integrations.channels.title')}
        actions={
          <StatusChip
            status={channel.connected ? 'connected' : 'disconnected'}
            label={statusLabel(channel.connected ? 'connected' : 'disconnected')}
          />
        }
      >
        <KeyValueList
          items={[
            {
              key: 'app-id',
              label: 'App ID',
              value: <span className="font-mono">{channel.appIdMasked || '—'}</span>,
            },
            {
              key: 'active-chats',
              label: t('integrations.channels.activeChats'),
              value: <span className="font-mono">{channel.active_chats}</span>,
            },
            {
              key: 'queued-messages',
              label: t('integrations.channels.queuedMessages'),
              value: <span className="font-mono">{channel.queued_messages}</span>,
            },
            {
              key: 'last-error',
              label: t('integrations.channels.lastError'),
              value: channel.last_error ? (
                <span className="text-danger">{channel.last_error}</span>
              ) : (
                <span className="text-muted">—</span>
              ),
            },
          ]}
        />
        {channel.last_error && (
          <p
            className="mt-2.5 rounded-sm bg-danger-soft px-2.75 py-2 text-md text-danger"
            role="alert"
          >
            {channel.last_error}
          </p>
        )}
        <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
          {t('integrations.channels.noToggle')}
        </p>
      </Section>
    </div>
  );
}
