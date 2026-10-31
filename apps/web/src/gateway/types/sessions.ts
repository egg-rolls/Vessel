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

/** 会话详情（sessions.get 返回 `{ session: RunState }`） */
export interface SessionDetail {
  session_id: string;
  messages: Message[];
  title?: string;
  preview?: string;
  started_at?: number;
  updated_at?: number;
  status?: string;
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
