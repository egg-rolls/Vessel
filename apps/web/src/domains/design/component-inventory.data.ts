/**
 * 组件清单数据（构建期快照）——由 apps/web/scripts/gen-component-inventory.ts 生成，
 * 再生成：仓库根目录运行 `bun apps/web/scripts/gen-component-inventory.ts`。
 * 消费方口径见脚本头注；单消费方 = 疑似一次性组件（复用共享或退役候选）。
 */

export interface InventoryEntry {
  /** components/ui 模块名（文件名去后缀）。 */
  module: string;
  kind: 'component' | 'hook' | 'util';
  /** 是否转口 @vessel-agent/plugin-ui（同一组件两条 import 路径都计复用）。 */
  reexport: boolean;
  /** 应用消费方数（不含样例与 ui 目录自身）。 */
  consumerCount: number;
  /** 消费方路径（相对 src，最多 12 条示例；全量见外层仓清点报告）。 */
  consumers: string[];
  /** ui 目录内部消费方（0 应用消费方时看这里：可能只被其它共享组件引用）。 */
  uiConsumers: string[];
  /** 引用该组件的 *.preview.tsx 样例（相对 src）。 */
  previews: string[];
}

export const INVENTORY_COMMIT = 'ca96675a';

export const COMPONENT_INVENTORY: readonly InventoryEntry[] = [
  {
    module: 'AutoGrowTextarea',
    kind: 'component',
    reexport: false,
    consumerCount: 0,
    consumers: [
    ],
    uiConsumers: [
    ],
    previews: [
    ],
  },
  {
    module: 'Badge',
    kind: 'component',
    reexport: true,
    consumerCount: 30,
    consumers: [
      'domains/agents/AgentDetailView.tsx',
      'domains/agents/AgentListRow.tsx',
      'domains/auth/AccountPanel.tsx',
      'domains/chat/AskCard.tsx',
      'domains/design/ComponentInventorySection.tsx',
      'domains/design/PreviewSection.tsx',
      'domains/design/TokenSection.tsx',
      'domains/inbox/AsyncJobCard.tsx',
      'domains/inbox/InboxRow.tsx',
      'domains/integrations/McpPanel.tsx',
      'domains/integrations/ToolsPanel.tsx',
      'domains/kanban/KanbanCard.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'components/ui/card-shell.preview.tsx',
      'components/ui/entity-header.preview.tsx',
      'domains/design/previews/ui/badges.preview.tsx',
      'domains/design/previews/ui/data-table.preview.tsx',
      'domains/design/previews/ui/section.preview.tsx',
    ],
  },
  {
    module: 'Button',
    kind: 'component',
    reexport: true,
    consumerCount: 70,
    consumers: [
      'app/LanguageToggle.tsx',
      'app/ShellOverlays.tsx',
      'auth/LoginPage.tsx',
      'domains/agents/AgentCreateDialog.tsx',
      'domains/agents/AgentDetailView.tsx',
      'domains/agents/AgentEditView.tsx',
      'domains/agents/AgentsView.tsx',
      'domains/chat/AskCard.tsx',
      'domains/chat/AttachDialog.tsx',
      'domains/chat/Composer.tsx',
      'domains/chat/ComposerAttach.tsx',
      'domains/chat/ComposerChrome.tsx',
    ],
    uiConsumers: [
      'components/ui/MessageFold.tsx',
    ],
    previews: [
      'components/ui/card-shell.preview.tsx',
      'components/ui/entity-header.preview.tsx',
      'domains/chat/composer-controls.preview.tsx',
      'domains/design/previews/overlays/confirm-dialog.preview.tsx',
      'domains/design/previews/overlays/modal-shell.preview.tsx',
      'domains/design/previews/overlays/tooltip.preview.tsx',
      'domains/design/previews/ui/buttons.preview.tsx',
      'domains/design/previews/ui/states.preview.tsx',
      'domains/design/previews/ui/toolbar.preview.tsx',
    ],
  },
  {
    module: 'card-surface',
    kind: 'util',
    reexport: true,
    consumerCount: 2,
    consumers: [
      'domains/agents/AgentListRow.tsx',
      'domains/nodes/NodePanelView.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
    ],
  },
  {
    module: 'CardShell',
    kind: 'component',
    reexport: false,
    consumerCount: 3,
    consumers: [
      'domains/chat/RefCard.tsx',
      'domains/chat/SessionRefBlock.tsx',
      'domains/chat/ToolImageCard.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'components/ui/card-shell.preview.tsx',
    ],
  },
  {
    module: 'clipboard',
    kind: 'util',
    reexport: false,
    consumerCount: 1,
    consumers: [
      'domains/teams/useTeamsView.ts',
    ],
    uiConsumers: [
      'components/ui/MessageActions.tsx',
    ],
    previews: [
    ],
  },
  {
    module: 'cn',
    kind: 'util',
    reexport: true,
    consumerCount: 25,
    consumers: [
      'app/BottomNav.tsx',
      'app/DomainNav.tsx',
      'app/NavGroup.tsx',
      'app/NavItem.tsx',
      'components/JsonView.tsx',
      'domains/auth/AccountAvatar.tsx',
      'domains/auth/AccountPanel.tsx',
      'domains/chat/AgentMessageCard.tsx',
      'domains/chat/AskCard.tsx',
      'domains/chat/ComposerAttach.tsx',
      'domains/chat/ComposerChrome.tsx',
      'domains/chat/MemberModelSwitch.tsx',
    ],
    uiConsumers: [
      'components/ui/CardShell.tsx',
      'components/ui/EntityHeader.tsx',
      'components/ui/FilterPopover.tsx',
      'components/ui/Icon.tsx',
      'components/ui/MessageActions.tsx',
      'components/ui/SidebarShell.tsx',
    ],
    previews: [
      'domains/chat/composer-controls.preview.tsx',
    ],
  },
  {
    module: 'CountBadge',
    kind: 'component',
    reexport: true,
    consumerCount: 7,
    consumers: [
      'app/NavGroup.tsx',
      'app/NavItem.tsx',
      'domains/chat/SessionList.tsx',
      'domains/inbox/InboxView.tsx',
      'domains/kanban/KanbanView.tsx',
      'domains/pending/PendingClusterCard.tsx',
      'domains/settings/dialog/CategoryTree.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'domains/design/previews/ui/badges.preview.tsx',
    ],
  },
  {
    module: 'DataTable',
    kind: 'component',
    reexport: true,
    consumerCount: 8,
    consumers: [
      'domains/design/ComponentInventorySection.tsx',
      'domains/hub/HubDirectory.tsx',
      'domains/observe/DiagnosticsView.tsx',
      'domains/observe/DoctorChecksSection.tsx',
      'domains/observe/EvalReportView.tsx',
      'domains/runs/RunsTable.tsx',
      'domains/settings/CapabilitiesView.tsx',
      'domains/settings/ConfigView.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'domains/design/previews/ui/data-table.preview.tsx',
    ],
  },
  {
    module: 'EntityHeader',
    kind: 'component',
    reexport: false,
    consumerCount: 4,
    consumers: [
      'domains/agents/AgentDetailView.tsx',
      'domains/nodes/NodeDetailView.tsx',
      'domains/team/BodyTranscripts.tsx',
      'domains/team/TeamChatHeader.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'components/ui/entity-header.preview.tsx',
    ],
  },
  {
    module: 'Field',
    kind: 'component',
    reexport: true,
    consumerCount: 22,
    consumers: [
      'auth/LoginPage.tsx',
      'domains/agents/AgentCreateDialog.tsx',
      'domains/agents/AgentEditView.tsx',
      'domains/agents/AgentsView.tsx',
      'domains/chat/AskCard.tsx',
      'domains/chat/AttachDialog.tsx',
      'domains/chat/MemberModelSwitch.tsx',
      'domains/chat/SessionList.tsx',
      'domains/hub/HubConnectForm.tsx',
      'domains/inbox/InboxView.tsx',
      'domains/nodes/AddNodeDialog.tsx',
      'domains/observe/EvalsPanel.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'domains/design/previews/ui/form.preview.tsx',
    ],
  },
  {
    module: 'FilterPopover',
    kind: 'component',
    reexport: false,
    consumerCount: 1,
    consumers: [
      'domains/runs/RunsTable.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'components/ui/filter-popover.preview.tsx',
    ],
  },
  {
    module: 'ghost-control',
    kind: 'util',
    reexport: false,
    consumerCount: 5,
    consumers: [
      'domains/runs/RunDetailPage.tsx',
      'domains/runs/RunEventLog.tsx',
      'domains/settings/ConfigView.tsx',
      'domains/settings/dialog/SettingRow.tsx',
      'domains/settings/dialog/SettingsSearchBar.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
    ],
  },
  {
    module: 'Icon',
    kind: 'component',
    reexport: false,
    consumerCount: 13,
    consumers: [
      'auth/LoginPage.tsx',
      'domains/chat/ComposerAttach.tsx',
      'domains/chat/ComposerChrome.tsx',
      'domains/chat/MemberModelSwitch.tsx',
      'domains/chat/PendingStrip.tsx',
      'domains/chat/QuoteBlock.tsx',
      'domains/chat/ReasoningBlock.tsx',
      'domains/chat/SessionList.tsx',
      'domains/chat/SessionRefBlock.tsx',
      'domains/chat/StreamCard.tsx',
      'domains/chat/StreamItems.tsx',
      'domains/chat/image-preview.tsx',
    ],
    uiConsumers: [
      'components/ui/MessageActions.tsx',
    ],
    previews: [
      'domains/chat/composer-controls.preview.tsx',
    ],
  },
  {
    module: 'KeyValueList',
    kind: 'component',
    reexport: true,
    consumerCount: 10,
    consumers: [
      'domains/agents/AgentDetailView.tsx',
      'domains/integrations/ChannelsPanel.tsx',
      'domains/nodes/NodeDetailView.tsx',
      'domains/observe/DiagnosticsView.tsx',
      'domains/plugins/PluginHostView.tsx',
      'domains/runs/RunDetailPage.tsx',
      'domains/settings/ConfigView.tsx',
      'domains/settings/ConnectionForm.tsx',
      'domains/team/MemberDetail.tsx',
      'domains/team/RoleConversionSection.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'domains/design/previews/ui/key-value.preview.tsx',
    ],
  },
  {
    module: 'MessageActions',
    kind: 'component',
    reexport: false,
    consumerCount: 8,
    consumers: [
      'domains/chat/ReasoningBlock.tsx',
      'domains/chat/RefCard.tsx',
      'domains/chat/StreamItems.tsx',
      'domains/chat/ToolImageCard.tsx',
      'domains/chat/Transcript.tsx',
      'domains/chat/TranscriptWindow.tsx',
      'domains/chat/image-preview.tsx',
      'domains/team/TeamMessageRow.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'domains/design/previews/chat/assistant-text.preview.tsx',
    ],
  },
  {
    module: 'MessageFold',
    kind: 'component',
    reexport: false,
    consumerCount: 3,
    consumers: [
      'domains/chat/StreamItems.tsx',
      'domains/chat/Transcript.tsx',
      'domains/team/TeamMessageRow.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'components/ui/message-fold.preview.tsx',
    ],
  },
  {
    module: 'RichComposer',
    kind: 'component',
    reexport: false,
    consumerCount: 2,
    consumers: [
      'domains/chat/Composer.tsx',
      'domains/team/TeamComposer.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
    ],
  },
  {
    module: 'SearchInput',
    kind: 'component',
    reexport: true,
    consumerCount: 12,
    consumers: [
      'domains/agents/AgentsView.tsx',
      'domains/chat/SessionList.tsx',
      'domains/design/PreviewSection.tsx',
      'domains/design/TokenSection.tsx',
      'domains/integrations/ToolsPanel.tsx',
      'domains/nodes/NodePanelView.tsx',
      'domains/runs/RunsFilters.tsx',
      'domains/settings/CapabilitiesView.tsx',
      'domains/settings/ConfigView.tsx',
      'domains/settings/dialog/SettingsSearchBar.tsx',
      'domains/team/TeamChatMembersAside.tsx',
      'domains/teams/TeamsListColumn.tsx',
    ],
    uiConsumers: [
      'components/ui/FilterPopover.tsx',
    ],
    previews: [
      'components/ui/sidebar-shell.preview.tsx',
      'domains/design/previews/ui/toolbar.preview.tsx',
    ],
  },
  {
    module: 'Section',
    kind: 'component',
    reexport: true,
    consumerCount: 19,
    consumers: [
      'domains/agents/AgentDetailView.tsx',
      'domains/agents/AgentEditView.tsx',
      'domains/design/PreviewSection.tsx',
      'domains/hub/HubConnectForm.tsx',
      'domains/hub/HubDirectory.tsx',
      'domains/integrations/ChannelsPanel.tsx',
      'domains/nodes/NodeDetailView.tsx',
      'domains/observe/DiagnosticsView.tsx',
      'domains/observe/DoctorChecksSection.tsx',
      'domains/observe/EvalReportView.tsx',
      'domains/pending/PendingClusterCard.tsx',
      'domains/plugins/PluginHostView.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'domains/design/previews/ui/section.preview.tsx',
    ],
  },
  {
    module: 'SidebarShell',
    kind: 'component',
    reexport: false,
    consumerCount: 2,
    consumers: [
      'domains/chat/SessionList.tsx',
      'domains/teams/TeamsListColumn.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'components/ui/sidebar-shell.preview.tsx',
    ],
  },
  {
    module: 'Stat',
    kind: 'component',
    reexport: true,
    consumerCount: 3,
    consumers: [
      'domains/observe/EvalReportView.tsx',
      'domains/observe/MetricsPanel.tsx',
      'domains/settings/CapabilitiesView.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
      'domains/design/previews/ui/stat.preview.tsx',
    ],
  },
  {
    module: 'useEnteringItemKeys',
    kind: 'hook',
    reexport: false,
    consumerCount: 4,
    consumers: [
      'domains/chat/PendingStrip.tsx',
      'domains/chat/SessionList.tsx',
      'domains/inbox/InboxView.tsx',
      'domains/team/TeamTranscript.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
    ],
  },
  {
    module: 'useTypewriterText',
    kind: 'hook',
    reexport: false,
    consumerCount: 1,
    consumers: [
      'domains/chat/ReasoningBlock.tsx',
    ],
    uiConsumers: [
    ],
    previews: [
    ],
  },
];
