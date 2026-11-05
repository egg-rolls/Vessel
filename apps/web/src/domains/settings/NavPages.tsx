/** 从 Settings 拆出的三个顶层页面：Tenants / Capabilities / Visual。 */
import { t, useLocale } from '../../i18n';
import { AppearanceView } from './AppearanceView';
import { CapabilitiesView } from './CapabilitiesView';
import { DisplaySettingsView } from './DisplaySettingsView';
import { PageFrame } from './PageFrame';
import { TenantsView } from './TenantsView';

export function TenantsPage() {
  useLocale();
  return (
    <PageFrame title={t('nav.domain.tenants')}>
      <TenantsView />
    </PageFrame>
  );
}

export function CapabilitiesPage() {
  useLocale();
  return (
    <PageFrame title={t('nav.domain.capabilities')}>
      <CapabilitiesView />
    </PageFrame>
  );
}

export function VisualPage() {
  useLocale();
  return (
    <PageFrame title={t('nav.domain.visual')}>
      <AppearanceView />
      <DisplaySettingsView />
    </PageFrame>
  );
}
