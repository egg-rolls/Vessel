/**
 * canonical `agents.create|update|close` 的结构化控制面端口（0.25）。
 *
 * `packages/serve` 不依赖 `@vessel-agent/agent`（分包方向不可倒置）：
 * app 侧把 AgentService 适配成此结构接口注入，gateway 与（后续的）owner
 * 端点共用同一套 handler，不做二次生命周期逻辑。
 *
 * 所有方法都是批量的：单条调用 = 单元素数组；结果与输入同序，
 * 单条失败不影响其它条目（与 `AgentService.new` / `close` 的批量语义一致）。
 *
 * @module @vessel-agent/serve
 */

/** 成员可见性（与 packages/agent 的 MemberVisibility 同值）。 */
export type AgentVisibilityLike = 'private' | 'team' | 'tenant';

/** 成员状态机值（含只读 legacy `stale`）。 */
export type AgentStateLike =
  | 'created'
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'closed'
  | 'stale';

/** 成员对外状态（MemberStatus 的结构化子集；未知字段忽略）。 */
export interface AgentStatusLike {
  id: string;
  session_id: string;
  name?: string;
  parent_id?: string;
  owner: string;
  visibility: AgentVisibilityLike;
  state: AgentStateLike;
  presence?: 'live' | 'gone';
  membership?: 'present' | 'left';
  team_id?: string;
  epoch?: number;
  current_tool?: string;
  last_seen?: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    total_cost?: number;
  };
  body_history?: Array<{
    session_id: string;
    epoch: number;
    started_at: number;
    retired_at: number;
  }>;
}

/** `agents.create` 的单个条目（workspace 由 handler 从 team_id 解析后填入）。 */
export interface AgentCreateLikeInput {
  name?: string;
  model?: string;
  system_prompt?: string;
  /** team_id 解析出的 workspace；缺省 = AgentService 的默认 workspace 规则。 */
  workspace?: string;
  visibility?: AgentVisibilityLike;
}

/** `agents.update` 的单个条目。 */
export interface AgentUpdateLikeInput {
  agent_id: string;
  name?: string;
  model?: string;
  system_prompt?: string;
}

/** 成功条目：create / update 返回成员状态；update 额外带变化字段。 */
export interface AgentLifecycleOkLike {
  ok: true;
  agent: AgentStatusLike;
  /** 只有 update 会带：实际变化的字段名。 */
  changed?: string[];
  /** 只有 model / system_prompt 实际变化时出现。 */
  applies_to?: 'next_body';
}

/** close 成功条目：批量契约统一带 `agent`，并保留关闭结果字段。 */
export interface AgentCloseOkLike {
  ok: true;
  agent: AgentStatusLike;
  agent_id: string;
  closed: true;
}

/** 失败条目：稳定 code + 人读 message。 */
export interface AgentLifecycleFailLike {
  ok: false;
  code: string;
  error: string;
}

export type AgentLifecycleItemLike = AgentLifecycleOkLike | AgentLifecycleFailLike;
export type AgentCloseItemLike = AgentCloseOkLike | AgentLifecycleFailLike;

export interface AgentLifecycleBatchResultLike {
  results: AgentLifecycleItemLike[];
}

export interface AgentCloseBatchResultLike {
  results: AgentCloseItemLike[];
}

/**
 * 注入的 Agent 生命周期控制面；`tenantId` 决定 canonical RPC 的 tenant 作用域。
 * 未注入 / tenant 不匹配时 `agents.create|update|close` 返回 `not_found`。
 */
export interface AgentControlLike {
  readonly tenantId: string;
  /** 批量创建；条目并行，结果与输入同序。 */
  create(inputs: AgentCreateLikeInput[]): Promise<AgentLifecycleBatchResultLike>;
  /** 批量更新；条目并行，结果与输入同序。 */
  update(inputs: AgentUpdateLikeInput[]): Promise<AgentLifecycleBatchResultLike>;
  /** 批量关闭；条目并行，结果与输入同序。 */
  close(agentIds: string[]): Promise<AgentCloseBatchResultLike>;
  /** 按成员 id / 当前 Body session 查找（忽略可见性）；未知返回 undefined。 */
  get(agentId: string): Promise<AgentStatusLike | undefined>;
}
