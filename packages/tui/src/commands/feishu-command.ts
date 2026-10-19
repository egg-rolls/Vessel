/**
 * /feishu —— 打印 FeishuStatus
 * @module @vessel/tui
 *
 * 只读：渠道生命周期归 asm 的 --feishu；TUI 只展示状态。
 * 只使用 appIdMasked，绝不展示 app_id / app_secret / token。
 */

import type { FeishuStatusLike, ReplContext } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFeishuStatus(value: unknown): FeishuStatusLike | null {
  const raw = isRecord(value) && isRecord(value.status) ? value.status : value;
  if (!isRecord(raw) || typeof raw.connected !== 'boolean') return null;
  return {
    connected: raw.connected,
    appIdMasked: typeof raw.appIdMasked === 'string' ? raw.appIdMasked : '-',
    active_chats: typeof raw.active_chats === 'number' ? raw.active_chats : 0,
    queued_messages: typeof raw.queued_messages === 'number' ? raw.queued_messages : 0,
    ...(typeof raw.last_error === 'string' ? { last_error: raw.last_error } : {}),
  };
}

/** /feishu 的执行体（导出供单测） */
export async function runFeishuCommand(args: string[], ctx: ReplContext): Promise<CommandResult> {
  if (args.length > 0) return { handled: true, output: '\nUsage: /feishu\n' };

  if (ctx.rpc) {
    try {
      const raw = await ctx.rpc.request<unknown>('feishu.status');
      const status = readFeishuStatus(raw);
      if (!status) {
        return { handled: true, output: '\nFailed to read Feishu status: invalid payload.\n' };
      }
      return { handled: true, output: `\n${formatFeishuStatus(status)}\n` };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to read Feishu status:\n${formatRpcError(error)}\n`,
      };
    }
  }

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
      output: `\nFailed to read Feishu status:\n${formatRpcError(error)}\n`,
    };
  }
}

export function feishuCommand(): CommandEntry {
  return {
    name: 'feishu',
    description: 'Show Feishu channel status',
    usage: '/feishu',
    category: 'inspect',
    keywords: ['channel', 'status'],
    available: (ctx) => Boolean(ctx.feishu || ctx.rpc),
    run: (args, ctx) => runFeishuCommand(args, ctx),
  };
}
