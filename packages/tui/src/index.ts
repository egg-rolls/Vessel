/**
 * @vessel/tui - 终端交互界面
 * @module @vessel/tui
 *
 * 调用 core + config，提供终端交互。
 * 无基础用户入口。
 * 使用 Ink 框架实现 React 组件式终端 UI。
 */

// Ink 版本（React 组件式 UI）
export { startInkRepl } from './repl/ink-repl.js';

// 错误分类器
export { classifyError, type ErrorCategory, type ClassifiedError } from './error-classifier.js';

export type { ReplContext } from './repl-context.js';

export { createCommands, consumePendingResume, CommandRegistry } from './commands/commands.js';
export type {
  ReplState,
  CommandEntry,
  SubCommand,
  CommandResult,
} from './commands/commands.js';

export { SetupWizard, runSetupWizard } from './wizard/setup-wizard.js';
export type { SetupWizardConfig } from './wizard/setup-wizard.js';

export {
  buildBanner,
  buildSessionTable,
  infoPanel,
  divider,
} from './rich-renderer.js';

// Ink 组件
export { StatusBar } from './components/StatusBar.js';
export { StreamOutput } from './components/StreamOutput.js';
export { CommandMenu } from './components/CommandMenu.js';
export { ConfirmDialog } from './components/ConfirmDialog.js';
export { SessionTable } from './components/SessionTable.js';
