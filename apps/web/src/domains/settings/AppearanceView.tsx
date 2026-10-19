import { useEffect, useState } from 'react';
import { SegmentedTabs } from '../../components/Tabs';
import { applyTheme, readStoredTheme, storeTheme, THEMES, type Theme } from '../../state/theme';

/** Settings → Appearance：主题切换；动效只跟随系统 reduced-motion。 */
export function AppearanceView() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme(localStorage));

  useEffect(() => {
    applyTheme(theme);
    storeTheme(theme, localStorage);
  }, [theme]);

  return (
    <div className="settings-section">
      <section className="panel">
        <h2 className="section-title">主题</h2>
        <p className="section-desc">
          默认深色；选择跟随系统会使用 prefers-color-scheme，选择会保留到刷新后。
        </p>
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
