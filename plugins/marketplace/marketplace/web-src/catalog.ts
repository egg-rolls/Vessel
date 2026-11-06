/**
 * Pure join of the host plugin catalog (`vessel.catalog`) with the registry
 * update lookup (`updates` RPC). CONTRACT-0.47 §4: the installed version comes
 * from the catalog; the child only supplies registry `latest` values.
 */

import { compareVersionStrings } from '../src/semver.js';
import type { CatalogItem, CatalogRow, UpdatesResult } from './types';

export function mergeCatalogRows(
  catalog: readonly CatalogItem[],
  updates: UpdatesResult | null,
): CatalogRow[] {
  const byId = new Map((updates?.items ?? []).map((item) => [item.id, item]));
  return catalog.map((item) => {
    const update = byId.get(item.id);
    const latest = update?.latest;
    const derived = latest !== undefined && compareVersionStrings(latest, item.version) > 0;
    return {
      ...item,
      ...(latest !== undefined ? { latest } : {}),
      ...(update?.update_available !== undefined || latest !== undefined
        ? { update_available: update?.update_available ?? derived }
        : {}),
    };
  });
}
