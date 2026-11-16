/**
 * 「下一次要发的请求」的 token 上界估算 —— 上下文计数链路的唯一口径（0.55 P0）
 * @module @vessel-agent/core/context
 *
 * ## 为什么需要这个模块（真实事故）
 *
 * 0.55 之前，`WorkingContext.tokenCount` 是「上一次 provider 回报」的镜像：
 * `realTokens > 0` 时直接返回它。于是一条 423,386 字符的 bash stdout（本地估算
 * 106,211 token，实际远比这多）落地之后，三个数字各自撒谎：
 *
 * | 数字 | 值 | 谁给的 |
 * | --- | --- | --- |
 * | 落盘 `llm.request.estimated_tokens` | 673,076 / 673,113 / 672,708（67%） | 上一次 `llm.response.prompt_tokens` + 少量增量 |
 * | 用户看到的环 | 77% | 整窗 `estimateTokens`（含未占位正文） |
 * | provider 实际计数 | 1,048,568 | 400 原文 |
 *
 * 三次请求全部 400（`Input exceeds the context limit`），最后一次 run 的数字还**倒退**了
 * （778,258 → 673,076：`seedRealTokensFromLastRequest` 用上一次 provider 回报重置了锚点，
 * 把新追加的 106k 整体抹掉）。
 *
 * ## 合同（五条；改任何一条都要同步改这里的注释与 `ExecutionUnit` 的闸）
 *
 * 1. **口径**：显示 / 压缩 / 发送前闸用的那个数 = **下一次要发的请求视图**的估算。
 *    请求视图 = `buildRequestMessages()` 之后、`withClearedToolResults()` 之后的那一份
 *    （`ExecutionUnit.chatWithOverflowRetry` 拿到的 `args.messages`），**不是**「上一次
 *    provider 回报」。判据两条：两次请求之间新增的消息必须计入；run 起点
 *    （`seedRealTokensFromLastRequest`）不许让数字倒退 —— provider 回报只能当日志与
 *    地板值（`max`），不能当现值。
 * 2. **锚点**：`ContextAnchor` 必须真的落盘、重启后读得回来用得上。比值 = provider
 *    `prompt_tokens` ÷ **同一请求视图**的本模块估算。
 * 3. **同口径**：分子分母必须是同一次请求的同一份视图。拿「整窗估算」当分母会被结构性
 *    压小（占位后请求比整窗小，事故里整窗 767,709 vs 请求视图 569,633）⇒ 校正过头。
 * 4. **发送前闸**：请求视图估算（按锚点校正；无锚点用本模块的保守上界）≥ `maxTokens`
 *    ⇒ **不发**，本轮以明确失败收尾（`run.failed` + 一张可见的 env 卡）。压缩只发生在
 *    段起点（`compactAtSegmentStart`），段内绝不改写历史。
 * 5. **只许高报，不许低报**：低估的代价是请求被 provider 400 打回（今天就发生了一次，
 *    用户看到一个必然失败的 77%）；高估的代价只是多一次压缩。
 *
 * ## 为什么不能继续用 `estimateTokens`（0.4 起的老口径）
 *
 * `estimateTokens` 的语义被冻结（对外契约：「ASCII 0.25 / CJK 0.5 token 每字符」），
 * 但它是**乐观**的，而且错得不成比例：
 *
 * - 它对 ASCII 一律 0.25 token/字符。真实 BPE 在**控制字符 / 转义序列 / 密集标点**上完全
 *   不按这个比例走：`\x1b[0m`（4 字符，ANSI 清色）在 BPE 里是 2–4 个 token，老口径只算
 *   1 个。事故那条 stdout 有 88,338 个控制字符（20.9%）与 97,520 个标点，老口径给
 *   106,211，provider 的整次请求比整窗老口径估算还多出 ~281k —— 差额几乎全落在这条
 *   输出上。
 * - CJK 按 0.5 也偏低：BPE 里汉字基本 1 字 1 token。
 *
 * 所以本模块**另立**一份上界口径（老函数一个字没改，见合同 5）。
 *
 * ## 上界系数的取值依据（不是拍脑袋）
 *
 * 拿 83 个真实会话（`~/.vessel/data/sessions` 只读样本）做过一次标定：对每个会话取
 * 「最后一条 `llm.response.usage.prompt_tokens`」与「同一请求消息条数下的本地估算」，
 * 得到 provider ÷ 老口径 = 中位数 1.24（最坏 1.57），provider ÷ 本模块上界 = 中位数
 * 0.86、**最坏 1.05**。也就是说本模块的上界口径在样本里最坏只低报 5%，
 * 再乘 `NO_ANCHOR_SAFETY_MARGIN = 1.15` 就是「观测分布上永远不低报」。
 *
 * 每个字符的速率（上界，乘完再 `Math.ceil`）：
 *
 * | 类别 | 速率 | 理由 |
 * | --- | --- | --- |
 * | 控制字符（U+0000–U+001F、U+007F） | 1.0 | 转义序列逐字符成 token 是 BPE 的坏情况；宁可当 1 |
 * | 标点 / 符号（ASCII 非字母数字） | 0.6 | 常见 1–2 字符 1 token；0.6 覆盖坏情况 |
 * | 字母 / 数字 / 空格（ASCII） | 0.3 | 老口径 0.25 偏低（标定中位数 1.24 里有一部分是它） |
 * | 宽字符（CJK / 非 ASCII / 代理对） | 0.6 | 汉字 ~1 token/字；代理对按两个码元各 0.6 = 1.2（emoji 常 2–3） |
 *
 * 另加两项固定开销（provider 真实计数里有、消息正文里没有的东西）：
 * `REQUEST_MESSAGE_OVERHEAD_TOKENS`（每条消息的角色 / 分隔符）与 tools schema
 * （`estimateRequestViewTokens` 的 `tools` 参数）。
 *
 * ## 谁来用（不要自己再算一遍）
 *
 * - `ExecutionUnit`：请求期算一次（`estimateRequestViewTokens`），写进
 *   `llm.request.estimated_tokens` / `context.changed.token_count` / `context.pressure.used`，
 *   并作为发送前闸与锚点分母；
 * - `MemoryWorkingContext.tokenCount`：窗口自己只知道整窗（本段冻结的占位集合在 runtime
 *   侧），所以它给的是**整窗上界**（≥ 请求视图，永不低估），并在锚点生效时按锚点校正。
 */

import type { Message } from '../types/provider.js';

/**
 * 每条消息在 provider 侧的固定开销（role 标记 + 分隔符）。
 *
 * 依据：OpenAI 系 chat 模板每条消息 3–4 token（`<|im_start|>role\n... <|im_end|>`）；
 * 取 4 = 上界。事故请求 2,253 条消息 ⇒ 9,012 token，占 1M 窗口的 0.9%，不小到可以忽略。
 */
export const REQUEST_MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * **没有可用锚点**时的安全边距（乘在上界估算上）。
 *
 * 依据见模块头「上界系数的取值依据」：标定样本里 provider ÷ 上界口径最坏 1.05，
 * 1.15 留出 10% 余量。有锚点时不乘它 —— 那时的偏差已经被实测比值吸收，
 * 再乘一次就是双重高报（会凭空提前压缩）。
 */
export const NO_ANCHOR_SAFETY_MARGIN = 1.15;

/** 宽字符（CJK / 非 ASCII / 代理对）每码元的上界（token）。 */
export const UPPER_BOUND_RATE_WIDE = 0.6;
/** 控制字符每码元的上界（token）。转义序列是 BPE 的坏情况，按 1 计。 */
export const UPPER_BOUND_RATE_CONTROL = 1;
/** ASCII 标点 / 符号每码元的上界（token）。 */
export const UPPER_BOUND_RATE_PUNCT = 0.6;
/** ASCII 字母 / 数字 / 空格每码元的上界（token）。 */
export const UPPER_BOUND_RATE_PLAIN = 0.3;

/**
 * 本地拒发（不发必然 400 的请求）的稳定错误码。
 *
 * 与 provider 的 `provider_context_overflow` 区分开：那个是「provider 说超了」，
 * 这个是「我们自己的闸拦下的，请求根本没出去」。看日志时两者含义完全不同。
 */
export const CONTEXT_WINDOW_EXCEEDED = 'context_window_exceeded';

/**
 * 发送前闸的拒发错误。
 *
 * 带 `code`（`toErrorEnvelope` 只接受 snake_case 的 `code`）与 `details`（读数留证），
 * 于是 `run.failed` 的 envelope 里能看到 `context_window_exceeded` + `{used, max}`，
 * 而不是一条语义含糊的 `provider_error`。
 */
export class ContextWindowExceededError extends Error {
  readonly code = CONTEXT_WINDOW_EXCEEDED;
  readonly details: { used: number; max: number; action: 'not_sent' };
  constructor(used: number, max: number) {
    super(
      `${CONTEXT_WINDOW_EXCEEDED}: 下一次请求的估算 ${used} tokens ≥ 窗口上限 ${max}；` +
        '本段不发送该请求（压缩只在段起点发生），压缩后仍超需开新段 / 换会话。',
    );
    this.name = 'ContextWindowExceededError';
    this.details = { used, max, action: 'not_sent' };
  }
}

/**
 * 字符级 token **上界**估算（合同 5：只许高报）。
 *
 * 与 `estimateTokens` 的区别只有「每类字符的速率」和「一律向上取整」；扫描方式相同
 * （按 UTF-16 码元，不建中间字符串、不跑正则，1M 字符 ≈ 2–3ms）。
 */
export function estimateTokensUpperBound(text: string): number {
  if (!text) return 0;
  let wide = 0;
  let control = 0;
  let punct = 0;
  let plain = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // U+4E00–U+9FFF（CJK 统一表意）+ U+3400–U+4DBF（扩展 A）
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      wide += 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      control += 1;
      continue;
    }
    if (code < 0x80) {
      const isAlnumOrSpace =
        (code >= 0x30 && code <= 0x39) || // 0-9
        (code >= 0x41 && code <= 0x5a) || // A-Z
        (code >= 0x61 && code <= 0x7a) || // a-z
        code === 0x20; // 空格：BPE 里常与后词合并，按普通字符计更省（但仍是上界）
      if (isAlnumOrSpace) plain += 1;
      else punct += 1;
      continue;
    }
    // 非 ASCII / 代理对：一律按宽字符（emoji 两个码元 ⇒ 1.2 token，覆盖 2–3 的真实值）。
    wide += 1;
  }
  return Math.ceil(
    wide * UPPER_BOUND_RATE_WIDE +
      control * UPPER_BOUND_RATE_CONTROL +
      punct * UPPER_BOUND_RATE_PUNCT +
      plain * UPPER_BOUND_RATE_PLAIN,
  );
}

/**
 * 单条消息的上界估算（字段集与 `estimateMessageTokens` 逐项对应：
 * content + reasoning_content + name + 全部 tool_calls 的名称与参数）。
 *
 * 不含 `REQUEST_MESSAGE_OVERHEAD_TOKENS`：那是「消息集合」层的开销，
 * 见 `estimateMessagesTokensUpperBound`。
 */
export function estimateMessageTokensUpperBound(message: Message): number {
  let tokens = estimateTokensUpperBound(message.content ?? '');
  if (message.reasoning_content) tokens += estimateTokensUpperBound(message.reasoning_content);
  if (message.name) tokens += estimateTokensUpperBound(message.name);
  for (const call of message.tool_calls ?? []) {
    tokens += estimateTokensUpperBound(call.function?.name ?? '');
    tokens += estimateTokensUpperBound(call.function?.arguments ?? '');
  }
  return tokens;
}

/** 消息数组的上界估算 = 逐条上界 + 每条消息的固定开销（合同 5）。 */
export function estimateMessagesTokensUpperBound(messages: readonly Message[]): number {
  let tokens = messages.length * REQUEST_MESSAGE_OVERHEAD_TOKENS;
  for (const message of messages) tokens += estimateMessageTokensUpperBound(message);
  return tokens;
}

/** `estimateRequestViewTokens` 的输入。 */
export interface RequestViewEstimateInput {
  /** 本次请求会带上的工具声明（`ChatRequest.tools`）；provider 也把它算进 prompt。 */
  readonly tools?: readonly unknown[];
}

/**
 * **请求视图**的 token 上界估算（合同 1 的那个数）。
 *
 * `messages` 必须已经过 `buildRequestMessages()` → `withClearedToolResults()`：
 * 占位替换之后的正文才是 provider 真正看到的那一份。传整窗（含未占位正文）会高报，
 * 高报合法但不准，别再把它当「同一个口径」去当锚点分母（合同 3）。
 *
 * 未知 tokenizer 的安全边距**不在**这里乘：这是「上界估算」，乘不乘
 * `NO_ANCHOR_SAFETY_MARGIN` 是调用方（发送前闸 / 显示）的决定 —— 有锚点时不再乘。
 */
export function estimateRequestViewTokens(
  messages: readonly Message[],
  input: RequestViewEstimateInput = {},
): number {
  let tokens = estimateMessagesTokensUpperBound(messages);
  if (input.tools !== undefined && input.tools.length > 0) {
    // 工具声明是固定 JSON：序列化后走同一套上界口径（不解析、不挑字段 —— 少一次
    // 「哪些字段算不算」的判断，也就少一处会与 provider 口径漂移的地方）。
    try {
      tokens += estimateTokensUpperBound(JSON.stringify(input.tools));
    } catch {
      // 序列化失败（循环引用 / 代理对象）时按「不知道」处理：给一个显式的固定上界，
      // 而不是 0（0 会让闸静默放过一次可能是巨型工具表的请求）。
      tokens += REQUEST_MESSAGE_OVERHEAD_TOKENS * 512;
    }
  }
  return tokens;
}
