/**
 * /export —— 导出当前会话
 * @module @vessel/tui
 *
 * 默认 Markdown（`/export [path]`），`--json` 输出结构化消息。
 * 文件名默认 `vessel-session-<id>.md`（写当前工作目录）。
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { t } from '../i18n/index.js';
import type { ReplContext } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import type { CommandEntry, CommandResult, ReplState } from './commands.js';
import { getSessionState, type SessionMessageLike } from './sessions-command.js';

interface ExportOptions {
  path?: string;
  json: boolean;
  reasoning: boolean;
}

function parseExportArgs(
  args: string[],
  state: ReplState,
): { ok: true; value: ExportOptions } | { ok: false; message: string } {
  let path: string | undefined;
  let json = false;
  let reasoning = state.showReasoning ?? false;

  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--reasoning') {
      reasoning = true;
      continue;
    }
    if (arg === '--no-reasoning') {
      reasoning = false;
      continue;
    }
    if (arg.startsWith('-')) {
      return {
        ok: false,
        message: `Usage: /export [path] [--json] [--reasoning|--no-reasoning] (unknown "${arg}")`,
      };
    }
    if (path !== undefined) {
      return { ok: false, message: 'Usage: /export [path] [--json] (only one path)' };
    }
    path = arg;
  }

  return { ok: true, value: { ...(path !== undefined ? { path } : {}), json, reasoning } };
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 96) || 'session';
}

function toolCallSummary(message: SessionMessageLike): string | null {
  if (!message.tool_calls?.length) return null;
  return message.tool_calls
    .map((call) => {
      const name = call.function?.name ?? 'unknown';
      const args = (call.function?.arguments ?? '').replace(/\s+/g, ' ').trim();
      return `- \`${name}\` ${args.length > 300 ? `${args.slice(0, 300)}…` : args}`;
    })
    .join('\n');
}

/** 纯函数：会话 -> Markdown */
export function formatSessionMarkdown(
  sessionId: string,
  messages: SessionMessageLike[],
  options: { reasoning?: boolean; exportedAt?: number } = {},
): string {
  const lines = [
    `# Vessel session ${sessionId}`,
    '',
    `- exported: ${new Date(options.exportedAt ?? Date.now()).toISOString()}`,
    `- messages: ${messages.length}`,
    '',
  ];

  for (const message of messages) {
    const heading =
      message.role === 'assistant'
        ? 'Assistant'
        : message.role === 'user'
          ? 'User'
          : message.role === 'tool'
            ? `Tool${message.name ? ` (${message.name})` : ''}`
            : message.role;
    lines.push(`## ${heading}`, '');
    if (options.reasoning && message.reasoning_content) {
      lines.push(
        '<details><summary>reasoning</summary>',
        '',
        message.reasoning_content,
        '',
        '</details>',
        '',
      );
    }
    if (message.content) lines.push(message.content, '');
    const calls = toolCallSummary(message);
    if (calls) lines.push('Tool calls:', '', calls, '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** 纯函数：会话 -> JSON 文本 */
export function formatSessionJson(
  sessionId: string,
  messages: SessionMessageLike[],
  options: { exportedAt?: number } = {},
): string {
  return JSON.stringify(
    {
      session_id: sessionId,
      exported_at: new Date(options.exportedAt ?? Date.now()).toISOString(),
      messages,
    },
    null,
    2,
  );
}

export async function runExportCommand(
  args: string[],
  ctx: ReplContext,
  state: ReplState,
): Promise<CommandResult> {
  const parsed = parseExportArgs(args, state);
  if (!parsed.ok) return { handled: true, output: `\n${parsed.message}\n` };

  const loaded = await getSessionState(ctx, state.currentSessionId);
  if (!loaded) {
    return { handled: true, output: '\nSession history not found; nothing to export.\n' };
  }

  const options = parsed.value;
  const extension = options.json ? 'json' : 'md';
  const target =
    options.path ?? `vessel-session-${sanitizeFileName(state.currentSessionId)}.${extension}`;
  const absolute = resolve(process.cwd(), target);
  const body = options.json
    ? formatSessionJson(state.currentSessionId, loaded.messages)
    : formatSessionMarkdown(state.currentSessionId, loaded.messages, {
        reasoning: options.reasoning,
      });

  try {
    await writeFile(absolute, body, 'utf-8');
    return {
      handled: true,
      output: `\nExported ${loaded.messages.length} message(s) to ${absolute}\n`,
    };
  } catch (error) {
    return {
      handled: true,
      output: `\nFailed to export session:\n${formatRpcError(error)}\n`,
    };
  }
}

export function exportCommand(): CommandEntry {
  return {
    name: 'export',
    description: t('command.export.description'),
    usage: '/export [path] [--json] [--reasoning|--no-reasoning]',
    category: 'session',
    keywords: ['export', 'save', 'markdown', 'json'],
    run: (args, ctx, state) => runExportCommand(args, ctx, state),
  };
}
