/**
 * team 插件对外形状（工具面类型）。
 *
 * 0.3 起宿主统一为 core `RuntimeHost`（由 asm 注入）。
 * 0.1 的插件私有 `RuntimeHost` / `InProcessRuntimeHost` 兼容层已移除（ADR-037）。
 */

import type {
  LLMProvider,
  PluginHost,
  TerminationPolicy,
  Usage,
  UsageLimits,
} from '@vessel-agent/core';

/** 成员状态 */
export type AgentState = 'idle' | 'running' | 'cancelled' | 'error' | 'closed';

/** 0.16 成员状态（DECISION-031 E1）；与 `agents.tree` / `agents.list` 同名同义 */
export type MemberState =
  | 'created'
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'closed'
  | 'stale';

/** 成员可见性：private 仅 owner；team / tenant 同 tenant 可寻址 */
export type MemberVisibility = 'private' | 'team' | 'tenant';

/** 成员权限模式：bridge 弹到父窗口；allow 自动放行；deny 只保留只读工具 */
export type MemberPermissionMode = 'bridge' | 'allow' | 'deny';

/** 消息类型（team 语义由插件声明；core 的 kind 是开放 string） */
export type TeamMessageKind = 'message' | 'task' | 'result' | 'cancel';

/** 成员消息（对外 JSON 字段保持 0.1：reply_to 为 snake_case） */
export interface TeamMessage {
  id: string;
  from: string;
  to: string | '*';
  kind: TeamMessageKind;
  content: string;
  reply_to?: string;
  ts: number;
  /** 0.6：消息来自远端节点时标注来源；本机消息缺省 */
  nodeId?: string;
}

/** spawn 规格（0.1 形状；适配层翻译成 core AgentSpec） */
export interface AgentSpec {
  id?: string;
  name?: string;
  provider: LLMProvider;
  model: string;
  pluginHost: PluginHost;
  systemPrompt?: string;
  limits?: UsageLimits;
  termination?: TerminationPolicy;
  /** 0.16：成员默认 session id（session 即成员；缺省由 core 用 'default'） */
  sessionId?: string;
  /** 0.16：成员可见性（注册表使用；不传给 core） */
  visibility?: MemberVisibility;
  /** 0.16：成员权限模式（注册表/桥接使用；不传给 core） */
  permissionMode?: MemberPermissionMode;
  /** 0.16：父成员 id（注册表使用） */
  parentId?: string;
  /** 0.16：父 session id，权限桥的 parent_session_id */
  parentSessionId?: string;
  /** 0.16：成员 owner（spawn/close 权限；默认插件 ownerId） */
  owner?: string;
}

/** 0.16 成员状态视图（E1） */
export interface MemberStatus {
  id: string;
  session_id: string;
  name?: string;
  parent_id?: string;
  visibility: MemberVisibility;
  state: MemberState;
  current_tool?: string;
  last_seen?: number;
  usage?: Usage;
}

/** 成员状态视图（保持 0.1 字段，不暴露 currentRunId） */
export interface AgentStatus {
  id: string;
  name?: string;
  state: AgentState;
  toolNames: string[];
  lastError?: string;
  /** 0.6：远端成员所属节点；本机成员缺省 */
  nodeId?: string;
}

/** 收件箱分页 */
export interface InboxPage {
  messages: TeamMessage[];
  cursor: string;
}
