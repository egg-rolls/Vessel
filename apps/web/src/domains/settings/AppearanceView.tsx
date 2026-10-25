import { useEffect, useState } from 'react';
import { SegmentedTabs } from '../../components/Tabs';
import { Section } from '../../components/ui';
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
    <div className="flex flex-col gap-6">
      <Section title={t('appearance.theme.title')} description={t('appearance.theme.desc')}>
        <SegmentedTabs
          label={t('appearance.theme.title')}
          tabs={themeTabs}
          value={theme}
          onChange={setTheme}
        />
      </Section>
      <Section title={t('appearance.language.title')} description={t('appearance.language.desc')}>
        <SegmentedTabs
          label={t('appearance.language.title')}
          tabs={languageTabs}
          value={locale}
          onChange={setLocale}
        />
      </Section>
      <Section title={t('appearance.motion.title')} description={t('appearance.motion.desc')} />
    </div>
  );
}
