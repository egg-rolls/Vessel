/**
 * 块组件适配层（块 P0 渲染统一）：注册表 component 槽的统一形状是
 * `BlockProps<P>`（payload + render 上下文），既有组件各有自己的 props ——
 * 这里做**薄适配**，不改组件内部（红线：image/file/notice 组件只包装不重写）。
 *
 * `BlockView` 是注册表消费入口：按 block.type 查表取组件渲染；未知 type 返回
 * null（正文已在 lift 管线里原样保留，零回归）。订阅注册变化（useBlockType），
 * 插件热更新/禁用即生效。
 */
import type { ImageDelivery, MessageRef } from '../../gateway/types';
import { type BlockRenderCtx, type LiftedBlock, useBlockType } from './block-registry';
import { EnvCard } from './EnvCard';
import type { EnvNoticeCard } from './env-notice';
import { MessageRefs } from './MessageRefs';
import { QuoteBlock } from './QuoteBlock';
import type { ParsedQuoteEnvelope } from './quote-ref';
import { SessionRefBlock } from './SessionRefBlock';
import type { ParsedSessionRefEnvelope } from './session-ref';
import { ToolImageCard } from './ToolImageCard';

/** quote 块 payload = 既有信封解析结果（不另造形状）。 */
export type QuoteBlockPayload = ParsedQuoteEnvelope;

/** session-ref 块 payload = 信封解析结果（chips + 剩余正文）。 */
export type SessionRefBlockPayload = ParsedSessionRefEnvelope;

/** image 块 payload = ToolImageCard 的既有 props（整条消息成卡）。 */
export interface ImageBlockPayload {
  refs: readonly MessageRef[];
  imageDelivery?: readonly ImageDelivery[];
  /** 原始注记全文（收进卡内折叠区，原文不丢）。 */
  note: string;
  ts?: number;
}

/** file 块 payload = MessageRefs 的既有 props（结构化 refs，不占正文）。 */
export interface FileBlockPayload {
  refs: readonly MessageRef[];
  imageDelivery?: readonly ImageDelivery[];
}

/** notice 块 payload = runtimeEnvCard 装配结果 + 消息时刻。 */
export interface NoticeBlockPayload {
  env: EnvNoticeCard;
  ts?: number;
}

function QuoteBlockView({
  payload,
  render,
}: {
  payload: QuoteBlockPayload;
  render: BlockRenderCtx;
}) {
  return (
    <QuoteBlock
      messageId={payload.messageId}
      snippet={payload.snippet}
      onJump={render.onJumpQuote}
      className={render.className}
    />
  );
}

function SessionRefBlockView({
  payload,
  render,
}: {
  payload: SessionRefBlockPayload;
  render: BlockRenderCtx;
}) {
  return <SessionRefBlock chips={payload.chips} className={render.className} />;
}

function ToolImageCardView({ payload }: { payload: ImageBlockPayload; render: BlockRenderCtx }) {
  return (
    <ToolImageCard
      refs={payload.refs}
      imageDelivery={payload.imageDelivery}
      note={payload.note}
      ts={payload.ts}
    />
  );
}

function MessageRefsView({ payload }: { payload: FileBlockPayload; render: BlockRenderCtx }) {
  return <MessageRefs refs={payload.refs} imageDelivery={payload.imageDelivery} />;
}

function NoticeBlockView({ payload }: { payload: NoticeBlockPayload; render: BlockRenderCtx }) {
  return <EnvCard env={payload.env} ts={payload.ts} />;
}

export const blockViews = {
  quote: QuoteBlockView,
  'session-ref': SessionRefBlockView,
  image: ToolImageCardView,
  file: MessageRefsView,
  notice: NoticeBlockView,
} as const;

/** 一个块 → 注册表组件。未知 type ⇒ null（原文渲染兜底在管线侧）。 */
export function BlockView({ block, render }: { block: LiftedBlock; render?: BlockRenderCtx }) {
  const spec = useBlockType(block.type);
  if (spec === undefined) return null;
  const Component = spec.component;
  return <Component payload={block.payload} render={render ?? {}} />;
}

/** 一组块按管线顺序渲染（消费点只喂 blocks + 交互上下文）。
 * key = type：一条消息里每个宿主 type 至多提升一块（lift 契约），type 即稳定唯一键；
 * 未来一 type 多块时由 lift 侧给块内稳定 id，不用数组下标。 */
export function MessageBlocks({
  blocks,
  render,
}: {
  blocks: readonly LiftedBlock[];
  render?: BlockRenderCtx;
}) {
  return (
    <>
      {blocks.map((block) => (
        <BlockView key={block.type} block={block} render={render} />
      ))}
    </>
  );
}
