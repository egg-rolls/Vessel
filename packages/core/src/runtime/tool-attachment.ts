/**
 * 工具结果图片附件回执（q-media-view）
 * @module @vessel-agent/core/runtime
 *
 * ## 这条通路解决什么
 *
 * 多模态主模型应当能**直接看到**工具读出的本地图片（像用户消息附图那样），而不是
 * 只能拿到一段文字描述（describe 桥）或 OCR 文本。0.56 的视觉基座已经具备全部机件：
 * `Message.refs`（kind:'image' + sha256）→ `vision/plan.ts` 请求期解析 →适配器把该条
 * 消息的 content 升成图块。缺的只是「工具结果 → refs」这一段。
 *
 * ## 为什么是回执，而不是改 `ToolHandler` 返回类型
 *
 * 与出口闸回执（`tool-result-gate.ts` 的 `markToolResultBounded`）同一判据：
 * `ToolHandler` 返回 `Promise<string>`，被所有插件与调用点直接读取；改成联合类型会让
 * 全部既有调用点收窄（回归面太大）。回执挂在**每次调用新建**的 `ToolContext` 上
 * （WeakMap，随 ctx 回收），handler 签名一个字不变，不用的工具零感知。
 *
 * ## 全程只有引用，没有字节
 *
 * 回执携带的是 `MessageRef`（path + sha256 + 元信息），**不是图片字节**：字节在工具
 * 侧经 `vision/ingest.ts` 落 blob（上传即落），请求期由 plan 按 sha256 读冻结副本。
 * 于是「图片字节永不进 Message / 事件 / 出口闸」的三条不变量原样成立。
 *
 * ## 下游消费（唯一消费方：tool-calling-loop）
 *
 * 管道认领回执 → `ToolPipelineResult.refs` → `ToolExecutionOutcome.refs` → loop 在
 * 本批工具结果全部写回后**追加一条带 refs 的 user 消息**（既有注入通道
 * `appendInjectedMessages`，身份盖章 / 事件 / 落盘全复用）。为什么不把 refs 挂在
 * role:'tool' 消息上：OpenAI 兼容传输的 tool 消息 content 只能是字符串（图块会被
 * 400），而 user 消息附图是三家传输都支持的既有通路 —— 正是「像用户消息附图那样」。
 *
 * 只接受 `kind:'image'` 的引用；没有 sha256 的引用不会入池（plan 记 `not_ingested`），
 * loop 侧也不会为它注入消息（不声称「附上了」一张发不出去的图）。
 */

import type { MessageRef } from '../types/provider.js';
import type { ToolContext } from '../types/tool.js';

/** 一次调用累计的图片引用（handler 可多次登记；按登记顺序保留）。 */
const attachmentReceipts = new WeakMap<ToolContext, MessageRef[]>();

/**
 * 登记「这次工具结果要附带这些图片」（由读出图片的 handler 调用，如 media action=view）。
 *
 * 只收 `kind:'image'`；其余种类静默忽略（本通道专用于图片 surfaced，文档 / 普通文件
 * 仍走 refs 提示 + 工具按需读的既有通路）。引用应已带 sha256（先经 `ingestImageRefs`
 * 入池）；缺 sha256 的引用下游不会 surfaced。
 */
export function attachToolImages(ctx: ToolContext, refs: readonly MessageRef[]): void {
  const images = refs.filter((ref) => ref.kind === 'image');
  if (images.length === 0) return;
  const existing = attachmentReceipts.get(ctx);
  if (existing === undefined) attachmentReceipts.set(ctx, [...images]);
  else existing.push(...images);
}

/**
 * 认领回执（工具管道用；取走即删，与 gate receipt / transport 同口径）。
 * 没有登记过返回 undefined —— 旧工具 / 旧事件逐字节不变。
 */
export function takeToolAttachments(ctx: ToolContext): MessageRef[] | undefined {
  const refs = attachmentReceipts.get(ctx);
  if (refs === undefined) return undefined;
  attachmentReceipts.delete(ctx);
  return refs.length > 0 ? refs : undefined;
}
