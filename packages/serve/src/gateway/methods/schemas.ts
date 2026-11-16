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

/**
 * 会话级「模型这一轮看到了什么系统消息」（`sessions.get.system_context`，additive）。
 *
 * 载荷就是 core `prompt.system_context` 事件里能展示的那几项：**模型真正看到的那份系统
 * 消息**（基底 system prompt + Self Card 原文）与它对应哪一轮。
 * **整字段缺省 = 没有可用数据**（没跑过 / 尾部没有该事件 / 端口未注入），不是空串、不是 0；
 * `system_prompt` 与 `self_card` 至少有一个（只有 hash 的空壳不作为数据出现）。
 */
export const systemContextSchema = {
  type: 'object',
  required: ['hash'],
  properties: {
    hash: { type: 'string' },
    system_prompt: { type: 'string' },
    self_card: { type: 'string' },
    model: { type: 'string' },
    message_count: { type: 'integer', minimum: 0 },
    tools_count: { type: 'integer', minimum: 0 },
    estimated_tokens: { type: 'integer', minimum: 0 },
    context_max: { type: 'integer', minimum: 0 },
    at: { type: 'number' },
    run_id: { type: 'string' },
    // Additive（0.52）：与上一份快照差在哪。缺省 = 不知道（首次 / 旧日志），不是「0 项」。
    changed: { type: 'array', items: { type: 'string' } },
    previous_hash: { type: 'string' },
  },
};

/**
 * 会话事件日志的游标（`sessions.get.event_cursor`，additive 0.53）。
 *
 * 两个数是**不同**的东西，别混：
 * - `last_seq` = 事件日志里最后一条事件的 `seq`（从文件尾定边界，不依赖索引）；
 * - `derived_upto_seq` = 元数据派生覆盖到的 `seq`（`index.json`）：它 `< last_seq`
 *   说明还有事件没进会话投影（正跑 / 刚崩）。
 *
 * **整字段缺省 = 这个会话还没有事件日志**（一条事件都没落过），不是 0 也不是 null。
 * `event_count` 与 `derived_upto_seq` 同源（`index.json`），索引缺失/损坏时一起缺省。
 */
export const sessionEventCursorSchema = {
  type: 'object',
  required: ['last_seq'],
  properties: {
    last_seq: { type: 'integer', minimum: 0 },
    derived_upto_seq: { type: 'integer', minimum: 0 },
    event_count: { type: 'integer', minimum: 0 },
    // 0.54 A（ADR-105 §3 I4）：timeline 的四个技术字段。**一起出现或一起缺省**：
    // 开关关 / 该会话没有 timeline ⇒ 四个都不在（0 是「有 timeline 但还没归档」，不是「没有」）。
    timeline_head: { type: 'integer', minimum: 0 },
    wal_head: { type: 'integer', minimum: 0 },
    holes: {
      type: 'array',
      // 只给区间：洞内是读不回来的 seq，贴 payload = 把不可读伪装成可读。
      items: {
        type: 'object',
        required: ['from_seq', 'to_seq'],
        properties: {
          from_seq: { type: 'integer', minimum: 1 },
          to_seq: { type: 'integer', minimum: 1 },
        },
      },
    },
    tainted: { type: 'boolean' },
  },
};

/**
 * `sessions.events` 的事件体（additive 0.53）：与 SSE 回放的**事件对象同字段**——
 * `RunEvent` 的 `type` / `run_id` / `ts` / `data` 再加 `seq`，前端按 `seq` 幂等合并。
 *
 * 落盘记录里的 `v` / `fencing_token` / `session_id` 是写入内部字段，不透出
 * （`session_id` 就是入参，`data` 形状由事件类型决定，schema 只保证是对象外的一切值）。
 */
export const sessionEventSchema = {
  type: 'object',
  required: ['seq', 'type', 'ts'],
  properties: {
    seq: { type: 'integer', minimum: 1 },
    type: { type: 'string', minLength: 1 },
    ts: { type: 'integer', minimum: 0 },
    run_id: { type: 'string' },
    data: {},
  },
};

/**
 * 一个被裁字段的结构化裁断事实（`messages[i].truncated.<field>`，additive 0.54）。
 *
 * 字符串里那串 `... [truncated]` 标记照旧拼（既有 UI 依赖），这三个数只是把它显式化：
 * `bytes` 是**截断前**的完整 UTF-8 字节数，`limit` 是生效上限，`marker` 是那串标记本身。
 */
export const cappedFieldInfoSchema = {
  type: 'object',
  required: ['bytes', 'limit', 'marker'],
  properties: {
    bytes: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1 },
    marker: { type: 'string' },
  },
};

/**
 * 单条消息上的裁断事实（`messages[i].truncated`，additive 0.54）。**sparse**：没被裁就没有。
 *
 * `arguments` 是「被裁 call 里的最大原字节数」，`arguments_calls` 只在多个 call 合并时才出现。
 */
export const messageTruncationSchema = {
  type: 'object',
  properties: {
    content: cappedFieldInfoSchema,
    arguments: cappedFieldInfoSchema,
    arguments_calls: { type: 'integer', minimum: 2 },
  },
};

/**
 * 一条工具消息的投影（`messages[i].projection`，additive 0.54，wire-only 派生）。
 *
 * 形状与取值域照抄 `docs/specs/projection-card-spec.md` §1.7；`mode` 用 ADR-104 §2.2
 * 冻结的四模式闭集（`externalize` 只占位、不可声明），**不在这里自创枚举**。
 *
 * 三个「不知道」的字段故意**不写 type**（校验器只认 string/number/integer/boolean/
 * object/array 的单一 `type`，写不成 `integer|null`）：
 * - `original_bytes` / `original_lines`：`integer | null`（null = 原文只在事件日志里，未知）；
 * - `declaration_id`：`string | null`（null = 该会话没有声明）。
 * 一律**不写 0 / 不写空串**冒充：0 在字节数与行数上都是合法值。
 */
export const projectionViewSchema = {
  type: 'object',
  required: ['mode', 'tool_call_id', 'placeholder_text', 'placeholder_hash', 'original_available'],
  properties: {
    mode: {
      type: 'string',
      enum: ['passthrough', 'placeholder', 'externalize', 'archive_notice'],
    },
    tool_call_id: { type: 'string', minLength: 1 },
    // 逐字：core 渲染好的那一字节。**不 trim、不重排**（UI 只展示）。
    placeholder_text: { type: 'string' },
    // 与 `prompt.system_context.hash` 同一口径（sha256 前 16 位）。
    placeholder_hash: { type: 'string', minLength: 1 },
    original_bytes: {},
    original_lines: {},
    original_available: {
      type: 'string',
      enum: ['inline', 'inline_truncated', 'readback', 'gone'],
    },
    // 需要跨源读取时的句柄（`kind` 是闭集；`events` 用 tool_call_id + since_seq。
    // `since_seq` 与 `sessions.events` 同名同义：**排他**游标，0 = 从日志头按 id 找）。
    // `readback` 只表示「请求可得」，不保证读得回来：空结果时 UI 降级到 `gone` 文案。
    readback: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['events', 'file', 'handle'] },
        tool_call_id: { type: 'string', minLength: 1 },
        since_seq: { type: 'integer', minimum: 0 },
      },
    },
    // 缺省 = 不知道（本次没读事件日志）；**不写 0**（0 在日志里是「第一条事件」）。
    since_event_seq: { type: 'integer', minimum: 0 },
    declaration_id: {},
  },
};

/**
 * 整会话的投影汇总（`sessions.get.session.projection_summary`，additive 0.54）。
 *
 * 口径 = **整个会话当前态**（在切片前对全量 messages 累加），不是当前分页窗口。
 * `bytes_saved` 是**净值**（可负，不 clamp）；`unknown_original_count > 0` 时它是**下界**
 * （有几条的原文体量未知，未计入 —— 未知不等于 0）。
 */
export const projectionSummarySchema = {
  type: 'object',
  required: ['total', 'bytes_saved', 'modes'],
  properties: {
    total: { type: 'integer', minimum: 0 },
    // 净值：原文比占位还短的小结果会让它变小 / 变负 —— 不 clamp（那是系统性高估）。
    bytes_saved: { type: 'integer' },
    // 闭集键 → 条数（没出现的 mode 不补 0）。
    modes: { type: 'object' },
    unknown_original_count: { type: 'integer', minimum: 0 },
  },
};

/**
 * `sessions.get.session.messages[i]` 的登记面（additive 0.54）。
 *
 * 只登记**承载新字段的容器**与 `role` / `tool_call_id`（新字段的语义锚点）：其余字段
 * （`content` / `tool_calls` / `timestamp` / `refs` …）由 core 的 `Message` 定义，旧数据
 * 缺字段是常态，**不写 required**，也不在这里重述它们的形状（重述只会漂移）。
 */
export const sessionMessageSchema = {
  type: 'object',
  properties: {
    role: { type: 'string' },
    tool_call_id: { type: 'string' },
    // Additive（0.54）：8 KiB 裁断事实（始终 ≥ 0 字节；不出现 = 一个字都没裁）。
    truncated: messageTruncationSchema,
    // Additive（0.54）：投影（**sparse**，不出现 = 没被投射，UI 与今天完全一致）。
    projection: projectionViewSchema,
  },
};

export const runStateSchema = {
  type: 'object',
  required: ['run_id', 'session_id', 'messages', 'started_at', 'status'],
  properties: {
    run_id: { type: 'string' },
    session_id: { type: 'string' },
    messages: { type: 'array', items: sessionMessageSchema },
    // Additive（0.54）：整会话投影汇总；一条都没被投影 ⇒ 字段缺省（旧行为一字不改）。
    projection_summary: projectionSummarySchema,
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
    // Additive（模型这一轮看到的系统消息，从事件日志尾窗派生）：缺省 = 没有可用数据。
    system_context: systemContextSchema,
    // Additive（0.53）：事件日志游标，决定要不要 `/sessions.events` 补洞。
    // 缺省 = 该会话还没有事件日志。
    event_cursor: sessionEventCursorSchema,
    // Additive（0.53 U1，ADR-104 §8.2）：会话级上下文投射模式。由服务端解析给出
    // （旧会话 / 缺省 ⇒ `placeholder`），**客户端不许自己推断**。
    projection_mode: {
      type: 'string',
      enum: ['passthrough', 'placeholder', 'archive_notice'],
    },
    // Additive（0.53 U1，ADR-104 §8.2）：模式是否已写定（`sessions.get` 恒 true；
    // 「还能不能改」属于 create 入口，不属于 get）。
    projection_locked: { type: 'boolean' },
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
    // Additive (0.52, `agent`): 会话的**归属**。让「会话卡片第二行」不再靠前端拿 session id
    // 去 agents / team members / body_history 三份名单反查 —— 那三份各有门槛（只认 primary
    // body、只认 member、roster 拉不到就没有），反查不到就是一行空白。字段全部可选：
    // 老 gateway 不返回 ⇒ 前端自动回落到反查；`primary=false` 表示这是已退役 body 的会话。
    agent: {
      type: 'object',
      required: ['id', 'state', 'primary'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        /** 成员状态原值（`closed` = 已停用：会话默认归档，由「显示归档」开关决定是否列出）。 */
        state: { type: 'string' },
        presence: { type: 'string', enum: ['live', 'gone'] },
        primary: { type: 'boolean' },
      },
    },
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
