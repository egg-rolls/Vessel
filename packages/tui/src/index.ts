/**
 * @vessel/tui - 终端交互界面
 * @module @vessel/tui
 *
 * 调用 core + config，提供终端交互。
 * 无基础用户入口。
 * 使用 Ink 框架实现 React 组件式终端 UI。
 */

export type {
  CommandEntry,
  CommandResult,
  ReplState,
} from './commands/commands.js';
export {
  CommandRegistry,
  consumePendingResume,
  createCommands,
  doResume,
} from './commands/commands.js';
export { ConfirmDialog } from './components/ConfirmDialog.js';
export {
  type CommandEnterDecision,
  type CommandItem,
  decideCommandEnter,
  filterCommands,
  InlineAutocomplete,
} from './components/InlineAutocomplete.js';
export { SessionTable } from './components/SessionTable.js';
// Ink 组件
export { StatusBar } from './components/StatusBar.js';
export { StreamOutput } from './components/StreamOutput.js';
// 错误分类器
export { type ClassifiedError, classifyError, type ErrorCategory } from './error-classifier.js';
// Ink 版本（React 组件式 UI）
export { startInkRepl } from './repl/ink-repl.js';
export type { ReplContext } from './repl-context.js';
export {
  buildBanner,
  buildSessionTable,
  divider,
  infoPanel,
} from './rich-renderer.js';
export type { SseBridge } from './sse-bridge.js';
// SSE Bridge
export { startSseBridge } from './sse-bridge.js';
// Git 工具
export { getCurrentGitBranch } from './utils/git.js';
export type { SetupWizardConfig } from './wizard/setup-wizard.js';
export { runSetupWizard, SetupWizard } from './wizard/setup-wizard.js';
