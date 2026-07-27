/**
 * Session 类型定义
 * @module @vessel/core/session
 */

import type { Message } from './provider.js';

/** Run 状态 */
export interface RunState {
  run_id: string;
  session_id: string;
  messages: Message[];
  started_at: number;
  completed_at?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    total_cost?: number;
  };
  error?: string;
  /** 会话标题（默认从首条用户消息派生，可由 /title 覆盖） */
  title?: string;
  /** 首条用户消息摘要（前 60 字符），用于 /resume 列表 */
  preview?: string;
  /** 最后活动时间戳（ms），用于 /resume 按 recency 排序 */
  updated_at?: number;
}

/** 会话摘要（listRich 返回，照搬 Hermes list_sessions_rich 的字段集，简化） */
export interface SessionInfo {
  session_id: string;
  title: string;
  preview: string;
  status: string;
  started_at: number;
  updated_at: number;
  message_count: number;
}

/** Session 信息 */
export interface Session {
  session_id: string;
  created_at: number;
  updated_at: number;
  runs: RunState[];
  metadata?: Record<string, unknown>;
}

/** Session Backend 接口 */
export interface SessionBackend {
  load(sessionId: string): Promise<RunState | null>;
  save(state: RunState): Promise<void>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<string[]>;
  /** 列出会话摘要（含 title/preview/updated_at/message_count），按 recency 倒序，过滤空会话 */
  listRich(): Promise<SessionInfo[]>;
  close?(): void;
}
