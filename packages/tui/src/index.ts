/**
 * @vessel/tui - 终端交互界面
 * @module @vessel/tui
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
export { formatKeyHints, KeyHints, type KeyHintsProps } from './components/KeyHints.js';
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
export { StatusBar } from './components/StatusBar.js';
export { StreamOutput } from './components/StreamOutput.js';
export {
  reduceSubagentState,
  SubagentActivity,
  type SubagentState,
} from './components/SubagentActivity.js';
export {
  DEFAULT_TOOL_DISPLAY,
  type DisplayOptions,
  type ToolDisplayDefinition,
  ToolDisplayRegistry,
  toolDisplayRegistry,
} from './components/ToolDisplay.js';
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
// Ink 版本（React 组件式 UI）
export { startInkRepl } from './repl/ink-repl.js';
export {
  executeResume,
  executeTurn,
  executeWorkflow,
  type TurnOutcome,
  type WorkflowTurnOutcome,
} from './repl/run-turn.js';
export {
  buildStartupNotice,
  loadStartupNotice,
  type StartupNoticeInput,
} from './repl/startup-notice.js';
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
  RpcClientLike,
  RpcErrorCodeLike,
  RpcErrorLike,
  RpcEventNotificationLike,
  TenantInfoLike,
  TenantQuotaLike,
  TenantSummaryLike,
  WorkflowOutcomeLike,
  WorkflowRunDetailLike,
  WorkflowRunHandle,
  WorkflowRunStatusLike,
  WorkflowRunSummaryLike,
  WorkflowStartResultLike,
  WorkflowStepStatusLike,
  WorkflowStepSummaryLike,
  WorkflowsControl,
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
  type WorkflowCompletionOutcome,
  type WorkflowCompletionStatus,
  waitForRunCompletion,
  waitForWorkflowCompletion,
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
  VIEW_MAX_WIDTH,
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
