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
export type AgentRoleLike = 'member' | 'temporary';

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
  /**
   * 0.28（D10）：本地装配层直接调用时指定 agent id。
   *
   * 仅进程内适配器使用（`local-run-adapter`）：把 agent id 定成已有的会话 id，
   * 使 `create` 生成的唯一 body 恰好就是那个会话，避免「agent 自带一具 body +
   * 会话再建一具」的双 body（CONTRACT-0.28 §1 要求恰好一具）。
   * **不进 gateway 的 `agents.create` schema**：远端仍由服务生成 id。
   */
  id?: string;
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
  /**
   * CREATE-0.39：来源 session。传了即以该 session 的稳定 transcript 为新
   * agent 的种子；不传 = 冷建。源 agent / 源 session 零改动。
   */
  from_session_id?: string;
  /** 仅 `from_session_id` 存在时合法；缺省 copy，compact 必须显式。 */
  seed?: AgentCreateSeedLike;
  /** 仅 `from_session_id` 存在时合法；`sessions.get().messages` 下标。 */
  keep_messages?: number;
}

/** CREATE-0.39：种子方式；缺省 copy，compact 必须显式。 */
export type AgentCreateSeedLike = 'copy' | 'compact';

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
  /** `interrupt + message_id` 时可为空：正文取自 inbox 里的既有消息。 */
  content: string;
  conversation_id?: string;
  /** 合成 owner principal 的 agent id；缺省由 app 适配器使用 DEFAULT_OWNER。 */
  from?: string;
  /** 0.32-D：打断当前 run，并把本次消息 / message_id 指定的 inbox 消息优先投递。 */
  interrupt?: boolean;
  /** 0.41：只 append inbox + 摘要唤醒，不抢占、不产生普通 run；与 interrupt 互斥。 */
  notify?: boolean;
  message_id?: string;
}

/** `agents.dispatch` 的单个条目。 */
export interface AgentDispatchLikeInput {
  to: string;
  content: string;
  conversation_id?: string;
  /** CREATE-0.39：resume 失败后是否自动创建。 */
  allow_auto_create?: boolean;
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
  /** Stage 3 conflict payload：当前 active run */
  run_id?: string;
  /** Stage 3 conflict payload：目标 Session */
  session_id?: string;
  /** Stage 3 conflict payload：当前有效 SessionLease 的 fencingToken（无则 null） */
  lease_token?: number | null;
  /** Stage 3 conflict payload：当前 binding epoch */
  epoch?: number;
}

export type AgentLifecycleItemLike = AgentLifecycleOkLike | AgentLifecycleFailLike;
export type AgentCloseItemLike = AgentCloseOkLike | AgentLifecycleFailLike;

export interface AgentLifecycleBatchResultLike {
  results: AgentLifecycleItemLike[];
}

export interface AgentCloseBatchResultLike {
  results: AgentCloseItemLike[];
}

/** `agents.send` 成功条目：strict send 已入队（work / urgent）。 */
export interface AgentSendQueuedOkLike {
  ok: true;
  queued: true;
  message_id: string;
  state: AgentStateLike;
}

/**
 * `agents.send` 成功条目：notify 已 append（0.41）。`resolved_to` /
 * `conversation_id` 在 serve 适配层缺省（`SendResult` 不携带），按可选处理。
 */
export interface AgentSendNotifiedOkLike {
  ok: true;
  notified: true;
  message_id: string;
  resolved_to?: string;
  conversation_id?: string;
  wake: boolean;
  resolution: 'live' | 'gone';
}

export type AgentSendOkLike = AgentSendQueuedOkLike | AgentSendNotifiedOkLike;

export type AgentSendItemLike = AgentSendOkLike | AgentLifecycleFailLike;

export interface AgentSendBatchResultLike {
  results: AgentSendItemLike[];
}

/** `agents.dispatch` 成功条目：统一 dispatch 的结果（resolution 为 live/resumed/rotating/created）。 */
export interface AgentDispatchOkLike {
  ok: true;
  status: 'queued';
  message_id: string;
  resolved_to: string;
  resolution: 'live' | 'resumed' | 'rotating' | 'created';
  conversation_id?: string;
}

export type AgentDispatchItemLike = AgentDispatchOkLike | AgentLifecycleFailLike;

export interface AgentDispatchBatchResultLike {
  results: AgentDispatchItemLike[];
}

/** `sessions.create` 的输入（CONTRACT-0.39 §2.1）。 */
export interface SessionCreateLikeInput {
  /** 无来源时必填；有来源时可省（由源推断），两者不一致 → invalid_params。 */
  agent_id?: string;
  /** 来源 session；必须是该 agent 当前 primary。 */
  from_session_id?: string;
  /** 仅 `from_session_id` 存在时合法；缺省 copy。 */
  seed?: AgentCreateSeedLike;
  /** 仅 `from_session_id` 存在时合法；`sessions.get().messages` 下标。 */
  keep_messages?: number;
  /** 新 session 首条输入；给了才起 run。 */
  startup_prompt?: string;
  /**
   * Additive (title_source): human name for the new session. Stored as
   * title_source: 'manual' so automatic naming never overwrites it.
   */
  title?: string;
  /** 缺省 conversation；仅 `from_session_id` 存在时合法。 */
  mode?: 'conversation' | 'both';
  /** mode=both 时必填。 */
  files?: { ref: string; paths: string[] };
}

/** `sessions.create` 的结果（CONTRACT-0.39 §2.3）；无来源时省略 source / seed / counts。 */
export interface SessionCreateLikeResult {
  agent_id: string;
  session_id: string;
  /** Additive: echoed only when the request named the session. */
  title?: string;
  source_session_id?: string;
  seed?: AgentCreateSeedLike;
  keep_messages?: number;
  keep_projected?: number;
  copied_messages?: number;
  primary: true;
  /** 仅 mode=both（文件回滚由入口层执行）。 */
  files_restored?: number;
  files_skipped?: number;
}

/** `sessions.restart`：同一 session 换 binding（epoch+1）。 */
export interface SessionRestartLikeInput {
  session_id: string;
  startup_prompt?: string;
}

export interface SessionRestartLikeResult {
  agent_id: string;
  session_id: string;
  from_epoch: number;
  epoch: number;
}

/** `sessions.activate`：把 primary / bindingHistory 中的 session 切回 primary。 */
export interface SessionActivateLikeInput {
  session_id: string;
  startup_prompt?: string;
}

export interface SessionActivateLikeResult {
  agent_id: string;
  session_id: string;
  previous_session_id: string;
  epoch: number;
  /** 目标本来就是当前 primary 时为 true。 */
  noop: boolean;
}

/**
 * `sessions.create{mode:'both'}` 的 git restore 入口；必须在切换 session 之前调用。
 * 未注入 = git restore 不可用（`not_supported`）。
 */
export interface SessionRestoreFilesLikeInput {
  agent_id: string;
  session_id: string;
  files: { ref: string; paths: string[] };
}

export interface SessionRestoreFilesLikeResult {
  files_restored: number;
  files_skipped: number;
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
  /** 按成员 id / 当前 Binding session 查找（忽略可见性）；未知返回 undefined。 */
  get(agentId: string): Promise<AgentStatusLike | undefined>;
  /** 成员列表；viewer 决定 private 可见性。 */
  list(input?: AgentListLikeInput): Promise<AgentStatusLike[]>;
  /**
   * 按 dispatch 的寻址规则（id / 当前 Binding session / 唯一 present name）解析目标。
   * 未知或同名歧义返回 undefined；只用于 team-scoped token 的作用域校验。
   */
  resolve(target: string): Promise<AgentStatusLike | undefined>;
  /** 批量 strict send（不 resume）；条目并行，结果与输入同序。 */
  send(inputs: AgentSendLikeInput[]): Promise<AgentSendBatchResultLike>;
  /** 批量 dispatch；条目并行，结果与输入同序。 */
  dispatch(inputs: AgentDispatchLikeInput[]): Promise<AgentDispatchBatchResultLike>;
  /**
   * 只读 inbox 视图（`agents.inbox`）。**不改状态**：不消费、不 hold / unhold。
   * `messageIds` 非空时才带 `text`（点某条 peek 正文用），RPC 层限制一次 ≤10 条。
   */
  inbox?(
    agentId: string,
    options?: AgentInboxLikeOptions,
  ): AgentInboxLikeResult | Promise<AgentInboxLikeResult>;
  /**
   * 撤回待处理输入（`agents.recall`，0.53）：把消息从「将执行」集合里拿走。
   *
   * human 源 = 真删（inbox discard）；agent 源 = unhold 留档。未实现（缺省）时 RPC 回
   * `not_supported`。**不给条目加 run id**：取消只按 message id 反查，run 是执行侧的一次
   * 尝试，不该写进消息。
   */
  recall?(input: AgentRecallLikeInput): AgentRecallLikeResult | Promise<AgentRecallLikeResult>;
  /**
   * 认领待处理输入（`agents.claim`，0.51）：**「这条我已经拿到了，别再投给我」**。
   *
   * 与 `recall` 的区别只在「拿走之后留什么」：recall 真删（human 源）/ 留档（agent 源），
   * claim 一律**消费**（标 consumed + 解 hold）—— 条目不再投递、不再出现在 `agents.inbox`
   * 里，下一次 append 裁剪时清掉。**不可逆**（没有 unclaim），所以前端只把它放在
   * 「已经看到正文」的入口上。未实现（缺省）时 RPC 回 `not_supported`。
   */
  claim?(input: AgentClaimLikeInput): AgentClaimLikeResult | Promise<AgentClaimLikeResult>;
  /**
   * 0.51（可选）：该成员的**真实**工具面（`tools.list{agent_id}` 的唯一数据源）。
   *
   * **可选**是硬口径：老适配器 / 老注入没有它时，`tools.list{agent_id}` 退化成今天的
   * 节点插件面（响应没有 `surface` / `source`），谁都不会因此炸；不传 `agent_id` 的口径
   * 在任何情况下不受影响。有透传但答不出（未知成员 / 老执行内核）返回 `undefined`
   * ⇒ RPC 报 `not_found`，不静默给空列表。
   * 数据来自执行内核的真实注册路径 —— 这里只透传，不自己拼工具清单。
   */
  toolSurface?(
    agentId: string,
  ): AgentToolSurfaceLike | undefined | Promise<AgentToolSurfaceLike | undefined>;
  /**
   * `sessions.create`（CREATE-0.39）：同 agent 新 session，成为唯一 primary。
   * 失败以 AgentError 形状（`code` + `message`）reject，RPC 层统一映射。
   */
  createSession(input: SessionCreateLikeInput): Promise<SessionCreateLikeResult>;
  /** `sessions.restart`（CREATE-0.39）：同一 session 原地换 binding（epoch+1）。 */
  restartSession(input: SessionRestartLikeInput): Promise<SessionRestartLikeResult>;
  /** `sessions.activate`（CREATE-0.39）：把保留 session 切回 primary。 */
  activateSession(input: SessionActivateLikeInput): Promise<SessionActivateLikeResult>;
  /**
   * `sessions.create{mode:'both'}` 的文件回滚端口（asm 注入）：必须在切换 session
   * 前执行；未注入 = git restore 不可用。
   */
  restoreFiles?(input: SessionRestoreFilesLikeInput): Promise<SessionRestoreFilesLikeResult>;
}

/**
 * 成员工具面条目（`tools.list{agent_id}` 的 `tools[]`）：与节点口径同形状，多一个来源。
 *
 * - `plugin`：来自父宿主（节点插件面，即不传 `agent_id` 时看到的那一层）；
 * - `member`：成员运行期注入、**不在节点插件面里**（当前只有 `inbox`）。
 */
export interface AgentToolSurfaceEntryLike {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  has_permission_check: boolean;
  source: 'plugin' | 'member';
}

/** 成员工具面快照：`live` = 活身体实取，`derived` = 无身体时按 spawn 规则推导。 */
export interface AgentToolSurfaceLike {
  surface: 'live' | 'derived';
  tools: AgentToolSurfaceEntryLike[];
  /**
   * 节点有、这具成员身体拿不到的工具 + 原因（0.51 additive）。
   *
   * 判据由执行内核算（只有它知道「为什么没给」），serve 只透传，不在这一层重新解释。
   * reason 的含义见 `MemberToolUnavailableReason`。
   */
  unavailable: AgentToolSurfaceUnavailableLike[];
}

/** 被挡在成员工具面外的一条工具：只给名字与原因（键面与 `tools[]` 不同）。 */
export interface AgentToolSurfaceUnavailableLike {
  name: string;
  reason: 'parent_answered' | 'readonly_mode' | 'unknown';
}

/** `agents.inbox` 入参（只读）。 */
export interface AgentInboxLikeOptions {
  /** 缺省 true：连「已排进队列、尚未成为 run input」的 held 一起列出。 */
  includeHeld?: boolean;
  /** 只读正文的 id 列表（≤10）；非空时结果条目带 `text`。 */
  messageIds?: readonly string[];
  /**
   * 只返回归属这个会话的条目（0.53 additive）：等值比较，缺 `session_id` 的老条目永不命中。
   * 条带按 `session_id === 选中会话` 取数，服务端过滤后客户端不再猜归属。
   */
  sessionId?: string;
}

/** `agents.inbox` 结果条目。 */
export interface AgentInboxLikeEntry {
  message_id: string;
  from: string;
  summary: string;
  status: 'unread' | 'held';
  ts: number;
  /** 归属会话（0.53 additive）；缺省 = 老条目 / 非 input 投递 ⇒ 归属未知。 */
  session_id?: string;
  /** 仅当请求带 `messageIds` 且命中时存在。 */
  text?: string;
}

/** `agents.inbox` 结果。 */
export interface AgentInboxLikeResult {
  /** 这批条目所属的 agent（0.53 additive）：前端据此调 `agents.recall`。 */
  agent_id?: string;
  unread: number;
  pending: number;
  entries: AgentInboxLikeEntry[];
}

/** `agents.recall` 入参（0.53）：按 message id 撤回待处理输入。 */
export interface AgentRecallLikeInput {
  agent_id: string;
  message_ids: readonly string[];
}

/** `agents.recall` 的单条跳过原因。 */
export interface AgentRecallLikeSkip {
  message_id: string;
  reason: 'not_found' | 'consumed' | 'active';
}

/** `agents.recall` 结果（与 inbox 的 discard 口径同形，前端可直接用）。 */
export interface AgentRecallLikeResult {
  deleted: string[];
  skipped: AgentRecallLikeSkip[];
}

/** `agents.claim` 入参（0.51）：按 message id 认领「已经看到正文」的待处理输入。 */
export interface AgentClaimLikeInput {
  agent_id: string;
  message_ids: readonly string[];
}

/**
 * `agents.claim` 的单条跳过原因。
 *
 * 没有 `active` 这一档（recall 有）：一条正在跑的消息在开跑那一刻就已 consumed，落进来
 * 的判据与「已经拿走过」完全相同。
 */
export interface AgentClaimLikeSkip {
  message_id: string;
  reason: 'not_found' | 'consumed';
}

/**
 * `agents.claim` 结果：`claimed` = 真的被拿走（→ consumed）的 id，`skipped` = 没拿成的。
 *
 * 与 `agents.recall` 的 `{deleted, skipped}` 同形（条带对两个动作写同一套「本地减法 +
 * 如实报失败」）；差别是出口不可逆：claim 之后这些条目不再投递、不再出现在 `agents.inbox`。
 */
export interface AgentClaimLikeResult {
  claimed: string[];
  skipped: AgentClaimLikeSkip[];
}
