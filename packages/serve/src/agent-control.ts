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

/** 成员角色（与 packages/agent 的 AgentRole 同值）；转换只经 `agents.update`。 */
export type AgentRoleLike = 'single' | 'member' | 'temporary';

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
  /** v3 成员角色；旧快照可能缺省。 */
  role?: AgentRoleLike;
  /** 归属 principal；缺省 = peer（无 owner） */
  owner?: string;
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
  /** 输入判别（不落盘）：peer 无 owner 且绑定 team；contractor 归属调用者。缺省 = 旧行为。 */
  kind?: 'peer' | 'contractor';
  /** peer / 成员派生路径：按已存在 Team 绑定；peer 必填。 */
  team_id?: string;
  name?: string;
  model?: string;
  system_prompt?: string;
  /** team_id 解析出的 workspace；缺省 = AgentService 的默认 workspace 规则。 */
  workspace?: string;
  visibility?: AgentVisibilityLike;
  /**
   * 发送者 / 所有者身份。只由合成 owner principal 填入（root owner id）；
   * gateway 不传，沿用 AgentService 的 `DEFAULT_OWNER`。
   */
  owner?: string;
  /** 审计用调用者 id（只写入 `agent.spawned` 事件，不持久化）。 */
  spawnedBy?: string;
  /** 同 `owner`，合成 owner 创建的成员与 owner 建立父子关系。 */
  parent_id?: string;
}

/** `agents.list` 的过滤条件；viewer 用于 private 可见性。 */
export interface AgentListLikeInput {
  viewer?: string;
  visibility?: AgentVisibilityLike;
  state?: AgentStateLike | readonly AgentStateLike[];
  parent_id?: string;
}

/** `agents.send` 的单个条目（strict send：不 resume）。 */
export interface AgentSendLikeInput {
  to: string;
  content: string;
  conversation_id?: string;
  /** 合成 owner principal 的 agent id；缺省由 app 适配器使用 DEFAULT_OWNER。 */
  from?: string;
}

/** `agents.dispatch` 的单个条目。 */
export interface AgentDispatchLikeInput {
  to: string;
  content: string;
  conversation_id?: string;
  allow_fork?: boolean;
  from?: string;
}

/** `agents.rotate` 的单个条目。 */
export interface AgentRotateLikeInput {
  to: string;
  startup_prompt: string;
  from_session_id?: string;
  from?: string;
}

/** `agents.update` 的单个条目。 */
export interface AgentUpdateLikeInput {
  agent_id: string;
  name?: string;
  model?: string;
  system_prompt?: string;
  /** 目标角色；缺省 = 不转换。 */
  role?: AgentRoleLike;
  /** wire 的 `team_id`；转换目标 Team（缺省语义由服务按目标角色决定）。 */
  teamId?: string;
  /** 转换发起者：`principal.agent_id ?? 'human'`；只随角色 / Team 转换发送。 */
  from?: string;
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

/** `agents.send` 成功条目：strict send 已入队。 */
export interface AgentSendOkLike {
  ok: true;
  queued: true;
  message_id: string;
  state: AgentStateLike;
}

export type AgentSendItemLike = AgentSendOkLike | AgentLifecycleFailLike;

export interface AgentSendBatchResultLike {
  results: AgentSendItemLike[];
}

/** `agents.dispatch` 成功条目：统一 dispatch 的结果（resolution 为 live/resumed/rotating/forked）。 */
export interface AgentDispatchOkLike {
  ok: true;
  status: 'queued';
  message_id: string;
  resolved_to: string;
  resolution: 'live' | 'resumed' | 'rotating' | 'forked';
  conversation_id?: string;
}

export type AgentDispatchItemLike = AgentDispatchOkLike | AgentLifecycleFailLike;

export interface AgentDispatchBatchResultLike {
  results: AgentDispatchItemLike[];
}

/** `agents.rotate` 成功条目：Body 已切换。 */
export interface AgentRotateOkLike {
  ok: true;
  status: 'rotated';
  agent_id: string;
  from_session_id: string;
  to_session_id: string;
  epoch: number;
}

export type AgentRotateItemLike = AgentRotateOkLike | AgentLifecycleFailLike;

export interface AgentRotateBatchResultLike {
  results: AgentRotateItemLike[];
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
  /** 成员列表；viewer 决定 private 可见性。 */
  list(input?: AgentListLikeInput): Promise<AgentStatusLike[]>;
  /**
   * 按 dispatch 的寻址规则（id / 当前 Body session / 唯一 present name）解析目标。
   * 未知或同名歧义返回 undefined；只用于 team-scoped token 的作用域校验。
   */
  resolve(target: string): Promise<AgentStatusLike | undefined>;
  /** 批量 strict send（不 resume）；条目并行，结果与输入同序。 */
  send(inputs: AgentSendLikeInput[]): Promise<AgentSendBatchResultLike>;
  /** 批量 dispatch；条目并行，结果与输入同序。 */
  dispatch(inputs: AgentDispatchLikeInput[]): Promise<AgentDispatchBatchResultLike>;
  /** 批量 rotate；条目并行，结果与输入同序。 */
  rotate(inputs: AgentRotateLikeInput[]): Promise<AgentRotateBatchResultLike>;
}
