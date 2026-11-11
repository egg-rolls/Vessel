/** 会话摘要（/v1/sessions 返回的 SessionInfo） */
export interface SessionInfo {
  session_id: string;
  title: string;
  preview: string;
  status: string;
  started_at: number;
  updated_at: number;
  message_count: number;
  branch?: string;
  /**
   * Additive (title_source)：标题来源。`manual` = 人显式命名过（自动命名不会覆盖）；
   * `generated` = AI 命名；缺失 = 旧 gateway / 旧数据 / 尚未命名。
   */
  title_source?: 'manual' | 'generated';
}

/** 会话消息角色（与 core `Message` 对齐） */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 工具调用（assistant 消息里的 tool_calls） */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 单条会话消息（sessions.get 返回的 session.messages） */
export interface Message {
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /**
   * 思维链（thinking 模式）：core 持久化保留、只在展示层用。
   * 历史里同样带着它，所以终止态也能渲染思考块（与运行态同一实现）。
   */
  reasoning_content?: string;
  /** 0.6.1：逐条消息时间戳（core 可能缺省；缺失时 Web 降级为不分组/不显示时间）。 */
  timestamp?: number;
}

/** sessions.search 的单条结果（E5 冻结形状）。 */
export interface SessionSearchHit {
  session_id: string;
  title: string;
  preview: string;
  snippet: string;
  updated_at: number;
  message_count: number;
}

/** 会话详情（sessions.get 返回 `{ session: SessionState + 最近 RunRecord 投影 }`） */
export interface SessionDetail {
  session_id: string;
  /** 本次返回的连续消息窗口（升序）；不传分页参数时是完整的 `state.messages`。 */
  messages: Message[];
  /**
   * 完整 `state.messages.length`（切窗之前）。S1 additive；旧 gateway 缺失时
   * 客户端按「本次 `messages` 就是全量」降级。
   */
  messages_total?: number;
  /**
   * 上一次响应的 `next_before` 游标；`start > 0` 时才有。旧 gateway 缺失时
   * 分页关闭。客户端只透传，不解析游标内容。
   */
  next_before?: string;
  title?: string;
  preview?: string;
  started_at?: number;
  updated_at?: number;
  status?: string;
  /**
   * 最近一次 run 的 id（服务端 `toSessionView` 的 `run_id`：RunRecord 优先，
   * 回退 `state.last_run_id`）。旧 gateway / 伪会话缺失。
   *
   * 与 `status` / `error` / `completed_at` 一起构成「会话级」终态快照：聊天时间线的
   * 失败卡在事件缓冲里已经没有 `run.failed` 时（刷新 / 切会话 / 环形缓冲淘汰）
   * 用它兜底，见 `domains/chat/transcript-items.ts#sessionFailureOfDetail`。
   */
  run_id?: string;
  /** 该 run 的错误原文（成功 / 运行中 / 旧数据缺失）。 */
  error?: string;
  /** 该 run 的终态时刻（终态 status 下等于 `updated_at`）。 */
  completed_at?: number;
}

/** ask_user 单个问题 */
export interface AskUserQuestion {
  header: string;
  question: string;
  options?: string[];
  multi_select?: boolean;
}

/** ask_user 单个回答 */
export interface AskUserAnswer {
  header: string;
  question: string;
  answer: string;
}

/** ask_user 请求（ask.user.requested） */
export interface AskUserRequest {
  requestId: string;
  questions: AskUserQuestion[];
  runId: string;
  /** 事件时间（缺失回退收到时间）；只用于与权限请求混排，不表示过期。 */
  requestedAt: number;
  /** 0.15 additive：由 run.started 反查的归属会话；旧流缺失时不参与跨 session 归类。 */
  sessionId?: string;
  /** 成员 bridge 的父 chat（事件 `parent_session_id`）；旧事件缺失，缺失时回退 `sessionId`。 */
  parentSessionId?: string;
  /** 0.17 additive：发起请求的子 agent（delegate_id / agent_id）；旧流缺失。 */
  agentId?: string;
  /**
   * 成员 bridge 请求所属 Team（`interactions.list` 的 `team_id` / 事件 `team_id`）。
   * 用于「待批」页区分会话面与团队面；旧流缺失时按会话面处理。
   */
  teamId?: string;
  /**
   * 0.52：ask 的语义。`async` = 提问的工具已经返回成功、那个 run 早就结束了，
   * 但这个请求仍然有效：回答会作为一条 user 消息投给该成员并**起一次新 run**。
   *
   * 因此它不跟 run 终态一起消失（卡片必须留在待批页），并显示「异步」标记。
   * 缺省 = sync（阻塞型：应答者就在原地等）。
   */
  mode?: 'sync' | 'async';
}

/** 权限应答范围（DECISION-024 §2.1）。 */
export type PermissionScope = 'once' | 'session' | 'always';

/**
 * 待答权限请求（tool.permission.request，0.13 增加关联字段）。
 *
 * Addendum A / 0.18：权限等待默认不超时，因此没有过期字段；卡片只保留事件时间用于排序。
 */
export interface PermissionRequest {
  requestId: string;
  tool: string;
  input: unknown;
  runId: string;
  /** run 归属会话；旧 gateway 缺失时不参与跨 session 归类。 */
  sessionId?: string;
  /** 成员 bridge 的父 chat（事件 `parent_session_id`）；旧事件缺失，缺失时回退 `sessionId`。 */
  parentSessionId?: string;
  toolCallId?: string;
  source?: string;
  /** 0.17 additive：发起请求的子 agent（delegate_id / agent_id）；旧流缺失。 */
  agentId?: string;
  /** 事件时间（同一 run 多请求排序）。 */
  requestedAt: number;
}

/** sessions.delete 结果（级联计数用于确认/反馈） */
export interface DeleteSessionResult {
  sessions_deleted: number;
  runs_deleted: number;
  events_deleted: number;
}

export interface RenameSessionResult {
  session_id: string;
  title: string;
}

/**
 * `sessions.create` 参数（CONTRACT-0.39-create §2.1）。
 *
 * 无来源时空建；`from_session_id` 存在时从源 session 复制前缀
 * （`keep_messages` 是 `sessions.get().messages` 下标），可选 `seed: 'compact'`。
 * `mode` / `files` 是已批准的可选 git restore 字段，Phase 1 无 UI 入口。
 */
export interface SessionCreateInput {
  agent_id?: string;
  from_session_id?: string;
  seed?: 'copy' | 'compact';
  keep_messages?: number;
  startup_prompt?: string;
  /**
   * Additive (title_source): name the new session; it is marked as named so
   * automatic AI titling will not overwrite it. No UI entry point yet.
   */
  title?: string;
  mode?: 'conversation' | 'both';
  files?: { ref: string; paths: string[] };
}

/** `sessions.create` 结果；新 session 恒为 primary，源 session 退役但保留。 */
export interface SessionCreateResult {
  agent_id: string;
  session_id: string;
  source_session_id?: string;
  seed?: 'copy' | 'compact';
  keep_messages?: number;
  keep_projected?: number;
  copied_messages?: number;
  /** Additive: echoed only when the request named the session. */
  title?: string;
  primary: boolean;
  files_restored?: number;
  files_skipped?: number;
}

/** `sessions.activate` 参数（CONTRACT-0.39-create §4.1）。 */
export interface SessionActivateInput {
  session_id: string;
  startup_prompt?: string;
}

/** `sessions.activate` 结果；`noop` = 目标本来就是 primary。 */
export interface SessionActivateResult {
  agent_id: string;
  session_id: string;
  previous_session_id: string;
  epoch: number;
  noop: boolean;
}
