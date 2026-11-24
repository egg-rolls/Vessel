/** 从 Settings 拆出的顶层页面：Capabilities（Visual 已收敛进设置弹窗，S6）。 */
import { t, useLocale } from '../../i18n';
import { CapabilitiesView } from './CapabilitiesView';
import { PageFrame } from './PageFrame';

export function CapabilitiesPage() {
  useLocale();
  return (
    <PageFrame title={t('nav.domain.capabilities')} subtitle={t('capabilities.subtitle')}>
      <CapabilitiesView />
    </PageFrame>
  );
}
