/**
 * Hook 类型定义
 * @module @vessel/core/hooks
 */

/** Hook 类型枚举 */
export enum HookType {
  BeforeLlm = 'before_llm',
  AfterLlm = 'after_llm',
  BeforeTool = 'before_tool',
  AfterTool = 'after_tool',
  OnError = 'on_error',
}

/** Hook 上下文 */
export interface HookContext {
  run_id: string;
  session_id?: string;
  /** BeforeLlm 注入位：hook 写这里，loop 在调用 LLM 前读取，作为本次请求的 system 消息 */
  systemPrompt?: string;
  [key: string]: unknown;
}

/** Hook 接口 */
export interface Hook {
  name: string;
  priority?: number;
  type: HookType;
  /** 收窄：不再返回 HookContext | null（返回值此前被静默丢弃） */
  run(ctx: HookContext): Promise<void>;
}
