/**
 * LLM Provider 类型定义
 * @module @vessel-agent/core/provider
 */

import type { ToolCall, ToolSchema } from './tool.js';
import type { AttachmentPlan, VisionBackend } from './vision.js';

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 引用种类（附件引用；见 `Message.refs`） */
export type MessageRefKind = 'file' | 'image' | 'document';

/**
 * `Message.refs` 的两条硬上限（条数也是 token 税）：单条消息最多 32 个引用、
 * 单条 `path` 最多 4096 字符。写入侧（admit 闸门）与读取侧（投影）共用这两个数。
 */
export const MESSAGE_REFS_MAX = 32;
export const MESSAGE_REF_PATH_MAX = 4096;

/**
 * 消息引用（附件）：**只有路径与元信息，没有正文**。
 *
 * 引用文件的内容不进上下文——需要读时由多模态解析器插件提供的工具按路径读，
 * 输出受边界与字节上限约束。形状刻意保持可序列化、可审计。
 */
export interface MessageRef {
  kind: MessageRefKind;
  /** 绝对路径（宿主机本地文件）；唯一的定位信息 */
  path: string;
  /**
   * 内容地址（additive，0.56）：`<dataDir>/blobs/sha256/xx/<sha256>` 的文件名。
   *
   * 上传即落（决策 2）：附件在**到达节点那一刻**就算出 sha256、落 blob，并写回这条引用。
   * 请求构造期只按它读 blob，**不再读 `path`** —— 这是「同一张图连续 3 次请求逐字节
   * 相同」的实现基础（读路径 = 用户随时能改的文件；读 blob = 冻结的字节）。
   *
   * 缺省 = 旧数据 / 旧 gateway / 没入池：此时图**不内联**（`not_ingested`），
   * 而不是回源读 path（那会让前缀随文件内容漂移）。
   */
  sha256?: string;
  /** 展示名（缺省取 path 的 basename） */
  name?: string;
  /** MIME（前端探测值，不可信，仅供展示 / 透传） */
  mime?: string;
  /** 字节数（前端 stat 结果，不可信，仅供展示） */
  bytes?: number;
}

/** 消息 */
export interface Message {
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /**
   * 思维链内容（OpenAI 兼容的 thinking 模式，如 DeepSeek）。
   * 只存在于 assistant 消息：Provider 返回后由 runtime 原样保存，
   * 下一次请求必须回传，否则 API 会拒绝（reasoning_content required）。
   * 不发送到 TUI / 事件流，避免泄漏思维链。
   */
  reasoning_content?: string;
  /**
   * 消息写入时间（Unix ms，0.6.1 P2）。可选：旧数据缺失时消费者降级。
   * runtime 在加入上下文时补齐；Provider 适配层忽略该字段。
   */
  timestamp?: number;
  /**
   * 压缩摘要标记：仅 core 内部用于识别摘要（role=system）。Provider 忽略该字段。
   */
  compaction_summary?: boolean;
  /**
   * 消息身份（additive，可缺省）：这条消息属于哪个 run。
   *
   * 为什么需要：跨来源去重（Web 时间线的「认领」）过去只能拿**正文内容**当代理键，
   * 而 Output 阶段 guardrail 会在落盘前改写正文（PII 打码），于是同一条消息在实时流
   * 与落盘历史里内容不等、被当成两个对象渲染两遍。身份是结构化事实，不改内容就能认人。
   *
   * 语义边界：表示「写入上下文这一侧」的归属，`run_id` 就是写入时的那次 run；
   * 用户消息归属它开启的那次 run（注入消息归属被注入的那次 run）。
   * 缺失 = 旧数据 / 旧 gateway —— 消费端退回内容比较，不做回填。
   * Provider 适配层逐字段挑（`providers.ts` 的两处 message map），该字段不进请求体。
   */
  run_id?: string;
  /**
   * 消息身份（additive，可缺省）：同一次 run 内**第几段正文**（0 起）。
   *
   * 只对 assistant 正文消息有意义，且只数「正文非空的 assistant 消息」—— 与 Web 侧
   * 流式段序（`createFold` 的 `textIndex`，一次请求一段正文）同口径，所以刷新前后
   * 能对上同一个段。只有 tool_calls、没有正文的那一轮不占号（它不产生正文段）。
   *
   * 由落盘侧统一盖章（`assignMessageIdentities`，run_journal 的 saveSessionState），
   * 不在这里维护计数器：幂等、可重算、resume 之后接着往后编，不会让身份漂移。
   */
  run_segment?: number;
  /**
   * 消息身份（additive，可缺省）：**这条消息唯一的稳定 id**（0.56）。
   *
   * 为什么不是 `run_id + run_segment` 就够了：`run_segment` 只数 assistant 正文段
   * （`occupiesSegment` 的口径），用户输入 / 注入消息一段都不占 —— 于是「这一轮的输入
   * 是哪条」在 web 侧只能靠启发式重建：先是内容相等（guardrail 一改写就失效），
   * 后来是「`inputsByRun` 里恰好一条」（同一 run 落盘两条就失效）。两者都是猜。
   * 这条字段把猜去掉：消息写入**上下文**与写入**事件流**时带同一个字符串，前端按它归并。
   *
   * 生成口径（`message-id.ts`）：只在消息**进入会话**的那一处生成，确定式、可复算
   * （`${runId}:user` / `${runId}:inject:<下标>`）—— 同一条输入被执行两遍得到同一个 id，
   * 于是「落盘两份」在渲染层是**结构性**的同一条，而不是两条要猜的内容。
   * 幂等：已有值一律不覆盖（resume / 重放 / 续跑都保留原 id）。
   *
   * 缺失 = 旧数据 / 旧 gateway / 其它注入通道 —— 消费端退回 0.51 的身份 + 内容判据，
   * 不回填（回填会让同一条消息在两个出口拿到两个 id，比没有 id 更糟）。
   * Provider 适配层逐字段挑（`providers.ts` 的两处 message map），该字段不进请求体。
   */
  message_id?: string;
  /**
   * 附件引用（additive，可缺省）：只有路径与元信息，**不存正文 / base64**。
   *
   * 旧 session / 旧 gateway 没有这个字段，消费者一律按「无引用」降级；
   * Provider 适配层忽略该字段（不参与请求体）。
   */
  refs?: MessageRef[];
}

/** 使用量 */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Anthropic 显式提示词缓存：写入缓存的输入 token 数（其他 provider 可缺省） */
  cache_creation_input_tokens?: number;
  /** Anthropic 显式提示词缓存：从缓存读取的输入 token 数（其他 provider 可缺省） */
  cache_read_input_tokens?: number;
}

/** 聊天请求 */
export interface ChatRequest {
  messages: Message[];
  model: string;
  tools?: ToolSchema[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  session_id?: string; // 会话 ID，用于 Provider 状态管理
  /** AbortSignal——Provider 传给 fetch() 以支持流中断（Hermes/Claude Code 模式） */
  signal?: AbortSignal;
  /**
   * 是否把思维链增量经 `on_chunk` 回调（`reasoning_delta`，0.11.1）。
   * 显式 opt-in；未设置时与 0.11.0 一致：只累积进 `response.reasoning_content`，
   * 不产生 reasoning chunk / 事件。
   */
  include_reasoning?: boolean;
  /**
   * 流式增量回调。当 stream=true 且本字段存在时，Provider 在接收 LLM 流式响应时
   * 逐 chunk 调用；chat() 仍返回拼装好的完整 LLMResponse（ADR-007：流式=事件订阅，
   * 非独立方法）。非流式 Provider 忽略本字段即退化为整段返回。
   */
  on_chunk?: (chunk: StreamChunk) => void;
  /**
   * 这一轮要发的图（additive，0.56）。**只有适配器读它**，`Message` 一个字节不变。
   *
   * 由 `ExecutionUnit` 在请求期算出来（`vision/plan.ts`），随 `chat()` 传下去；
   * 缺省 = 旧行为（所有消息的 `content` 仍是 `string`，请求体逐字节相同）。
   * 适配器命中 `byMessageIndex` 时才把那条消息的 `content` 升成块数组。
   */
  attachment_plan?: AttachmentPlan;
  /**
   * 额外请求头（additive，q-thinking-plugin）。请求期由 BeforeLlm hook 注入
   * （`HookResult.requestExtras.headers`），EU 原样透传；**只有适配器读它**。
   * 合并闸见 `provider/request-extras.ts`：危险头（Authorization 等）丢弃 + 告警。
   * 缺省 / 空 ⇒ 请求头与今天逐字节相同。
   */
  extra_headers?: Readonly<Record<string, string>>;
  /**
   * 额外请求体参数（additive，q-thinking-plugin）。顶层浅合并进 body；core 保留键
   * （model/messages/tools/stream/…）不可覆盖，丢弃 + 告警。值必须 JSON 可序列化
   * （函数/symbol/循环引用丢弃）。缺省 / 空 ⇒ 请求体逐字节相同。
   */
  extra_params?: Readonly<Record<string, unknown>>;
}

/** 流式 chunk：Provider 吐给 loop 的增量单元 */
export interface StreamChunk {
  /** chunk 类型 */
  type: 'text_delta' | 'reasoning_delta' | 'tool_call_delta' | 'finish';
  /** text_delta / reasoning_delta：增量文本 */
  delta?: string;
  /** tool_call_delta：第几个 tool_call（按 index 累积，对应 OpenAI delta.tool_calls[].index） */
  tool_call_index?: number;
  /** tool_call_delta：该 tool_call 首次出现时携带的 id */
  tool_call_id?: string;
  /** tool_call_delta：该 tool_call 首次出现时携带的 function name */
  tool_call_name?: string;
  /** tool_call_delta：function arguments 的部分 JSON 片段（需按 index 拼接） */
  arguments_delta?: string;
  /** finish：完成原因 */
  finish_reason?: FinishReason;
  /** finish：用量（流式 usage 仅在流末尾可得） */
  usage?: Usage;
}

/** 完成原因 */
export type FinishReason = 'stop' | 'tool_calls' | 'length';

/** LLM 响应 */
export interface LLMResponse {
  content: string;
  tool_calls?: ToolCall[];
  finish_reason: FinishReason;
  usage?: Usage;
  /** 思维链内容（thinking 模式）；存在时 runtime 写入 assistant 消息并在下一轮回传 */
  reasoning_content?: string;
}

/**
 * 传输层重试策略（指数退避 + 抖动）。
 *
 * 只管「请求根本没产出内容」的失败：传输层断开与过载（429 / 502 / 503 / 504）。
 * 鉴权 / 参数 / 上下文超长 / 内容审查不重试（重试只会重复烧钱）。
 * 默认值见 core `DEFAULT_PROVIDER_RETRY_POLICY`；`maxRetries: 0` 关闭。
 */
export interface ProviderRetryPolicy {
  /** 最多重试次数（不含首次请求）；0 = 不重试 */
  maxRetries: number;
  /** 首次退避毫秒数，之后逐次 x2 */
  baseDelayMs: number;
  /** 单次退避封顶毫秒数（`Retry-After` 也按它封顶） */
  maxDelayMs: number;
  /** 抖动比例 0–1：每次退避在 `delay * (1 ± jitterRatio)` 内随机，仍受 `maxDelayMs` 封顶 */
  jitterRatio: number;
}

/**
 * 空响应兜底策略（q-empty-response）。
 *
 * 针对「模型偶发返回空内容 + 无工具调用 + 终止原因」：无兜底时 loop 的两条终止路径
 * （stop / 其他 finish_reason）会把空串当终稿返回，agent 早退零输出（大上下文 / 压缩后更易发）。
 * 启用后空响应不终止——追加一条「继续你的任务」nudge（user 消息）重新轮询模型；
 * 重试限次，耗尽后落一条 `llm.empty_response`（action=exhausted）事件并抛
 * `EmptyResponseExhaustedError`（code=empty_response_exhausted）⇒ run 标 failed，
 * agent 层既有 peer 链路自动通知 parent（q-empty-exhaust，防静默早退）。
 *
 * 只管「语义空响应」；传输层断开 / 过载重试是另一套策略（`ProviderRetryPolicy`）。
 * 缺省值见 core `DEFAULT_EMPTY_RESPONSE_MAX_RETRIES` / `DEFAULT_EMPTY_RESPONSE_NUDGE`
 * （tool-calling-loop.ts）：未注入本策略 = 启用、重试 2 次。
 */
export interface EmptyResponsePolicy {
  /** 总开关；缺省 true。false = 空响应直接当终稿（修复前行为，零回归开关）。 */
  enabled?: boolean;
  /**
   * 无感重试（缺省 true）：空响应时**丢弃空轮**（不发 llm.response、不写窗口），
   * 用已有一致 transcript（含上一个工具结果）原样重调模型——零注入零疤痕，
   * 与无感 resume 同源。连续空耗尽 `maxRetries` 后升级**一次** nudge 打破空模式
   * （纯重调可能采样再吐空，nudge 是可靠性兜底）；再空则 exhausted 标 failed 并通知 parent。
   * false = 直接走 nudge 注入路径（一期行为）。
   */
  seamless?: boolean;
  /** 重试上限（不含首次响应）；缺省 2；0 = 不重试（首个空响应即耗尽标 failed，也不升级 nudge）。 */
  maxRetries?: number;
  /** nudge 文案（以 user 消息追加）；缺省 `DEFAULT_EMPTY_RESPONSE_NUDGE`。 */
  nudge?: string;
}

/** LLM Provider 接口 */
export interface LLMProvider {
  chat(req: ChatRequest): Promise<LLMResponse>;
  /**
   * 视觉能力（additive，0.56；**可选**）。
   *
   * 挂在 provider 实例上而不是「模型名 → 能力」映射表上：能力是 `(provider, model)` 的
   * 函数，而 provider 实例正是这个函数的求值结果 —— `agent.model` 覆盖因此自动生效，
   * 不会与配置漂移（见 design §4.2）。
   *
   * `undefined` = 该模型**没有**视觉能力（不是「可能支持」）：图不内联、`[refs]` 尾注
   * 回落旧文案。实例由**插件**在构造 provider 时挂上（宪法第十三条：核心只有形状）。
   */
  vision?: VisionBackend;
  /**
   * provider 身份（additive，q-thinking-plugin；**可选**）。装配注册名 / model-registry
   * protocol（'openai' / 'anthropic' / 'google' / …）。与 vision 同一判据：身份是实例事实，
   * 由构造方挂上；EU 经它填 `HookContext.providerName`。缺省 = 身份未知（裸 fallback /
   * Memory / 旧插件），消费方按 model 名启发式降级，不炸。
   */
  providerName?: string;
}

/** Provider 工厂 */
export type ProviderFactory = (config: Record<string, unknown>) => LLMProvider;
