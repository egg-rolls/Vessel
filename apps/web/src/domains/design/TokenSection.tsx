/**
 * Token 展区：**全部条目由 tokens.ts 自动枚举**驱动，本文件不认识任何具体 token 名。
 *
 * 颜色类并排给两个色块（左 = 当前主题，右 = 强制暗色采样），其余按种类给对应的
 * 可视化（圆角 / 阴影 / 间距 / 字号 / 字体 / 动效 / 尺寸 / 层级）。
 */
import { Badge, SearchInput } from '@vessel-agent/plugin-ui';
import { useMemo, useState } from 'react';
import { t } from '../../i18n';
import {
  formatTokenValue,
  type TokenCatalog,
  type TokenGroup,
  type TokenKind,
  type TokenValues,
} from './tokens';

const CARD = 'flex w-44 min-w-0 flex-col gap-1.5 rounded-sm bg-sunken p-2';
const CARD_WIDE = 'flex min-w-0 flex-col gap-1.5 rounded-sm bg-sunken p-2';
const NAME = 'truncate font-mono text-xs text-ink';
const VALUE = 'truncate font-mono text-2xs text-faint';

function swatchBackground(value: string): string | undefined {
  return value === '—' ? undefined : value;
}

/** 颜色：左当前主题 / 右强制暗色。 */
function ColorCard({ name, value, dark }: { name: string; value: string; dark: string }) {
  return (
    <div className={CARD}>
      <div className="flex gap-1.5">
        <span
          aria-hidden="true"
          className="h-8 min-w-0 flex-1 rounded-xs shadow-elev-inset"
          style={{ background: swatchBackground(value) }}
        />
        <span
          aria-hidden="true"
          className="h-8 min-w-0 flex-1 rounded-xs border border-line shadow-elev-inset"
          style={{ background: swatchBackground(dark) }}
        />
      </div>
      <span className={NAME} title={name}>
        {name}
      </span>
      <span className={VALUE} title={value}>
        {value}
      </span>
      <span className={VALUE} title={dark}>
        {dark}
      </span>
    </div>
  );
}

function TokenCard({
  kind,
  name,
  value,
  dark,
}: {
  kind: TokenKind;
  name: string;
  value: string;
  dark: string;
}) {
  if (kind === 'color') return <ColorCard name={name} value={value} dark={dark} />;

  if (kind === 'radius' || kind === 'shadow') {
    return (
      <div className={CARD}>
        <span
          aria-hidden="true"
          className={kind === 'radius' ? 'size-12 bg-accent-soft' : 'size-12 bg-raised'}
          style={
            kind === 'radius'
              ? { borderRadius: value === '—' ? undefined : value }
              : { boxShadow: value === '—' ? undefined : value }
          }
        />
        <span className={NAME} title={name}>
          {name}
        </span>
        <span className={VALUE} title={value}>
          {value}
        </span>
      </div>
    );
  }

  if (kind === 'space') {
    return (
      <div className={CARD_WIDE}>
        <span className="flex items-center gap-2.5 overflow-hidden">
          <span
            aria-hidden="true"
            className="h-2 max-w-full flex-none rounded-full bg-accent"
            style={{ width: value === '—' ? undefined : value }}
          />
          <span className={NAME} title={name}>
            {name}
          </span>
        </span>
        <span className={VALUE} title={value}>
          {value}
        </span>
      </div>
    );
  }

  if (kind === 'type' || kind === 'font') {
    return (
      <div className={CARD_WIDE}>
        <span
          className="truncate text-ink"
          style={
            kind === 'type'
              ? { fontSize: value === '—' ? undefined : value }
              : { fontFamily: value === '—' ? undefined : value }
          }
        >
          {t('designLab.tokens.typeSample')}
        </span>
        <span className="font-mono text-2xs text-faint" title={value}>
          {name} · {value}
        </span>
      </div>
    );
  }

  // 动效 / 尺寸 / 层级 / 兜底：只有名字与值（宽度类 token 画条没有意义）。
  return (
    <div className={CARD_WIDE}>
      <span className={NAME} title={name}>
        {name}
      </span>
      <span className="break-all font-mono text-2xs text-faint">{value}</span>
    </div>
  );
}

function matchesNeedle(
  name: string,
  values: TokenValues,
  darkValues: TokenValues,
  needle: string,
): boolean {
  if (needle === '') return true;
  if (name.toLowerCase().includes(needle)) return true;
  if ((values[name] ?? '').toLowerCase().includes(needle)) return true;
  return (darkValues[name] ?? '').toLowerCase().includes(needle);
}

function TokenGroupBlock({
  group,
  values,
  darkValues,
  needle,
}: {
  group: TokenGroup;
  values: TokenValues;
  darkValues: TokenValues;
  needle: string;
}) {
  const tokens = group.tokens.filter((name) => matchesNeedle(name, values, darkValues, needle));
  if (tokens.length === 0) return null;
  const stacked = group.kind !== 'color' && group.kind !== 'radius' && group.kind !== 'shadow';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-md font-semibold text-ink">{t(group.titleKey)}</h3>
        <span className="font-mono text-2xs text-faint">
          {t('designLab.tokens.count', { count: tokens.length })}
        </span>
      </div>
      <div className={stacked ? 'flex flex-col gap-2' : 'flex flex-wrap gap-2'}>
        {tokens.map((name) => (
          <TokenCard
            key={name}
            kind={group.kind}
            name={name}
            value={formatTokenValue(group.kind, values[name])}
            dark={formatTokenValue(group.kind, darkValues[name])}
          />
        ))}
      </div>
    </div>
  );
}

/** Tokens 区：运行时枚举 :root 上的自定义属性，按前缀规则分组。 */
export function TokenSection({ catalog }: { catalog: TokenCatalog }) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const groups = useMemo(
    () =>
      catalog.groups
        .map((group) => ({
          group,
          visible: group.tokens.some((name) =>
            matchesNeedle(name, catalog.values, catalog.darkValues, needle),
          ),
        }))
        .filter((entry) => entry.visible)
        .map((entry) => entry.group),
    [catalog, needle],
  );

  return (
    <section className="flex flex-col gap-5" aria-labelledby="design-lab-tokens">
      <div className="flex flex-col gap-1.5">
        <h2 id="design-lab-tokens" className="font-serif text-xl leading-snug text-ink">
          {t('designLab.tokens.title')}
        </h2>
        <p className="max-w-prose text-md leading-normal text-muted">
          {t('designLab.tokens.subtitle')}
        </p>
        <p className="max-w-prose text-sm leading-normal text-muted">
          {t('designLab.tokens.autoNote')}
        </p>
        <p className="max-w-prose font-mono text-2xs leading-normal text-faint">
          {t('designLab.tokens.runtimeNote')}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('designLab.tokens.filterPlaceholder')}
            ariaLabel={t('designLab.tokens.filter')}
            className="grow basis-60 max-w-search"
          />
          <Badge tone="neutral">{t('designLab.tokens.count', { count: catalog.total })}</Badge>
        </div>
        <p className="font-mono text-2xs leading-normal text-faint">
          {t('designLab.tokens.legend')}
        </p>
      </div>

      {groups.length === 0 ? (
        <p className="text-md text-muted">{t('designLab.tokens.filterEmpty')}</p>
      ) : (
        groups.map((group) => (
          <TokenGroupBlock
            key={group.id}
            group={group}
            values={catalog.values}
            darkValues={catalog.darkValues}
            needle={needle}
          />
        ))
      )}
    </section>
  );
}
