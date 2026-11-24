/**
 * 设计实验室内容（无页面脚手架）：供设置弹窗视觉分区懒加载内嵌 / 全屏复用。
 * token 运行时枚举 + import.meta.glob 预览自动发现机制原样保留（不进首屏 chunk）。
 * 不连 gateway：纯静态样例，弹窗断连时仍可用。
 */
import { useLocale } from '../../i18n';
import { PreviewSection } from './PreviewSection';
import { TokenSection } from './TokenSection';
import { useTokenCatalog } from './tokens';

export function DesignLabContent() {
  useLocale();
  const catalog = useTokenCatalog();
  return (
    <div className="flex flex-col gap-6">
      <TokenSection catalog={catalog} />
      <PreviewSection />
    </div>
  );
}
