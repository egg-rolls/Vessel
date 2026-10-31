export function isForbidden(code: string | undefined, message: string): boolean {
  return code === 'forbidden' || code === 'unauthorized' || message.includes('forbidden');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function formatQuota(quota: Record<string, number> | undefined): string {
  if (!quota) return '—';
  const parts = Object.entries(quota).map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}
