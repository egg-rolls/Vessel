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
}

/** Run 配置 */
export interface RunConfig {
  max_iterations?: number;
  max_runtime_seconds?: number;
  stop_on_no_tool_calls?: boolean;
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
  load(session_id: string): Promise<RunState | null>;
  save(state: RunState): Promise<void>;
  delete(session_id: string): Promise<void>;
  list(): Promise<string[]>;
}
