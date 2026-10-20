/**
 * team 插件对外形状（工具面类型）。
 *
 * 0.3 起宿主统一为 core `RuntimeHost`（由 asm 注入）。
 * 0.1 的插件私有 `RuntimeHost` / `InProcessRuntimeHost` 兼容层已移除（ADR-037）。
 */

import type { LLMProvider, PluginHost, TerminationPolicy, UsageLimits } from '@vessel-agent/core';

/** 成员状态 */
export type AgentState = 'idle' | 'running' | 'cancelled' | 'error' | 'closed';

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
