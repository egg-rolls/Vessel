/**
 * canonical RPC 方法的 result_schema 复用片段（DECISION-019 §B）。
 *
 * 只使用 `rpc.ts` 校验器支持的子集：object / array / string / number /
 * integer / boolean，以及 required / properties / items / enum / minLength /
 * maxLength / minimum / maximum。不要引入 oneOf / $ref / additionalProperties 等。
 *
 * @module @vessel-agent/serve
 */

import { MESSAGE_REF_PATH_MAX, MESSAGE_REFS_MAX, type MessageRef } from '@vessel-agent/core';
import { RpcError } from '../../rpc.js';

export const stringListSchema = {
  type: 'array',
  items: { type: 'string' },
};

/**
 * 附件引用条目（0.52）：与 core `MessageRef` 对齐，**只有路径与元信息**。
 *
 * `mime` / `bytes` 是前端探测值（不可信），只透传；`path` 是宿主机绝对路径，
 * 边界判定在 handler 闸门里做（schema 只保证形状）。
 */
export const messageRefSchema = {
  type: 'object',
  required: ['kind', 'path'],
  properties: {
    kind: { type: 'string', enum: ['file', 'image', 'document'] },
    path: { type: 'string', minLength: 1, maxLength: MESSAGE_REF_PATH_MAX },
    name: { type: 'string' },
    mime: { type: 'string' },
    bytes: { type: 'integer', minimum: 0 },
  },
};

/**
 * 引用参数（`refs`）→ 归一后的条目（0.52）。`runs.start` 与 `teams.post` 共用一份。
 *
 * 这里**只做形状校验**：绝对路径、长度、条数、kind。路径边界（`allowed_roots` /
 * deny 目录）**不在这里判** —— 引用是「用户想让我读这个」，提前拒等于把用户意图
 * 丢掉；权限校验发生在模型读文件那一刻（`read` / `media` 的 `evaluatePath`），
 * 与普通文件工具同一套。
 *
 * params_schema 已经卡住形状；这里再截一次条数（服务端不接受比上限更宽的输入，
 * 而不是悄悄截断）——超限属于 `invalid_params`，由调用方抛出。
 */
export function readRefsParam(value: unknown): MessageRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RpcError('invalid_params', 'refs must be an array');
  if (value.length > MESSAGE_REFS_MAX) {
    throw new RpcError('invalid_params', `refs exceeds ${MESSAGE_REFS_MAX} items`, {
      reason: 'refs_invalid',
    });
  }
  const refs: MessageRef[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      throw new RpcError('invalid_params', 'refs entries must be objects', {
        reason: 'refs_invalid',
      });
    }
    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    const path = record.path;
    if (kind !== 'file' && kind !== 'image' && kind !== 'document') {
      throw new RpcError('invalid_params', 'refs[].kind must be file|image|document', {
        reason: 'refs_invalid',
      });
    }
    if (typeof path !== 'string' || path.length === 0 || path.length > MESSAGE_REF_PATH_MAX) {
      throw new RpcError('invalid_params', 'refs[].path must be a non-empty string', {
        reason: 'refs_invalid',
      });
    }
    // 形状：绝对路径。不用 `node:path.isAbsolute` 单判 —— 它的结果随宿主平台变
    //（Linux 上 `C:\x` 不算绝对），而 refs 的路径来自驱动 gateway 的那台宿主。
    if (!/^(?:[\\/]|[A-Za-z]:[\\/])/.test(path)) {
      throw new RpcError('invalid_params', 'refs[].path must be absolute', {
        reason: 'refs_invalid',
        path,
      });
    }
    const ref: MessageRef = { kind, path };
    if (typeof record.name === 'string') ref.name = record.name;
    if (typeof record.mime === 'string') ref.mime = record.mime;
    if (typeof record.bytes === 'number' && Number.isFinite(record.bytes) && record.bytes >= 0) {
      ref.bytes = Math.floor(record.bytes);
    }
    refs.push(ref);
  }
  return refs;
}

export const usageSchema = {
  type: 'object',
  properties: {
    prompt_tokens: { type: 'integer' },
    completion_tokens: { type: 'integer' },
    total_tokens: { type: 'integer' },
    total_cost: { type: 'number' },
  },
};

/** RunStatus；runs.get 的 durable checkpoint 也落在同一超集里。 */
export const runStatusSchema = {
  type: 'object',
  required: ['run_id', 'session_id', 'status'],
  properties: {
    run_id: { type: 'string' },
    core_run_id: { type: 'string' },
    session_id: { type: 'string' },
    status: {
      type: 'string',
      enum: ['queued', 'running', 'interrupted', 'completed', 'failed', 'cancelled'],
    },
    output: { type: 'string' },
    error: { type: 'string' },
    // 0.14 / 0.15 E6：run.failed envelope（additive）。
    error_code: { type: 'string' },
    category: { type: 'string' },
    phase: { type: 'string' },
    retryable: { type: 'boolean' },
    http_status: { type: 'integer' },
    details: { type: 'object' },
    usage: usageSchema,
    started_at: { type: 'number' },
    completed_at: { type: 'number' },
    queue_position: { type: 'integer' },
    // durable checkpoint 字段
    agent_id: { type: 'string' },
    messages: { type: 'array' },
    // 0.18：durable runs.get 从 metadata.preview / messages 派生的预览。
    preview: { type: 'string' },
    iteration: { type: 'integer' },
    updated_at: { type: 'number' },
  },
};

/** `sessions.get` 的 `session`：SessionState + 最近 RunRecord 的投影。 */
/**
 * 会话级上下文用量（`sessions.get.context_usage`，additive）。
 *
 * **整字段缺省 = 没有可用数据**（新会话还没跑过 / 尾部没有用量事件），不是 0、不是 null。
 * `max` 缺省表示上下文窗口未知 —— 客户端据此不画比例（不假造）。
 * `source` 只是自查字段（这个数字来自哪条事件的哪个字段），UI 不消费；
 * `request` = `used` / `max` 同源于那条 `llm.request` 的落盘元信息
 * （`estimated_tokens` + `context_max`）。
 */
export const contextUsageSchema = {
  type: 'object',
  required: ['used'],
  properties: {
    used: { type: 'integer', minimum: 0 },
    max: { type: 'integer', minimum: 0 },
    at: { type: 'number' },
    source: { type: 'string', enum: ['pressure', 'changed', 'estimated', 'prompt', 'request'] },
  },
};

export const runStateSchema = {
  type: 'object',
  required: ['run_id', 'session_id', 'messages', 'started_at', 'status'],
  properties: {
    run_id: { type: 'string' },
    session_id: { type: 'string' },
    messages: { type: 'array' },
    // S1：分页元数据（additive；旧客户端忽略）。messages_total 恒返回。
    messages_total: { type: 'integer', minimum: 0 },
    next_before: { type: 'string' },
    started_at: { type: 'number' },
    completed_at: { type: 'number' },
    status: {
      type: 'string',
      enum: ['running', 'interrupted', 'completed', 'failed', 'cancelled'],
    },
    usage: usageSchema,
    error: { type: 'string' },
    title: { type: 'string' },
    preview: { type: 'string' },
    updated_at: { type: 'number' },
    branch: { type: 'string' },
    // Additive（会话级上下文用量，从事件日志尾窗派生）：缺省 = 没有可用数据。
    context_usage: contextUsageSchema,
  },
};

/** core SessionInfo（sessions.list / sessions.search）。 */
export const sessionInfoSchema = {
  type: 'object',
  required: [
    'session_id',
    'title',
    'preview',
    'status',
    'started_at',
    'updated_at',
    'message_count',
  ],
  properties: {
    session_id: { type: 'string' },
    title: { type: 'string' },
    preview: { type: 'string' },
    status: { type: 'string' },
    started_at: { type: 'number' },
    updated_at: { type: 'number' },
    message_count: { type: 'integer' },
    // 以下可选字段在真实 session 文件中可能是 null 或缺失；校验器不支持
    // nullable/union，故不声明类型（任意值通过），required 与其余字段仍受约束。
    branch: {},
    // Additive (title_source): `manual` / `generated`；无标记（旧数据 / 未命名）时
    // 该 key 不出现。封闭联合，故这里能收窄成 enum。
    title_source: { type: 'string', enum: ['manual', 'generated'] },
  },
};

export const sessionSearchHitSchema = {
  type: 'object',
  required: ['session_id', 'title', 'preview', 'snippet', 'updated_at', 'message_count'],
  properties: {
    session_id: { type: 'string' },
    title: { type: 'string' },
    preview: { type: 'string' },
    snippet: { type: 'string' },
    updated_at: { type: 'number' },
    message_count: { type: 'integer' },
  },
};

/** 成员角色（AgentRole）；member / temporary 的转换入口是 agents.update。 */
const agentRoleEnum = ['member', 'temporary'];

/**
 * agents.list / agents.get 的条目（0.14 P0，DECISION-025 §1.4）。
 * 只声明冻结字段；`state` 同时覆盖 Host AgentState 与 run/派生状态。
 * `role` 同时承载运行期注册表角色（main / subagent）与 v3 成员角色。
 */
export const agentInfoSchema = {
  type: 'object',
  required: ['id', 'depth', 'state'],
  properties: {
    id: { type: 'string' },
    role: { type: 'string', enum: ['main', 'subagent', ...agentRoleEnum] },
    parent_id: { type: 'string' },
    depth: { type: 'integer', minimum: 0 },
    state: {
      type: 'string',
      enum: [
        // 注册表派生状态
        'idle',
        'queued',
        'running',
        'completed',
        'failed',
        'cancelled',
        'error',
        'closed',
        // 0.26：AgentService 成员状态（owner viewer）
        'created',
        'waiting_permission',
        'stale',
      ],
    },
    current_tool: { type: 'string' },
    session_id: { type: 'string' },
    usage: usageSchema,
    // 0.26 additive：owner viewer 从 AgentService 列出的成员字段。
    name: { type: 'string' },
    owner: { type: 'string' },
    visibility: { type: 'string', enum: ['private', 'team', 'tenant'] },
    presence: { type: 'string', enum: ['live', 'gone'] },
    membership: { type: 'string', enum: ['present', 'left'] },
    team_id: { type: 'string' },
    epoch: { type: 'integer', minimum: 0 },
    last_seen: { type: 'number' },
  },
};

/** agents.tree 节点（0.15 E5）：AgentCard + children_ids。 */
export const agentCardSchema = {
  type: 'object',
  required: ['id', 'depth', 'state', 'children_count', 'children_ids'],
  properties: {
    ...agentInfoSchema.properties,
    task: { type: 'string' },
    node_id: { type: 'string' },
    queue_position: { type: 'integer', minimum: 1 },
    wait_reason: { type: 'string' },
    context_used: { type: 'integer', minimum: 0 },
    context_max: { type: 'integer', minimum: 0 },
    children_count: { type: 'integer', minimum: 0 },
    last_seen: { type: 'number' },
    artifact_refs: stringListSchema,
    children_ids: stringListSchema,
  },
};

const schedulerStatsSchema = {
  type: 'object',
  required: ['queued', 'running', 'completed', 'failed', 'cancelled'],
  properties: {
    queued: { type: 'integer' },
    running: { type: 'integer' },
    completed: { type: 'integer' },
    failed: { type: 'integer' },
    cancelled: { type: 'integer' },
  },
};

const schedulerRunSchema = {
  type: 'object',
  required: ['run_id', 'status'],
  properties: {
    run_id: { type: 'string' },
    agent_id: { type: 'string' },
    session_id: { type: 'string' },
    status: { type: 'string' },
    queue_position: { type: 'integer' },
    queued_at: { type: 'number' },
    started_at: { type: 'number' },
    wait_reason: { type: 'string' },
  },
};

/** health.get 的 runtime 快照（0.15 E6）。 */
export const runtimeSnapshotSchema = {
  type: 'object',
  required: ['scheduler'],
  properties: {
    active_run_id: { type: 'string' },
    scheduler: {
      type: 'object',
      required: ['as_of', 'queued', 'running', 'stats'],
      properties: {
        as_of: { type: 'number' },
        queued: { type: 'array', items: schedulerRunSchema },
        running: { type: 'array', items: schedulerRunSchema },
        stats: schedulerStatsSchema,
      },
    },
  },
};

export const runEventSchema = {
  type: 'object',
  required: ['type', 'run_id', 'data', 'ts'],
  properties: {
    type: { type: 'string' },
    run_id: { type: 'string' },
    data: { type: 'object' },
    ts: { type: 'number' },
    seq: { type: 'integer' },
    node_id: { type: 'string' },
  },
};

export const metricsSnapshotSchema = {
  type: 'object',
  required: ['runs', 'tool_calls', 'llm', 'duration_ms', 'updated_at'],
  properties: {
    runs: {
      type: 'object',
      required: ['started', 'completed', 'failed', 'cancelled'],
      properties: {
        started: { type: 'integer' },
        completed: { type: 'integer' },
        failed: { type: 'integer' },
        cancelled: { type: 'integer' },
      },
    },
    tool_calls: {
      type: 'object',
      required: ['total', 'failed'],
      properties: {
        total: { type: 'integer' },
        failed: { type: 'integer' },
      },
    },
    llm: {
      type: 'object',
      required: ['requests', 'prompt_tokens', 'completion_tokens', 'total_tokens'],
      properties: {
        requests: { type: 'integer' },
        prompt_tokens: { type: 'integer' },
        completion_tokens: { type: 'integer' },
        total_tokens: { type: 'integer' },
        // 0.29 B3（CONTRACT-0.29 §3）：additive，**不进 required**。
        // 缺省表示该批事件没有缓存数据（provider 不支持），不是 0。
        cache_read_tokens: { type: 'integer', minimum: 0 },
        cache_creation_tokens: { type: 'integer', minimum: 0 },
      },
    },
    duration_ms: {
      type: 'object',
      required: ['total', 'max', 'avg'],
      properties: {
        total: { type: 'number' },
        max: { type: 'number' },
        avg: { type: 'number' },
      },
    },
    updated_at: { type: 'integer' },
  },
};

export const evalCaseResultSchema = {
  type: 'object',
  required: ['id', 'status', 'duration_ms', 'assertions'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['passed', 'failed', 'error', 'skipped'] },
    duration_ms: { type: 'number' },
    assertions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'ok'],
        properties: {
          type: { type: 'string' },
          ok: { type: 'boolean' },
          detail: { type: 'string' },
        },
      },
    },
    output: { type: 'string' },
    usage: {
      type: 'object',
      required: ['prompt_tokens', 'completion_tokens', 'total_tokens'],
      properties: {
        prompt_tokens: { type: 'integer' },
        completion_tokens: { type: 'integer' },
        total_tokens: { type: 'integer' },
      },
    },
    error: { type: 'string' },
  },
};

export const evalReportSchema = {
  type: 'object',
  required: [
    'suite',
    'network',
    'started_at',
    'finished_at',
    'duration_ms',
    'total',
    'passed',
    'failed',
    'errors',
    'skipped',
    'cases',
  ],
  properties: {
    suite: { type: 'string' },
    network: { type: 'boolean' },
    started_at: { type: 'number' },
    finished_at: { type: 'number' },
    duration_ms: { type: 'number' },
    total: { type: 'integer' },
    passed: { type: 'integer' },
    failed: { type: 'integer' },
    errors: { type: 'integer' },
    skipped: { type: 'integer' },
    cases: { type: 'array', items: evalCaseResultSchema },
  },
};

// ── 0.19 S3：本地 Team 控制面（canonical teams.*） ──
// 未列入 required 的字段（name / team_id / system_event）都是可选的。

/** teams.list / teams.get 的 `team`（TeamSummary）。 */
export const teamSummarySchema = {
  type: 'object',
  required: ['team_id', 'name', 'member_count', 'online_count', 'created_at'],
  properties: {
    team_id: { type: 'string' },
    name: { type: 'string' },
    workspace: { type: 'string' },
    policy: { type: 'object' },
    // 0.21：Team 描述（additive）。
    description: { type: 'string' },
    member_count: { type: 'integer', minimum: 0 },
    online_count: { type: 'integer', minimum: 0 },
    created_at: { type: 'number' },
    // S10.3：归档时间（additive）；缺省 = active。
    archived_at: { type: 'number' },
    // 0.27：冻结 spawn（additive）；缺省 = 未冻结。
    spawn_frozen: { type: 'boolean' },
  },
};

/** 已退役 Binding（0.19 S6 additive）。 */
export const agentBodyHistoryEntrySchema = {
  type: 'object',
  required: ['session_id', 'epoch', 'started_at', 'retired_at'],
  properties: {
    session_id: { type: 'string' },
    epoch: { type: 'integer', minimum: 0 },
    started_at: { type: 'number' },
    retired_at: { type: 'number' },
  },
};

/** teams.get 的 roster 条目（TeamMemberSummary）；name / body_history 可缺失。 */
export const teamMemberSchema = {
  type: 'object',
  required: ['agent_id', 'session_id', 'membership', 'presence', 'visibility', 'state', 'epoch'],
  properties: {
    agent_id: { type: 'string' },
    name: { type: 'string' },
    session_id: { type: 'string' },
    team_id: { type: 'string' },
    // peer 缺省 owner；contractor / root 有值。
    owner: { type: 'string' },
    membership: { type: 'string', enum: ['present', 'left'] },
    presence: { type: 'string', enum: ['live', 'gone'] },
    visibility: { type: 'string', enum: ['private', 'team', 'tenant'] },
    state: { type: 'string' },
    epoch: { type: 'integer', minimum: 0 },
    // 0.21：epoch ms；旧数据 / 从未活跃时缺失。
    last_seen: { type: 'number' },
    body_history: { type: 'array', items: agentBodyHistoryEntrySchema },
  },
};

/** teams.get 的最近消息（TeamLogEntry）。 */
export const teamMessageSchema = {
  type: 'object',
  required: ['message_id', 'team_id', 'from', 'to', 'mentions', 'content', 'ts', 'kind'],
  properties: {
    message_id: { type: 'string' },
    team_id: { type: 'string' },
    from: { type: 'string' },
    to: stringListSchema,
    mentions: stringListSchema,
    content: { type: 'string' },
    ts: { type: 'number' },
    kind: { type: 'string', enum: ['post', 'mention', 'system', 'reply'] },
    // 0.19 S4：人工预算 override 的系统记录；0.38：撤回 tombstone。
    system_event: {
      type: 'string',
      enum: [
        'join',
        'leave',
        'rotate',
        'archive',
        'budget_override',
        // CREATE-0.39：新写为 create；`fork` 只作旧日志只读值。
        'create',
        'fork',
        'retract',
      ],
    },
    // 0.38：撤回 tombstone 指向的目标 message_id。
    retracted_message_id: { type: 'string' },
    // 0.19 S4：会话分组；旧日志缺省。
    conversation_id: { type: 'string' },
    // 0.21：跨节点报文元数据（additive；同机消息缺失）。
    federation: {
      type: 'object',
      required: ['from_addr', 'to_addr', 'conversation_id', 'hop'],
      properties: {
        from_addr: { type: 'string' },
        to_addr: { type: 'string' },
        conversation_id: { type: 'string' },
        hop: { type: 'integer', minimum: 1 },
      },
    },
    // 0.52 additive：本条日志携带的附件引用；无引用 / 旧日志缺失该键。
    refs: { type: 'array', items: messageRefSchema },
  },
};

/** teams.post 的逐条投递结果（TeamDelivery）。 */
export const teamDeliverySchema = {
  type: 'object',
  required: ['agent_id', 'status'],
  properties: {
    agent_id: { type: 'string' },
    status: { type: 'string', enum: ['queued', 'rejected', 'error'] },
    message_id: { type: 'string' },
    resolution: { type: 'string', enum: ['live', 'resumed', 'rotating', 'created'] },
    code: { type: 'string' },
    reason: { type: 'string' },
  },
};

/** teams.post 结果（TeamPostResult）。 */
export const teamPostResultSchema = {
  type: 'object',
  required: ['message_id', 'team_id', 'kind', 'mentions', 'delivered', 'ts'],
  properties: {
    message_id: { type: 'string' },
    team_id: { type: 'string' },
    kind: { type: 'string', enum: ['post', 'mention', 'system'] },
    mentions: stringListSchema,
    delivered: { type: 'array', items: teamDeliverySchema },
    ts: { type: 'number' },
    // 0.19 S4：本次 post 的会话分组；新实现总是返回。
    conversation_id: { type: 'string' },
    // 0.52 additive：已写进日志的引用；无引用时缺省。
    refs: { type: 'array', items: messageRefSchema },
  },
};

/** teams.retract 结果：`message_id` 是 tombstone，`retracted_message_id` 是目标。 */
export const teamRetractResultSchema = {
  type: 'object',
  required: ['team_id', 'message_id', 'retracted_message_id'],
  properties: {
    team_id: { type: 'string' },
    message_id: { type: 'string' },
    retracted_message_id: { type: 'string' },
  },
};

/** teams.members 结果（TeamMembersResult）。 */
export const teamMembersResultSchema = {
  type: 'object',
  required: ['team_id', 'action', 'agent_id', 'membership'],
  properties: {
    team_id: { type: 'string' },
    action: { type: 'string', enum: ['add', 'remove'] },
    agent_id: { type: 'string' },
    membership: { type: 'string', enum: ['present', 'left'] },
  },
};

// ── 0.19 S4：conversation 预算（teams.budget） ──

const budgetOverrideEntrySchema = {
  type: 'object',
  required: ['max', 'by', 'via', 'at'],
  properties: {
    max: { type: 'integer' },
    by: { type: 'string', enum: ['human'] },
    via: { type: 'string', enum: ['cli', 'api'] },
    at: { type: 'number' },
  },
};

/** ConversationBudgetStatus；不含消息正文。 */
export const conversationBudgetStatusSchema = {
  type: 'object',
  required: [
    'conversation_id',
    'created_at',
    'last_activity',
    'hops',
    'turns',
    'total_tokens',
    'wall_clock_ms',
    'edges',
    'overrides',
  ],
  properties: {
    conversation_id: { type: 'string' },
    team_id: { type: 'string' },
    created_at: { type: 'number' },
    last_activity: { type: 'number' },
    hops: { type: 'integer', minimum: 0 },
    turns: { type: 'integer', minimum: 0 },
    total_tokens: { type: 'integer', minimum: 0 },
    wall_clock_ms: { type: 'number', minimum: 0 },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['from', 'to', 'count', 'last_ts'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          count: { type: 'integer', minimum: 0 },
          last_ts: { type: 'number' },
          blocked_until: { type: 'number' },
        },
      },
    },
    overrides: {
      type: 'object',
      properties: {
        hops: budgetOverrideEntrySchema,
        turns: budgetOverrideEntrySchema,
        tokens: budgetOverrideEntrySchema,
        wall_clock: budgetOverrideEntrySchema,
        cycle: budgetOverrideEntrySchema,
      },
    },
    blocked: {
      type: 'object',
      required: ['dimension', 'reason', 'at'],
      properties: {
        dimension: {
          type: 'string',
          enum: ['hops', 'turns', 'tokens', 'wall_clock', 'cycle'],
        },
        reason: { type: 'string' },
        at: { type: 'number' },
      },
    },
  },
};

/**
 * teams.budget 结果（status / override）。
 * `previous_max` / `max` 允许 null，而校验器子集没有 union / nullable；
 * 这里不声明 type（任意值通过），nullable 语义由注入的 Team 控制面保证。
 */
export const teamBudgetResultSchema = {
  type: 'object',
  required: ['team_id', 'action'],
  properties: {
    team_id: { type: 'string' },
    action: { type: 'string', enum: ['status', 'override'] },
    conversation_id: { type: 'string' },
    status: conversationBudgetStatusSchema,
    conversations: { type: 'array', items: conversationBudgetStatusSchema },
    previous_max: {},
    max: {},
  },
};

/** teams.get 结果（TeamDetail）。 */
export const teamDetailSchema = {
  type: 'object',
  required: ['team', 'members', 'messages'],
  properties: {
    team: teamSummarySchema,
    members: { type: 'array', items: teamMemberSchema },
    messages: { type: 'array', items: teamMessageSchema },
    // S1：窗口之前是否还有日志（可选：旧控制面 / 旧传输缺省视为 false）。
    messages_has_more: { type: 'boolean' },
  },
};

// ── 0.25：canonical agent 生命周期（agents.create|update|close） ──

/**
 * 成员对外状态（MemberStatus）。只声明对外字段；
 * model / system_prompt 不进入 DTO（只落快照，由下一次 spawn 使用）。
 */
export const agentStatusSchema = {
  type: 'object',
  // owner 可选：缺省表示 peer（无 owner）；role 对旧快照也可缺省。
  required: ['id', 'session_id', 'visibility', 'state'],
  properties: {
    id: { type: 'string' },
    session_id: { type: 'string' },
    name: { type: 'string' },
    parent_id: { type: 'string' },
    role: { type: 'string', enum: agentRoleEnum },
    owner: { type: 'string' },
    visibility: { type: 'string', enum: ['private', 'team', 'tenant'] },
    state: {
      type: 'string',
      enum: [
        'created',
        'idle',
        'running',
        'waiting_permission',
        'completed',
        'failed',
        'cancelled',
        'closed',
        'stale',
      ],
    },
    presence: { type: 'string', enum: ['live', 'gone'] },
    membership: { type: 'string', enum: ['present', 'left'] },
    team_id: { type: 'string' },
    epoch: { type: 'integer', minimum: 0 },
    current_tool: { type: 'string' },
    last_seen: { type: 'number' },
    usage: usageSchema,
    body_history: { type: 'array', items: agentBodyHistoryEntrySchema },
  },
};
