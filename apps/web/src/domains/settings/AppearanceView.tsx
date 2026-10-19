import { useEffect, useState } from 'react';
import { SegmentedTabs } from '../../components/Tabs';

type Theme = 'system' | 'light' | 'dark';

const THEME_KEY = 'vessel.theme';
const THEMES: readonly { id: Theme; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];

function readTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** Settings → Appearance：主题切换；动效只跟随系统 reduced-motion。 */
export function AppearanceView() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  return (
    <div className="settings-section">
      <section className="panel">
        <h2 className="section-title">主题</h2>
        <p className="section-desc">默认跟随系统；手动选择会覆盖 prefers-color-scheme。</p>
        <SegmentedTabs label="主题" tabs={THEMES} value={theme} onChange={setTheme} />
      </section>
      <section className="panel">
        <h2 className="section-title">动效</h2>
        <p className="section-desc">
          动效跟随系统的 prefers-reduced-motion，不提供单独开关。减少动效时抽屉、命令面板与
          状态脉冲都会关闭。
        </p>
      </section>
    </div>
  );
}
