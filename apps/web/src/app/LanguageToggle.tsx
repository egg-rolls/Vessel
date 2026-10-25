import { Button } from '../components/ui';
import { type Locale, setLocale, t, useLocale } from '../i18n';

/** 语言切换只接受两个受支持的 locale，保证反复点击稳定往返。 */
export function toggleLocale(locale: Locale): Locale {
  return locale === 'zh-CN' ? 'en' : 'zh-CN';
}

/** 顶栏紧凑语言切换：显示目标语言，点击立即切换。 */
export function LanguageToggle() {
  const locale = useLocale();
  const next = toggleLocale(locale);
  const target = next === 'en' ? t('appearance.language.en') : t('appearance.language.zh');
  const label = t('language.toggleTo', { language: target });
  const short = next === 'en' ? t('language.short.en') : t('language.short.zh');

  return (
    <Button
      className="min-w-10 flex-none rounded-full font-mono text-xs tracking-wide pointer-coarse:min-h-touch"
      size="small"
      aria-label={label}
      title={label}
      onClick={() => setLocale(next)}
    >
      {short}
    </Button>
  );
}
