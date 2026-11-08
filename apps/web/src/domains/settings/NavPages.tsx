/** 从 Settings 拆出的两个顶层页面：Capabilities / Visual。 */
import { t, useLocale } from '../../i18n';
import { AppearanceView } from './AppearanceView';
import { CapabilitiesView } from './CapabilitiesView';
import { DisplaySettingsView } from './DisplaySettingsView';
import { PageFrame } from './PageFrame';

export function CapabilitiesPage() {
  useLocale();
  return (
    <PageFrame title={t('nav.domain.capabilities')} subtitle={t('capabilities.subtitle')}>
      <CapabilitiesView />
    </PageFrame>
  );
}

export function VisualPage() {
  useLocale();
  return (
    <PageFrame title={t('nav.domain.visual')} subtitle={t('visual.subtitle')}>
      <AppearanceView />
      <DisplaySettingsView />
    </PageFrame>
  );
}
