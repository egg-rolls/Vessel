/**
 * 版本读取——根 package.json 是唯一版本源（0.1.0 不加 bin，不发 npm CLI）。
 */

import { readFileSync } from 'node:fs';

/** 读取根 package.json 的 version；缺失时返回 '0.0.0' */
export function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
