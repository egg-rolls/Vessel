/**
 * 气泡内轻量内联渲染器（图片内嵌气泡精炼 D1）：纯文本 + 内联 chip 混排，
 * **不经 Markdown 解释**（ADR-061 / blocks.md §3.2 纯文本裁定不变：人手星号 /
 * 井号逐字保留）。文本段原样输出（气泡容器 pre-wrap）；原子 token 段按 scheme 分流：
 * - `vessel-ref` → 宿主原生 InlineRefChip（插件禁用不露原文）；与结构化 refs
 *   按 path occurrence 消费 matchFileTokens 结果（继承 sha256 / delivery，
 *   镜像 composer refsToAttachmentsFiltered）；无匹配 ref 的 token 走 path 预览；
 * - 其他已注册 scheme → useLinkEnhancer 查插件卡，未命中 → 原文；
 * - 半截 token / 未注册 scheme → 分段核心原样留作文本（流式逐字不闪）。
 *
 * 零第二解析器：分段 = RichComposer.segmentByKnownSchemes（composer 同一核心）；
 * scheme 集 = 宿主 vessel-ref ∪ 已注册 atomicSchemes ∪ link-enhancers。
 * 剩余 refs（未被 token 消费）→ 气泡内尾部内联 chip 行（裁示①）。
 */
import { useMemo } from 'react';
import { useLinkEnhancer, useLinkEnhancerSchemes } from '../../components/link-enhancers';
import { type Segment, segmentByKnownSchemes } from '../../components/ui/RichComposer';
import { occurrenceKeys } from '../../text';
import { useComposerExtensions } from '../plugins/composer-extensions';
import { type FileTokenCard, type FileTokenMatch, pathBasename } from './file-token';
import { InlineRefChip } from './InlineRefChip';
import { refDisplayName } from './MessageRefs';

/** 宿主原生接管的 scheme（裁示③：插件 bundle 零改动 + 禁用不露原文）。 */
const HOST_SCHEME = 'vessel-ref';

/** 非 vessel-ref 原子段：查插件 link 增强器；未命中原文（不导航、不解释）。 */
function PluginInlineSegment({ segment }: { segment: Extract<Segment, { type: 'atomic' }> }) {
  const href = `${segment.scheme}:${segment.target}`;
  const entry = useLinkEnhancer(href);
  if (entry === undefined) return <>{segment.token}</>;
  const Component = entry.component;
  return <Component href={href} text={segment.name} host={entry.host} />;
}

export function InlineText({ text, match }: { text: string; match?: FileTokenMatch }) {
  const { atomicSchemes } = useComposerExtensions();
  const linkSchemes = useLinkEnhancerSchemes();
  const known = useMemo(() => {
    const set = new Set<string>([HOST_SCHEME]);
    for (const entry of atomicSchemes) set.add(entry.scheme);
    for (const scheme of linkSchemes) set.add(scheme);
    return set;
  }, [atomicSchemes, linkSchemes]);

  const cards = match?.cards ?? [];
  const parts = useMemo(() => {
    const segments = segmentByKnownSchemes(text, known);
    // token ↔ ref 按 path occurrence 消费（与 matchFileTokens 同序同口径）。
    const consumed = new Set<number>();
    return segments.map((segment, index) => {
      if (segment.type === 'text') return <span key={index}>{segment.text}</span>;
      if (segment.scheme !== HOST_SCHEME) {
        return <PluginInlineSegment key={index} segment={segment} />;
      }
      // 空 path token 不成 chip（镜像 liftFileTokens：原文保留）。
      if (segment.target.length === 0) return <span key={index}>{segment.token}</span>;
      const cardIndex = cards.findIndex(
        (card, i) => !consumed.has(i) && card.path === segment.target,
      );
      const matched = cardIndex >= 0 ? cards[cardIndex] : undefined;
      const card: FileTokenCard = matched ?? {
        name: segment.name.trim() || pathBasename(segment.target),
        path: segment.target,
      };
      if (matched !== undefined) consumed.add(cardIndex);
      return <InlineRefChip key={index} card={card} />;
    });
  }, [text, known, cards]);

  const tailRefs = match?.refs ?? [];
  const tailKeys = occurrenceKeys(tailRefs.map((ref) => ref.path));
  return (
    <>
      {parts}
      {tailRefs.length > 0 && (
        <span className="inline-ref-tail">
          {tailRefs.map((ref, index) => (
            <InlineRefChip
              key={tailKeys[index] ?? `${ref.path}#${index}`}
              card={{
                name: refDisplayName(ref),
                path: ref.path,
                ref,
                ...(match?.imageDelivery?.[index] !== undefined
                  ? { delivery: match.imageDelivery[index] }
                  : {}),
              }}
            />
          ))}
        </span>
      )}
    </>
  );
}
