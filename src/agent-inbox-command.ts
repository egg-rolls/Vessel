/**
 * `vessel agent inbox <member> [--json]`（0.32）。
 *
 * 只读本地 inbox 文件，不触达 owner RPC、不写文件：
 * 缺失 = 空列表，损坏 = `agent_inbox_corrupt` 且保持文件原样。
 *
 * @module vessel/agent-inbox-command
 */

import { readFileSync } from 'node:fs';
import { inboxPath } from '@vessel-agent/agent';
import type { CommandResult } from './agent-command';
import {
  AgentOwnerRequestError,
  AgentOwnerUnavailableError,
  resolveAgentOwner,
} from './agent-owner-client';
import type { AgentCommand } from './cli-args';
import { ui } from './ui-style';

export interface AgentInboxCommandOptions {
  dataDir: string;
  tenantId?: string;
}

interface InboxViewMessage {
  id: string;
  ts: number;
  source: string;
  status: string;
  important: boolean;
  summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: unknown): CommandResult {
  if (error instanceof AgentOwnerUnavailableError || error instanceof AgentOwnerRequestError) {
    return { exitCode: 1, stdout: '', stderr: `${error.code}: ${error.message}` };
  }
  return { exitCode: 1, stdout: '', stderr: `agent_owner_error: ${errorText(error)}` };
}

function corrupt(message: string): CommandResult {
  return { exitCode: 1, stdout: '', stderr: `agent_inbox_corrupt: ${message}` };
}

/** 宽松读取：缺失字段用安全默认值；永不暴露 text。 */
function viewMessage(value: unknown): InboxViewMessage {
  const entry: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    ts: typeof entry.ts === 'number' && Number.isFinite(entry.ts) ? entry.ts : 0,
    source: typeof entry.source === 'string' ? entry.source : '',
    status: typeof entry.status === 'string' ? entry.status : '',
    important: entry.important === true,
    summary: typeof entry.summary === 'string' ? entry.summary : '',
  };
}

/** 只读列出本地 inbox；不写文件、不调用 RPC。 */
export async function runAgentInboxCommand(
  command: Extract<AgentCommand, { kind: 'inbox' }>,
  options: AgentInboxCommandOptions,
): Promise<CommandResult> {
  let tenantId: string;
  if (options.tenantId !== undefined) {
    tenantId = options.tenantId;
  } else {
    try {
      const record = await resolveAgentOwner(options.dataDir);
      tenantId = record.tenant_id;
    } catch (error) {
      return failure(error);
    }
  }

  const path = inboxPath(options.dataDir, tenantId, command.member);
  let raw: string | undefined;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      raw = undefined;
    } else {
      return corrupt(errorText(error));
    }
  }

  const messages: InboxViewMessage[] = [];
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return corrupt(`invalid JSON: ${errorText(error)}`);
    }
    if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.messages)) {
      return corrupt('unexpected inbox file shape');
    }
    for (const entry of parsed.messages) messages.push(viewMessage(entry));
  }

  const unread = messages.filter((message) => message.status === 'unread').length;
  if (command.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          agent_id: command.member,
          tenant_id: tenantId,
          unread,
          total: messages.length,
          messages,
        },
        null,
        2,
      ),
      stderr: '',
    };
  }

  const header = `Inbox ${command.member} (${unread} unread / ${messages.length})`;
  const lines = [ui.section(header)];
  for (const message of messages) {
    const important = message.important ? ' [!]' : '';
    lines.push(`  ${message.status}  ${message.id}${important}  ${message.summary}`);
  }
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
