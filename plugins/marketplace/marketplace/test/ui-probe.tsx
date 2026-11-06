/**
 * Marketplace UI probe. No browser and no gateway: the host window is faked,
 * so the `vessel.catalog` push and the catalog-unavailable empty state are
 * exercised directly.
 *
 * Covers CONTRACT-0.47 §6.4:
 *   - `watchHostCatalog` asks the parent once after mounting (first-frame
 *     handshake) and accepts only array `items`;
 *   - a faked `vessel.catalog` push joins with the registry lookup and renders
 *     rows (builtin read-only, `restartRequired` badge);
 *   - an old gateway that never pushes renders the catalog-unavailable state.
 *
 * Run: bun run plugins/marketplace/marketplace/test/ui-probe.ts
 */

import { watchHostCatalog } from '@vessel-agent/plugin-ui';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mergeCatalogRows } from '../web-src/catalog.js';
import { InstalledTable } from '../web-src/components/InstalledTable.js';
import { translator } from '../web-src/i18n.js';
import type { CatalogItem, UpdatesResult } from '../web-src/types.js';
import { InstalledView } from '../web-src/views/InstalledView.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

// ── fake iframe window ──────────────────────────────────────────────────────

type MessageListener = (event: { data: unknown; source?: unknown }) => void;

const posted: Array<Record<string, unknown>> = [];
const listeners = new Set<MessageListener>();
const fakeWindow = {
  parent: {
    postMessage: (message: Record<string, unknown>) => {
      posted.push(message);
    },
  },
  addEventListener: (type: string, listener: MessageListener) => {
    if (type === 'message') listeners.add(listener);
  },
  removeEventListener: (type: string, listener: MessageListener) => {
    if (type === 'message') listeners.delete(listener);
  },
};
Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

function push(message: unknown): void {
  for (const listener of listeners) listener({ data: message });
}

// ── catalog push / handshake ────────────────────────────────────────────────

const catalog: CatalogItem[] = [
  {
    id: 'marketplace',
    name: 'Marketplace',
    version: '0.1.0',
    scope: 'builtin',
    kind: 'builtin',
    mode: 'child',
    enabled: true,
    supportsToggle: true,
    restartRequired: false,
    path: '/repo/plugins/marketplace/marketplace',
  },
  {
    id: 'probe-plugin',
    name: 'Probe plugin',
    version: '1.0.0',
    scope: 'user',
    kind: 'marketplace',
    mode: 'child',
    enabled: false,
    supportsToggle: true,
    restartRequired: true,
    path: '/home/probe/.vessel/plugins/probe-plugin',
  },
];

const received: Array<readonly CatalogItem[]> = [];
const cleanup = watchHostCatalog<CatalogItem>((items) => received.push(items));

check(
  'catalog: mount sends one first-frame request',
  posted.length === 1 && posted[0]?.type === 'vessel.catalog.request',
  JSON.stringify(posted),
);

push({ type: 'vessel.catalog', items: catalog });
check('catalog: receives the pushed items', received.length === 1 && received[0]?.length === 2);

push({ type: 'vessel.catalog', items: 'not-an-array' });
check('catalog: ignores non-array items', received.length === 1);

cleanup();
check('catalog: cleanup removes the listener', listeners.size === 0);

// ── rows: catalog + registry lookup ─────────────────────────────────────────

const updates: UpdatesResult = {
  registry: { url: 'https://example.test/index.json', trusted: true, stale: false },
  items: [{ id: 'probe-plugin', latest: '1.1.0' }],
};
const rows = mergeCatalogRows(catalog, updates);
check(
  'rows: registry latest merged into the catalog row',
  rows.find((row) => row.id === 'probe-plugin')?.latest === '1.1.0' &&
    rows.find((row) => row.id === 'probe-plugin')?.update_available === true,
);
check(
  'rows: builtin has no registry row',
  rows.find((row) => row.id === 'marketplace')?.latest === undefined,
);

const t = translator('en');
const html = renderToStaticMarkup(
  createElement(InstalledTable, {
    items: rows,
    t,
    busy: false,
    pendingId: null,
    onToggle: () => {},
    onUpdate: () => {},
    onRemove: () => {},
  }),
);

check(
  'rows: renders the catalog id and name',
  html.includes('probe-plugin') && html.includes('Probe plugin'),
);
check('rows: renders the merged latest version', html.includes('1.1.0'));
check('rows: shows restartRequired', html.includes('restart to apply'));
check(
  'rows: builtin is read-only (one remove button)',
  (html.match(/Remove/g) ?? []).length === 1,
  String((html.match(/Remove/g) ?? []).length),
);

// ── old gateway: no push → catalog unavailable ──────────────────────────────

const view = renderToStaticMarkup(
  createElement(InstalledView, {
    api: {} as never,
    t,
    busy: false,
    onJob: async () => {},
    catalogAvailable: false,
    rows: [],
    onRefresh: () => {},
    onChanged: () => {},
  }),
);
check(
  'old gateway: renders the catalog-unavailable state',
  view.includes('Plugin catalog unavailable'),
);
check('old gateway: does not render a plugin table', !view.includes('probe-plugin'));

// ── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  throw new Error(`${failed} ui probe checks failed`);
}
