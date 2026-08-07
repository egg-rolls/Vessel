/**
 * REPL 上下文契约——egg-rolls（壳）与 emma（REPL）的接缝
 * @module @vessel/tui
 *
 * 使用方式：
 *   // cli.ts（egg-rolls 壳）
 *   import { startRepl, type ReplContext } from '@vessel/tui';
 *   const ctx: ReplContext = { ... };
 *   await startRepl(ctx);
 *
 * ReplContext 类型由 emma 定义，egg-rolls 认可。本文件是 draft proposal。
 */

import type { VesselConfig } from '@vessel/config';
import type {
  AgentRuntime,
  ContextManager,
  EventStream,
  SessionBackend,
  ToolRegistry,
} from '@vessel/core';
import type { AskUserBridge } from './renderer/ask-user.js';
import type { ToolPermissionChecker } from './renderer/tool-confirm.js';

/** REPL 上下文——cli.ts 壳构造，传给 startRepl() */
export interface ReplContext {
  // ── 核心能力（egg-rolls 构造并注入）──────────────────

  /** Agent 运行时——REPL 调 runtime.run(input, sessionId) 执行对话 */
  runtime: AgentRuntime;

  /** 工具注册表——/tools 命令列出 tool.name + tool.description */
  tools: ToolRegistry;

  /** 会话后端——/resume、/history 的增删改查 */
  session: SessionBackend;

  /** 事件流——StreamRenderer 订阅，获取 LlmStreamChunk + 工具调用事件 */
  events: EventStream;

  /** 上下文管理器--/new、/resume 切会话时 clear()，让 runtime.run() 重新从 SessionBackend 载入历史 */
  context: ContextManager;

  /** 工具权限确认器--REPL 注入 promptFn 复用其 readline，避免确认输入泄漏进对话 */
  permissionChecker?: ToolPermissionChecker;

  /** ask-user 桥接——Agent 工具 handler 通过此 bridge 暂停并等待用户回答，TUI 注入 onPrompt */
  askUserBridge?: AskUserBridge;

  // ── 可变状态（REPL 读写，壳感知变化）────────────────

  /** 当前会话 ID——/resume、/new 会改；chat 传此 ID 给 runtime.run() */
  currentSessionId: string;

  /** 会话切换回调——REPL 执行 /resume 或 /new 后通知壳更新 currentSessionId */
  onSessionChange: (sessionId: string) => void;

  // ── 显示信息（REPL 只读）────────────────────────────

  /** Provider 信息——状态栏显示 "OpenAI | gpt-4 | api.openai.com" */
  provider: {
    name: string;
    model: string;
    baseUrl: string;
  };

  /** 已加载插件名——状态栏显示 "meta-tools, skills-loader" */
  plugins: string[];

  /** 当前配置（只读）——状态栏/system prompt 引用 */
  config: VesselConfig;

  // ── 工具函数（跨壳/REPL 共用）───────────────────────

  /** 生成新会话 ID——格式 {YYYYMMDD_HHMMSS}_{6hex}（照搬 Hermes） */
  newSessionId: () => string;

  // ── 生命周期 ───────────────────────────────────────

  /** 退出回调——/exit 时调，壳负责 runtime.dispose() + process.exit() */
  onExit: () => void;
}
