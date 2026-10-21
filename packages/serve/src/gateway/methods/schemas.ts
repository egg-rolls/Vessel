/**
 * canonical RPC 方法的 result_schema 复用片段（DECISION-019 §B）。
 *
 * 只使用 `rpc.ts` 校验器支持的子集：object / array / string / number /
 * integer / boolean，以及 required / properties / items / enum / minLength /
 * maxLength / minimum / maximum。不要引入 oneOf / $ref / additionalProperties 等。
 *
 * @module @vessel-agent/serve
 */

export const stringListSchema = {
  type: 'array',
  items: { type: 'string' },
};

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
    iteration: { type: 'integer' },
    updated_at: { type: 'number' },
    tenant_id: { type: 'string' },
  },
};

/** core RunState（sessions.get 的 `session`）。 */
export const runStateSchema = {
  type: 'object',
  required: ['run_id', 'session_id', 'messages', 'started_at', 'status'],
  properties: {
    run_id: { type: 'string' },
    session_id: { type: 'string' },
    messages: { type: 'array' },
    started_at: { type: 'number' },
    completed_at: { type: 'number' },
    status: { type: 'string', enum: ['running', 'completed', 'failed', 'cancelled'] },
    usage: usageSchema,
    error: { type: 'string' },
    title: { type: 'string' },
    preview: { type: 'string' },
    updated_at: { type: 'number' },
    branch: { type: 'string' },
    tenant_id: { type: 'string' },
    ended_at: { type: 'number' },
    end_reason: { type: 'string' },
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
    tenant_id: {},
    ended_at: {},
    end_reason: {},
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

/**
 * agents.list / agents.get 的条目（0.14 P0，DECISION-025 §1.4）。
 * 只声明冻结字段；`state` 同时覆盖 Host AgentState 与 run/派生状态。
 */
export const agentInfoSchema = {
  type: 'object',
  required: ['id', 'depth', 'state'],
  properties: {
    id: { type: 'string' },
    role: { type: 'string' },
    parent_id: { type: 'string' },
    depth: { type: 'integer', minimum: 0 },
    state: {
      type: 'string',
      enum: ['idle', 'queued', 'running', 'completed', 'failed', 'cancelled', 'error', 'closed'],
    },
    current_tool: { type: 'string' },
    session_id: { type: 'string' },
    usage: usageSchema,
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

/** tasks.list / tasks.get 条目（0.15 E5，只读派生）。 */
export const taskEntrySchema = {
  type: 'object',
  required: ['id', 'title', 'assignee', 'status', 'artifact_refs', 'since'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    assignee: { type: 'string' },
    status: {
      type: 'string',
      enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    },
    parent_task: { type: 'string' },
    artifact_refs: stringListSchema,
    since: { type: 'number' },
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

export const tenantInfoSchema = {
  type: 'object',
  required: ['tenant_id', 'status', 'created_at'],
  properties: {
    tenant_id: { type: 'string' },
    name: { type: 'string' },
    status: { type: 'string', enum: ['active', 'disabled'] },
    created_at: { type: 'number' },
    quota: { type: 'object' },
    usage: { type: 'object' },
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
    tenant_id: { type: 'string' },
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

export const workflowSummarySchema = {
  type: 'object',
  required: [
    'workflow_run_id',
    'workflow_name',
    'status',
    'step_count',
    'completed_steps',
    'started_at',
    'updated_at',
  ],
  properties: {
    workflow_run_id: { type: 'string' },
    workflow_name: { type: 'string' },
    status: {
      type: 'string',
      enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted'],
    },
    step_count: { type: 'integer' },
    completed_steps: { type: 'integer' },
    started_at: { type: 'number' },
    updated_at: { type: 'number' },
    error: { type: 'string' },
  },
};

export const workflowStepSchema = {
  type: 'object',
  required: ['id', 'type', 'status', 'attempts'],
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['agent', 'tool'] },
    status: {
      type: 'string',
      enum: ['pending', 'running', 'completed', 'failed', 'skipped', 'cancelled'],
    },
    attempts: { type: 'integer' },
    started_at: { type: 'number' },
    finished_at: { type: 'number' },
    error: { type: 'string' },
    output_preview: { type: 'string' },
  },
};

export const workflowDetailSchema = {
  type: 'object',
  required: [
    'workflow_run_id',
    'workflow_name',
    'status',
    'step_count',
    'completed_steps',
    'started_at',
    'updated_at',
    'definition_path',
    'inputs',
    'steps',
  ],
  properties: {
    workflow_run_id: { type: 'string' },
    workflow_name: { type: 'string' },
    status: {
      type: 'string',
      enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted'],
    },
    step_count: { type: 'integer' },
    completed_steps: { type: 'integer' },
    started_at: { type: 'number' },
    updated_at: { type: 'number' },
    error: { type: 'string' },
    definition_path: { type: 'string' },
    inputs: { type: 'object' },
    steps: { type: 'array', items: workflowStepSchema },
  },
};
