/**
 * @vessel/tui - 终端交互界面
 * @module @vessel/tui
 *
 * 调用 core + config，提供终端交互。
 * 无基础用户入口。
 */

export { startRepl } from './repl/repl.js';
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
