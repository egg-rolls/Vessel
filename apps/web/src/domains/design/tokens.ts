/**
 * Design Lab token catalog.
 *
 * The lab never hard-codes token values: it reads the custom properties from
 * `document.documentElement` at runtime, so the samples follow the active
 * light/dark theme (`data-theme` or `prefers-color-scheme`).
 */
import { useEffect, useState } from 'react';

export type TokenKind = 'color' | 'type' | 'space' | 'radius' | 'shadow' | 'font';

export interface TokenGroupDef {
  id: string;
  /** Literal catalog key so `check-i18n` sees the reference. */
  titleKey: string;
  kind: TokenKind;
  tokens: readonly string[];
}

export const TOKEN_GROUPS: readonly TokenGroupDef[] = [
  {
    id: 'colors',
    titleKey: 'designLab.tokens.colors',
    kind: 'color',
    tokens: [
      '--bg',
      '--surface',
      '--surface-raised',
      '--surface-hover',
      '--surface-sunken',
      '--surface-deep',
      '--ink',
      '--muted',
      '--faint',
      '--line',
      '--line-strong',
      '--accent',
      '--accent-ink',
      '--accent-soft',
      '--ok',
      '--ok-soft',
      '--warn',
      '--warn-soft',
      '--danger',
      '--danger-soft',
      '--info',
      '--info-soft',
    ],
  },
  {
    id: 'type',
    titleKey: 'designLab.tokens.typography',
    kind: 'type',
    tokens: [
      '--size-2xs',
      '--size-xs',
      '--size-sm',
      '--size-md',
      '--size-base',
      '--size-lg',
      '--size-xl',
      '--size-2xl',
      '--text-title',
    ],
  },
  {
    id: 'space',
    titleKey: 'designLab.tokens.spacing',
    kind: 'space',
    tokens: [
      '--space-1',
      '--space-2',
      '--space-3',
      '--space-4',
      '--space-5',
      '--space-6',
      '--space-8',
    ],
  },
  {
    id: 'radius',
    titleKey: 'designLab.tokens.radii',
    kind: 'radius',
    tokens: [
      '--radius-xs',
      '--radius-sm',
      '--radius-md',
      '--radius-lg',
      '--radius-xl',
      '--radius-pill',
    ],
  },
  {
    id: 'shadow',
    titleKey: 'designLab.tokens.shadows',
    kind: 'shadow',
    tokens: ['--elev-1', '--elev-2', '--elev-3', '--elev-4', '--elev-inset'],
  },
  {
    id: 'font',
    titleKey: 'designLab.tokens.fonts',
    kind: 'font',
    tokens: ['--font-sans', '--font-serif', '--font-mono'],
  },
];

export const ALL_TOKEN_NAMES: readonly string[] = TOKEN_GROUPS.flatMap((group) => group.tokens);

export type TokenValues = Readonly<Record<string, string>>;

function readTokenValues(): TokenValues {
  if (typeof document === 'undefined') return {};
  const style = getComputedStyle(document.documentElement);
  const values: Record<string, string> = {};
  for (const name of ALL_TOKEN_NAMES) {
    values[name] = style.getPropertyValue(name).trim();
  }
  return values;
}

/**
 * Reads the token values from the document root and refreshes them whenever
 * the theme attribute or the system color scheme changes.
 */
export function useTokenValues(): TokenValues {
  const [values, setValues] = useState<TokenValues>(readTokenValues);

  useEffect(() => {
    const update = () => setValues(readTokenValues());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    });
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    media?.addEventListener('change', update);
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', update);
    };
  }, []);

  return values;
}

/** Font stacks come back multiline; collapse whitespace for display. */
export function formatTokenValue(kind: TokenKind, raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (value === '') return '—';
  return kind === 'font' ? value.replace(/\s+/g, ' ') : value;
}
