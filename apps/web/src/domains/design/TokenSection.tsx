import { t } from '../../i18n';
import { formatTokenValue, type TokenGroupDef, type TokenKind, type TokenValues } from './tokens';

function TokenCard({ kind, name, value }: { kind: TokenKind; name: string; value: string }) {
  if (kind === 'color') {
    return (
      <div className="flex w-40 min-w-0 flex-col gap-1.5 rounded-sm bg-sunken p-2">
        <span
          aria-hidden="true"
          className="h-8 rounded-xs shadow-elev-inset"
          style={{ background: value === '—' ? undefined : value }}
        />
        <span className="truncate font-mono text-xs text-ink">{name}</span>
        <span className="break-all font-mono text-2xs text-faint">{value}</span>
      </div>
    );
  }

  if (kind === 'radius' || kind === 'shadow') {
    return (
      <div className="flex w-40 min-w-0 flex-col gap-1.5 rounded-sm bg-sunken p-2">
        <span
          aria-hidden="true"
          className={kind === 'radius' ? 'size-12 bg-accent-soft' : 'size-12 bg-raised'}
          style={
            kind === 'radius'
              ? { borderRadius: value === '—' ? undefined : value }
              : { boxShadow: value === '—' ? undefined : value }
          }
        />
        <span className="truncate font-mono text-xs text-ink">{name}</span>
        <span className="break-all font-mono text-2xs text-faint">{value}</span>
      </div>
    );
  }

  if (kind === 'space') {
    return (
      <div className="flex items-center gap-2.5 rounded-sm bg-sunken px-3 py-2">
        <span
          aria-hidden="true"
          className="h-2 flex-none rounded-full bg-accent"
          style={{ width: value === '—' ? undefined : value }}
        />
        <span className="font-mono text-xs text-ink">{name}</span>
        <span className="font-mono text-2xs text-faint">{value}</span>
      </div>
    );
  }

  // Type scale and font stacks: render the token as actual text.
  return (
    <div className="flex flex-col gap-1 rounded-sm bg-sunken px-3 py-2">
      <span
        className="truncate text-ink"
        style={
          kind === 'type' ? { fontSize: value === '—' ? undefined : value } : { fontFamily: value }
        }
      >
        {t('designLab.demo.typeSample')}
      </span>
      <span className="font-mono text-2xs text-faint">
        {name} · {value}
      </span>
    </div>
  );
}

function TokenGroup({ group, values }: { group: TokenGroupDef; values: TokenValues }) {
  const stacked = group.kind === 'type' || group.kind === 'space' || group.kind === 'font';
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-md font-semibold text-ink">{t(group.titleKey)}</h3>
      <div className={stacked ? 'flex flex-col gap-2' : 'flex flex-wrap gap-2'}>
        {group.tokens.map((name) => (
          <TokenCard
            key={name}
            kind={group.kind}
            name={name}
            value={formatTokenValue(group.kind, values[name])}
          />
        ))}
      </div>
    </div>
  );
}

/** Tokens area: live values, read from the current theme. */
export function TokenSection({
  groups,
  values,
}: {
  groups: readonly TokenGroupDef[];
  values: TokenValues;
}) {
  return (
    <section className="flex flex-col gap-5" aria-labelledby="design-lab-tokens">
      <div className="flex flex-col gap-1.5">
        <h2 id="design-lab-tokens" className="font-serif text-xl leading-snug text-ink">
          {t('designLab.tokens.title')}
        </h2>
        <p className="max-w-prose text-md leading-normal text-muted">
          {t('designLab.tokens.subtitle')}
        </p>
        <p className="max-w-prose font-mono text-2xs leading-normal text-faint">
          {t('designLab.tokens.runtimeNote')}
        </p>
      </div>
      {groups.map((group) => (
        <TokenGroup key={group.id} group={group} values={values} />
      ))}
    </section>
  );
}
