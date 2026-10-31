export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isForbidden(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const message = errorMessage(error);
  return code === 'forbidden' || code === 'unauthorized' || message.includes('forbidden');
}
