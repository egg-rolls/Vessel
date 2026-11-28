/**
 * 消息引用（q-message-quote）的纯函数层：信封合成 / 解析 / 轻量摘要。
 *
 * ## 为什么是「文本信封」而不是结构化 wire 字段
 *
 * 与 `session-ref.ts` 同一评估：`runs.start` 的 `refs` 是**文件附件**通道（服务端
 * 强校验绝对路径 + `file|image|document` 闭集），消息引用没有路径；而给
 * `Message` 加结构化 quote 字段要穿透 admit / inbox / dispatch / 投影整条链
 * （refs 在 service.ts 里有十余处副本接缝）。文本信封随正文走，**天然活过**
 * 排队 / 重启 / 重放 / 撤回编辑 —— 正文在哪，引用就在哪，零服务端改动。
 *
 * ## 信封格式（固定，不随 UI 语言变化）
 *
 * ```
 * [引用消息 <message_id>]
 * > <snippet ≤120 字，空白折叠，截断带 …>
 *
 * <正文>
 * ```
 *
 * - 这是 **AI 侧的结构化引用块**：接收 agent 在用户消息正文前直接读到
 *   「引用了哪条消息（稳定 id）+ 原文摘要」，轻量（~150 字符）、不重复全文。
 * - `message_id` 可缺省（`[引用消息]`）：被引消息没有稳定身份（旧数据），
 *   或 **AI 主动引用**时不知道 id —— 渲染侧按摘要在会话历史里定位原消息
 *   （`resolveQuoteMessageId`），定位不到就只渲染引用块、不跳转。
 * - **双向同形**：AI 回复也可以用同一个信封开头引用用户消息（模仿它收到的
 *   引用块格式）；渲染侧对 user / assistant 消息一视同仁地解析提升。
 * - 渲染侧把信封**提升**成气泡上方的轻量引用块（`QuoteBlock`），正文只渲染
 *   信封之后的部分；解析失败（正文被 guardrail 改写 / 用户手打了形似文本）
 *   一律按原文渲染 —— 零回归兜底，不猜。
 *
 * @module web/chat/quote-ref
 */
import type { ComposerQuote } from '../../stores/composerDraftStore';

/** 摘要上限（字符）：引用是「指向哪一句」，不是转载全文。 */
export const QUOTE_SNIPPET_MAX = 120;

/** 信封头部（固定中文标记：AI 侧口径稳定，不随 UI locale 漂移）。 */
const QUOTE_HEADER = '[引用消息';

/** 折叠空白后的前 N 字摘要；不劈开代理对，截断带 …。空正文 → 空串。 */
export function quoteSnippetOf(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= QUOTE_SNIPPET_MAX) return flat;
  let cut = QUOTE_SNIPPET_MAX;
  // 不劈开代理对（emoji 等）：与 composerDraftStore.truncateDraftText 同一口径。
  const code = flat.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${flat.slice(0, cut)}…`;
}

/**
 * 发送序列化：引用 → 信封块前置进正文（空行隔开）。
 * 无引用 / 空摘要时原样返回（调用方无需分支）。与 `composeSessionRefText` 同族。
 */
export function composeQuoteText(text: string, quote: ComposerQuote | undefined): string {
  if (quote === undefined || quote.snippet.length === 0) return text;
  const header =
    quote.messageId !== undefined && quote.messageId.length > 0
      ? `${QUOTE_HEADER} ${quote.messageId}]`
      : `${QUOTE_HEADER}]`;
  return `${header}\n> ${quote.snippet}\n\n${text}`;
}

/** 解析出的信封：id 可缺省；body 是信封之后的正文（可为空串）。 */
export interface ParsedQuoteEnvelope {
  messageId?: string;
  snippet: string;
  body: string;
}

/**
 * 严格解析正文开头的信封；不是信封返回 null（按原文渲染，零回归）。
 * 只认完整形状：头部行 + `> ` 摘要行 + 空行。流式期信封未收全时同样返回 null。
 */
export function parseQuoteEnvelope(content: string): ParsedQuoteEnvelope | null {
  if (!content.startsWith(QUOTE_HEADER)) return null;
  const match = /^\[引用消息(?: ([^\]\n]{1,128}))?\]\n> ([^\n]+)\n\n/.exec(content);
  if (match === null) return null;
  const messageId = match[1];
  const snippet = match[2];
  if (snippet === undefined || snippet.length === 0) return null;
  return {
    ...(messageId !== undefined ? { messageId } : {}),
    snippet,
    body: content.slice(match[0].length),
  };
}

/** 渲染侧用的最小消息形状（历史 Message / 实时输入都满足）。 */
export interface QuotableMessage {
  message_id?: string;
  content: string;
  role: string;
}

/**
 * 从一条消息构造引用（hover 工具栏「引用」的落点）。
 * 被引消息本身是引用回复时，摘要取它的**正文**（信封里的信封不转载）。
 * 空正文返回 undefined（没有可引用的内容）。
 */
export function quoteOfMessage(message: QuotableMessage): ComposerQuote | undefined {
  const inner = parseQuoteEnvelope(message.content);
  const snippet = quoteSnippetOf(inner !== null ? inner.body : message.content);
  if (snippet.length === 0) return undefined;
  return {
    ...(message.message_id !== undefined && message.message_id.length > 0
      ? { messageId: message.message_id }
      : {}),
    snippet,
    source: message.role === 'user' ? 'user' : 'assistant',
  };
}

/**
 * 无 id 信封的目标定位：按摘要在会话历史里找**最后一条**匹配的消息。
 * 摘要折叠空白后做前缀匹配（AI 的摘要逐字来自上下文，前缀匹配足够精确）；
 * 被引消息本身是引用回复时，也按它的正文匹配。找不到返回 undefined（不跳转）。
 */
export function resolveQuoteMessageId(
  snippet: string,
  messages: readonly QuotableMessage[],
): string | undefined {
  const needle = snippet.replace(/\s+/g, ' ').replace(/…$/, '').trim();
  if (needle.length === 0) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.message_id === undefined) continue;
    const inner = parseQuoteEnvelope(message.content);
    const haystacks = inner !== null ? [inner.body, message.content] : [message.content];
    for (const haystack of haystacks) {
      if (haystack.replace(/\s+/g, ' ').trim().startsWith(needle)) return message.message_id;
    }
  }
  return undefined;
}

/**
 * 渲染提升：正文 → 引用块数据 + 剩余正文。不是信封返回 null。
 * 无 id 时给会话历史（`messages`）就顺手定位跳转目标；不给就只渲染不跳转。
 */
export function liftQuoteForDisplay(
  content: string,
  messages?: readonly QuotableMessage[],
): ParsedQuoteEnvelope | null {
  const parsed = parseQuoteEnvelope(content);
  if (parsed === null) return null;
  if (parsed.messageId === undefined && messages !== undefined) {
    const resolved = resolveQuoteMessageId(parsed.snippet, messages);
    if (resolved !== undefined) return { ...parsed, messageId: resolved };
  }
  return parsed;
}
