/**
 * EADDRINUSE 识别（0.15）。
 *
 * gateway 在 `Bun.serve` 外再包一层 Error（`cause` 保留原始 code），
 * startGateway 的调用方需要按原始错误返回 `port_in_use`。
 *
 * @module vessel/port-in-use
 */

/** 沿 `cause` 链识别端口占用（最多 4 层）。 */
export function isAddressInUse(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (record.code === 'EADDRINUSE') return true;
    if (
      typeof record.message === 'string' &&
      (/\bEADDRINUSE\b/.test(record.message) ||
        /address already in use/i.test(record.message) ||
        /is port \d+ in use/i.test(record.message))
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}
