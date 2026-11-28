/**
 * 块提升管线（块 P0 渲染统一，architecture-block-bootstrap-design §2.6）。
 *
 * `liftBlocks(message, ctx)` 是**唯一**的「正文 → 结构化块 + 剩余正文」入口：
 * 按注册表 order 依次调用各 type 的 lift（收编既有解析器，不重写）：
 * - quote：`quote-ref.ts#liftQuoteForDisplay`（信封最外层，先剥）；
 * - session-ref：`session-ref.ts#liftSessionRefForDisplay`（本批新补，zh/en 双词）；
 * - image：`transcript-items.ts#toolImageRefsOf`（整条消息成卡）；
 * - notice：`env-notice.ts#runtimeEnvCard`（统一装配入口的包装）；
 * - file：结构化 `Message.refs` + 正文 vessel-ref token（token 成卡剥出正文，
 *   按 path occurrence 与 refs 去重；工具图片卡已含非图 refs 时不重复出 chip）；
 * - vessel-block：`vessel-block.ts#parseVesselBlockFence`（块 P1 试点：整条正文
 *   单闭合 fence + table schema，坏 payload / 未闭合一律原文渲染）。
 *
 * **硬约束**（逐字保留既有语义）：
 * - 流式「信封未收全返回 null」：quote / session-ref 的解析器对半截信封返回 null，
 *   这里不提升、正文原样 —— 否则流式期块闪烁回归；
 * - 历史消息逐字节不变：只读取解析，不回填不改写；legacy 解析器永久保留；
 * - 未知 type / 解析失败一律原文渲染（blocks 为空，body = 原文）。
 *
 * 宿主原生 type 在本模块加载时注册（消费点 import liftBlocks 即完成）；插件
 * type 经 composer-extensions 既有桥另行注册进同一张表。
 */
import type { Message } from '../../gateway/types';
import { runtimeMessageKind } from '../../state/runtime-kinds';
import {
  blockTypesInOrder,
  type LiftCtx,
  type LiftedBlock,
  registerBlockType,
} from './block-registry';
import { blockViews } from './block-views';
import { runtimeEnvCard } from './env-notice';
import { liftFileTokens, matchFileTokens } from './file-token';
import { composeQuoteText, liftQuoteForDisplay } from './quote-ref';
import { composeSessionRefText, liftSessionRefForDisplay } from './session-ref';
import { toolImageRefsOf } from './transcript-items';
import { parseVesselBlockFence } from './vessel-block';

export interface LiftBlocksResult {
  /** 按注册表 order 排好的块（quote 最前 → session-ref → image/notice → file → vessel-block）。 */
  blocks: LiftedBlock[];
  /** 剥掉所有被消费信封后的剩余正文（无块时 = 原文，逐字节）。 */
  body: string;
}

/**
 * 正文 → 块 + 剩余正文。纯函数（注册表当前态），无 React / store 依赖。
 * 流式消费点没有历史窗口：ctx 缺省即可（无 id 信封只渲染不跳转，与旧行为一致）。
 */
export function liftBlocks(message: Message, ctx: LiftCtx = {}): LiftBlocksResult {
  let body = message.content;
  const blocks: LiftedBlock[] = [];
  for (const spec of blockTypesInOrder()) {
    for (const block of spec.lift({ message, body }, ctx)) {
      blocks.push(block);
      if (block.body !== undefined) body = block.body;
    }
  }
  return { blocks, body };
}

// ── 宿主原生 type 注册（启动即注册；owner='host'，不参与插件注销）──────────────

registerBlockType({
  type: 'quote',
  surface: 'light',
  order: 10,
  owner: 'host',
  component: blockViews.quote,
  compose: composeQuoteText,
  lift: ({ body }, ctx) => {
    const parsed = liftQuoteForDisplay(body, ctx.messages);
    if (parsed === null) return [];
    return [{ type: 'quote', payload: parsed, body: parsed.body }];
  },
});

registerBlockType({
  type: 'session-ref',
  surface: 'card',
  order: 20,
  owner: 'host',
  component: blockViews['session-ref'],
  compose: composeSessionRefText,
  lift: ({ body }) => {
    const parsed = liftSessionRefForDisplay(body);
    if (parsed === null) return [];
    return [{ type: 'session-ref', payload: parsed, body: parsed.body }];
  },
});

registerBlockType({
  type: 'image',
  surface: 'card',
  order: 30,
  owner: 'host',
  component: blockViews.image,
  lift: ({ message }) => {
    const refs = toolImageRefsOf(message);
    if (refs === undefined) return [];
    return [
      {
        type: 'image',
        payload: {
          refs,
          ...(message.image_delivery !== undefined
            ? { imageDelivery: message.image_delivery }
            : {}),
          note: message.content,
          ...(message.timestamp !== undefined ? { ts: message.timestamp } : {}),
        },
        body: '',
      },
    ];
  },
});

registerBlockType({
  type: 'notice',
  surface: 'card',
  order: 40,
  owner: 'host',
  component: blockViews.notice,
  lift: ({ message }) => {
    // runtime 上下文消息恒为 user 侧注入（runtime-kinds 口径）；助手消息即便
    // 带 vessel:* 名字也保持原文渲染（历史行为逐字节不变）。
    if (message.role !== 'user') return [];
    const kind = runtimeMessageKind(message);
    if (kind === undefined) return [];
    const env = runtimeEnvCard(kind, message.content);
    // 装配不出卡（未登记 kind）⇒ 不出块：渲染侧既有「整段文本运行时提示卡」兜底。
    if (env === undefined) return [];
    return [
      {
        type: 'notice',
        payload: { env, ...(message.timestamp !== undefined ? { ts: message.timestamp } : {}) },
        body: '',
      },
    ];
  },
});

registerBlockType({
  type: 'file',
  surface: 'card',
  order: 50,
  owner: 'host',
  component: blockViews.file,
  lift: ({ message, body }) => {
    // refs chip / token 卡只属于用户输入侧（助手消息历史/实时都不渲 refs，保持
    // 既有行为；助手正文的 vessel-ref 链接仍走 Markdown link-enhancers 内联卡）。
    if (message.role !== 'user') return [];
    // 工具图片卡内部已渲非图 refs（MessageRefs）：整条成卡时不重复出 chip。
    if (toolImageRefsOf(message) !== undefined) return [];
    // 正文 vessel-ref token 提升（用户新 UI 方向①）：完整 token 成卡、剥出正文；
    // 半截形状不命中 ⇒ 原文保留（流式逐字不闪）。与结构化 refs 按 path occurrence
    // 匹配去重（镜像 composer refsToAttachmentsFiltered）：被 token 消费的 ref 不
    // 再出 chip，剩余 refs 照旧 chip —— 每个 occurrence 恰渲一次。
    const lifted = liftFileTokens(body);
    const refs = message.refs ?? [];
    if (lifted === null && refs.length === 0) return [];
    const match = matchFileTokens(lifted?.tokens ?? [], refs, message.image_delivery);
    return [
      {
        type: 'file',
        payload: {
          refs: match.refs,
          ...(match.imageDelivery !== undefined ? { imageDelivery: match.imageDelivery } : {}),
          ...(match.cards.length > 0 ? { tokens: match.cards } : {}),
        },
        ...(lifted !== null ? { body: lifted.body } : {}),
      },
    ];
  },
});

registerBlockType({
  type: 'vessel-block',
  surface: 'card',
  order: 60,
  owner: 'host',
  component: blockViews['vessel-block'],
  lift: ({ body }) => {
    // 试点（blocks.md §5.1）：整条剩余正文恰为一个闭合 vessel-block fence +
    // 合法 schema 才提升；未闭合 / 坏 payload / 中段 fence 一律 null ⇒ 原文
    // 渲染（markdown code 块兜底，流式逐字保留）。
    const payload = parseVesselBlockFence(body);
    if (payload === null) return [];
    return [{ type: 'vessel-block', payload, body: '' }];
  },
});
