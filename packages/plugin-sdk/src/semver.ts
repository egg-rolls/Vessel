/**
 * 最小 semver 工具（plugin-embed 契约 §7：从 src/plugin-manifest.ts 搬家至此）。
 *
 * 版本范围支持比较符（`>=x` / `>x.y` / `<=x.y.z` / `=x`，端点缺位补 0）、
 * `^` / `~`（标准 caret / tilde 语义），空格分隔为 AND、`||` 分隔为 OR；
 * `x` 单独出现等同 `=x.0.0`。不支持预发布排序（`1.0.0-beta`）—— unsupported
 * 语法一律返回 null / false（fail-closed）。
 *
 * 纯函数、零依赖：宿主 manifest 校验与 Web embed loader 共用同一份实现。
 *
 * @module @vessel-agent/plugin-sdk/semver
 */

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

export type ComparatorOperator = '>=' | '<=' | '>' | '<' | '=';

export interface VersionComparator {
  op: ComparatorOperator;
  version: SemverParts;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
/** 范围端点允许 `x` / `x.y` / `x.y.z`（缺位补 0，契约示例 `>=0.43 <0.45`） */
const RANGE_VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~)?(\d+(?:\.\d+)?(?:\.\d+)?)$/;

export function parseSemver(value: string): SemverParts | null {
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** 范围端点解析：`0.43` → 0.43.0 */
export function parseRangeVersion(value: string): SemverParts | null {
  const match = RANGE_VERSION_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0,
  };
}

/** 是否为支持的完整 semver（`x.y.z`） */
export function isValidSemver(value: string): boolean {
  return parseSemver(value) !== null;
}

export function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * `^` / `~` 展开成 `>=lower <upper` 两个比较器。上界取决于**书写精度**
 * （precision = 端点里写出的段数减一：`x`→0、`x.y`→1、`x.y.z`→2），
 * 与 node-semver 一致：
 * - `^x.y.z`（x>0）→ `>=x.y.z <(x+1).0.0`；`^x`（x>0）同
 * - `^0.y.z`（y>0）→ `>=0.y.z <0.(y+1).0`；`^0.y` 同
 * - `^0.0.z` → `>=0.0.z <0.0.(z+1)`；`^0.0` → `>=0.0.0 <0.1.0`；`^0` → `<1.0.0`
 * - `~x.y(.z)` → `>=x.y.z <x.(y+1).0`；`~x` → `>=x.0.0 <(x+1).0.0`
 */
function expandRangeOperator(
  op: '^' | '~',
  version: SemverParts,
  precision: number,
): VersionComparator[] {
  let upper: SemverParts;
  if (op === '~') {
    upper =
      precision >= 1
        ? { major: version.major, minor: version.minor + 1, patch: 0 }
        : { major: version.major + 1, minor: 0, patch: 0 };
  } else if (version.major > 0 || precision === 0) {
    upper = { major: version.major + 1, minor: 0, patch: 0 };
  } else if (version.minor > 0 || precision === 1) {
    upper = { major: 0, minor: version.minor + 1, patch: 0 };
  } else {
    upper = { major: 0, minor: 0, patch: version.patch + 1 };
  }
  return [
    { op: '>=', version },
    { op: '<', version: upper },
  ];
}

/** 解析版本范围；不支持的语法返回 null（调用方报 plugin_manifest_invalid） */
export function parseVersionRange(range: string): VersionComparator[][] | null {
  const alternatives: VersionComparator[][] = [];
  for (const alternative of range.split('||')) {
    const trimmed = alternative.trim();
    if (trimmed === '') return null;
    const comparators: VersionComparator[] = [];
    for (const token of trimmed.split(/\s+/)) {
      const match = COMPARATOR_RE.exec(token);
      if (!match) return null;
      const version = parseRangeVersion(match[2] ?? '');
      if (!version) return null;
      const op = (match[1] ?? '=') as ComparatorOperator | '^' | '~';
      if (op === '^' || op === '~') {
        const precision = ((match[2] ?? '').match(/\./g) ?? []).length;
        comparators.push(...expandRangeOperator(op, version, precision));
      } else {
        comparators.push({ op, version });
      }
    }
    alternatives.push(comparators);
  }
  return alternatives.length > 0 ? alternatives : null;
}

export function satisfiesComparator(version: SemverParts, comparator: VersionComparator): boolean {
  const delta = compareSemver(version, comparator.version);
  switch (comparator.op) {
    case '>=':
      return delta >= 0;
    case '<=':
      return delta <= 0;
    case '>':
      return delta > 0;
    case '<':
      return delta < 0;
    default:
      return delta === 0;
  }
}

/** `version` 是否满足 `range`；范围语法不支持时返回 false */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsedVersion = parseSemver(version);
  const parsedRange = parseVersionRange(range);
  if (!parsedVersion || !parsedRange) return false;
  return parsedRange.some((alternative) =>
    alternative.every((comparator) => satisfiesComparator(parsedVersion, comparator)),
  );
}
