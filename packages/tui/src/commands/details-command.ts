/**
 * /details：Tool trail 三态（R0 §4.4）
 * @module @vessel/tui
 */

import type { CommandEntry, CommandResult, ReplState, ToolDetailMode } from './commands.js';

export const TOOL_DETAIL_MODES: readonly ToolDetailMode[] = ['hidden', 'collapsed', 'expanded'];

export function isToolDetailMode(value: string): value is ToolDetailMode {
  return TOOL_DETAIL_MODES.includes(value as ToolDetailMode);
}

export function detailsCommand(): CommandEntry {
  return {
    name: 'details',
    description: 'Tool trail 详细程度：hidden | collapsed | expanded',
    usage: '/details [hidden|collapsed|expanded]',
    category: 'config',
    keywords: ['details', 'tool', 'trail', 'verbose'],
    run: (args, _ctx, state: ReplState): CommandResult => {
      const requested = (args[0] ?? '').toLowerCase();
      const current = state.toolDetailMode ?? 'collapsed';

      if (!requested) {
        return {
          handled: true,
          output: `Tool trail: ${current} (hidden | collapsed | expanded)`,
        };
      }

      if (!isToolDetailMode(requested)) {
        return {
          handled: true,
          output: `Unknown mode: ${requested}. Usage: /details [hidden|collapsed|expanded]`,
        };
      }

      return {
        handled: true,
        nextState: { toolDetailMode: requested },
        output: `Tool trail: ${requested}.`,
      };
    },
  };
}
