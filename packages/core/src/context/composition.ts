/**
 * 请求视图的**组成分解**（q-context-composition）。
 *
 * ## 为什么需要它
 * 此前上下文只有一个总数（`context_window: 552702/1M`）：知道窗口快满了，却不知道
 * **被什么占满** —— 是工具结果原文？历史对话？环境卡？图片？压缩摘要？没有这份明细，
 * trim / whitelist / 压缩策略的优化只能猜。本模块把「下一次请求」的 token 上界估算
 * 拆成固定成分表，每个成分给 `{tokens, count, share}`，供：
 * - `context.composition` 事实事件（每请求一条，落时间线，供增长分析）；
 * - `sessions.composition` RPC（读最近 N 条快照，introspection）。
 *
 * ## 口径（与 `request-view.ts` 合同逐字对齐）
 * - `messages` 必须是**请求视图**（`buildRequestMessages` → `withClearedToolResults`
 *   之后的那一份）—— 占位替换后的正文才是 provider 真正看到的；
 * - 逐条 token 用 `estimateMessageTokensUpperBound`（与 `estimateRequestViewTokens`
 *   同一个函数），`total_tokens` 直接调 `estimateRequestViewTokens` —— **一个数、
 *   一个出处**，成分之和与总数按构造相等（同公式拆开算，不另立口径）；
 * - 图片 token 只认 `attachments.tokens`（后端描述符计价），**绝不**按 base64 字符数；
 * - 工具声明按序列化 JSON 的上界估算（与估算器同一套，含序列化失败的固定上界回退）。
 *
 * ## 成分表（固定键集，零值也写 —— 分析侧不用猜键存在性）
 * | 键 | 含义 |
 * |---|---|
 * | `system_prompt` | 基底 system（role=system 且非压缩摘要；含 Self Card 改写后的那份） |
 * | `compaction_summary` | 压缩摘要（role=system + `compaction_summary` 标记） |
 * | `user_history` | 历史用户消息（非环境卡、非本 run 输入） |
 * | `current_input` | 本 run 的用户输入 / 注入消息（`message.run_id === currentRunId`） |
 * | `assistant` | assistant 正文 + reasoning_content + tool_calls 名称/参数 |
 * | `tool_results` | 保留原文的工具结果 |
 * | `tool_placeholders` | 已清空的工具结果占位（`[cleared ...]`） |
 * | `notices` | `vessel:notice` 环境卡 / 运行时提示（按 `name` 识别，任何非 system role） |
 * | `images` | 图片计划计价（count = 张数） |
 * | `tools` | 工具声明 JSON（count = 工具个数） |
 * | `overhead` | 每条消息的固定开销（count = 消息条数 × 4 token） |
 *
 * `cleared_original_tokens` / `cleared_saved_tokens`（可选）：占位对应的**原文**在
 * 落盘窗口里值多少 token、占位替它省了多少 —— 回答「清空机制到底省没省」。
 * 只在调用方给了 `originalMessages`（落盘窗口）时计算；视图里只有占位正文，
 * 原文体积必须回窗口取，按 `tool_call_id` 配对。
 *
 * @module @vessel-agent/core/context
 */

import type { Message } from '../types/provider.js';
import { isClearedToolResult } from './cleared-tool-result.js';
import {
  estimateMessageTokensUpperBound,
  estimateRequestViewTokens,
  estimateTokensUpperBound,
  REQUEST_MESSAGE_OVERHEAD_TOKENS,
} from './request-view.js';

/** 一个成分的读数：token 上界 + 条数（图片=张数 / tools=个数）+ 占总数比例。 */
export interface CompositionComponent {
  /** 上界估算 token（与 `estimateRequestViewTokens` 同口径）。 */
  tokens: number;
  /** 条数（images = 张数；tools = 声明个数；overhead = 消息条数）。 */
  count: number;
  /** `tokens / total_tokens`（0..1，四位小数；total=0 时为 0）。 */
  share: number;
}

/** 固定成分键集（顺序即展示顺序）。 */
export const COMPOSITION_COMPONENT_KEYS = [
  'system_prompt',
  'compaction_summary',
  'user_history',
  'current_input',
  'assistant',
  'tool_results',
  'tool_placeholders',
  'notices',
  'images',
  'tools',
  'overhead',
] as const;

export type CompositionComponentKey = (typeof COMPOSITION_COMPONENT_KEYS)[number];

/** 一次请求的组成快照（`context.composition` 事件的载荷核心）。 */
export interface RequestComposition {
  /** 请求视图 token 上界（= `estimateRequestViewTokens`，未锚点校正）。 */
  total_tokens: number;
  /** 锚点校正后的现值（`correctedContextTokens`；调用方给了才写）。 */
  corrected_tokens?: number;
  /** 上下文窗口上限（`workingContext.maxTokens`；未知不写）。 */
  context_max?: number;
  /** 请求视图消息条数。 */
  message_count: number;
  /** 固定键集的成分表（零值也写）。 */
  components: Record<CompositionComponentKey, CompositionComponent>;
  /** 占位对应原文的 token 上界（给了 originalMessages 才写）。 */
  cleared_original_tokens?: number;
  /** 占位相对原文省下的 token（= original − placeholder；同上条件）。 */
  cleared_saved_tokens?: number;
}

/** `buildRequestComposition` 的输入。 */
export interface RequestCompositionInput {
  /** 本次请求的工具声明（与估算器同一个数组）。 */
  readonly tools?: readonly unknown[];
  /** 图片计划计价（**必填**，无图显式传 0）+ 张数。 */
  readonly attachments: { readonly tokens: number; readonly count?: number };
  /** 锚点校正后的现值（可选，只透传进快照）。 */
  readonly correctedTokens?: number;
  /** 窗口上限（可选）。 */
  readonly contextMax?: number;
  /** 落盘窗口（可选）：只为算占位对应原文的体积。 */
  readonly originalMessages?: readonly Message[];
  /** 本 run id（可选）：给了才把「本 run 输入」从 user_history 里分出来。 */
  readonly currentRunId?: string;
}

/** 环境卡的识别口径（与 `appendNotice` / project-messages 同一套）：`name` 命中。 */
const NOTICE_NAME = 'vessel:notice';

function shareOf(tokens: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((tokens / total) * 10000) / 10000;
}

/**
 * 把请求视图拆成成分表（纯函数，不改任何消息）。
 *
 * 成本 = 一遍逐条上界估算（与发送前闸同一量级，1M 字符 ≈ 2–3ms）+ 可选的一遍
 * 落盘窗口扫描（只为占位原文体积）。调用方按配置开关决定要不要付这份钱。
 */
export function buildRequestComposition(
  messages: readonly Message[],
  input: RequestCompositionInput,
): RequestComposition {
  const total = estimateRequestViewTokens(messages, {
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    attachments: { tokens: input.attachments.tokens },
  });

  const tokens: Record<CompositionComponentKey, number> = {
    system_prompt: 0,
    compaction_summary: 0,
    user_history: 0,
    current_input: 0,
    assistant: 0,
    tool_results: 0,
    tool_placeholders: 0,
    notices: 0,
    images: 0,
    tools: 0,
    overhead: 0,
  };
  const counts: Record<CompositionComponentKey, number> = {
    system_prompt: 0,
    compaction_summary: 0,
    user_history: 0,
    current_input: 0,
    assistant: 0,
    tool_results: 0,
    tool_placeholders: 0,
    notices: 0,
    images: 0,
    tools: 0,
    overhead: 0,
  };
  /** 视图里已是占位的 tool_call_id（回窗口配原文用）。 */
  const placeholderIds = new Set<string>();

  const add = (key: CompositionComponentKey, cost: number): void => {
    tokens[key] += cost;
    counts[key] += 1;
  };

  for (const message of messages) {
    const cost = estimateMessageTokensUpperBound(message);
    if (message.role === 'system') {
      add(message.compaction_summary === true ? 'compaction_summary' : 'system_prompt', cost);
      continue;
    }
    // 环境卡按 name 识别（role 通常是 user，但识别口径不绑 role）。
    if (message.name === NOTICE_NAME) {
      add('notices', cost);
      continue;
    }
    if (message.role === 'tool') {
      if (isClearedToolResult(message.content)) {
        add('tool_placeholders', cost);
        if (typeof message.tool_call_id === 'string') placeholderIds.add(message.tool_call_id);
      } else {
        add('tool_results', cost);
      }
      continue;
    }
    if (message.role === 'assistant') {
      add('assistant', cost);
      continue;
    }
    // user（其余 role 兜底归 user_history：provider 序列里只有这四种）。
    if (input.currentRunId !== undefined && message.run_id === input.currentRunId) {
      add('current_input', cost);
    } else {
      add('user_history', cost);
    }
  }

  // 图片 / 工具声明 / 消息开销：与 estimateRequestViewTokens 的加法逐项同公式。
  const attachmentTokens = input.attachments.tokens;
  if (Number.isFinite(attachmentTokens) && attachmentTokens > 0) {
    tokens.images = Math.ceil(attachmentTokens);
  }
  counts.images = input.attachments.count ?? 0;
  if (input.tools !== undefined && input.tools.length > 0) {
    counts.tools = input.tools.length;
    try {
      tokens.tools = estimateTokensUpperBound(JSON.stringify(input.tools));
    } catch {
      tokens.tools = REQUEST_MESSAGE_OVERHEAD_TOKENS * 512;
    }
  }
  tokens.overhead = messages.length * REQUEST_MESSAGE_OVERHEAD_TOKENS;
  counts.overhead = messages.length;

  const components = {} as Record<CompositionComponentKey, CompositionComponent>;
  for (const key of COMPOSITION_COMPONENT_KEYS) {
    components[key] = {
      tokens: tokens[key],
      count: counts[key],
      share: shareOf(tokens[key], total),
    };
  }

  const composition: RequestComposition = {
    total_tokens: total,
    ...(input.correctedTokens !== undefined ? { corrected_tokens: input.correctedTokens } : {}),
    ...(input.contextMax !== undefined ? { context_max: input.contextMax } : {}),
    message_count: messages.length,
    components,
  };

  // 占位原文体积：回落在窗口按 tool_call_id 配对（视图里只有占位，原文不在视图里）。
  if (input.originalMessages !== undefined && placeholderIds.size > 0) {
    let original = 0;
    for (const message of input.originalMessages) {
      if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
      if (!placeholderIds.has(message.tool_call_id)) continue;
      if (isClearedToolResult(message.content)) continue; // 落盘已是占位 ⇒ 无原文可省
      original += estimateMessageTokensUpperBound(message);
    }
    composition.cleared_original_tokens = original;
    composition.cleared_saved_tokens = Math.max(0, original - tokens.tool_placeholders);
  }

  return composition;
}
