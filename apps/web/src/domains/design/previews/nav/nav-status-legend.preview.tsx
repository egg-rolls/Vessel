/**
 * 圆点 / 状态语义图例：四档语义（已连接 / 进行中 / 出错 / 未配置）与颜色 token 的对照表。
 *
 * 一致性靠「不复制事实」保证：
 * - 文案来自 hubNavStatus(...) 的 labelKey（app/nav-status.ts 第 57–75 行是唯一事实源）；
 * - 圆点由 NavItem 自己渲染（data-tone 决定颜色，见 app/NavItem.tsx 第 60 行）；
 * - 这里只维护「tone → token 名」这一张表，值仍从 tokens.ts 的运行时快照读。
 */

import { NavItem } from '../../../../app/NavItem';
import type { NavItemModel } from '../../../../app/nav-model';
import { hubNavStatus, type NavStatusTone } from '../../../../app/nav-status';
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

/** 四档语义（用户口径）：已连接 = accent、进行中 = amber、出错 = danger、未配置 / 未知 = muted。 */
const FOUR_TONES: readonly HubNavStatus[] = [
  'connected',
  'loading',
  'unauthorized',
  'unconfigured',
];

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
        {FOUR_TONES.map((status) => {
          const meta = hubNavStatus(status);
          const token = TONE_TOKENS[meta.tone];
          const item: NavItemModel = {
            id: `legend:${status}`,
            title: t(meta.labelKey),
            icon: 'hub',
            route: ROUTE,
            active: false,
            status: meta,
          };
          return (
            <li
              key={status}
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
