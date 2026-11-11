/**
 * 内置 `agent` 工具：模型侧唯一的成员生命周期入口。
 *
 * 只做参数映射与错误码格式化；registry、生命周期、批次并行都在 AgentService。
 * 不提供 wait / inbox / status / cancel——等待语义是结束这一轮、回复作为新 turn 到达。
 *
 * @module @vessel-agent/agent
 */

import { randomUUID } from 'node:crypto';
import { LIMIT_WARNING_THRESHOLD, type ToolContext, type ToolDefinition } from '@vessel-agent/core';
import { deliveryFromNotify } from './inbox.js';
import { HUMAN_PRINCIPAL } from './team-address.js';
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
  MAX_SESSION_TITLE_LENGTH,
  type MemberState,
  type MemberStatus,
  type MemberVisibility,
  type SendResult,
  type TeamAgentSendResult,
  TeamError,
} from './types.js';

const ACTIONS = ['create', 'hire', 'send', 'close', 'list', 'rotate', 'read'] as const;

/** root owner 可见的动作：root 没有 Team，不暴露 create（派 peer 需要 Team） */
const OWNER_ACTIONS = ['hire', 'send', 'close', 'list', 'rotate', 'read'] as const;

/** 成员 ExecutionUnit 可用的动作；rotate 在动作闸门之前单独处理 */
const BODY_ACTIONS: readonly string[] = [
  'create',
  'hire',
  'close',
  'rotate',
  'send',
  'list',
  'read',
];

const VISIBILITIES: readonly MemberVisibility[] = ['private', 'team', 'tenant'];

/** `read` 返回的成员会话消息条数：缺省 20，封顶 50（与 sessions.get 的分页上限同量级）。 */
const READ_MESSAGE_LIMIT_DEFAULT = 20;
const READ_MESSAGE_LIMIT_MAX = 50;
/** `read` 单条正文的截断长度（字符）：只够看清结论 / 摘要，不搬整段工具输出。 */
const READ_MESSAGE_MAX_CHARS = 1000;

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

/** dispatch / team.send / SendResult 的逐条结果映射到既有 batch 形状 */
type SendOutcome = DispatchResult | TeamAgentSendResult | SendResult;

function mapSendOutcome(result: SendOutcome): BatchItemResult<SendOutcome> {
  // 带 status 的是 dispatch / TeamService 的业务结果。
  if ('status' in result) {
    if (result.status === 'queued' || result.status === 'notified') {
      return { ok: true, status: result };
    }
    const code = result.code ?? result.status;
    const reason = result.reason;
    const error =
      reason === undefined ? code : reason.startsWith(`${code}: `) ? reason : `${code}: ${reason}`;
    return { ok: false, error };
  }
  // SendResult 只有成功（work queued:true / notify notified:true）；失败会 throw。
  return { ok: true, status: result };
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
  // 0.41 三档：interrupt / notify 互斥；message_id 仅与 interrupt 同用。
  // notify 是 wire 名，进 handler 后立刻变成 inbox 的投递模式（见 sendSingle）。
  if (record.interrupt !== undefined) input.interrupt = record.interrupt;
  if (record.notify !== undefined) input.notify = record.notify;
  if (record.message_id !== undefined) input.message_id = record.message_id;
  return input;
}

function readVisibility(value: unknown): MemberVisibility {
  if (typeof value !== 'string' || !VISIBILITIES.includes(value as MemberVisibility)) {
    throw invalid(`invalid visibility "${String(value)}" (expected private|team|tenant)`);
  }
  return value as MemberVisibility;
}

/**
 * rotate: optional name for the new session. Trimmed, 1..MAX_SESSION_TITLE_LENGTH
 * chars (120). Absent = keep the old behaviour (derived title, then AI naming).
 * A named session is marked title_source: manual, so AI naming never overwrites it.
 */
function readRotateTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw invalid('rotate title must be a string');
  }
  const title = value.trim();
  if (title === '') {
    throw invalid('rotate title must not be empty');
  }
  if (Array.from(title).length > MAX_SESSION_TITLE_LENGTH) {
    throw invalid(`rotate title exceeds ${MAX_SESSION_TITLE_LENGTH} characters`);
  }
  return title;
}

function readState(value: unknown): MemberState {
  if (typeof value !== 'string' || !MEMBER_STATES.includes(value as MemberState)) {
    throw invalid(`invalid state "${String(value)}"`);
  }
  return value as MemberState;
}

/** `read` 的 limit：缺省 20，1..50（封顶而不是报错：模型不该为了一个数字失败）。 */
function readMessageLimit(value: unknown): number {
  if (value === undefined) return READ_MESSAGE_LIMIT_DEFAULT;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return READ_MESSAGE_LIMIT_DEFAULT;
  return Math.min(Math.floor(parsed), READ_MESSAGE_LIMIT_MAX);
}

/** 单条正文截断（按码点，避免切坏 emoji / 中文）。 */
function truncateText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('')}…`;
}

/** agent 工具选项 */
export interface AgentToolOptions {
  /** 调用者（root owner）id；成员 owner / parent 与 list viewer 都用它 */
  ownerId?: string;
  /** root owner 自己的 session；用于区分 owner 调用与成员 ExecutionUnit 调用 */
  ownerSessionId?: string;
  /** 成员 ExecutionUnit 的 Team 能力（send / list）；缺失时这些动作报错 */
  team?: AgentTeamService;
  /**
   * `read` 的只读会话读取端口（装配层注入，与 `sessions.get` RPC 同一份 SessionState）。
   *
   * 不新增 RPC：只把已经落盘的会话消息读出来，供父级自己看成员报告（收口不再自动
   * 回传正文之后，这是「父级要原文」的唯一入口）。缺省 = `read` 报不可用。
   */
  readSession?: (
    sessionId: string,
  ) => Promise<{ messages: ReadonlyArray<{ role: string; content: string }> } | null>;
  /**
   * 0.31：是否有能应答权限确认的人类通道（交互 REPL / serve；headless 为 false）。
   *
   * 只影响模型发起的 rotate：无人类通道时不发请求、不等待，直接
   * `rotate_not_needed`，避免 bridge 收不到人类应答而挂死。
   */
  humanApproval?: boolean;
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
      'body); returns immediately. Add interrupt:true for urgent (cancel + front of queue) or ' +
      'notify:true to append to the inbox + summary wake without running. ' +
      'close: release member(s), idempotent. list: return the roster. ' +
      'read: read the last messages of a member session (read-only; role + truncated text), so ' +
      'you can read a report yourself instead of waiting for it to be forwarded to you. ' +
      'rotate: move an agent into a fresh body (new session, epoch + 1) with startup_prompt first, ' +
      'plus an optional title that AI naming will not overwrite; ' +
      'a body may only rotate itself. ' +
      'Bodies may use create, hire, close, rotate, send, list and read. ' +
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
          description: 'hire | send | close | list | rotate | read',
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
            'rotate: target agent; read: member id, session id or name',
        },
        content: { type: 'string', description: 'send: message text' },
        interrupt: {
          type: 'boolean',
          description:
            'send: urgent — cancel the target body active run and put this message first ' +
            '(work/queued messages are preserved; cannot combine with notify)',
        },
        notify: {
          type: 'boolean',
          description:
            'send: append to the target inbox as unread and wake it with a summary notice; ' +
            'does not run, queue, or cancel anything (cannot combine with interrupt)',
        },
        message_id: {
          type: 'string',
          description:
            'send: with interrupt, deliver an existing inbox message id instead of new content',
        },
        messages: {
          type: 'array',
          description: 'send: [{to, content, interrupt?, notify?, message_id?}]',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: READ_MESSAGE_LIMIT_MAX,
          description: `read: how many trailing messages to return (default ${READ_MESSAGE_LIMIT_DEFAULT}, max ${READ_MESSAGE_LIMIT_MAX})`,
        },
        member: { type: 'string', description: 'close: member id or session id' },
        startup_prompt: {
          type: 'string',
          description: 'rotate: required first message for the new body',
        },
        title: {
          type: 'string',
          maxLength: MAX_SESSION_TITLE_LENGTH,
          description: `rotate: optional name for the new session (1-${MAX_SESSION_TITLE_LENGTH} chars); AI titling never renames a named session`,
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
     * - member：需要人类审批（ask）—— 含 `main`。0.28 删除了「single 记录直接 deny」
     *   这条：`main` 现在是 member，成员关它要让人类看到并有明确答复，而不是静默拒绝。
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
        // member 关闭需要人类审批（`main` 也是 member，同样走审批而不是被静默拒绝）。
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
        // 成员 ExecutionUnit 调用（有 session 且不是 root owner 的 session）只能 rotate 自己。
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
          if (typeof record.startup_prompt !== 'string' || record.startup_prompt === '') {
            throw invalid('rotate requires startup_prompt');
          }
          const rotateTitle = readRotateTitle(record.title);
          // 0.31：模型发起的 rotate 一律先问人类。CLI / 人工 RPC 直接走
          // service.createSession，不经过这里，因此不会被询问。
          const ratio = service.contextRatio(callerSession);
          // floor：0.895 必须显示 89%（低于 90% 线），不能用 round 显示成 90%
          // 却同时说“below the 90% line”。
          const percent = ratio === undefined ? undefined : Math.floor(ratio * 100);
          const warning =
            ratio === undefined
              ? 'Context usage is unknown; rotate only with human approval.'
              : ratio >= LIMIT_WARNING_THRESHOLD
                ? `Context is at ${percent}% (at or above the ${Math.round(
                    LIMIT_WARNING_THRESHOLD * 100,
                  )}% line); rotation is recommended.`
                : `Context is at ${percent}% (below the ${Math.round(
                    LIMIT_WARNING_THRESHOLD * 100,
                  )}% line); rotation is usually unnecessary.`;

          let approved = false;
          let denial = 'no_human_channel';
          // 入口有人类 + 该 body 真有 bridge，两个条件都成立才发请求；否则
          // fail-closed。只检查入口标志会在 permissionMode=allow 的无 team body
          // 上把请求发进无人订阅的事件流并永久等待。
          if (options.humanApproval === true && service.canConfirm(callerSession)) {
            const requestId = randomUUID();
            ctx.events.publish({
              type: 'tool.permission.request',
              run_id: ctx.run_id,
              data: {
                requestId,
                tool: 'agent.rotate',
                input: {
                  action: 'rotate',
                  to: (record.to ?? callerSession) as string,
                  ...(ratio !== undefined
                    ? { context_ratio: ratio, context_percent: percent }
                    : {}),
                  warning,
                },
                session_id: callerSession,
                ...(ctx.tool_call_id !== undefined ? { tool_call_id: ctx.tool_call_id } : {}),
                source: ctx.source ?? 'runtime',
              },
              ts: Date.now(),
            });
            try {
              const response = await ctx.events.waitFor('tool.permission.response', {
                requestId,
                ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
              });
              const data = isRecord(response) ? response : {};
              // 缺 answered_by = legacy human（TUI）；policy / auto_allow 不是人类。
              const human = data.answered_by === undefined || data.answered_by === 'human';
              const decision =
                data.decision ?? (data.allowed === false ? ('deny' as const) : ('allow' as const));
              approved = human && decision === 'allow';
              if (!human) denial = 'no_human_channel';
              else if (!approved) denial = 'denied_by_human';
            } catch (error) {
              if (ctx.signal?.aborted) throw error;
              denial = 'approval_unavailable';
            }
          }

          const decisionData = {
            ...(ratio !== undefined ? { context_ratio: ratio } : {}),
            ...(percent !== undefined ? { context_percent: percent } : {}),
            warning,
          };
          if (!approved) {
            service.noteAgentEvent('agent.rotate.denied', callerSession, {
              ...decisionData,
              reason: denial,
            });
            return JSON.stringify({
              status: 'failed',
              code: 'rotate_not_needed',
              reason: denial,
              ...decisionData,
            });
          }

          const caller = await service.identify(callerSession);
          if (caller === undefined) {
            throw invalid('rotate requires a known calling body');
          }
          service.noteAgentEvent('agent.rotate.approved', callerSession, decisionData);
          // CREATE-0.39：rotate 下沉到 sessions.create（无来源 + startup_prompt）。
          const result = await service.createSession(
            {
              agent_id: caller.id,
              startup_prompt: record.startup_prompt,
              ...(rotateTitle !== undefined ? { title: rotateTitle } : {}),
            },
            // 工具在调用者自身 active run 内执行；RPC 路径不传此内部选项。
            { allowActiveRun: true },
          );
          const created = await service.identify(result.session_id);
          const rotated = {
            status: 'rotated',
            agent_id: result.agent_id,
            from_session_id: callerSession,
            to_session_id: result.session_id,
            epoch: created?.epoch,
            ...(result.title !== undefined ? { title: result.title } : {}),
          };
          return `${JSON.stringify(rotated)}\nrotation committed; finish the current turn`;
        }

        if (!isOwnerCaller && !BODY_ACTIONS.includes(action as string)) {
          throw invalid('agent bodies may only use create|hire|close|rotate|send|list|read');
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
          // owner 走统一 dispatch；成员 ExecutionUnit 用自己的 session 走 TeamService.send
          // （from 恒由入口决定，模型不能伪造）。
          // 0.41：一批 send 生成一个 wake 边计数 key；整批 await 完后释放（内部、非 wire）。
          const releaseWakeBatch = (batchKey: string): void => {
            service.releaseWakeBatch(batchKey);
          };
          const sendSingle = async (
            entry: unknown,
            batchKey?: string,
          ): Promise<DispatchResult | TeamAgentSendResult | SendResult> => {
            // 0.41：important 已全链路删除；显式传入按非法输入拒绝，不静默忽略。
            if (isRecord(entry) && entry.important !== undefined) {
              throw invalid('send does not accept important');
            }
            const mapped = isRecord(entry) ? mapSend(entry) : {};
            const to = mapped.to as string;
            const content = mapped.content as string;
            const interrupt = mapped.interrupt === true;
            // 工具参数 `notify` 是 wire 名：映射成 inbox 的投递模式再往下传，
            // 内部（TeamService / dispatch）不再二传布尔。
            const delivery = deliveryFromNotify(mapped.notify === true);
            const wakes = delivery === 'wake';
            const messageId = typeof mapped.message_id === 'string' ? mapped.message_id : undefined;
            if (!isOwnerCaller) {
              if (options.team === undefined) throw invalid('send requires a team service');
              return options.team.send({
                from_session_id: callerSession as string,
                to,
                content,
                ...(interrupt ? { interrupt: true } : {}),
                delivery,
                ...(messageId !== undefined ? { message_id: messageId } : {}),
                origin_run_id: ctx.run_id,
                ...(batchKey !== undefined ? { batch_key: batchKey } : {}),
              });
            }
            // owner 的会话就是人类直接看的那个 session，每轮回复的文本人类直接能看到。
            // 所以 owner 没有「把话递给人类」这个动作可做 ——
            // 那是给 Team 成员用的（成员在 Team 里跑，人类不在它的 session 里）。
            // 两条拒绝理由不同，文案必须分开，否则模型会去追一个不存在的动作：
            // - `human`：回复本身就是回答，不需要 send；
            // - 地址形式：owner 所在 Team 的构型不允许它从这里发地址。
            // 旧文案让模型「用 vessel federation post --from ...」——那是 CLI，模型没有
            // 这条工具调用可发，属于不可执行的死提示。错误消息给的替代动作必须真能用。
            if (typeof to === 'string' && (to.includes('@') || to === HUMAN_PRINCIPAL)) {
              // 0.41：地址 / 跨节点目标不支持 urgent / wake 投递。
              if (interrupt || wakes) {
                return {
                  status: 'rejected',
                  code: 'invalid_input',
                  reason: 'unsupported_delivery',
                  logged: false,
                };
              }
              const reason =
                to === HUMAN_PRINCIPAL
                  ? 'owner has no team: your reply text is shown to the human directly, ' +
                    'so no send is needed. To reach an agent, send to its id.'
                  : 'owner has no team, so an address cannot be delivered from here; ' +
                    'to reach an agent, send to its id instead of an address.';
              return { status: 'rejected', code: 'no_team', reason, logged: false };
            }
            return service.dispatch({
              to,
              content,
              from: ownerId,
              ...(interrupt ? { interrupt: true } : {}),
              // wire 边界：dispatch 只认 notify 布尔，wake 模式在这里转回去。
              ...(wakes ? { notify: true } : {}),
              ...(messageId !== undefined ? { message_id: messageId } : {}),
              // 内部（非 wire）：tool 路径按调用者 session 继承会话 / 按 run 去重边。
              ...(callerSession !== undefined ? { origin_session_id: callerSession } : {}),
              origin_run_id: ctx.run_id,
              ...(batchKey !== undefined ? { batch_key: batchKey } : {}),
            });
          };

          if (record.important !== undefined) {
            throw invalid('send does not accept important');
          }
          if (record.messages !== undefined) {
            // 三档 flag 是逐条投递语义：与 messages 数组同用会被静默丢弃，必须显式拒绝。
            assertExclusive(
              record,
              ['to', 'content', 'interrupt', 'notify', 'message_id'],
              'messages',
              'send',
            );
            const entries = readBatch(record, 'messages', 'send');
            // 一次 messages 数组共享一个 wake 边计数 key（内部、非 wire）。
            const batchKey = randomUUID();
            try {
              const results = await Promise.all(
                entries.map(async (entry) => {
                  try {
                    return mapSendOutcome(await sendSingle(entry, batchKey));
                  } catch (error) {
                    return { ok: false as const, error: batchErrorText(error) };
                  }
                }),
              );
              return JSON.stringify({ results });
            } finally {
              releaseWakeBatch(batchKey);
            }
          }
          const batchKey = randomUUID();
          try {
            return JSON.stringify(await sendSingle(record, batchKey));
          } finally {
            releaseWakeBatch(batchKey);
          }
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

        if (action === 'read') {
          // 只读：解析目标 → 取该成员当前 primary body 的 session → 读最近 N 条消息。
          // 不新增 RPC，也不改 sessions.get 的形状：同一份 SessionState 只读一份。
          const target = typeof record.to === 'string' ? record.to.trim() : '';
          if (target === '') throw invalid('read requires to');
          // 跨节点 / 地址形态读不到对方的本地会话：显式拒绝，不猜。
          if (target.includes('@')) {
            throw invalid(
              'read: only local members are readable; address targets live on another node',
            );
          }
          const visible: { id: string; session_id: string; name?: string }[] = [];
          if (!isOwnerCaller) {
            const team = options.team;
            if (team === undefined) throw invalid('read requires a team service');
            for (const entry of await team.listForCaller(callerSession as string)) {
              visible.push({
                id: entry.agent_id,
                session_id: entry.session_id,
                ...(entry.name !== undefined ? { name: entry.name } : {}),
              });
            }
          } else {
            for (const entry of await service.list({ viewer: ownerId })) {
              visible.push({
                id: entry.id,
                session_id: entry.session_id,
                ...(entry.name !== undefined ? { name: entry.name } : {}),
              });
            }
          }
          const hit =
            visible.find((entry) => entry.id === target) ??
            visible.find((entry) => entry.session_id === target) ??
            visible.find((entry) => entry.name === target);
          if (hit === undefined) {
            throw new AgentError('unknown_member', `unknown_member: ${target}`);
          }
          const readSession = options.readSession;
          if (readSession === undefined) {
            throw invalid('read: no session store is attached to this entry');
          }
          // 当前 primary body 的 session：rotate 之后旧 session 是历史，读新的那具。
          const current = await service.identify(hit.id);
          const sessionId = current?.session_id ?? hit.session_id;
          const state = await readSession(sessionId);
          if (state === null) {
            throw invalid(`read: no session state for ${sessionId}`);
          }
          const limit = readMessageLimit(record.limit);
          const all = state.messages;
          const selected = all.slice(Math.max(0, all.length - limit));
          const messages = selected.map((message) => ({
            role: message.role,
            content: truncateText(message.content, READ_MESSAGE_MAX_CHARS),
          }));
          return JSON.stringify({
            agent_id: hit.id,
            ...(hit.name !== undefined ? { name: hit.name } : {}),
            session_id: sessionId,
            state: current?.state,
            messages_total: all.length,
            returned: messages.length,
            messages,
          });
        }

        throw invalid(`unknown action "${String(action)}" (expected ${ACTIONS.join('|')})`);
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
