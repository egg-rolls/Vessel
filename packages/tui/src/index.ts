/**
 * @vessel-agent/tui - 终端交互界面
 * @module @vessel-agent/tui
 *
 * 调用 core + config，提供终端交互。
 * 无基础用户入口。
 * 使用 Ink 框架实现 React 组件式终端 UI。
 */

export type {
  CommandCategory,
  CommandEntry,
  CommandResult,
  ReplState,
  ResumeResult,
  ToolDetailMode,
} from './commands/commands.js';
export {
  CommandRegistry,
  consumePendingResume,
  createCommands,
  doResume,
} from './commands/commands.js';
export {
  type DeleteSessionOptions,
  deleteSessionAction,
  renameSessionAction,
  runSessionsCommand,
  SESSIONS_DEPRECATION,
  sessionActionResult,
  sessionsCommand,
} from './commands/sessions-command.js';
export { AskUserDialog } from './components/AskUserDialog.js';
export { BottomBar, type BottomBarProps } from './components/BottomBar.js';
export { ConfirmDialog } from './components/ConfirmDialog.js';
export { DataTable, type DataTableProps } from './components/DataTable.js';
export { DetailPanel, type DetailPanelProps } from './components/DetailPanel.js';
export { EmptyState, type EmptyStateProps } from './components/EmptyState.js';
export {
  type CommandEnterDecision,
  type CommandItem,
  decideCommandEnter,
  filterCommands,
  InlineAutocomplete,
} from './components/InlineAutocomplete.js';
export {
  InteractiveViewHost,
  type InteractiveViewHostProps,
} from './components/InteractiveViewHost.js';
export {
  type IndicatorStyle,
  indicatorFrame,
  indicatorFrames,
  indicatorInterval,
  resolveIndicatorStyle,
  THINKING_VERB_INTERVAL_MS,
  THINKING_VERBS,
  thinkingVerb,
} from './components/indicator.js';
export { formatKeyHints, KeyHints, type KeyHintsProps } from './components/KeyHints.js';
export {
  type BorderParts,
  buildBorderParts,
  PanelFrame,
  type PanelFrameProps,
  type PanelVariant,
} from './components/PanelFrame.js';
export {
  formatQueuePreview,
  getQueueWindow,
  type QueueLine,
  type QueueLineTone,
  QueuePreview,
  type QueuePreviewProps,
  type QueueWindow,
} from './components/QueuePreview.js';
export { QuickHelp, type QuickHelpProps, shouldOpenQuickHelp } from './components/QuickHelp.js';
export {
  type SessionPickerActionResult,
  SessionTable,
  type SessionTableProps,
} from './components/SessionTable.js';
export {
  minVerbDelayMs,
  SpinnerWithVerb,
  type SpinnerWithVerbProps,
} from './components/SpinnerWithVerb.js';
export {
  reduceSpinnerState,
  type SpinnerState,
  type SpinnerVerb,
  useSpinnerState,
} from './components/StateTracker.js';
// Ink 组件
export {
  contextBar,
  contextTone,
  formatStatusRule,
  StatusBar,
  type StatusKind,
  type StatusRuleProps,
  type StatusSegment,
  type StatusTone,
} from './components/StatusBar.js';
export { StreamOutput } from './components/StreamOutput.js';
export {
  buildSubagentLines,
  MAX_SUBAGENT_LINES,
  SubagentActivity,
} from './components/SubagentActivity.js';
export {
  pagerRows,
  shouldPageOutput,
  TextViewer,
  type TextViewerProps,
} from './components/TextViewer.js';
export {
  DEFAULT_TOOL_DISPLAY,
  makeToolCallView,
  type ToolDisplayDefinition,
  ToolDisplayRegistry,
  toolDisplayRegistry,
} from './components/ToolDisplay.js';
export {
  buildTrail,
  ToolTrail,
  type TrailLine,
  type TrailTone,
  type TrailView,
} from './components/ToolTrail.js';
export {
  buildToolCard,
  formatDuration,
  formatTokens,
  type ItemTone,
  type ToolCardLine,
  type ToolCardOptions,
  type ToolCardView,
  toneColor,
  UiItemView,
  type UiItemViewProps,
} from './components/UiItemView.js';
export {
  reduceUpdateState,
  UpdateBanner,
  type UpdateBannerState,
} from './components/UpdateBanner.js';
// 错误分类器
export {
  type ClassifiedError,
  classifyError,
  type ErrorCategory,
  formatClassifiedError,
} from './error-classifier.js';
export { formatPermissionQuestion, type ToolOrigin } from './renderer/tool-confirm.js';
export {
  buildAgentRegistry,
  buildAgentTree,
  countActiveAgents,
  matchAgents,
  reduceAgentRegistry,
  sortAgentNodes,
  toAgentSummary,
  useAgentRegistry,
} from './repl/agent-registry.js';
// Ink 版本（React 组件式 UI）
export {
  CLEAR_ON_START_SEQUENCE,
  maybeClearOnStart,
  shouldClearOnStart,
} from './repl/clear-on-start.js';
export { startInkRepl } from './repl/ink-repl.js';
export {
  BOTTOM_BAR_ROWS,
  computeLiveLayout,
  defaultBottomBarVisible,
  type LiveLayout,
  type LiveMode,
  OVERLAY_LIVE_ROWS,
  type OverlayKind,
  queuePreviewRows,
  showsQuickHint,
} from './repl/layout.js';
export {
  createUiProjection,
  fullTextOfItem,
  type PermissionDecision,
  projectMessagesToUiItems,
  projectUiItems,
  type RunUsage,
  readErrorEnvelope,
  reduceUiProjection,
  resetUiProjection,
  type ToolCallStatus,
  type ToolCallView,
  type UiItem,
  type UiProjectionState,
} from './repl/project/ui-item.js';
export {
  executeResume,
  executeTurn,
  type TurnOutcome,
} from './repl/run-turn.js';
export {
  INITIAL_RUNTIME_COUNTERS,
  type RuntimeCounters,
  reduceRuntimeCounters,
  useRuntimeCounters,
} from './repl/runtime-counters.js';
export {
  buildSessionSummary,
  buildStartupHeader,
  frameStartupLines,
  type SessionSummaryFacts,
  STARTUP_TAGLINE,
  type StartupHeaderInput,
  WORDMARK_5,
} from './repl/startup-header.js';
export {
  buildStartupNotice,
  loadStartupFacts,
  loadStartupNotice,
  type StartupFacts,
  type StartupNoticeInput,
} from './repl/startup-notice.js';
export {
  applyStatusBarToggle,
  type BottomBarData,
  fitSegments,
  formatBottomBar,
  formatPathLabel,
  MARQUEE_PAUSE_MS,
  MARQUEE_TICK_MS,
  marqueeOffset,
  marqueeWindow,
  matchStatusBarHotkey,
  middleEllipsisPath,
  parseStatusBars,
  resolveInitialStatusBars,
  type StatusBarsValue,
  type StatusBarsVisibility,
  statusBarsValue,
  statusBarsVisibility,
} from './repl/status-format.js';
export type {
  CapabilityManifestLike,
  CapabilityMethodLike,
  CapabilityPluginLike,
  CapabilityToolLike,
  DurableRunHandle,
  DurableRunOutcome,
  DurableRunSummary,
  DurableRunsControl,
  FeishuControlLike,
  FeishuStatusLike,
  McpControl,
  McpServerSummary,
  MetricsSnapshotLike,
  PermissionsControl,
  ReplContext,
  ReplErrorLevel,
  ReplSettingsControl,
  ReplVerbosity,
  RpcClientLike,
  RpcErrorCodeLike,
  RpcErrorLike,
  RpcEventNotificationLike,
  TenantInfoLike,
  TenantQuotaLike,
  TenantSummaryLike,
} from './repl-context.js';
export {
  buildBanner,
  buildSessionTable,
  divider,
  infoPanel,
} from './rich-renderer.js';
export {
  formatRpcError,
  isRpcError,
  isRpcErrorCode,
  RPC_ERROR_CODES,
  readRpcCode,
  redactForDisplay,
} from './rpc.js';
export {
  type CompletionWaiter,
  type PollOptions,
  pollRunCompletion,
  type RunCompletionOutcome,
  type RunCompletionStatus,
  waitForRunCompletion,
} from './rpc-events.js';
// Git 工具
export { getCurrentGitBranch } from './utils/git.js';
// 命令视图（CommandView）纯数据与渲染工具
export {
  COLUMN_GAP,
  formatTableHeader,
  formatTableRow,
  priorityThreshold,
  resolveColumns,
  scrollWindow,
  TABLE_PREFIX_WIDTH,
  viewContentWidth,
  viewWidth,
  widthClass,
} from './views/layout.js';
export { type RenderTextOptions, renderViewAsText } from './views/render-text.js';
export {
  buildSessionPickerView,
  buildSessionRows,
  filterSessions as filterSessionsForPicker,
  sessionColumns,
  sessionPickerActions,
  sortSessionsForPicker,
} from './views/session-picker.js';
export type {
  CommandView,
  ConfirmView,
  DetailField,
  DetailSection,
  DetailView,
  FormField,
  FormView,
  ListView,
  TableView,
  ViewAction,
  ViewActionInvocation,
  ViewColumn,
  ViewEnvelope,
  ViewMode,
  ViewRow,
  ViewTone,
} from './views/types.js';
export type { SetupWizardConfig } from './wizard/setup-wizard.js';
export { runSetupWizard, SetupWizard } from './wizard/setup-wizard.js';
