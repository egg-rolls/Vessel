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
  [key: string]: unknown;
}

/** Hook 接口 */
export interface Hook {
  name: string;
  type: HookType;
  run(ctx: HookContext): Promise<HookContext | null>;
  priority?: number;
}
