/**
 * 块组件适配层（块 P0 渲染统一）：注册表 component 槽的统一形状是
 * `BlockProps<P>`（payload + render 上下文），既有组件各有自己的 props ——
 * 这里做**薄适配**，不改组件内部（红线：image/file/notice 组件只包装不重写）。
 *
 * `BlockView` 是注册表消费入口：按 block.type 查表取组件渲染；未知 type 返回
 * null（正文已在 lift 管线里原样保留，零回归）。订阅注册变化（useBlockType），
 * 插件热更新/禁用即生效。
 */
import { Markdown } from '../../components/Markdown';
import type { ImageDelivery, MessageRef } from '../../gateway/types';
import { type BlockRenderCtx, type LiftedBlock, useBlockType } from './block-registry';
import { EnvCard } from './EnvCard';
import type { EnvNoticeCard } from './env-notice';
import type { FileTokenCard } from './file-token';
import type { LiftBlocksResult } from './lift-blocks';
import { QuoteBlock } from './QuoteBlock';
import type { ParsedQuoteEnvelope } from './quote-ref';
import { SessionRefBlock } from './SessionRefBlock';
import type { ParsedSessionRefEnvelope } from './session-ref';
import { ToolImageCard } from './ToolImageCard';
import { ToolResultCard } from './ToolResultCard';
import { type VesselBlockPayload, vesselBlockMarkdown } from './vessel-block';

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

/** file 块 payload = 内联数据（token 卡 + 剩余 refs，occurrence 去重后）。
 * 渲染位置在气泡内（liftBlocks 分流到 result.inline → InlineText）；
 * 块区视图形同虚设（FileBlockView 返回 null）。 */
export interface FileBlockPayload {
  /** 未被 token 消费的 refs（气泡内尾部 chip 行；空数组不渲染）。 */
  refs: readonly MessageRef[];
  imageDelivery?: readonly ImageDelivery[];
  /** 正文 vessel-ref token 扫出的卡（每 token 一张 chip；缺省 = 无 token）。 */
  cards?: readonly FileTokenCard[];
}

/** notice 块 payload = runtimeEnvCard 装配结果 + 消息时刻。 */
export interface NoticeBlockPayload {
  env: EnvNoticeCard;
  ts?: number;
}

/** tool-media 块 payload = ToolResultCard 的 props（新锚注入整条成卡，插槽伪消息）。 */
export interface ToolMediaBlockPayload {
  /** 插槽 = 伪消息（锚行已剥）过 liftBlocks 的结果（lift 内算好，组件纯展示）。 */
  slot: LiftBlocksResult;
  /** 锚行 `from tool X` 解析出的工具名（缺省回落通用标题）。 */
  tool?: string;
  /** 注入 refs 条数（卡头 meta）。 */
  refCount: number;
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

/**
 * file 块视 = null（图片内嵌气泡精炼 D3）：token chip 在气泡内原位、剩余 refs
 * 在气泡尾部，全由 InlineText 渲染；liftBlocks 已把 file 块分流到 result.inline，
 * 正常路径到不了这里 —— 注册表 component 槽保留只为 lift 注册完整性。
 */
function FileBlockView(_props: { payload: FileBlockPayload; render: BlockRenderCtx }) {
  return null;
}

function NoticeBlockView({ payload }: { payload: NoticeBlockPayload; render: BlockRenderCtx }) {
  return <EnvCard env={payload.env} ts={payload.ts} />;
}

/** tool-media 块视 = ToolResultCard 薄适配（新锚注入；legacy image 块视不动）。 */
function ToolResultCardView({
  payload,
}: {
  payload: ToolMediaBlockPayload;
  render: BlockRenderCtx;
}) {
  return (
    <ToolResultCard
      slot={payload.slot}
      tool={payload.tool}
      refCount={payload.refCount}
      ts={payload.ts}
    />
  );
}

/**
 * vessel-block 试点（块 P1）：payload → markdown 文本 → 既有 Markdown 组件
 * （原生 table：滚动 + 复制全复用，不造独立卡）。fence 原文即模型侧投影，
 * 可见性对等天然满足（blocks.md §5）。
 */
function VesselBlockView({
  payload,
  render,
}: {
  payload: VesselBlockPayload;
  render: BlockRenderCtx;
}) {
  return <Markdown text={vesselBlockMarkdown(payload)} className={render.className} />;
}

export const blockViews = {
  quote: QuoteBlockView,
  'session-ref': SessionRefBlockView,
  image: ToolImageCardView,
  'tool-media': ToolResultCardView,
  file: FileBlockView,
  notice: NoticeBlockView,
  'vessel-block': VesselBlockView,
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
