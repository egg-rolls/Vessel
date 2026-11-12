/**
 * 圆点 / 状态语义图例：四档语义（已连接 / 进行中 / 出错 / 未配置）与颜色 token 的对照表。
 *
 * 一致性靠「不复制事实」保证：
 * - 行的清单来自 `NAV_STATUS_TONES`（app/nav-status.ts 的**运行时数组**）：新增一档
 *   自动多一行，本文件不用改；
 * - 文案来自 hubNavStatus(...) 的 labelKey（app/nav-status.ts 是唯一事实源）；
 * - 圆点由 NavItem 自己渲染（data-tone 决定颜色，见 app/NavItem.tsx 第 60 行）；
 * - 「tone → token 名」与「tone → 代表状态」两张表都是 `Record<NavStatusTone, …>`：
 *   新增一档 tone 时缺键即编译报错，不会静默漂移。
 */

import { NavItem } from '../../../../app/NavItem';
import type { NavItemModel } from '../../../../app/nav-model';
import { hubNavStatus, NAV_STATUS_TONES, type NavStatusTone } from '../../../../app/nav-status';
import type { HubNavStatus } from '../../../../gateway/platform/hub-storage';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';
import { useTokenCatalog } from '../../tokens';

export const preview: PreviewMeta = {
  title: 'NavStatusDot',
  descriptionKey: 'designLab.preview.navStatus.desc',
  group: 'nav',
  order: 20,
};

/**
 * 每档 tone 取一个代表状态，好让原本文案仍由 hubNavStatus() 产出。
 * 这张表是 `Record<NavStatusTone, …>` ⇒ 新增 tone 时缺键就编译报错。
 */
const TONE_SAMPLE_STATUS: Readonly<Record<NavStatusTone, HubNavStatus>> = {
  accent: 'connected',
  amber: 'loading',
  danger: 'unauthorized',
  muted: 'unconfigured',
};

/** tone → 颜色 token（唯一一张对照表；值本身仍从 :root 运行时读取）。 */
const TONE_TOKENS: Readonly<Record<NavStatusTone, string>> = {
  accent: '--accent',
  amber: '--amber',
  danger: '--danger',
  muted: '--faint',
};

const ROUTE: NavItemModel['route'] = { domain: 'hub' };
const NOOP_NAVIGATE = (_route: NavItemModel['route']): void => undefined;

export default function NavStatusLegendPreview() {
  const catalog = useTokenCatalog();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 px-2 font-mono text-2xs uppercase tracking-wider text-faint">
        <span className="w-56 flex-none">{t('designLab.preview.navStatus.colStatus')}</span>
        <span className="w-16 flex-none">tone</span>
        <span className="w-24 flex-none">token</span>
        <span className="min-w-0 flex-1">{t('designLab.preview.navStatus.colValue')}</span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {NAV_STATUS_TONES.map((tone) => {
          // 代表状态 → 真值；tone 只用来选代表状态与行序，配色仍以 hubNavStatus 的结果为准
          // （万一代表状态漂了，行里显示的是真 tone，不会撒谎）。
          const meta = hubNavStatus(TONE_SAMPLE_STATUS[tone]);
          const token = TONE_TOKENS[meta.tone];
          const item: NavItemModel = {
            id: `legend:${tone}`,
            title: t(meta.labelKey),
            icon: 'hub',
            route: ROUTE,
            active: false,
            status: meta,
          };
          return (
            <li
              key={tone}
              className="flex flex-wrap items-center gap-3 rounded-sm bg-sunken px-2 py-1.5"
            >
              <span className="w-56 flex-none">
                <NavItem item={item} collapsed={false} onNavigate={NOOP_NAVIGATE} />
              </span>
              <span className="w-16 flex-none font-mono text-2xs text-muted">{meta.tone}</span>
              <span className="w-24 flex-none font-mono text-2xs text-accent-ink">{token}</span>
              <span className="min-w-0 flex-1 font-mono text-2xs text-faint">
                {catalog.values[token] ?? '—'}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="max-w-prose text-sm leading-normal text-muted">
        {t('designLab.preview.navStatus.note')}
      </p>
    </div>
  );
}
