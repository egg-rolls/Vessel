/**
 * @vessel/core - AI Agent 运行时核心
 * @module @vessel/core
 *
 * 核心运行时库，零 UI 依赖，可独立嵌入。
 * 提供 tool-calling loop、provider 抽象、context/session、events、
 * tool registry、limits、guardrail、hooks、PluginHost。
 */

// 类型定义
export * from './types/index.js';

// 事件流
export { MemoryEventStream } from './events/index.js';

// 工具注册表
export { MemoryToolRegistry } from './tools/index.js';

// 上下文管理器
export { MemoryContextManager } from './context/index.js';

// 会话后端
export { MemorySessionBackend, FileSessionBackend } from './session/index.js';
export { SQLiteSessionBackend } from './session/sqlite-backend.js';

// 限制检查器
export { MemoryLimitChecker } from './limits/index.js';

// Provider
export { MemoryLLMProvider, OpenAICompatibleProvider, AnthropicProvider } from './provider/index.js';

// 运行时
export { AgentRuntime, MemoryPluginHost } from './runtime/index.js';
