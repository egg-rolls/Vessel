/**
 * `vessel agent new|send|close|list|dispatch|rotate`（0.17 Phase A；0.19 dispatch / rotate）。
 *
 * 只做参数映射与渲染；生命周期全部在 REPL owner 的 AgentService。
 * `--json` 原样输出端点结果，人类输出走 ui-style，错误码进 stderr。
 *
 * @module vessel/agent-command
 */

import type { MemberStatus } from '@vessel-agent/agent';
import {
  AgentOwnerRequestError,
  AgentOwnerUnavailableError,
  callAgentOwner,
  resolveAgentOwner,
} from './agent-owner-client';
import type { AgentOwnerMethod, AgentOwnerRecord } from './agent-owner-server';
import type { AgentCommand } from './cli-args';
import { ui } from './ui-style';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AgentCommandOptions {
  dataDir: string;
  /** 显式 `--tenant`；与 owner 记录的 tenant 不一致时拒绝 */
  tenantId?: string;
  /** 测试注入 */
  isAlive?: (pid: number) => boolean;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusView(value: unknown): MemberStatus | undefined {
  return isRecord(value) && typeof value.id === 'string'
    ? (value as unknown as MemberStatus)
    : undefined;
}

function formatStatus(status: MemberStatus): string {
  const lines = [`${ui.symbol('ok')} ${ui.brand(status.id)} ${status.state}`];
  if (status.presence !== undefined) lines.push(ui.kv('presence', status.presence));
  if (status.membership !== undefined) lines.push(ui.kv('membership', status.membership));
  if (status.epoch !== undefined) lines.push(ui.kv('epoch', String(status.epoch)));
  lines.push(ui.kv('session', status.session_id));
  if (status.name !== undefined) lines.push(ui.kv('name', status.name));
  lines.push(ui.kv('visibility', status.visibility));
  lines.push(ui.kv('owner', status.owner));
  if (status.parent_id !== undefined) lines.push(ui.kv('parent', status.parent_id));
  return lines.join('\n');
}

function formatList(statuses: MemberStatus[]): string {
  if (statuses.length === 0) return ui.dim('No agents.');
  const lines = [ui.section(`Agents (${statuses.length}):`)];
  for (const status of statuses) {
    const name = status.name !== undefined ? `  ${status.name}` : '';
    const presence = status.presence ?? '-';
    lines.push(`  ${status.id}  ${status.state}  ${presence}  ${status.visibility}${name}`);
  }
  return lines.join('\n');
}

function formatCloseResult(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.results)) {
    const lines: string[] = [];
    result.results.forEach((entry, index) => {
      if (isRecord(entry) && entry.ok === true) {
        lines.push(`${ui.symbol('ok')} member ${index + 1}: closed`);
      } else {
        const message = isRecord(entry) && typeof entry.error === 'string' ? entry.error : 'failed';
        lines.push(`${ui.symbol('err')} member ${index + 1}: ${message}`);
      }
    });
    return lines.join('\n');
  }
  return `${ui.symbol('ok')} closed`;
}

function methodParams(command: AgentCommand): {
  method: AgentOwnerMethod;
  params: Record<string, unknown>;
} {
  if (command.kind === 'new') {
    return {
      method: 'agents.create',
      params: {
        agents: [
          {
            ...(command.name !== undefined ? { name: command.name } : {}),
            ...(command.model !== undefined ? { model: command.model } : {}),
            ...(command.visibility !== undefined ? { visibility: command.visibility } : {}),
            ...(command.systemPrompt !== undefined ? { system_prompt: command.systemPrompt } : {}),
            ...(command.workspace !== undefined ? { workspace: command.workspace } : {}),
          },
        ],
      },
    };
  }
  if (command.kind === 'send') {
    return {
      method: 'agents.send',
      params: { messages: [{ to: command.member, content: command.content }] },
    };
  }
  if (command.kind === 'dispatch') {
    return {
      method: 'agents.dispatch',
      params: {
        messages: [
          {
            to: command.to,
            content: command.content,
            ...(command.allowFork !== undefined ? { allow_fork: command.allowFork } : {}),
          },
        ],
      },
    };
  }
  if (command.kind === 'rotate') {
    return {
      method: 'agents.rotate',
      params: {
        agents: [
          {
            to: command.to,
            startup_prompt: command.startupPrompt,
            ...(command.handoffPath !== undefined ? { handoff_path: command.handoffPath } : {}),
          },
        ],
      },
    };
  }
  if (command.kind === 'close') {
    return {
      method: 'agents.close',
      params: { agents: command.members.map((agent_id) => ({ agent_id })) },
    };
  }
  return {
    method: 'agents.list',
    params: {
      ...(command.visibility !== undefined ? { visibility: command.visibility } : {}),
      ...(command.state !== undefined ? { state: command.state } : {}),
    },
  };
}

/** canonical 批量结果的第一条（CLI 单条调用 = 单元素数组）。 */
function firstResult(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result) || !Array.isArray(result.results)) return undefined;
  const first = result.results[0];
  return isRecord(first) ? first : undefined;
}

function firstResultStatus(result: unknown): MemberStatus | undefined {
  const item = firstResult(result);
  return item !== undefined ? statusView(item.agent) : undefined;
}

/** 失败条目的人类输出：`code: error`。 */
function failureLine(item: Record<string, unknown>): string {
  const code = typeof item.code === 'string' ? item.code : 'failed';
  const error = typeof item.error === 'string' ? item.error : code;
  return `${code}: ${error}`;
}

function agentList(result: unknown): MemberStatus[] | undefined {
  if (isRecord(result) && Array.isArray(result.agents)) {
    return result.agents as MemberStatus[];
  }
  return Array.isArray(result) ? (result as MemberStatus[]) : undefined;
}

function humanOutput(command: AgentCommand, result: unknown): string {
  if (command.kind === 'new') {
    const item = firstResult(result);
    if (item !== undefined && item.ok === true) {
      const status = firstResultStatus(result);
      return status ? formatStatus(status) : JSON.stringify(result, null, 2);
    }
    return item !== undefined ? failureLine(item) : JSON.stringify(result, null, 2);
  }
  if (command.kind === 'send') {
    const item = firstResult(result);
    if (item !== undefined && item.ok === true && typeof item.message_id === 'string') {
      return `${ui.symbol('ok')} queued ${item.message_id} → ${command.member} (${String(item.state ?? '')})`;
    }
    return item !== undefined ? failureLine(item) : JSON.stringify(result, null, 2);
  }
  if (command.kind === 'dispatch') {
    const item = firstResult(result);
    if (item !== undefined && item.ok === true && typeof item.message_id === 'string') {
      return `queued ${item.message_id} -> ${String(item.resolved_to)} (${String(item.resolution)})`;
    }
    return item !== undefined ? failureLine(item) : JSON.stringify(result, null, 2);
  }
  if (command.kind === 'rotate') {
    const item = firstResult(result);
    if (item !== undefined && item.ok === true) {
      return `rotated ${String(item.agent_id)} epoch ${String(item.epoch)} ${String(item.from_session_id)} -> ${String(item.to_session_id)}`;
    }
    return item !== undefined ? failureLine(item) : JSON.stringify(result, null, 2);
  }
  if (command.kind === 'close') return formatCloseResult(result);
  const statuses = agentList(result);
  return statuses !== undefined ? formatList(statuses) : JSON.stringify(result, null, 2);
}

/** 执行一个 agent 子命令；不抛错，错误转 exitCode / stderr */
export async function runAgentCommand(
  command: AgentCommand,
  options: AgentCommandOptions,
): Promise<CommandResult> {
  let record: AgentOwnerRecord;
  try {
    record = await resolveAgentOwner(options.dataDir, {
      ...(options.isAlive !== undefined ? { isAlive: options.isAlive } : {}),
    });
  } catch (error) {
    return failure(error);
  }

  if (options.tenantId !== undefined && options.tenantId !== record.tenant_id) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `agent_owner_tenant_mismatch: owner serves tenant "${record.tenant_id}", not "${options.tenantId}"`,
    };
  }

  const { method, params } = methodParams(command);
  try {
    const result = await callAgentOwner(record, method, params, {
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    const stdout = command.json ? JSON.stringify(result, null, 2) : humanOutput(command, result);
    // 单条 send / dispatch / rotate / new 的逐条失败 → exit 1（close 保持批量汇总语义）。
    const single =
      command.kind === 'new' ||
      command.kind === 'send' ||
      command.kind === 'dispatch' ||
      command.kind === 'rotate';
    const item = single ? firstResult(result) : undefined;
    const rejected = item !== undefined && item.ok === false;
    return { exitCode: rejected ? 1 : 0, stdout, stderr: '' };
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown): CommandResult {
  if (error instanceof AgentOwnerUnavailableError || error instanceof AgentOwnerRequestError) {
    return { exitCode: 1, stdout: '', stderr: `${error.code}: ${error.message}` };
  }
  return {
    exitCode: 1,
    stdout: '',
    stderr: `agent_owner_error: ${error instanceof Error ? error.message : String(error)}`,
  };
}
