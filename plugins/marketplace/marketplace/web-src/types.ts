/**
 * Wire DTOs for the marketplace RPCs (CONTRACT-0.43 §3.2.1 / CONTRACT-0.44)
 * and the host plugin catalog push (CONTRACT-0.47).
 * Kept structural: the child process / host is the source of truth, the UI only
 * reads.
 */

/** Discovery source in the host catalog. */
export type CatalogScope = 'builtin' | 'user' | 'project' | 'node_modules';

/** `builtin`: ships with the host; `marketplace`: external child plugin;
 * `dynamic`: external in-process plugin. */
export type CatalogKind = 'builtin' | 'marketplace' | 'dynamic';

export type CatalogMode = 'in-process' | 'child';

export type CatalogStatus = 'active' | 'inactive' | 'unhealthy' | 'disabled' | 'invalid';

/** One `PluginCatalogItem` pushed by the host (`vessel.catalog`). */
export interface CatalogItem {
  id: string;
  name: string;
  version: string;
  scope: CatalogScope;
  kind: CatalogKind;
  mode: CatalogMode;
  enabled: boolean;
  supportsToggle: boolean;
  restartRequired: boolean;
  status?: CatalogStatus;
  path: string;
  entry?: string;
  manifest?: unknown;
}

/** `updates` result row: registry latest for one catalog id. */
export interface UpdateItem {
  id: string;
  latest?: string;
  update_available?: boolean;
}

export interface UpdatesResult {
  items: UpdateItem[];
  registry?: RegistryMeta;
  registry_error?: string;
}

/** Catalog row merged with the registry lookup used by the installed views. */
export interface CatalogRow extends CatalogItem {
  latest?: string;
  update_available?: boolean;
}

export interface RegistryPermissions {
  fs?: string[];
  net?: string[];
  process?: boolean;
  secrets?: boolean;
  events?: string[];
  rpc?: string[];
  [key: string]: unknown;
}

export interface RegistryAsset {
  url: string;
  sha256: string;
  size: number;
}

export interface RegistryVersion {
  version: string;
  engines?: { vessel?: string; [key: string]: unknown };
  asset: RegistryAsset;
  permissions?: RegistryPermissions;
  contributes?: Record<string, unknown>;
  published_at?: string;
}

export interface RegistryPlugin {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  category?: string;
  tags?: string[];
  repo?: string;
  homepage?: string;
  latest: string;
  versions: RegistryVersion[];
}

export interface RegistryMeta {
  url: string;
  trusted: boolean;
  stale: boolean;
  fetched_at?: number;
  updated_at?: string;
}

export interface SearchItem {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  category?: string;
  tags?: string[];
  repo?: string;
  homepage?: string;
  latest: string;
  versions_count: number;
}

export interface SearchResult {
  registry?: RegistryMeta;
  items: SearchItem[];
  total: number;
  categories: string[];
}

export interface DetailResult {
  registry?: RegistryMeta;
  plugin: RegistryPlugin;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobError {
  code: string;
  message: string;
}

export interface JobDto {
  job_id: string;
  kind: 'install' | 'update';
  plugin_id: string;
  version?: string;
  status: JobStatus;
  phase: string;
  bytes_done: number;
  bytes_total: number;
  created_at: number;
  updated_at: number;
  error?: JobError;
  result?: unknown;
}

/** `install` / `update` return the new job id, not the final result. */
export interface StartJobResult {
  job_id?: string;
}
