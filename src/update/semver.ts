/**
 * 最小 semver 比较（不引入依赖）。
 * 支持 `0.1.0`、`v0.1.0`、`0.2.0-beta.1`；不支持的格式返回 null。
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** 解析版本号；非法返回 null */
export function parseVersion(input: string): ParsedVersion | null {
  const match = SEMVER_RE.exec(input.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  const pre =
    prerelease === undefined
      ? []
      : prerelease.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre,
  };
}

/** 比较 prerelease 标识符：数字按数值，字符串按字典序；数字 < 字符串 */
function comparePrerelease(a: Array<string | number>, b: Array<string | number>): number {
  if (a.length === 0 && b.length === 0) return 0;
  // 无 prerelease 的版本更高
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return (x ?? '') < (y ?? '') ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** 比较两个版本；任一非法时抛错。返回 -1 / 0 / 1 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    throw new Error(`Invalid version: ${!left ? a : b}`);
  }
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** latest 是否严格高于 current */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}
