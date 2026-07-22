/**
 * @vessel/tui - 终端交互界面
 * @module @vessel/tui
 *
 * 调用 core + config，提供终端交互。
 * 无基础用户入口。
 */

export { CLI_REPL } from './repl/repl.js';
export type { REPLConfig, REPLState } from './repl/repl.js';

export { CommandRegistry, createDefaultCommands } from './commands/commands.js';
export type { CommandHandler } from './commands/commands.js';
