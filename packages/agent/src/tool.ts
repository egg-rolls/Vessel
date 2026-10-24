/**
 * 内置 `agent` 工具：模型侧唯一的成员生命周期入口。
 *
 * 只做参数映射与错误码格式化；registry、生命周期、批次并行都在 AgentService。
 * 不提供 wait / inbox / status / cancel——等待语义是结束这一轮、回复作为新 turn 到达。
 *
 * @module @vessel-agent/agent
 */

import type { ToolDefinition } from '@vessel-agent/core';
import {
  AgentError,
  type AgentService,
  type AgentTeamService,
  type BatchItemResult,
  type CloseInput,
  DEFAULT_OWNER,
  type DispatchResult,
  type ListFilter,
  type MemberState,
  type MemberVisibility,
  type NewMemberInput,
  type TeamAgentSendResult,
  TeamError,
  type TeamMemberSummary,
} from './types.js';

const ACTIONS = ['new', 'send', 'close', 'list', 'rotate', 'post'] as const;

/** 成员 Body 可用的动作；rotate 在动作闸门之前单独处理 */
const BODY_ACTIONS: readonly string[] = ['rotate', 'post', 'send', 'list'];

/** TeamService 的 identify 契约注释承诺带 team_id，但 TeamMemberSummary 尚未声明；按可选读取 */
type TeamCaller = TeamMemberSummary & { team_id?: string };

const VISIBILITIES: readonly MemberVisibility[] = ['private', 'team', 'tenant'];

const MEMBER_STATES: readonly MemberState[] = [
  'created',
  'idle',
  'running',
  'waiting_permission',
  'completed',
  'failed',
  'cancelled',
  'closed',
  'stale',
];

/** 与 AgentService 一致：对象且不是数组 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(message: string): AgentError {
  return new AgentError('invalid_input', message);
}

/** 错误串形状固定；message 已带 code 前缀时去重 */
function errorResult(error: unknown): string {
  if (!(error instanceof AgentError) && !(error instanceof TeamError)) {
    return `Error: invalid_input: ${errorText(error)}`;
  }
  const prefix = `${error.code}: `;
  const message = error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : error.message;
  return `Error: ${error.code}: ${message}`;
}

/** 逐条失败串：稳定 code 在前，异常消息不带前缀时补上 */
function batchErrorText(error: unknown): string {
  if (error instanceof AgentError || error instanceof TeamError) {
    const prefix = `${error.code}: `;
    return error.message.startsWith(prefix) ? error.message : `${prefix}${error.message}`;
  }
  return errorText(error);
}

/** dispatch / team.send 的逐条结果映射到既有 batch 形状 */
function mapSendOutcome(
  result: DispatchResult | TeamAgentSendResult,
): BatchItemResult<DispatchResult | TeamAgentSendResult> {
  if (result.status === 'queued') return { ok: true, status: result };
  const code = result.code ?? result.status;
  const reason = result.reason;
  const error =
    reason === undefined ? code : reason.startsWith(`${code}: `) ? reason : `${code}: ${reason}`;
  return { ok: false, error };
}

/** 单条字段与 batch 字段不能同时给 */
function assertExclusive(
  record: Record<string, unknown>,
  singles: readonly string[],
  batch: string,
  action: string,
): void {
  if (record[batch] === undefined) return;
  if (singles.some((key) => record[key] !== undefined)) {
    throw invalid(`${action}: pass either single ${singles.join('/')} or ${batch}, not both`);
  }
}

/** 读取 batch 数组参数；非数组或空数组直接拒绝 */
function readBatch(record: Record<string, unknown>, key: string, action: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw invalid(`${action}: ${key} must be an array`);
  if (value.length === 0) throw invalid(`${action}: ${key} must not be empty`);
  return value;
}

/**
 * 只拷已知键并转 camelCase；owner / parent 固定为工具的 owner，模型不能伪造。
 * 值不做类型校验：batch 要由 AgentService 逐条拒绝，不能在映射阶段整批抛错。
 */
function mapNew(record: Record<string, unknown>, ownerId: string): Record<string, unknown> {
  const input: Record<string, unknown> = { owner: ownerId, parentId: ownerId };
  if (record.name !== undefined) input.name = record.name;
  if (record.model !== undefined) input.model = record.model;
  if (record.system_prompt !== undefined) input.systemPrompt = record.system_prompt;
  if (record.visibility !== undefined) input.visibility = record.visibility;
  return input;
}

/** 非对象条目原样交给 service，由它逐条拒绝 */
function mapNewEntry(entry: unknown, ownerId: string): unknown {
  return isRecord(entry) ? mapNew(entry, ownerId) : entry;
}

/** `from` 不暴露：工具调用者恒为 owner，模型不能伪造发送者 */
function mapSend(record: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (record.to !== undefined) input.to = record.to;
  if (record.content !== undefined) input.content = record.content;
  return input;
}

function readVisibility(value: unknown): MemberVisibility {
  if (typeof value !== 'string' || !VISIBILITIES.includes(value as MemberVisibility)) {
    throw invalid(`invalid visibility "${String(value)}" (expected private|team|tenant)`);
  }
  return value as MemberVisibility;
}

function readState(value: unknown): MemberState {
  if (typeof value !== 'string' || !MEMBER_STATES.includes(value as MemberState)) {
    throw invalid(`invalid state "${String(value)}"`);
  }
  return value as MemberState;
}

/** agent 工具选项 */
export interface AgentToolOptions {
  /** 调用者（root owner）id；成员 owner / parent 与 list viewer 都用它 */
  ownerId?: string;
  /** root owner 自己的 session；用于区分 owner 调用与成员 Body 调用 */
  ownerSessionId?: string;
  /** 成员 Body 的 Team 能力（post / send / list）；缺失时这些动作报错 */
  team?: AgentTeamService;
}

/** 构造内置 `agent` 工具；生命周期全部委托给 AgentService */
export function createAgentTool(
  service: AgentService,
  options: AgentToolOptions = {},
): ToolDefinition {
  const ownerId = options.ownerId ?? DEFAULT_OWNER;

  return {
    name: 'agent',
    description:
      'Long-lived member lifecycle tool for this agent. ' +
      'action=new creates member(s) that keep their own session and returns the created member; ' +
      'action=send delivers a message to a member through the unified dispatch path ' +
      '(live members queue immediately, gone members resume first, rotating members are ' +
      'queued for the new body) and returns immediately; ' +
      'action=post appends a message to the caller team log only and never notifies or wakes ' +
      'any member; ' +
      'action=close releases member(s) (idempotent); action=list returns the roster; ' +
      'action=rotate moves an agent into a fresh body (new session, epoch + 1) with ' +
      'startup_prompt as the first message and optional handoff_path appended to it. ' +
      'A body may only rotate itself; startup_prompt is required. ' +
      'Agent bodies may use rotate, post, send and list; new and close are owner-only. ' +
      'Batch: new/close accept `members` and send accepts `messages`; entries run in ' +
      'parallel and return {results:[...]} in input order, each entry either its result ' +
      'or an error. ' +
      'A failed entry does not abort the others; do not mix single fields with a batch. ' +
      'Cross-node replies: when a federated message arrives from <principal>@<node>:<team>, ' +
      'reply with action=send and set to to that address; the runtime fills from with your ' +
      'own <name>@<local node>:<team>, so a from field is neither accepted nor needed. ' +
      'A member without a team cannot send to an address (no_team); the owner cannot either ' +
      '(use the vessel federation post CLI).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: 'new | send | close | list | rotate | post',
        },
        name: { type: 'string', description: 'new: display name' },
        model: { type: 'string', description: 'new: model override' },
        system_prompt: { type: 'string', description: 'new: optional system prompt' },
        visibility: {
          type: 'string',
          enum: [...VISIBILITIES],
          description: 'new: visibility (default private); list: filter by visibility',
        },
        members: {
          type: 'array',
          description:
            'new: [{name?, model?, system_prompt?, visibility?}]; close: [member id or session id]',
        },
        to: {
          type: 'string',
          description:
            'send: member id or session id, or a federated address ' +
            '<principal>@<node_id>:<team_id> (any value containing @ is treated as an address); ' +
            'rotate: target agent',
        },
        content: { type: 'string', description: 'send/post: message text' },
        messages: { type: 'array', description: 'send: [{to, content}]' },
        member: { type: 'string', description: 'close: member id or session id' },
        startup_prompt: {
          type: 'string',
          description: 'rotate: required first message for the new body',
        },
        handoff_path: {
          type: 'string',
          description: 'rotate: optional handoff path appended to the first message',
        },
        state: {
          type: 'string',
          enum: [...MEMBER_STATES],
          description: 'list: filter by member state',
        },
        parent_id: { type: 'string', description: 'list: filter by parent member id' },
      },
      required: ['action'],
    },
    handler: async (args: unknown, ctx): Promise<string> => {
      try {
        const record = isRecord(args) ? args : {};
        const action = record.action;
        const callerSession = ctx?.session_id;
        // 成员 Body 调用（有 session 且不是 root owner 的 session）只能 rotate 自己。
        const isOwnerCaller =
          callerSession === undefined ||
          options.ownerSessionId === undefined ||
          callerSession === options.ownerSessionId;

        if (action === 'rotate') {
          if (callerSession === undefined) {
            throw invalid('rotate requires a calling body');
          }
          const result = await service.rotate({
            to: (record.to ?? callerSession) as string,
            startup_prompt: record.startup_prompt as string,
            ...(record.handoff_path !== undefined
              ? { handoff_path: record.handoff_path as string }
              : {}),
            from_session_id: callerSession,
            from: ownerId,
          });
          return result.status === 'rotated'
            ? `${JSON.stringify(result)}\nrotation committed; finish the current turn`
            : JSON.stringify(result);
        }

        if (!isOwnerCaller && !BODY_ACTIONS.includes(action as string)) {
          throw invalid('agent bodies may only use rotate|post|send|list');
        }

        if (action === 'new') {
          if (record.members !== undefined) {
            assertExclusive(
              record,
              ['name', 'model', 'system_prompt', 'visibility'],
              'members',
              'new',
            );
            const entries = readBatch(record, 'members', 'new').map((entry) =>
              mapNewEntry(entry, ownerId),
            );
            const result = await service.new({
              members: entries as unknown as NewMemberInput[],
            });
            return JSON.stringify(result);
          }
          return JSON.stringify(
            await service.new(mapNew(record, ownerId) as unknown as NewMemberInput),
          );
        }

        if (action === 'send') {
          // owner 走统一 dispatch；成员 Body 用自己的 session 走 TeamService.send
          // （from 恒由入口决定，模型不能伪造）。
          const sendSingle = async (
            entry: unknown,
          ): Promise<DispatchResult | TeamAgentSendResult> => {
            const mapped = isRecord(entry) ? mapSend(entry) : {};
            const to = mapped.to as string;
            const content = mapped.content as string;
            if (!isOwnerCaller) {
              if (options.team === undefined) throw invalid('send requires a team service');
              return options.team.send({
                from_session_id: callerSession as string,
                to,
                content,
              });
            }
            // owner 没有本地 Team，无法构造 `<name>@<local node>:<team>`；
            // 地址形式明确拒绝，绝不回落到 dispatch 或跨节点端口。
            if (typeof to === 'string' && to.includes('@')) {
              return {
                status: 'rejected',
                code: 'no_team',
                reason:
                  'owner has no local team; use vessel federation post --from human@<node>:<team>',
                logged: false,
              };
            }
            return service.dispatch({ to, content, from: ownerId });
          };

          if (record.messages !== undefined) {
            assertExclusive(record, ['to', 'content'], 'messages', 'send');
            const entries = readBatch(record, 'messages', 'send');
            const results = await Promise.all(
              entries.map(async (entry) => {
                try {
                  return mapSendOutcome(await sendSingle(entry));
                } catch (error) {
                  return { ok: false as const, error: batchErrorText(error) };
                }
              }),
            );
            return JSON.stringify({ results });
          }
          return JSON.stringify(await sendSingle(record));
        }

        if (action === 'post') {
          if (isOwnerCaller) {
            throw invalid('owner has no team; use vessel team post');
          }
          const team = options.team;
          if (team === undefined) throw invalid('post requires a team service');
          const sessionId = callerSession as string;
          const caller = (await team.identify(sessionId)) as TeamCaller | undefined;
          if (caller === undefined) throw invalid('post requires a team');
          const teamId = caller.team_id ?? (await service.identify(sessionId))?.team_id;
          if (teamId === undefined) throw invalid('post requires a team');
          // 永不传 mentions：post 只写日志，不产生任何 run。
          const conversationId = service.currentConversation?.(caller.agent_id);
          const result = await team.post({
            team_id: teamId,
            content: record.content as string,
            from: caller.agent_id,
            ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
          });
          return JSON.stringify(result);
        }

        if (action === 'close') {
          if (record.members !== undefined) {
            assertExclusive(record, ['member'], 'members', 'close');
            const members = readBatch(record, 'members', 'close') as string[];
            return JSON.stringify(await service.close({ members }));
          }
          const input: CloseInput = {};
          if (record.member !== undefined) input.member = record.member as string;
          return JSON.stringify(await service.close(input));
        }

        if (action === 'list') {
          const visibility =
            record.visibility === undefined ? undefined : readVisibility(record.visibility);
          const state = record.state === undefined ? undefined : readState(record.state);

          if (!isOwnerCaller) {
            // 成员只看调用者所属 Team 的 roster；filter 在本地做，parent_id 不适用。
            const team = options.team;
            if (team === undefined) throw invalid('list requires a team service');
            let roster = await team.listForCaller(callerSession as string);
            if (visibility !== undefined) {
              roster = roster.filter((entry) => entry.visibility === visibility);
            }
            if (state !== undefined) {
              roster = roster.filter((entry) => entry.state === state);
            }
            return JSON.stringify(roster);
          }

          // private 成员只有 owner 可见；工具调用者就是 owner
          const filter: ListFilter = { viewer: ownerId };
          if (visibility !== undefined) filter.visibility = visibility;
          if (state !== undefined) filter.state = state;
          if (record.parent_id !== undefined) {
            if (typeof record.parent_id !== 'string' || record.parent_id === '') {
              throw invalid('parent_id must be a non-empty string');
            }
            filter.parentId = record.parent_id;
          }
          return JSON.stringify(await service.list(filter));
        }

        throw invalid(`unknown action "${String(action)}" (expected ${ACTIONS.join('|')})`);
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
