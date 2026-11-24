/**
 * Skills plugin UI DTO types — mirror of src/rpc.ts results (DTO additive:
 * unknown fields are ignored, new fields never break old clients).
 */

export type SkillSource = 'project' | 'user' | 'library';
export type FrontmatterState = 'ok' | 'partial' | 'none' | 'invalid';
export type TrustState = 'unknown' | 'trusted' | 'stale' | 'revoked';

export interface SkillEntryDto {
  id: string;
  name: string;
  description: string;
  tags: string[];
  version?: string;
  source: SkillSource;
  relPath: string;
  absPath: string;
  format: 'flat' | 'dir';
  auxFiles?: string[];
  bytes: number;
  mtimeMs: number;
  sha256: string;
  frontmatter: FrontmatterState;
  warnings?: string[];
  /** server-derived trust badge (RPC additive field) */
  trust?: TrustState;
}

export interface TrustRecordDto {
  sha256: string;
  recordedAt: string;
  origin: 'local' | 'import' | 'marketplace';
  state: 'trusted' | 'revoked';
}

export interface BusinessError {
  error: { code: string; message: string };
}

export interface ListResult {
  items: SkillEntryDto[];
  total: number;
  generatedAt: string;
}

export interface GetResult extends Partial<BusinessError> {
  entry?: SkillEntryDto;
  content?: string;
  auxFiles?: string[];
  trust?: TrustState;
  trustRecord?: TrustRecordDto;
  truncated?: boolean;
}

export interface SessionLoadDto {
  id: string;
  sha256: string;
  loadedAt: string;
  runId: string;
}

export interface SessionLoadsDto {
  version: 1;
  sessionId: string;
  loaded: SessionLoadDto[];
}

export interface LoadsResult {
  sessions: SessionLoadsDto[];
}

export interface RescanResult extends Partial<BusinessError> {
  added?: string[];
  removed?: string[];
  changed?: string[];
  total?: number;
  warnings?: string[];
}

export interface TrustSetResult extends Partial<BusinessError> {
  id?: string;
  trust?: TrustState;
  record?: TrustRecordDto;
}
