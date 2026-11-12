import { PageScaffold } from '@vessel-agent/plugin-ui';
import { t, useLocale } from '../../i18n';
import { PreviewSection } from './PreviewSection';
import { TokenSection } from './TokenSection';
import { useTokenCatalog } from './tokens';

/**
 * #/designLab —— token 与可复用组件的**自动发现**展览馆。
 *
 * - token：运行时枚举 :root 上实际存在的自定义属性（前缀分组），不手写清单；
 * - 组件 / 弹窗：import.meta.glob 自动收集 src 下所有 preview 文件（加文件即出现，见 preview-registry.ts）；
 * - 页面不连 gateway：所有样例都是静态数据，没有 fetch / rpc 调用点。
 */
export function DesignLabView() {
  // Subscribing here re-renders every sample when the locale changes.
  useLocale();
  const catalog = useTokenCatalog();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain">
      <PageScaffold title={t('designLab.title')} subtitle={t('designLab.subtitle')}>
        <TokenSection catalog={catalog} />
        <PreviewSection />
      </PageScaffold>
    </div>
  );
}
