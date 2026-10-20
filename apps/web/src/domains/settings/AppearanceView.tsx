import { useEffect, useState } from 'react';
import { SegmentedTabs } from '../../components/Tabs';
import { SUPPORTED_LOCALES, setLocale, t, useLocale } from '../../i18n';
import { applyTheme, readStoredTheme, storeTheme, THEMES, type Theme } from '../../state/theme';

/** Settings → Appearance：主题 / 动效 / 界面语言；动效只跟随系统 reduced-motion。 */
export function AppearanceView() {
  const locale = useLocale();
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme(localStorage));

  useEffect(() => {
    applyTheme(theme);
    storeTheme(theme, localStorage);
  }, [theme]);

  const themeTabs = THEMES.map(({ id }) => ({ id, label: t(`appearance.theme.${id}`) }));
  const languageTabs = SUPPORTED_LOCALES.map(({ id, labelKey }) => ({
    id,
    label: t(labelKey),
  }));

  return (
    <div className="settings-section">
      <section className="panel">
        <h2 className="section-title">{t('appearance.theme.title')}</h2>
        <p className="section-desc">{t('appearance.theme.desc')}</p>
        <SegmentedTabs
          label={t('appearance.theme.title')}
          tabs={themeTabs}
          value={theme}
          onChange={setTheme}
        />
      </section>
      <section className="panel">
        <h2 className="section-title">{t('appearance.language.title')}</h2>
        <p className="section-desc">{t('appearance.language.desc')}</p>
        <SegmentedTabs
          label={t('appearance.language.title')}
          tabs={languageTabs}
          value={locale}
          onChange={setLocale}
        />
      </section>
      <section className="panel">
        <h2 className="section-title">{t('appearance.motion.title')}</h2>
        <p className="section-desc">{t('appearance.motion.desc')}</p>
      </section>
    </div>
  );
}
