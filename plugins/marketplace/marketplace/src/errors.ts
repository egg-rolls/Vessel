/**
 * Marketplace error type.
 *
 * RPC handlers throw this type; `index.ts` maps it onto a JSON-RPC error whose
 * `data.code` is the stable marketplace code (`checksum_mismatch`, ...). The
 * contract (CONTRACT-0.44 §3-§5) has no host-side error enum for the
 * marketplace, so codes stay plugin-local strings.
 *
 * @module @vessel-agent/plugin-marketplace/errors
 */

export type MarketplaceErrorCode =
  | 'invalid_params'
  | 'plugin_not_activated'
  | 'registry_url_missing'
  | 'registry_url_insecure'
  | 'registry_fetch_failed'
  | 'registry_invalid'
  | 'registry_unavailable'
  | 'plugin_not_found'
  | 'version_not_found'
  | 'prerelease_not_allowed'
  | 'asset_missing'
  | 'asset_insecure'
  | 'asset_too_large'
  | 'asset_truncated'
  | 'checksum_mismatch'
  | 'size_mismatch'
  | 'archive_invalid'
  | 'archive_unsafe'
  | 'archive_too_large'
  | 'manifest_invalid'
  | 'manifest_mismatch'
  | 'version_incompatible'
  | 'install_failed'
  | 'config_write_failed'
  | 'not_installed'
  | 'builtin_readonly'
  | 'remove_failed'
  | 'update_failed'
  | 'busy'
  | 'job_not_found';

export class MarketplaceError extends Error {
  readonly code: MarketplaceErrorCode;
  readonly rpcCode: number;
  readonly data?: Record<string, unknown>;

  constructor(
    code: MarketplaceErrorCode,
    message: string,
    options: { rpcCode?: number; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'MarketplaceError';
    this.code = code;
    this.rpcCode = options.rpcCode ?? -32000;
    this.data = options.data;
  }
}

/** Invalid RPC params (JSON-RPC -32602). */
export function invalid(message: string): MarketplaceError {
  return new MarketplaceError('invalid_params', message, { rpcCode: -32602 });
}

export function isMarketplaceError(value: unknown): value is MarketplaceError {
  return value instanceof MarketplaceError;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Human-readable OS error code, never the full path. */
export function errorCodeOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}
