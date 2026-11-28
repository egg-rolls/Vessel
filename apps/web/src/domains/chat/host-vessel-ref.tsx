/**
 * 宿主原生 vessel-ref link 渲染器（图片内嵌气泡精炼裁示③）：助手 / AI 正文
 * Markdown 里的 `[name](<vessel-ref:path>)` 由宿主接管 —— LinkInline 先查宿主
 * 再查插件 ⇒ 插件禁用不露原文，插件 bundle 零改动。
 *
 * 形态 = InlineRefChip（与用户气泡内联 chip 同形）：有字节点击开同形大图
 * （ImageLightbox 带路径行 + 复制），无字节点击复制路径 —— 插件 FileRefLinkCard
 * 的「点击复制」升级为可见性对等。助手侧无结构化 refs ⇒ path 寻址预览
 * （useAttachmentPreview，经缓存去重 + 视口懒加载）。
 *
 * 注册在本模块加载时完成（与 lift-blocks 宿主 block type 同一模式）；
 * lift-blocks import 本模块 ⇒ 所有转录消费点启动即注册。
 */
import { registerHostLinkEnhancer } from '../../components/link-enhancers';
import { pathBasename } from './file-token';
import { InlineRefChip } from './InlineRefChip';

const SCHEME_PREFIX = 'vessel-ref:';

function HostVesselRefLink({ href, text }: { href: string; text: string }) {
  const path = href.startsWith(SCHEME_PREFIX) ? href.slice(SCHEME_PREFIX.length) : '';
  // 空 path 不成 chip（与 InlineText / liftFileTokens 同口径）：原文可见。
  if (path.length === 0) return <>{text}</>;
  return <InlineRefChip card={{ name: text.trim() || pathBasename(path), path }} />;
}

registerHostLinkEnhancer('vessel-ref', HostVesselRefLink);
