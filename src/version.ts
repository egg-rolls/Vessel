/**
 * 版本读取——根 package.json 是唯一版本源（0.1.0 不加 bin，不发 npm CLI）。
 */

import { execFileSync } from 'node:child_process';
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

/**
 * 当前代码的 git short commit；**不可用时返回 `undefined`**（不是 'unknown'）。
 *
 * 只用于「Web 产物是否是同一份代码构建的」这个判断。发布 tarball 里没有 `.git`，
 * 或机器上没装 git 时返回 `undefined`，调用方据此跳过比对 —— 不知道不等于不一致。
 */
export function readGitCommit(): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
