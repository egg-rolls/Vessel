import type { messages as zhMessages } from './zh-CN';

/**
 * Web 英文文案。类型要求与 zh-CN 的 key 集合完全一致，漏 key 会在 typecheck 报错。
 * 技术词 / 命令名 / 错误码保持原文。
 */
export const messages: Record<keyof typeof zhMessages, string> = {
  // Navigation
  'nav.domain.chat': 'Sessions',
  'nav.domain.runs': 'Runs',
  'nav.domain.workflows': 'Workflows',
  'nav.domain.integrations': 'Integrations',
  'nav.domain.observe': 'Observe',
  'nav.domain.settings': 'Settings',
  'nav.group.chat': 'CHAT',
  'nav.group.observe': 'OBSERVE',
  'nav.group.workflows': 'WORKFLOWS',
  'nav.group.integrations': 'INTEGRATIONS',
  'nav.mainLabel': 'Main navigation',
  'nav.bottomLabel': 'Main navigation (mobile)',
  'nav.openNav': 'Open navigation',
  'nav.closeNav': 'Close navigation',
  'nav.openSessions': 'Open session list',
  'nav.closeSessions': 'Close session list',
  'nav.collapseNav': 'Collapse sidebar',
  'nav.expandNav': 'Expand sidebar',
  'nav.collapsed': 'Collapse',
  'nav.jumpToMain': 'Skip to main content',
  'nav.more': 'More',
  'nav.moreSheet': 'More navigation',
  'nav.connection': 'Connection',
  'nav.connectionNamed': 'Connection: {value}',
  'nav.conn.online': 'online',
  'nav.conn.connecting': 'Connecting…',
  'nav.conn.connectingShort': 'Connecting',
  'nav.conn.reconnecting': 'Reconnecting…',
  'nav.conn.reconnectingShort': 'Reconnecting',
  'nav.conn.closed': 'Disconnected',
  'nav.conn.error': 'Connection failed',
  'nav.conn.idle': 'Not connected',
  'nav.tenant': 'Tenant',
  'nav.tenantCurrent': 'Current tenant',
  'nav.tenantChipTitle': 'Current tenant; click to view or switch',
  'nav.connStatusTitle': 'Gateway connection status; click to open connection settings',
  'nav.tenantNamed': 'Tenant {tenant}',
  'nav.searchOrCommand': 'Search or type a command',
  'nav.opened': 'Opened {path}',
  'nav.openNamed': 'Open {domain}',
  'nav.hintNavigation': 'Navigation',
  'nav.hintSettings': 'Settings',

  // Breadcrumb
  'breadcrumb.chat': 'Sessions',
  'breadcrumb.chat.session': 'Sessions › Conversation',
  'breadcrumb.runs.live': 'Live',
  'breadcrumb.runs.durable': 'Recoverable',
  'breadcrumb.runs.detail': 'Runs › {tab}',
  'breadcrumb.runs.detailRun': 'Runs › {tab} › Details',
  'breadcrumb.workflows': 'Workflows',
  'breadcrumb.workflows.detail': 'Workflows › Details',
  'breadcrumb.integrations.tools': 'Integrations › Tools',
  'breadcrumb.integrations.mcp': 'Integrations › MCP servers',
  'breadcrumb.integrations.channels': 'Integrations › Channels',
  'breadcrumb.observe.metrics': 'Observe › Metrics',
  'breadcrumb.observe.evals': 'Observe › Evals',
  'breadcrumb.settings': 'Settings › {tab}',

  // Settings
  'settings.title': 'Settings',
  'settings.description':
    'Connection, nodes, config, capabilities and tenants. The connection form appears only here.',
  'settings.tabsLabel': 'Settings sections',
  'settings.panelLabel': 'Settings content',
  'settings.tab.connection': 'Connection',
  'settings.tab.nodes': 'Nodes',
  'settings.tab.config': 'Config',
  'settings.tab.capabilities': 'Capabilities',
  'settings.tab.tenants': 'Tenants',
  'settings.tab.appearance': 'Appearance',

  // Appearance
  'appearance.theme.title': 'Theme',
  'appearance.theme.desc':
    'Dark by default; System follows prefers-color-scheme. Your choice persists across reloads.',
  'appearance.theme.system': 'System',
  'appearance.theme.light': 'Light',
  'appearance.theme.dark': 'Dark',
  'appearance.motion.title': 'Motion',
  'appearance.motion.desc':
    'Motion follows the system prefers-reduced-motion setting; there is no separate switch. When reduced motion is on, drawers, the command palette and status pulses are disabled.',
  'appearance.language.title': 'Language',
  'appearance.language.desc':
    'The interface updates immediately. Technical terms, commands and error codes stay untranslated.',
  'appearance.language.zh': '简体中文',
  'appearance.language.en': 'English',

  // Common
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.confirm': 'Confirm',
  'common.loading': 'Loading…',
  'common.processing': 'Working…',
  'common.retry': 'Retry',
  'common.refresh': 'Refresh',
  'common.loadFailed': 'Failed to load',
  'common.tenant': 'Tenant',

  // Permission / ask / reasoning stream (0.11.1)
  'permission.busy': 'Submitting…',
  'permission.expired': 'Request expired; removed from the pending list.',
  'chat.reasoning.summary': 'Thinking',
};
