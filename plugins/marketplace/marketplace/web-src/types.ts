/**
 * Wire DTOs for the marketplace RPCs (CONTRACT-0.43 §3.2.1 / CONTRACT-0.44).
 * Kept structural: the child process is the source of truth, the UI only reads.
 */

export type InstallScope = 'user' | 'project';

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
  installed_version?: string;
  update_available?: boolean;
}

export interface SearchResult {
  registry?: RegistryMeta;
  items: SearchItem[];
  total: number;
  categories: string[];
}

export interface InstalledVersion {
  id: string;
  version: string;
  scope: InstallScope;
  path: string;
  enabled: boolean;
}

export interface InstalledItem extends InstalledVersion {
  name: string;
  latest?: string;
  update_available?: boolean;
  engines?: { vessel?: string };
}

export interface InstalledResult {
  registry?: RegistryMeta;
  registry_error?: string;
  items: InstalledItem[];
  total: number;
}

export interface DetailResult {
  registry?: RegistryMeta;
  plugin: RegistryPlugin;
  installed?: InstalledVersion;
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
