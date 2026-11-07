/**
 * Persisted tenant event reader for the Usage plugin.
 *
 * Source of truth is the trace written by the host. 0.49 T2 root layout is
 * `<dataDir>/events/<run>.jsonl`; pre-migration legacy layout is
 * `<dataDir>/tenants/<tenant>/events/<run>.jsonl`. This module is read-only;
 * it never creates, appends, or deletes files.
 *
 * Parsed files are cached per path and invalidated by `(mtimeMs, size)`, so
 * repeated RPCs (logs pagination, tab switches) do not re-read the whole
 * history. Corrupt lines and unreadable files are skipped, matching the
 * `readTraceEvents` behaviour in core.
 *
 * @module @vessel-agent/plugin-usage
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveSingleTenantPaths } from '@vessel-agent/core';

/** Settings handed to the plugin in `plugin.activate`. */
export interface Settings {
  /** Model id -> USD per 1M tokens. */
  prices: Record<string, Price>;
  /** Overrides the model parsed from the Self Card when set. */
  default_model?: string;
}

/** One model's price table. All rates are USD per 1M tokens. */
export interface Price {
  input_per_1m: number;
  output_per_1m: number;
  cache_read_per_1m: number;
  cache_write_per_1m: number;
}

/** A parsed line from a tenant event log. */
export interface RawEvent {
  type: string;
  ts: number;
  run_id: string;
  tenant: string;
  /** 1-based line number inside the file; used when `seq` is missing. */
  line: number;
  seq?: number;
  data: Record<string, unknown>;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  events: RawEvent[];
}

interface ParsedSettings {
  ok: boolean;
  settings: Settings;
  error?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parsePrice(model: string, value: unknown): Price | string {
  if (!isRecord(value)) return `prices.${model} must be an object`;
  const input = value.input_per_1m;
  const output = value.output_per_1m;
  const cacheRead = value.cache_read_per_1m;
  const cacheWrite = value.cache_write_per_1m;
  if (!finiteNonNegative(input)) {
    return `prices.${model}.input_per_1m must be a non-negative number`;
  }
  if (!finiteNonNegative(output)) {
    return `prices.${model}.output_per_1m must be a non-negative number`;
  }
  if (!finiteNonNegative(cacheRead)) {
    return `prices.${model}.cache_read_per_1m must be a non-negative number`;
  }
  if (!finiteNonNegative(cacheWrite)) {
    return `prices.${model}.cache_write_per_1m must be a non-negative number`;
  }
  return {
    input_per_1m: input,
    output_per_1m: output,
    cache_read_per_1m: cacheRead,
    cache_write_per_1m: cacheWrite,
  };
}

/**
 * Validate `plugin.activate.settings`.
 *
 * Fail-closed: a malformed `prices` table rejects activation instead of
 * silently rendering a cost that the user did not configure. Absent settings
 * are valid and yield an empty price table.
 */
export function parseSettings(raw: unknown): ParsedSettings {
  if (raw === undefined || raw === null) return { ok: true, settings: { prices: {} } };
  if (!isRecord(raw))
    return { ok: false, settings: { prices: {} }, error: 'settings must be an object' };

  const prices: Record<string, Price> = {};
  if (raw.prices !== undefined) {
    if (!isRecord(raw.prices)) {
      return { ok: false, settings: { prices: {} }, error: 'prices must be an object' };
    }
    for (const [model, value] of Object.entries(raw.prices)) {
      if (model.length === 0) {
        return { ok: false, settings: { prices: {} }, error: 'prices keys must be non-empty' };
      }
      const price = parsePrice(model, value);
      if (typeof price === 'string') {
        return { ok: false, settings: { prices: {} }, error: price };
      }
      prices[model] = price;
    }
  }

  let defaultModel: string | undefined;
  if (raw.default_model !== undefined) {
    if (typeof raw.default_model !== 'string' || raw.default_model.length === 0) {
      return {
        ok: false,
        settings: { prices: {} },
        error: 'default_model must be a non-empty string',
      };
    }
    defaultModel = raw.default_model;
  }

  return {
    ok: true,
    settings: {
      prices,
      ...(defaultModel !== undefined ? { default_model: defaultModel } : {}),
    },
  };
}

/** Tenant ids become path segments; reject anything that can escape the root. */
export function isSafeTenantId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '.' && value !== '..';
}

/**
 * 0.49 T2：marker 或根 `events/` 存在即视为已迁移到单公司根布局。
 * 与宿主 C3 判定同口径；插件只读，不迁移。
 */
async function hasRootLayout(dataDir: string): Promise<boolean> {
  try {
    await stat(join(dataDir, '.layout.json'));
    return true;
  } catch {
    // marker 缺失时看根 events/（C3.4 收养旧写入）
  }
  try {
    return (await stat(join(dataDir, 'events'))).isDirectory();
  } catch {
    return false;
  }
}

/** 根布局的单公司 id：`tenant.json.tenant_id` → marker `source_tenant`。 */
async function readRootTenantId(dataDir: string): Promise<string | undefined> {
  const candidates: Array<[string, string]> = [
    ['tenant.json', 'tenant_id'],
    ['.layout.json', 'source_tenant'],
  ];
  for (const [file, key] of candidates) {
    try {
      const raw: unknown = JSON.parse(await readFile(join(dataDir, file), 'utf8'));
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === 'string' && isSafeTenantId(value)) return value;
    } catch {
      // 缺文件/损坏：继续下一个来源
    }
  }
  return undefined;
}

function parseLine(line: string, tenant: string, lineNumber: number): RawEvent | undefined {
  if (line.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.type !== 'string' || parsed.type.length === 0) return undefined;
  if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) return undefined;

  const data = isRecord(parsed.data) ? parsed.data : {};
  const runId =
    typeof parsed.run_id === 'string' && parsed.run_id.length > 0
      ? parsed.run_id
      : typeof data.run_id === 'string' && data.run_id.length > 0
        ? data.run_id
        : undefined;
  if (runId === undefined) return undefined;

  const seq =
    typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : undefined;
  return {
    type: parsed.type,
    ts: parsed.ts,
    run_id: runId,
    tenant,
    line: lineNumber,
    ...(seq !== undefined ? { seq } : {}),
    data,
  };
}

/**
 * Read-only event store. One instance per activation; the cache is dropped
 * when the host activates the plugin in a different data directory.
 */
export class EventStore {
  private readonly cache = new Map<string, CachedFile>();

  /** Drop cached files (called on activate/deactivate). */
  reset(): void {
    this.cache.clear();
  }

  /**
   * Tenant ids to read. 0.49 T2 root layout → the single company id
   * (`tenant.json` / marker; fallback `default`); legacy → `<dataDir>/tenants/*`.
   */
  async listTenants(dataDir: string): Promise<string[]> {
    if (await hasRootLayout(dataDir)) {
      return [(await readRootTenantId(dataDir)) ?? 'default'];
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(join(dataDir, 'tenants'), { withFileTypes: true });
    } catch {
      return [];
    }
    const tenants: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isSafeTenantId(entry.name)) continue;
      tenants.push(entry.name);
    }
    tenants.sort((a, b) => a.localeCompare(b));
    return tenants;
  }

  /** Load events from all `events/*.jsonl` files; root or legacy layout. */
  async loadTenant(dataDir: string, tenant: string): Promise<RawEvent[]> {
    const dir = (await hasRootLayout(dataDir))
      ? resolveSingleTenantPaths(dataDir).events_dir
      : join(dataDir, 'tenants', tenant, 'events');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }

    const events: RawEvent[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (!name.endsWith('.jsonl') || name.startsWith('.')) continue;
      const parsed = await this.loadFile(join(dir, name), tenant);
      if (parsed.length > 0) events.push(...parsed);
    }
    return events;
  }

  private async loadFile(path: string, tenant: string): Promise<RawEvent[]> {
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(path);
    } catch {
      this.cache.delete(path);
      return [];
    }

    const cached = this.cache.get(path);
    if (
      cached !== undefined &&
      cached.mtimeMs === fileStat.mtimeMs &&
      cached.size === fileStat.size
    ) {
      return cached.events;
    }

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return [];
    }

    const events: RawEvent[] = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) continue;
      const event = parseLine(line, tenant, index + 1);
      if (event !== undefined) events.push(event);
    }

    this.cache.set(path, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, events });
    return events;
  }
}
