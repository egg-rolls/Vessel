/**
 * /permissions —— 持久化免确认工具列表
 * @module @vessel-agent/tui
 *
 * 写回接口由 asm 注入（PermissionsControl -> 用户 YAML permission.auto_approve）。
 * 未注入时只读展示 config；明确提示重启后生效。
 */

import { t } from '../i18n/index.js';
import type { ReplContext } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import type { CommandEntry, CommandResult } from './commands.js';

/** config 里的权限段（asm 0.6.1 才加类型；这里用结构类型避免跨分支耦合） */
interface PermissionConfigLike {
  autoApprove?: string[];
  /** YAML permission.auto_approve 的 snake_case 形态 */
  auto_approve?: string[];
}

/** 纯函数：读取 config.permission.autoApprove / auto_approve（去重排序） */
export function configuredAutoApprove(ctx: ReplContext): string[] {
  const permission = (ctx.config as { permission?: PermissionConfigLike }).permission;
  const entries = permission?.autoApprove ?? permission?.auto_approve ?? [];
  return [...new Set(entries)].sort();
}

async function loadAutoApprove(ctx: ReplContext): Promise<string[]> {
  if (ctx.permissions) return [...new Set(await ctx.permissions.list())].sort();
  return configuredAutoApprove(ctx);
}

function usage(): CommandResult {
  return {
    handled: true,
    output: '\nUsage: /permissions [list|add <tool>|remove <tool>]\n',
  };
}

export async function runPermissionsCommand(
  args: string[],
  ctx: ReplContext,
): Promise<CommandResult> {
  const [subcommand, tool, ...rest] = args;
  if (subcommand === undefined || subcommand === 'list' || subcommand === 'ls') {
    try {
      const entries = await loadAutoApprove(ctx);
      const lines = ['', 'Auto-approved tools (permission.auto_approve):'];
      if (entries.length === 0) {
        lines.push('  (none)');
      } else {
        for (const entry of entries) lines.push(`  - ${entry}`);
      }
      const path = ctx.permissions?.path?.();
      if (path) lines.push('', `User config: ${path}`);
      lines.push(
        '',
        ctx.permissions
          ? 'Changes are written to user YAML and take effect on restart (current session: "always" remembers immediately).'
          : 'Read-only: config write-back is not available in this shell; edit user YAML and restart.',
        '',
      );
      return { handled: true, output: lines.join('\n') };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to read permission.auto_approve:\n${formatRpcError(error)}\n`,
      };
    }
  }

  if (subcommand === 'add' || subcommand === 'remove') {
    if (!tool || rest.length > 0) return usage();
    if (!ctx.permissions) {
      return {
        handled: true,
        output:
          '\nPermission write-back is not available (requires the vessel control plane). Edit user YAML manually.\n',
      };
    }
    try {
      if (subcommand === 'add') await ctx.permissions.add(tool);
      else await ctx.permissions.remove(tool);
      const entries = await loadAutoApprove(ctx);
      const path = ctx.permissions.path?.();
      return {
        handled: true,
        output: [
          '',
          `${subcommand === 'add' ? 'Added' : 'Removed'} "${tool}" ${subcommand === 'add' ? 'to' : 'from'} permission.auto_approve.`,
          `Current entries: ${entries.length > 0 ? entries.join(', ') : '(none)'}`,
          ...(path ? [`User config: ${path}`] : []),
          'Takes effect on restart; "always" already covers the current session.',
          '',
        ].join('\n'),
      };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to ${subcommand} "${tool}":\n${formatRpcError(error)}\n`,
      };
    }
  }

  return usage();
}

export function permissionsCommand(): CommandEntry {
  return {
    name: 'permissions',
    description: t('command.permissions.description'),
    usage: '/permissions [list|add <tool>|remove <tool>]',
    category: 'inspect',
    keywords: ['permissions', 'auto approve', 'always', 'config'],
    run: (args, ctx) => runPermissionsCommand(args, ctx),
  };
}
