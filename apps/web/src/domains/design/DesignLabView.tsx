import { PageScaffold } from '@vessel-agent/plugin-ui';
import { t, useLocale } from '../../i18n';
import { ComponentSection } from './ComponentSection';
import { TokenSection } from './TokenSection';
import { TOKEN_GROUPS, useTokenValues } from './tokens';

/**
 * `#/designLab` — static living reference for host tokens and standard
 * components. It talks to no gateway; all token values are read at runtime.
 */
export function DesignLabView() {
  // Subscribing here re-renders every sample when the locale changes.
  useLocale();
  const values = useTokenValues();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain">
      <PageScaffold title={t('designLab.title')} subtitle={t('designLab.subtitle')}>
        <TokenSection groups={TOKEN_GROUPS} values={values} />
        <ComponentSection />
      </PageScaffold>
    </div>
  );
}
