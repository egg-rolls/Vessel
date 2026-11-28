/**
 * 工具附件结果卡（q-tool-card-slot P0）：新锚 `[tool media] ` 注入消息的结构化呈现。
 *
 * 与 legacy ToolImageCard（旧 `[tool image]` 前缀，冻结不删不改）的分工：
 * 新消息 → 本卡；旧消息 → legacy 卡（历史双认永久，message-invariants §2）。
 *
 * **内容插槽 = 消息侧同一管线，零新解析器**（设计稿 §2.1）：锚行剥掉后，剩余
 * content + refs + image_delivery 组成伪消息 `{role:'user',content,refs,image_delivery}`
 * 过 liftBlocks（在 tool-media lift 内完成，本组件纯展示）—— token 认 file-token.ts
 * （matchFileTokens 按 occurrence 配 ref + 投递状态），fence 认 vessel-block.ts，
 * 块渲染认 block-registry（MessageBlocks）。剩余 body 按 role:'user' 走 InlineText
 * （与用户气泡同形：token 原位 chip，**delivery 三态 chip 经 matchFileTokens 继承**，
 * 可见性对等）；Markdown body 渲染器属 P2 MessageContentSurface 按 role 分档，
 * 本批不引入第二套正文渲染。
 *
 * 表面 = StreamCard（与 ToolCard / AsyncJobCard 同基座）：卡头 title = 工具名
 * （锚行 `from tool X`，裁示②），meta = 条数 + 时刻；展开体 = 插槽。
 * 取值 / 点击 / 放大 / PDF 预览全在 InlineRefChip → useRefPreview 共享逻辑体
 * （PDF isPdf 路径不回归）；本组件不持任何取值接线。
 */
import { formatClock } from '../../format';
import { t } from '../../i18n';
import { MessageBlocks } from './block-views';
import { InlineText } from './InlineText';
import type { LiftBlocksResult } from './lift-blocks';
import { StreamCard } from './StreamCard';

export function ToolResultCard({
  slot,
  tool,
  refCount,
  ts,
}: {
  /** 插槽 = 伪消息过 liftBlocks 的结果（tool-media lift 内算好，纯展示消费）。 */
  slot: LiftBlocksResult;
  /** 锚行解析出的工具名（`from tool X`）；缺省回落通用标题。 */
  tool?: string;
  /** 注入 refs 条数（卡头 meta；投递状态已在 slot.inline 的卡上）。 */
  refCount: number;
  ts?: number;
}) {
  const clock = formatClock(ts);
  const countText = t('chat.toolMedia.count', { count: refCount });
  const meta = clock !== '' ? `${countText} · ${clock}` : countText;
  return (
    <StreamCard
      className="tool-result-card"
      title={tool ?? t('chat.toolMedia.title')}
      meta={meta}
      defaultOpen
      ariaLabel={t('chat.toolMedia.group')}
    >
      <MessageBlocks blocks={slot.blocks} />
      {(slot.body.length > 0 || (slot.inline?.refs.length ?? 0) > 0) && (
        <InlineText text={slot.body} match={slot.inline} />
      )}
    </StreamCard>
  );
}
