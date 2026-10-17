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
  ContextManager,
  EventStream,
  PluginHost,
  RunnableAgent,
  SessionBackend,
} from '@vessel/core';

/** REPL 上下文——cli.ts 壳构造，传给 startRepl() */
export interface ReplContext {
  // ── 核心能力（egg-rolls 构造并注入）──────────────────

  /** 可运行 agent——REPL 只依赖 A10 的最小结构类型（不绑定 AgentRuntime） */
  runtime: RunnableAgent;

  /**
   * 插件宿主——工具与插件的唯一来源（C9）。
   * /tools 读 pluginHost.listTools()；/plugins 读壳注入的 plugins 名单。
   */
  pluginHost: PluginHost;

  /** 会话后端——/resume、/history 的增删改查 */
  session: SessionBackend;

  /** 事件流——StreamOutput / StateTracker 订阅，获取 LlmStreamChunk + 工具调用事件 */
  events: EventStream;

  /** 上下文管理器--/new、/resume 切会话时 clear()，让 runtime.run() 重新从 SessionBackend 载入历史 */
  context: ContextManager;

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

  /** 已加载插件名——状态栏显示（如 "basic-tools, hook-logging"） */
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
