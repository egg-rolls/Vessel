/**
 * Small semver helpers.
 *
 * Deliberately narrower than a full semver implementation:
 * - versions are full `x.y.z` (optionally with a prerelease tag, needed for
 *   `allow_prerelease`);
 * - engines ranges reuse the host loader's grammar (`>=0.33`, `<0.45.0`,
 *   space-separated comparators, `||` alternatives) so a value accepted by the
 *   loader is accepted here too.
 *
 * @module @vessel-agent/plugin-marketplace/semver
 */

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE_VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const COMPARATOR_RE = /^(>=|<=|>|<|=)?(.+)$/;

type ComparatorOperator = '>=' | '<=' | '>' | '<' | '=';

interface VersionComparator {
  op: ComparatorOperator;
  version: { major: number; minor: number; patch: number };
}

export function parseSemver(value: string): SemverParts | null {
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined ? match[4].split('.') : [],
  };
}

export function isFullSemver(value: string): boolean {
  return parseSemver(value) !== null;
}

export function isPrerelease(value: string): boolean {
  return (parseSemver(value)?.prerelease.length ?? 0) > 0;
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semantic-version precedence, including prerelease ordering. */
export function compareSemver(left: SemverParts, right: SemverParts): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const delta = compareIdentifiers(a, b);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Compare two full version strings; invalid input sorts last. */
export function compareVersionStrings(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return compareSemver(a, b);
}

function parseRangeVersion(value: string) {
  const match = RANGE_VERSION_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0,
  };
}

/** Parse a comparator range; `null` means the syntax is unsupported. */
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
      comparators.push({ op: (match[1] as ComparatorOperator | undefined) ?? '=', version });
    }
    alternatives.push(comparators);
  }
  return alternatives.length > 0 ? alternatives : null;
}

function satisfiesComparator(
  version: { major: number; minor: number; patch: number },
  comparator: VersionComparator,
): boolean {
  const delta =
    version.major !== comparator.version.major
      ? version.major - comparator.version.major
      : version.minor !== comparator.version.minor
        ? version.minor - comparator.version.minor
        : version.patch - comparator.version.patch;
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

/**
 * Whether `version` satisfies `range`. A prerelease version is compared on its
 * release triple (the host loader does the same); callers gate prerelease
 * policy separately via `allow_prerelease`.
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsedVersion = parseSemver(version);
  const parsedRange = parseVersionRange(range);
  if (!parsedVersion || !parsedRange) return false;
  const release = {
    major: parsedVersion.major,
    minor: parsedVersion.minor,
    patch: parsedVersion.patch,
  };
  return parsedRange.some((alternative) =>
    alternative.every((comparator) => satisfiesComparator(release, comparator)),
  );
}
