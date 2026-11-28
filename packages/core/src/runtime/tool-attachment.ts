/**
 * 工具结果结构化附件回执（q-media-view → 块 P2 泛化 attachToolBlocks）
 * @module @vessel-agent/core/runtime
 *
 * ## 这条通路解决什么
 *
 * 多模态主模型应当能**直接看到**工具读出的本地图片（像用户消息附图那样），而不是
 * 只能拿到一段文字描述（describe 桥）或 OCR 文本。0.56 的视觉基座已经具备全部机件：
 * `Message.refs`（kind:'image' + sha256）→ `vision/plan.ts` 请求期解析 →适配器把该条
 * 消息的 content 升成图块。缺的只是「工具结果 → refs」这一段。
 *
 * 块 P2（architecture-block-bootstrap-design §2.5）把同一回执泛化为 typed blocks：
 * 任何插件工具都能 surface quote / image / file / table / code 块，loop 在本批工具
 * 结果后以**统一信封 / vessel-block fence**（docs/architecture/blocks.md）追加注入
 * user 消息 —— 模型侧投影 = 信封 / fence 原文，可见性对等天然满足。**不新造
 * send_block 工具**：这是唯一既有结构化注入通道的泛化，不是第二套注入语义。
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
 * image / file 回执携带的是 `MessageRef`（path + sha256 + 元信息），**不是文件字节**：
 * 图片字节在工具侧经 `vision/ingest.ts` 落 blob（上传即落），请求期由 plan 按 sha256
 * 读冻结副本。于是「图片字节永不进 Message / 事件 / 出口闸」的三条不变量原样成立。
 * quote / table / code 是纯文本 payload，序列化进 content 信封 / fence（主 wire =
 * 文本，零服务端新字段；Message.blocks 结构化字段是 P3 远期，不做）。
 *
 * ## 下游消费（唯一消费方：tool-calling-loop）
 *
 * 管道认领回执 → `ToolPipelineResult.refs`（image 通道，逐字节旧语义）+
 * `ToolPipelineResult.blocks`（additive）→ `ToolExecutionOutcome` → loop 在本批工具
 * 结果全部写回后**按 type 分条追加 user 消息**（既有注入通道 `appendInjectedMessages`，
 * 身份盖章 / 事件 / 落盘全复用）。为什么不把 refs 挂在 role:'tool' 消息上：OpenAI
 * 兼容传输的 tool 消息 content 只能是字符串（图块会被 400），而 user 消息附图是三家
 * 传输都支持的既有通路 —— 正是「像用户消息附图那样」。为什么分条：前端 image lift
 * 按「`[tool image] ` 前缀 + image refs」整条成卡（吞正文），vessel-block fence 试点
 * 要求整条正文恰为单闭合 fence —— 混合内容塞一条会被卡吞掉，分条各自命中既有 lift。
 *
 * image 只接受 `kind:'image'` 的引用；没有 sha256 的引用不会入池（plan 记
 * `not_ingested`），loop 侧也不会为它注入消息（不声称「附上了」一张发不出去的图）。
 */

import type { MessageRef } from '../types/provider.js';
import type { ToolContext } from '../types/tool.js';

/**
 * 工具可 surface 的 typed block（判别联合；wire 形状见 blocks.md §3/§5）。
 *
 * - quote：信封 `[引用消息 <id>]` + `> snippet`（composeQuoteText 同形，双向同构）；
 * - file：`MessageRef`（kind file/document）+ 注记，前端既有 refs chip 直接认；
 * - table / code：vessel-block fence（闭合 JSON payload，模型侧投影 = fence 原文）。
 *   table schema 与前端 vessel-block.ts#validateTablePayload 逐条同口径（core 与 web
 *   bundle 隔离，两份校验是刻意代价，改一处必须同步另一处）。
 */
export type ToolBlock =
  | { type: 'quote'; messageId?: string; snippet: string }
  | { type: 'file'; ref: MessageRef }
  | { type: 'table'; caption?: string; columns: string[]; rows: string[][] }
  | { type: 'code'; language?: string; code: string };

/** 回执条目 = typed block + image（image 走既有 refs 通道，不进 blocks 序列化）。 */
export type ToolBlockAttachment = ToolBlock | { type: 'image'; ref: MessageRef };

/** 认领结果：image refs（旧通道逐字节不变）与 typed blocks（additive）分流。 */
export interface ToolAttachmentReceipt {
  refs: MessageRef[];
  blocks: ToolBlock[];
}

/** 一次调用累计的附件条目（handler 可多次登记；按登记顺序保留）。 */
const attachmentReceipts = new WeakMap<ToolContext, ToolBlockAttachment[]>();

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 入口形状校验（坏条目静默丢，与 attachToolImages 忽略非 image 同口径 ——
 * 不抛错、不猜、不吞合法条目）。table 严格 schema 镜像前端 vessel-block.ts。
 */
function isValidAttachment(entry: ToolBlockAttachment): boolean {
  switch (entry.type) {
    case 'image':
      return entry.ref.kind === 'image';
    case 'file':
      return (
        (entry.ref.kind === 'file' || entry.ref.kind === 'document') &&
        isNonEmptyString(entry.ref.path)
      );
    case 'quote':
      return (
        isNonEmptyString(entry.snippet) &&
        (entry.messageId === undefined ||
          // 镜像前端 parseQuoteEnvelope 的 id 形状（[^\]\n]{1,128}）：超形状的信封
          // 前端不提升，入口就不收（不声称 surface 了一个渲染不出的块）。
          (isNonEmptyString(entry.messageId) &&
            entry.messageId.length <= 128 &&
            !entry.messageId.includes(']') &&
            !entry.messageId.includes('\n')))
      );
    case 'table': {
      const { columns, rows, caption } = entry;
      if (!Array.isArray(columns) || columns.length === 0) return false;
      if (!columns.every((cell) => typeof cell === 'string')) return false;
      if (!Array.isArray(rows)) return false;
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== columns.length) return false;
        if (!row.every((cell) => typeof cell === 'string')) return false;
      }
      return caption === undefined || isNonEmptyString(caption);
    }
    case 'code':
      return (
        isNonEmptyString(entry.code) &&
        (entry.language === undefined || typeof entry.language === 'string')
      );
    default:
      return false;
  }
}

/**
 * 登记「这次工具结果要附带这些 typed blocks」（块 P2：任何插件工具可调用）。
 *
 * 形状不合法的条目静默忽略（入口校验，下游不再猜）。image 条目应已带 sha256
 * （先经 `ingestImageRefs` 入池）；缺 sha256 的图下游不会 surfaced（loop 既有判定）。
 */
export function attachToolBlocks(ctx: ToolContext, blocks: readonly ToolBlockAttachment[]): void {
  const valid = blocks.filter(isValidAttachment);
  if (valid.length === 0) return;
  const existing = attachmentReceipts.get(ctx);
  if (existing === undefined) attachmentReceipts.set(ctx, [...valid]);
  else existing.push(...valid);
}

/**
 * 登记「这次工具结果要附带这些图片」（q-media-view 原入口，保留为 attachToolBlocks
 * 特例：media 等既有 handler 零改动）。只收 `kind:'image'`；其余种类静默忽略。
 */
export function attachToolImages(ctx: ToolContext, refs: readonly MessageRef[]): void {
  attachToolBlocks(
    ctx,
    refs.filter((ref) => ref.kind === 'image').map((ref) => ({ type: 'image' as const, ref })),
  );
}

/**
 * 认领回执（工具管道用；取走即删，与 gate receipt / transport 同口径）。
 * 没有登记过返回 undefined —— 旧工具 / 旧事件逐字节不变。
 * image 条目分流进 refs（旧通道），其余 typed blocks 进 blocks（additive）。
 */
export function takeToolAttachments(ctx: ToolContext): ToolAttachmentReceipt | undefined {
  const entries = attachmentReceipts.get(ctx);
  if (entries === undefined) return undefined;
  attachmentReceipts.delete(ctx);
  const refs: MessageRef[] = [];
  const blocks: ToolBlock[] = [];
  for (const entry of entries) {
    if (entry.type === 'image') refs.push(entry.ref);
    else blocks.push(entry);
  }
  if (refs.length === 0 && blocks.length === 0) return undefined;
  return { refs, blocks };
}
