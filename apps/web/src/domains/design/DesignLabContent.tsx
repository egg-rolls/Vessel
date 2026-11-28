/**
 * 设计实验室内容（无页面脚手架）：整页 DesignLabView 与设置弹窗视觉分区共用。
 * token 运行时枚举 + import.meta.glob 预览自动发现 + 组件清单（构建期快照）。
 * 不连 gateway：纯静态样例，弹窗断连时仍可用。
 */
import { useLocale } from '../../i18n';
import { ComponentInventorySection } from './ComponentInventorySection';
import { PreviewSection } from './PreviewSection';
import { TokenSection } from './TokenSection';
import { useTokenCatalog } from './tokens';

export function DesignLabContent() {
  useLocale();
  const catalog = useTokenCatalog();
  return (
    <div className="flex flex-col gap-6">
      <TokenSection catalog={catalog} />
      <ComponentInventorySection />
      <PreviewSection />
    </div>
  );
}
