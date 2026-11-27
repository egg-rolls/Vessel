/**
 * Hook 类型定义
 * @module @vessel-agent/core/hooks
 */

import type { RunEvent } from './event.js';
import type { Message, MessageRef } from './provider.js';

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
  /**
   * BeforeLlm：可读的基底 system prompt。写入被忽略（system 跨轮必须稳定），
   * 首次写入发一次 `hook.system_prompt_ignored` 事件。要追加内容请写 `messages`。
   */
  systemPrompt?: string;
  /**
   * BeforeLlm 注入位（0.16 E5）：要追加到本次请求的消息，按顺序排在已有上下文之后。
   * runtime 只写入上下文一次；同一批消息再次返回时按稳定标识（`name` / `timestamp`）
   * 或对象引用去重。缺省不改变请求形状。
   */
  messages?: Message[];
  /**
   * BeforeLlm：**本轮输入的附件引用**（0.52；`Message.refs` 里那批路径）。
   *
   * 只读：值来自本次 run 的用户输入消息，没有引用时该键不出现（普通会话的 hook
   * 上下文与旧版逐字节一致）。给 hook 用是因为它拿不到上下文正文——「有附件」这件事
   * 只能由 runtime 告诉它，hook 自己无法从 `messages` 里反查。
   */
  refs?: readonly MessageRef[];
  /**
   * BeforeLlm：本 run 第几次 LLM 请求（**0 起**，首请求 = 0）。
   * run 级节奏 gate 用（`cadence === 'run' && request_index > 0 ⇒ 跳过观察`）。
   * 缺省 = 旧 caller 未传，按 0 处理。
   */
  request_index?: number;
  /** BeforeLlm：本次请求的模型标识（additive，q-thinking-plugin；来自 LoopContext.model，计价同源）。 */
  model?: string;
  /**
   * BeforeLlm：provider 身份（additive，q-thinking-plugin；来自 LLMProvider.providerName 实例事实）。
   * 缺省 = 装配未挂身份（裸 fallback / MemoryLLMProvider）——hook 自行按 model 启发式降级。
   */
  providerName?: string;
  /** BeforeTool / AfterTool：当前工具名（0.6.1 P2） */
  tool?: string;
  /** BeforeTool / AfterTool：当前工具输入；BeforeTool 可经 HookResult.updatedInput 改写 */
  input?: unknown;
  /**
   * 成员实际 cwd（additive，P1 origin 标记侧；设计 §2.2）。AfterTool 时 = 该成员实际
   * 工作目录（EU 从 member-cwd 事实填入），供相对路径归一化（修 config.cwd 口径错位）。
   * 缺省 = 装配未填，消费方回退 config.cwd（现状基线，零回归）。
   */
  cwd?: string;
  /**
   * 成员 id（additive，P1 origin 标记侧；设计 §2.2；EU/runtime 身份事实，跨 body 稳定）。
   * last_writer 抑制主键；缺省 = 装配未填，消费方回退 session_id 判等（现状基线）。
   */
  agent_id?: string;
  /**
   * BeforeLlm 事实发射端口（P2 粒度配置轴 C；additive）。装配层（EU tool-calling loop）
   * 绑定到 `publishEvent`（journal → 时间线双写）。hook 用它把「仅 UI 可见」的环境通知
   * 落一条 `message.injected` 事实（vessel:notice 消息 + 稳定 message_id）——Web 经既有
   * 投影渲染成 EnvCard，而**不**把消息写进 `ctx.messages`（模型上下文不收）。
   *
   * 为什么是 `message.injected` 而非 `runtime.notice`：后者是 internal 档原始事件行
   * （默认隐藏），前者才是环境信息卡的唯一投影入口（live + 刷新回放同源）。
   * 缺省 = 装配未填（旧 core / 裸宿主）⇒ 消费方回退 `ctx.messages` 注入（model+ui 现状）。
   */
  emitFact?: (event: RunEvent) => void;
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
  /**
   * @deprecated 不再拼进 system（会破坏前缀稳定）。runtime 改为追加一条
   * `{ role: 'user', name: 'vessel:hook' }` 尾消息；新代码请写 `ctx.messages`。
   */
  additionalContext?: string;
  /**
   * BeforeLlm：本次请求的额外头/参数（additive，q-thinking-plugin）。runtime 经
   * ProviderPort.chat → ChatRequest.extra_headers/extra_params 透传给适配器；合并闸在
   * 适配器（provider/request-extras.ts）。仅 BeforeLlm 消费；其它阶段返回本字段被忽略。
   * 缺省 = 请求形状不变。
   */
  requestExtras?: {
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
  };
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
