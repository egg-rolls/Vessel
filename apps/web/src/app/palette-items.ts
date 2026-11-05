import type { ToastApi } from '../components/ToastProvider';
import type { ConnectionState } from '../gateway/client';
import { t } from '../i18n';
import type { PaletteItem } from '../state/palette';
import { DOMAINS, domainLabel, primaryRoute } from './nav';
import { requestRefresh } from './refresh';
import type { Route } from './router';

export interface PaletteItemDeps {
  hasToken: boolean;
  connectionState: ConnectionState;
  navigate: (route: Route) => void;
  retry: () => void;
  toast: ToastApi;
  openHelp: () => void;
}

/** 命令面板条目；文案由 `t` 读取当前 locale，调用方需在 locale 变化时重算。 */
export function buildPaletteItems({
  hasToken,
  connectionState,
  navigate,
  retry,
  toast,
  openHelp,
}: PaletteItemDeps): PaletteItem[] {
  const items: PaletteItem[] = [
    ...DOMAINS.map((domain) => ({
      id: `nav-${domain.id}`,
      group: 'navigation' as const,
      label: t('nav.openNamed', { domain: domainLabel(domain.id) }),
      keywords: [domain.id, domainLabel(domain.id)],
      hint: t('nav.hintNavigation'),
      run: () => navigate(primaryRoute(domain.id)),
    })),
    {
      id: 'action-new-session',
      group: 'action',
      label: t('palette.action.newSession'),
      keywords: ['new', 'session', 'chat'],
      hint: t('palette.hint.action'),
      run: () => {
        // 先回到 Chat 再进入 new，确保已在 new 时也会生成新的草稿 id。
        navigate({ domain: 'chat' });
        window.setTimeout(() => navigate({ domain: 'chat', sessionId: 'new' }), 0);
      },
    },
    {
      id: 'action-resume-run',
      group: 'action',
      label: t('palette.action.resumeRun'),
      keywords: ['resume', 'durable', 'interrupted', '恢复'],
      hint: t('palette.hint.action'),
      run: () => navigate({ domain: 'runs', tab: 'durable' }),
    },
    {
      id: 'action-tenant',
      group: 'action',
      label: t('palette.action.switchTenant'),
      keywords: ['tenant', 'switch', '租户'],
      hint: t('palette.hint.action'),
      run: () => navigate({ domain: 'tenants' }),
    },
    {
      id: 'action-connection',
      group: 'action',
      label: t('palette.action.connectionSettings'),
      keywords: ['gateway', 'token', 'url', 'connect'],
      hint: t('palette.hint.action'),
      run: () => navigate({ domain: 'gateway' }),
    },
    {
      id: 'action-config',
      group: 'action',
      label: t('palette.action.viewConfig'),
      keywords: ['config', 'sources'],
      hint: t('palette.hint.action'),
      run: () => navigate({ domain: 'settings' }),
    },
    {
      id: 'action-capabilities',
      group: 'action',
      label: t('palette.action.viewCapabilities'),
      keywords: ['capabilities', 'methods'],
      hint: t('palette.hint.action'),
      run: () => navigate({ domain: 'capabilities' }),
    },
    {
      id: 'action-refresh',
      group: 'action',
      label: t('palette.action.refresh'),
      keywords: ['refresh', 'reload'],
      hint: t('palette.hint.action'),
      run: () => {
        requestRefresh();
        toast.info(t('palette.toast.refreshed'));
      },
    },
    {
      id: 'help-shortcuts',
      group: 'help',
      label: t('palette.action.shortcuts'),
      keywords: ['help', 'keyboard', 'shortcut'],
      hint: t('palette.hint.help'),
      run: openHelp,
    },
  ];
  if (hasToken) {
    items.push({
      id: 'action-retry',
      group: 'action',
      label:
        connectionState === 'open'
          ? t('palette.action.checkConnection')
          : t('palette.action.reconnect'),
      keywords: ['reconnect', 'retry'],
      hint: t('palette.hint.action'),
      run: () => {
        retry();
        toast.info(t('palette.toast.reconnecting'));
      },
    });
  }
  return items;
}
