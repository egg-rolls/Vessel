/**
 * /feishu —— 打印 FeishuStatus
 * @module @vessel/tui
 *
 * 只读：渠道生命周期归 asm 的 --feishu；TUI 只展示状态。
 * 只使用 appIdMasked，绝不展示 app_id / app_secret / token。
 */

import { classifyError, formatClassifiedError } from '../error-classifier.js';
import type { FeishuStatusLike, ReplContext } from '../repl-context.js';
import type { CommandEntry, CommandResult } from './commands.js';

const ERROR_MAX = 80;

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 纯函数：飞书状态单行摘要（不含换行） */
export function formatFeishuStatus(status: FeishuStatusLike): string {
  const base = [
    `Feishu: ${status.connected ? 'connected' : 'disconnected'}`,
    `appId ${status.appIdMasked || '-'}`,
    `active chats ${status.active_chats}`,
    `queued ${status.queued_messages}`,
  ].join(' · ');

  return status.last_error
    ? `${base} · last error ${truncate(oneLine(status.last_error), ERROR_MAX)}`
    : base;
}

/** /feishu 的执行体（导出供单测） */
export function runFeishuCommand(args: string[], ctx: ReplContext): CommandResult {
  if (args.length > 0) return { handled: true, output: '\nUsage: /feishu\n' };

  if (!ctx.feishu) {
    return {
      handled: true,
      output: '\nFeishu is not enabled (feishu.enabled: false).\n',
    };
  }

  try {
    return { handled: true, output: `\n${formatFeishuStatus(ctx.feishu.status())}\n` };
  } catch (error) {
    return {
      handled: true,
      output: `\nFailed to read Feishu status:\n${formatClassifiedError(classifyError(error))}\n`,
    };
  }
}

export function feishuCommand(): CommandEntry {
  return {
    name: 'feishu',
    description: 'Show Feishu channel status',
    usage: '/feishu',
    run: (args, ctx) => runFeishuCommand(args, ctx),
  };
}
