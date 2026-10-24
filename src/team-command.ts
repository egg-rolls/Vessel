/**
 * `vessel team list|get|post|members|budget`（0.19 S3 / S4）。
 *
 * 只做参数映射、roster 名字解析、渲染与 exit code；
 * Team 数据与投递全部在 REPL owner 的 TeamService。
 * `--json` 原样输出端点结果，人类输出走 ui-style，错误码进 stderr。
 *
 * @module vessel/team-command
 */

import type { CommandResult } from './agent-command';
import {
  AgentOwnerRequestError,
  AgentOwnerUnavailableError,
  callAgentOwner,
  resolveAgentOwner,
} from './agent-owner-client';
import type { AgentOwnerRecord } from './agent-owner-server';
import type { TeamCommand } from './cli-args';
import { ui } from './ui-style';

export interface TeamCommandOptions {
  dataDir: string;
  /** 显式 `--tenant`；与 owner 记录的 tenant 不一致时拒绝 */
  tenantId?: string;
  /** 测试注入 */
  isAlive?: (pid: number) => boolean;
  fetchImpl?: typeof fetch;
}

/** get 返回的成员条目（只读子集；服务端可能附加其它字段） */
interface TeamMemberView {
  agent_id: string;
  name?: string;
  session_id?: string;
  membership?: string;
  presence?: string;
  visibility?: string;
  /** 0.21：epoch ms；旧数据缺失 */
  last_seen?: number;
}

/** get 返回的消息条目（只读子集） */
interface TeamMessageView {
  message_id?: string;
  from?: string;
  content?: string;
  ts?: number;
  kind?: string;
}

/** list 返回的 Team 摘要（只读子集） */
interface TeamSummaryView {
  team_id?: string;
  name?: string;
  member_count?: number;
  online_count?: number;
  workspace?: string;
  description?: string;
  default_principal?: string;
}

/** post 返回的逐条投递结果（只读子集） */
interface TeamDeliveryView {
  agent_id?: string;
  status?: string;
  code?: string;
  reason?: string;
}

/** 人类输出里单条消息的最大宽度 */
const MESSAGE_MAX_CHARS = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = '-'): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 折叠换行并按字符数截断（数据行保持单行） */
function singleLine(value: string, max = MESSAGE_MAX_CHARS): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}...`;
}

function teamList(result: unknown): TeamSummaryView[] {
  const raw = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.teams)
      ? result.teams
      : [];
  return raw.filter(isRecord).map((entry) => entry as TeamSummaryView);
}

function teamMembers(result: unknown): TeamMemberView[] {
  if (!isRecord(result) || !Array.isArray(result.members)) return [];
  return result.members
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .filter((entry) => typeof entry.agent_id === 'string')
    .map((entry) => entry as unknown as TeamMemberView);
}

function teamMessages(result: unknown): TeamMessageView[] {
  if (!isRecord(result) || !Array.isArray(result.messages)) return [];
  return result.messages.filter(isRecord).map((entry) => entry as TeamMessageView);
}

function formatTeamList(result: unknown): string {
  const teams = teamList(result);
  if (teams.length === 0) return ui.dim('No teams.');
  const lines = [ui.section(`Teams (${teams.length}):`)];
  for (const team of teams) {
    lines.push(
      `  ${asString(team.team_id)}  ${asString(team.name)}  ${String(team.member_count ?? 0)} members  ${String(team.online_count ?? 0)} online  ${asString(team.workspace)}`,
    );
  }
  return lines.join('\n');
}

function formatTeamGet(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.team)) {
    return JSON.stringify(result, null, 2);
  }
  const team = result.team;
  const members = teamMembers(result);
  const messages = teamMessages(result);
  const lines: string[] = [
    ui.section(`Team ${asString(team.team_id)}`),
    ui.kv('name', asString(team.name)),
    ui.kv('description', asString(team.description, '')),
    ui.kv('default_principal', asString(team.default_principal, '')),
    ui.kv('workspace', asString(team.workspace)),
    ui.kv('members', String(team.member_count ?? members.length)),
    ui.kv('online', String(team.online_count ?? 0)),
  ];
  // 窗口大小 N 与完整 roster 总数 M 分开显示；缺失 member_count 时回退 N。
  const totalMembers = asNumber(team.member_count) ?? members.length;
  lines.push('', ui.section(`Members (${members.length} of ${totalMembers}):`));
  if (members.length === 0) {
    lines.push(`  ${ui.dim('No members.')}`);
  } else {
    for (const member of members) {
      const lastSeen =
        member.last_seen !== undefined ? new Date(member.last_seen).toISOString() : '';
      lines.push(
        `  ${asString(member.agent_id)}  ${asString(member.membership)}  ${asString(member.presence)}  ${asString(member.visibility)}  ${asString(member.name, '-')}  ${lastSeen}`,
      );
    }
  }
  lines.push('', ui.section(`Recent messages (${messages.length}):`));
  if (messages.length === 0) {
    lines.push(`  ${ui.dim('No messages.')}`);
  } else {
    for (const message of messages) {
      const ts = asNumber(message.ts);
      const when = ts !== undefined ? new Date(ts).toISOString() : '-';
      lines.push(
        `  ${when}  ${asString(message.from)}  [${asString(message.kind)}]  ${singleLine(asString(message.content, ''))}`,
      );
    }
  }
  return lines.join('\n');
}

function deliveriesOf(result: unknown): TeamDeliveryView[] {
  if (!isRecord(result) || !Array.isArray(result.delivered)) return [];
  return result.delivered.filter(isRecord).map((entry) => entry as TeamDeliveryView);
}

/** 逐条打印 delivery；返回是否有非 queued 项（决定 exit code） */
function formatPostResult(result: unknown): { text: string; failed: boolean } {
  if (!isRecord(result)) {
    return { text: JSON.stringify(result, null, 2), failed: false };
  }
  const deliveries = deliveriesOf(result);
  const failed = deliveries.some((delivery) => delivery.status !== 'queued');
  const lines: string[] = [`${ui.symbol('ok')} posted ${asString(result.message_id)}`];
  if (deliveries.length === 0) {
    lines.push(`  ${ui.symbol('info')} no mentions; message logged only`);
  }
  for (const delivery of deliveries) {
    const agentId = asString(delivery.agent_id);
    const status = asString(delivery.status, 'error');
    if (status === 'queued') {
      lines.push(`  ${ui.symbol('ok')} ${agentId} queued`);
      continue;
    }
    const detail =
      delivery.code !== undefined || delivery.reason !== undefined
        ? `${asString(delivery.code, status)}: ${asString(delivery.reason, '-')}`
        : status;
    lines.push(`  ${ui.symbol('err')} ${agentId} ${status} ${detail}`);
  }
  return { text: lines.join('\n'), failed };
}

function formatMembersResult(result: unknown): string {
  if (!isRecord(result)) return JSON.stringify(result, null, 2);
  return [
    ui.kv('team_id', asString(result.team_id)),
    ui.kv('action', asString(result.action)),
    ui.kv('agent_id', asString(result.agent_id)),
    ui.kv('membership', asString(result.membership)),
  ].join('\n');
}

function numeric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-';
}

function budgetConversations(result: unknown): Record<string, unknown>[] {
  if (!isRecord(result) || !Array.isArray(result.conversations)) return [];
  return result.conversations.filter(isRecord);
}

function formatBudgetStatus(result: unknown): string {
  if (!isRecord(result)) return JSON.stringify(result, null, 2);
  const lines: string[] = [ui.section(`Team ${asString(result.team_id)}`)];
  const conversations = budgetConversations(result);
  if (conversations.length === 0) {
    lines.push(`  ${ui.dim('No conversations.')}`);
    return lines.join('\n');
  }
  for (const conversation of conversations) {
    lines.push(`  ${asString(conversation.conversation_id)}`);
    lines.push(
      `    hops ${numeric(conversation.hops)}  turns ${numeric(conversation.turns)}  tokens ${numeric(conversation.total_tokens)}  wall_clock_ms ${numeric(conversation.wall_clock_ms)}`,
    );
    const blocked = conversation.blocked;
    lines.push(
      isRecord(blocked)
        ? `    blocked ${asString(blocked.dimension)} ${asString(blocked.reason)}`
        : '    blocked -',
    );
    const overrides = isRecord(conversation.overrides) ? conversation.overrides : {};
    const entries = Object.entries(overrides).filter(
      (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
    );
    if (entries.length === 0) {
      lines.push('    overrides -');
      continue;
    }
    for (const [dimension, override] of entries) {
      lines.push(
        `    overrides ${dimension}=${numeric(override.max)} (${asString(override.by)} via ${asString(override.via)})`,
      );
    }
  }
  return lines.join('\n');
}

function formatBudgetOverride(result: unknown): string {
  if (!isRecord(result)) return JSON.stringify(result, null, 2);
  const previous = result.previous_max === null ? 'policy' : numeric(result.previous_max);
  const max = result.max === null ? 'unlimited' : numeric(result.max);
  return [
    `${ui.symbol('ok')} budget override ${asString(result.conversation_id)}`,
    ui.kv('team_id', asString(result.team_id)),
    ui.kv('dimension', asString(result.dimension)),
    ui.kv('previous', previous),
    ui.kv('max', max),
  ].join('\n');
}

/**
 * 把 `--mention` 的 name|id 解析为 agent id：
 * 精确 agent_id / session_id 优先，其次 Team 内唯一 name。
 */
function resolveMentions(
  members: TeamMemberView[],
  mentions: string[],
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const ids: string[] = [];
  for (const mention of mentions) {
    const byId = members.filter(
      (member) => member.agent_id === mention || member.session_id === mention,
    );
    if (byId.length > 1) {
      return {
        ok: false,
        error: `ambiguous team member: "${mention}" (matches multiple ids)`,
      };
    }
    if (byId.length === 1) {
      const id = byId[0]?.agent_id;
      if (id !== undefined && !ids.includes(id)) ids.push(id);
      continue;
    }

    const byName = members.filter((member) => member.name === mention);
    if (byName.length === 0) {
      return {
        ok: false,
        error: `unknown team member: "${mention}" (not an agent id, session id, or present name)`,
      };
    }
    if (byName.length > 1) {
      return {
        ok: false,
        error: `ambiguous team member: "${mention}" (matches ${byName.length} members)`,
      };
    }
    const id = byName[0]?.agent_id;
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

/** 执行一个 team 子命令；不抛错，错误转 exitCode / stderr */
export async function runTeamCommand(
  command: TeamCommand,
  options: TeamCommandOptions,
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

  try {
    const result = await execute(command, record, options);
    if (!result.ok) return { exitCode: 1, stdout: '', stderr: result.error };
    if (command.json) {
      return {
        exitCode: result.exitCode ?? 0,
        stdout: JSON.stringify(result.value, null, 2),
        stderr: '',
      };
    }
    return { exitCode: result.exitCode ?? 0, stdout: result.text ?? '', stderr: '' };
  } catch (error) {
    return failure(error);
  }
}

type Executed =
  | { ok: true; value: unknown; text?: string; exitCode?: number }
  | { ok: false; error: string };

async function execute(
  command: TeamCommand,
  record: AgentOwnerRecord,
  options: TeamCommandOptions,
): Promise<Executed> {
  const fetchOptions = options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {};

  if (command.kind === 'list') {
    const value = await callAgentOwner(record, 'team.list', {}, fetchOptions);
    return { ok: true, value, text: formatTeamList(value) };
  }

  if (command.kind === 'get') {
    const value = await callAgentOwner(
      record,
      'team.get',
      {
        team_id: command.teamId,
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.members !== undefined ? { members_limit: command.members } : {}),
      },
      fetchOptions,
    );
    return { ok: true, value, text: formatTeamGet(value) };
  }

  if (command.kind === 'members') {
    const value = await callAgentOwner(
      record,
      'team.members',
      { team_id: command.teamId, action: command.action, member: command.member },
      fetchOptions,
    );
    return { ok: true, value, text: formatMembersResult(value) };
  }

  if (command.kind === 'budget-status') {
    const value = await callAgentOwner(
      record,
      'team.budget',
      {
        team_id: command.teamId,
        action: 'status',
        ...(command.conversationId !== undefined
          ? { conversation_id: command.conversationId }
          : {}),
      },
      fetchOptions,
    );
    return { ok: true, value, text: formatBudgetStatus(value) };
  }

  if (command.kind === 'budget-override') {
    const value = await callAgentOwner(
      record,
      'team.budget',
      {
        team_id: command.teamId,
        action: 'override',
        conversation_id: command.conversationId,
        dimension: command.dimension,
        max: command.max,
      },
      fetchOptions,
    );
    return { ok: true, value, text: formatBudgetOverride(value) };
  }

  // post：有 --mention 时用完整 roster 解析为 agent id（不受展示窗口 20 / 100 限制）。
  let mentionIds: string[] = [];
  if (command.mentions.length > 0) {
    const detail = await callAgentOwner(
      record,
      'team.roster',
      { team_id: command.teamId },
      fetchOptions,
    );
    const resolved = resolveMentions(teamMembers(detail), command.mentions);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    mentionIds = resolved.ids;
  }

  const value = await callAgentOwner(
    record,
    'team.post',
    {
      team_id: command.teamId,
      content: command.content,
      ...(mentionIds.length > 0 ? { mentions: mentionIds } : {}),
    },
    fetchOptions,
  );
  const rendered = formatPostResult(value);
  return { ok: true, value, text: rendered.text, exitCode: rendered.failed ? 1 : 0 };
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
