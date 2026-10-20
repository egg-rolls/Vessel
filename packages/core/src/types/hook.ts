/**
 * Hook 类型定义
 * @module @vessel-agent/core/hooks
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
  /** BeforeTool / AfterTool：当前工具名（0.6.1 P2） */
  tool?: string;
  /** BeforeTool / AfterTool：当前工具输入；BeforeTool 可经 HookResult.updatedInput 改写 */
  input?: unknown;
  [key: string]: unknown;
}

/**
 * Hook 返回值（0.6.1 P2）。
 * 返回 `void` / `undefined` 表示不干预；旧 hook 实现保持兼容。
 */
export interface HookResult {
  /** 阻断当前阶段：BeforeTool 折回 tool 错误（不终止 run） */
  block?: boolean;
  /** 阻断原因（写入 tool 错误文本） */
  reason?: string;
  /** BeforeTool：改写工具输入（后续 hook 与工具 handler 看到改写后的值） */
  updatedInput?: unknown;
  /** BeforeLlm：追加到本次请求的 system 上下文 */
  additionalContext?: string;
}

/** Hook 接口 */
export interface Hook {
  name: string;
  priority?: number;
  type: HookType;
  /**
   * 返回 void（不干预）或 HookResult（0.6.1 P2）。
   * 保留 void 以兼容既有 hook 实现（它们声明 `Promise<void>`）。
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: 旧 hook 返回 Promise<void>，需保持结构兼容
  run(ctx: HookContext): Promise<void | HookResult>;
}
