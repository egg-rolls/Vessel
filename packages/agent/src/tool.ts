/**
 * 内置 `agent` 工具：模型侧唯一的成员生命周期入口。
 *
 * 只做参数映射与错误码格式化；registry、生命周期、批次并行都在 AgentService。
 * 不提供 wait / inbox / status / cancel——等待语义是结束这一轮、回复作为新 turn 到达。
 *
 * @module @vessel-agent/agent
 */

import type { ToolContext, ToolDefinition } from '@vessel-agent/core';
import { TeamMetadataCorruptError } from './team-store.js';
import {
  AgentError,
  type AgentService,
  type AgentTeamService,
  type BatchItemResult,
  type CloseInput,
  type CreateMemberInput,
  DEFAULT_OWNER,
  type DispatchResult,
  type ListFilter,
  type MemberState,
  type MemberStatus,
  type MemberVisibility,
  type TeamAgentSendResult,
  TeamError,
  type TeamMemberSummary,
} from './types.js';

const ACTIONS = ['create', 'hire', 'send', 'close', 'list', 'rotate', 'post'] as const;

/** root owner 可见的动作：root 没有 Team，不暴露 create（派 peer 需要 Team） */
const OWNER_ACTIONS = ['hire', 'send', 'close', 'list', 'rotate', 'post'] as const;

/** 成员 Body 可用的动作；rotate 在动作闸门之前单独处理 */
const BODY_ACTIONS: readonly string[] = [
  'create',
  'hire',
  'close',
  'rotate',
  'post',
  'send',
  'list',
];

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

/** 带稳定 code 的错误：AgentError / TeamError / Team 元数据损坏 */
function isCodedError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof AgentError ||
    error instanceof TeamError ||
    error instanceof TeamMetadataCorruptError
  );
}

/** 错误串形状固定；message 已带 code 前缀时去重 */
function errorResult(error: unknown): string {
  if (!isCodedError(error)) {
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
  if (isCodedError(error)) {
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
 * 成员派生入口（create / hire）的字段映射：只拷模型可指定的键；
 * kind / owner / parentId / teamId / spawnedBy 由 handler 固定，模型不能伪造。
 * 值不做类型校验：batch 要由 AgentService 逐条拒绝，不能在映射阶段整批抛错。
 */
function mapDerived(
  record: Record<string, unknown>,
  fixed: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = { ...fixed };
  if (record.name !== undefined) input.name = record.name;
  if (record.model !== undefined) input.model = record.model;
  if (record.system_prompt !== undefined) input.systemPrompt = record.system_prompt;
  // create 的 visibility 由 service 强制 team；传了非 team 值时由 service 逐条拒绝。
  if (record.visibility !== undefined) input.visibility = record.visibility;
  return input;
}

/** 非对象条目原样交给 service，由它逐条拒绝 */
function mapDerivedEntry(entry: unknown, fixed: Record<string, unknown>): unknown {
  return isRecord(entry) ? mapDerived(entry, fixed) : entry;
}

/**
 * 同名成员已存在时 service 复用而不是新建，返回体带 `reused: true`。
 * 这里补一句 note 点明「没有再建一个」：否则调用方会以为刚创建了成员，
 * 进而再发一次消息，而它其实是在给一个已有的成员派活。
 * 正常创建时不加这个字段，避免每次调用多一段无用文本。
 */
function withReusedNote<T extends { id: string; name?: string; reused?: boolean }>(
  result: T,
): T & { note?: string } {
  if (result.reused !== true) return result;
  return {
    ...result,
    note:
      `a member named ${result.name ?? result.id} already exists in this team; ` +
      'reuse it with action=send',
  };
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
      'Long-lived member lifecycle tool. ' +
      'create: peer member(s) in the caller team (root owner: use hire). ' +
      'hire: contractor owned by the caller (any member may hire), bound to the caller team if it ' +
      'has one. ' +
      'send: dispatch a message (live queue now, gone resume first, rotating queue for the new ' +
      'body); returns immediately. ' +
      'post: append to the caller team log only; never notifies or wakes anyone. ' +
      'close: release member(s), idempotent. list: return the roster. ' +
      'rotate: move an agent into a fresh body (new session, epoch + 1) with startup_prompt first; ' +
      'a body may only rotate itself. ' +
      'Bodies may use create, hire, close, rotate, post, send and list. ' +
      'Closing a peer needs human approval; closing your own contractor or yourself does not. ' +
      'Cross-node: reply to a federated from by sending to that address; from is runtime-filled ' +
      'and must not be given. ' +
      'No team means no address send (no_team), owner included.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...OWNER_ACTIONS],
          description: 'hire | send | close | list | rotate | post',
        },
        name: { type: 'string', description: 'create/hire: display name' },
        model: { type: 'string', description: 'create/hire: model override' },
        system_prompt: { type: 'string', description: 'create/hire: optional system prompt' },
        visibility: {
          type: 'string',
          enum: [...VISIBILITIES],
          description:
            'create: team only; hire: visibility (default private for unbound, team with a team); ' +
            'list: filter by visibility',
        },
        members: {
          type: 'array',
          description:
            'create/hire: [{name?, model?, system_prompt?, visibility?}]; ' +
            'close: [member id or session id]',
        },
        to: {
          type: 'string',
          description:
            'send: member id or session id, or an address ' +
            '<principal>@<node_id>:<team_id> (any value containing @ is treated as an address); ' +
            'a local sender gets a node segment too, so send the location value back as-is; ' +
            'rotate: target agent',
        },
        content: { type: 'string', description: 'send/post: message text' },
        messages: { type: 'array', description: 'send: [{to, content}]' },
        member: { type: 'string', description: 'close: member id or session id' },
        startup_prompt: {
          type: 'string',
          description: 'rotate: required first message for the new body',
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
    /**
     * close 的审批在权限层完成（批准后 handler 照常执行 service.close）。
     * - owner 调用 / 非 close 动作：放行；
     * - self-close：放行；
     * - temporary：雇佣者或同 Team 成员放行，其它拒绝；
     * - member：需要人类审批（ask）；
     * - single（root owner / 独立 agent）记录：拒绝。
     * 批量 close 中只要含 member 就整体 ask 一次。
     */
    checkPermission: async (args: unknown, ctx: ToolContext): Promise<'allow' | 'deny' | 'ask'> => {
      const record = isRecord(args) ? args : {};
      if (record.action !== 'close') return 'allow';
      const callerSession = ctx.session_id;
      if (
        callerSession === undefined ||
        options.ownerSessionId === undefined ||
        callerSession === options.ownerSessionId
      ) {
        return 'allow';
      }

      const refs: string[] = [];
      if (Array.isArray(record.members)) {
        for (const entry of record.members) {
          if (typeof entry === 'string' && entry !== '') refs.push(entry);
        }
      }
      if (typeof record.member === 'string' && record.member !== '') refs.push(record.member);
      // 无目标时交给 handler 报参数错，权限层不额外拦截。
      if (refs.length === 0) return 'allow';

      const caller = await service.identify(callerSession);
      if (caller === undefined) return 'deny';

      let needAsk = false;
      for (const ref of refs) {
        const target = await service.identify(ref);
        // 无法解析的目标由 handler 报 unknown_member。
        if (target === undefined) continue;
        if (target.id === caller.id) continue;
        // single（root owner / 独立 agent）记录不可被成员关闭。
        if (target.role === 'single') return 'deny';
        // member 关闭需要人类审批。
        if (target.role === 'member') {
          needAsk = true;
          continue;
        }
        // temporary：雇佣者的、或同 Team 的可直接关闭。
        if (target.owner !== undefined && target.owner === caller.id) continue;
        if (target.team_id !== undefined && target.team_id === caller.team_id) continue;
        return 'deny';
      }
      return needAsk ? 'ask' : 'allow';
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

        /**
         * 成员派生入口的调用者：session 必须能解析出所属 Team，否则 no_team。
         * 只有 create（peer）要求 Team；hire 对任意成员开放，team 可选。
         */
        const requireTeamCaller = async (): Promise<MemberStatus & { team_id: string }> => {
          if (callerSession === undefined) {
            throw invalid('no_team: create requires a member session');
          }
          const caller = await service.identify(callerSession);
          if (caller === undefined || caller.team_id === undefined) {
            throw invalid('no_team: create requires a member with a team');
          }
          return caller as MemberStatus & { team_id: string };
        };

        if (action === 'rotate') {
          if (callerSession === undefined) {
            throw invalid('rotate requires a calling body');
          }
          const result = await service.rotate({
            to: (record.to ?? callerSession) as string,
            startup_prompt: record.startup_prompt as string,
            from_session_id: callerSession,
            from: ownerId,
          });
          return result.status === 'rotated'
            ? `${JSON.stringify(result)}\nrotation committed; finish the current turn`
            : JSON.stringify(result);
        }

        if (!isOwnerCaller && !BODY_ACTIONS.includes(action as string)) {
          throw invalid('agent bodies may only use create|hire|close|rotate|post|send|list');
        }

        if (action === 'create' || action === 'hire') {
          // create 只给成员（peer 必须绑定调用者 Team）；root 没有 Team，只能用 hire。
          if (action === 'create' && isOwnerCaller) {
            throw invalid('create requires a team member caller; owner should use hire');
          }
          let fixed: Record<string, unknown>;
          if (action === 'create') {
            const caller = await requireTeamCaller();
            fixed = {
              kind: 'peer',
              teamId: caller.team_id,
              spawnedBy: caller.id,
            };
          } else if (isOwnerCaller) {
            // root owner：unbound contractor，沿用旧 new 的 owner/parent 语义。
            fixed = {
              kind: 'contractor',
              owner: ownerId,
              parentId: ownerId,
              spawnedBy: ownerId,
            };
          } else {
            // 任意成员（含 contractor，是否有 Team 均可）都能 hire：owner / parent 固定为调用者，
            // 模型不能伪造。调用者有 Team 时绑定该 Team（计入上限 / 冻结），否则 unbound。
            if (callerSession === undefined) {
              throw invalid('hire requires a member session');
            }
            const caller = await service.identify(callerSession);
            if (caller === undefined) {
              throw invalid('hire requires a member session');
            }
            fixed = {
              kind: 'contractor',
              owner: caller.id,
              parentId: caller.id,
              spawnedBy: caller.id,
              ...(caller.team_id !== undefined ? { teamId: caller.team_id } : {}),
            };
          }
          const singles = ['name', 'model', 'system_prompt', 'visibility'];
          if (record.members !== undefined) {
            assertExclusive(record, singles, 'members', action);
            const entries = readBatch(record, 'members', action).map((entry) =>
              mapDerivedEntry(entry, fixed),
            );
            const result = await service.create({
              members: entries as unknown as CreateMemberInput[],
            });
            // batch 逐条标注复用：命中同名成员的条目要说明「没新建」
            const results = entries.map((entry, index) => {
              const item = result.results[index];
              if (item === undefined || !item.ok || !isRecord(entry)) return item;
              return { ...item, status: withReusedNote(item.status) };
            });
            return JSON.stringify({ ...result, results });
          }
          const created = await service.create(
            mapDerived(record, fixed) as unknown as CreateMemberInput,
          );
          return JSON.stringify(withReusedNote(created));
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
            // owner 是 unbound single：它跟人类的对话就是自己的 session，每轮回复的
            // 文本人类直接能看到。所以 owner 没有「把话递给人类」这个动作可做 ——
            // 那是给 Team 成员用的（成员在 Team 里跑，人类不在它的 session 里）。
            // 两条拒绝理由不同，文案必须分开，否则模型会去追一个不存在的动作：
            // - `human`：回复本身就是回答，不需要 send；
            // - 地址形式：owner 没有 Team，构造不出 `<name>@<node>:<team>`。
            // 旧文案让模型「用 vessel federation post --from ...」——那是 CLI，模型没有
            // 这条工具调用可发，属于不可执行的死提示。错误消息给的替代动作必须真能用。
            if (typeof to === 'string' && (to.includes('@') || to === 'human')) {
              const reason =
                to === 'human'
                  ? 'owner has no team: your reply text is shown to the human directly, ' +
                    'so no send is needed. To reach an agent, send to its id.'
                  : 'owner has no team, so an address cannot be delivered from here; ' +
                    'to reach an agent, send to its id instead of an address.';
              return { status: 'rejected', code: 'no_team', reason, logged: false };
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
