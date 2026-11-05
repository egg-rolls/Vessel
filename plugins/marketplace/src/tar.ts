/**
 * Minimal USTAR reader and safe extractor.
 *
 * CONTRACT-0.44 §4 requires: reject absolute paths, `..`, symlinks, hardlinks
 * and oversized output. The parser accepts only regular files and directories
 * (plus pax/GNU long-name records, which are metadata) and verifies every
 * header checksum. Extraction is the only place that touches the filesystem,
 * and it re-checks containment even though the parser already did.
 *
 * No dependency: this is ~250 lines of well-defined format parsing, which is
 * smaller than pulling a tar package into a plugin that users install.
 *
 * @module @vessel-agent/plugin-marketplace/tar
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { MarketplaceError } from './errors.js';

const BLOCK_SIZE = 512;

export interface ArchiveLimits {
  maxExtractBytes: number;
  maxEntries: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxExtractBytes: 200 * 1024 * 1024,
  maxEntries: 5000,
};

export interface TarEntry {
  path: string;
  type: 'file' | 'directory';
  data: Uint8Array;
}

function archiveInvalid(message: string): MarketplaceError {
  return new MarketplaceError('archive_invalid', `archive is invalid: ${message}`);
}

function archiveUnsafe(message: string): MarketplaceError {
  return new MarketplaceError('archive_unsafe', `archive entry is unsafe: ${message}`);
}

function cString(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  const end = nul === -1 ? slice.length : nul;
  return new TextDecoder().decode(slice.subarray(0, end));
}

function parseOctal(bytes: Uint8Array, offset: number, length: number, field: string): number {
  const text = cString(bytes, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw archiveInvalid(`${field} is not octal`);
  return Number.parseInt(text, 8);
}

function headerChecksum(bytes: Uint8Array, offset: number): number {
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (bytes[offset + index] ?? 0);
  }
  return sum;
}

function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    if (bytes[offset + index] !== 0) return false;
  }
  return true;
}

function parsePaxRecords(data: Uint8Array): Map<string, string> {
  const text = new TextDecoder().decode(data);
  const records = new Map<string, string>();
  let cursor = 0;
  while (cursor < text.length) {
    const space = text.indexOf(' ', cursor);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(cursor, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0) throw archiveInvalid('bad pax record length');
    const end = cursor + length;
    if (end > text.length) throw archiveInvalid('truncated pax record');
    const record = text.slice(space + 1, end);
    const equals = record.indexOf('=');
    if (equals !== -1) {
      const key = record.slice(0, equals);
      const value = record.slice(equals + 1).replace(/\n$/, '');
      records.set(key, value);
    }
    cursor = end;
  }
  return records;
}

/** Validate and normalize an entry path. */
function safeEntryPath(raw: string): string {
  if (raw === '' || raw.includes('\0')) throw archiveUnsafe('empty or NUL path');
  if (raw.includes('\\')) throw archiveUnsafe(`backslash path ${raw}`);
  if (raw.startsWith('/')) throw archiveUnsafe(`absolute path ${raw}`);
  if (/^[A-Za-z]:/.test(raw)) throw archiveUnsafe(`drive-letter path ${raw}`);

  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw archiveUnsafe(`path traversal ${raw}`);
    if (segment.includes(':')) throw archiveUnsafe(`unsupported path ${raw}`);
    segments.push(segment);
  }
  if (segments.length === 0) throw archiveUnsafe('empty path');
  return segments.join('/');
}

/**
 * Parse all entries. Metadata records (`x`, `g`, `L`) are consumed and never
 * returned; only regular files and directories remain.
 */
export function parseTarEntries(
  bytes: Uint8Array,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): TarEntry[] {
  const entries: TarEntry[] = [];
  let totalBytes = 0;
  let offset = 0;
  let pendingPath: string | undefined;
  let pendingSize: number | undefined;

  while (offset + BLOCK_SIZE <= bytes.length) {
    if (isZeroBlock(bytes, offset)) break;

    const expected = parseOctal(bytes, offset + 148, 8, 'checksum');
    const actual = headerChecksum(bytes, offset);
    if (expected !== actual) throw archiveInvalid('header checksum mismatch');

    // cString stops at NUL, so the standard magic "ustar\0" reads as "ustar".
    const magic = cString(bytes, offset + 257, 6);
    if (magic !== 'ustar' && magic !== 'ustar ') {
      throw archiveInvalid('not a USTAR archive');
    }

    const name = cString(bytes, offset, 100);
    const prefix = cString(bytes, offset + 345, 155);
    const typeflag = String.fromCharCode(bytes[offset + 156] ?? 0);
    const headerSize = parseOctal(bytes, offset + 124, 12, 'size');

    const fullName = prefix !== '' ? `${prefix}/${name}` : name;
    const dataStart = offset + BLOCK_SIZE;
    let padded = Math.ceil(headerSize / BLOCK_SIZE) * BLOCK_SIZE;
    if (dataStart + padded > bytes.length) throw archiveInvalid('truncated entry data');
    let data = bytes.subarray(dataStart, dataStart + headerSize);

    if (typeflag === 'x' || typeflag === 'g') {
      const records = parsePaxRecords(data);
      if (typeflag === 'x') {
        if (records.has('path')) pendingPath = records.get('path');
        if (records.has('size')) {
          const paxSize = Number.parseInt(records.get('size') ?? '', 10);
          if (!Number.isSafeInteger(paxSize) || paxSize < 0) {
            throw archiveInvalid('bad pax size');
          }
          pendingSize = paxSize;
        }
      }
      offset = dataStart + padded;
      continue;
    }
    if (typeflag === 'L') {
      pendingPath = cString(data, 0, data.length);
      offset = dataStart + padded;
      continue;
    }

    const entryPath = safeEntryPath(pendingPath ?? fullName);
    const size = pendingSize ?? headerSize;
    if (pendingSize !== undefined) {
      // A pax `size` record overrides the header size; the archive's data
      // length follows the override, so recompute the padded span.
      padded = Math.ceil(pendingSize / BLOCK_SIZE) * BLOCK_SIZE;
      if (dataStart + padded > bytes.length) throw archiveInvalid('truncated entry data');
      data = bytes.subarray(dataStart, dataStart + pendingSize);
    }
    pendingPath = undefined;
    pendingSize = undefined;

    if (typeflag === '5') {
      entries.push({ path: entryPath, type: 'directory', data: new Uint8Array(0) });
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      totalBytes += size;
      if (totalBytes > limits.maxExtractBytes) {
        throw new MarketplaceError(
          'archive_too_large',
          `archive expands beyond ${limits.maxExtractBytes} bytes`,
        );
      }
      entries.push({ path: entryPath, type: 'file', data });
    } else if (typeflag === '1' || typeflag === '2') {
      throw archiveUnsafe(`links are not allowed (type ${typeflag}: ${entryPath})`);
    } else {
      throw archiveUnsafe(`unsupported entry type "${typeflag}": ${entryPath}`);
    }

    if (entries.length > limits.maxEntries) {
      throw new MarketplaceError('archive_too_large', 'archive has too many entries');
    }
    offset = dataStart + padded;
  }

  if (entries.length === 0) throw archiveInvalid('archive has no files');
  return entries;
}

/**
 * Remove one shared top-level directory (npm-style `package/...`). A root-level
 * `package.json` means the archive is already flat and must not be stripped.
 */
export function stripCommonRoot(entries: TarEntry[]): TarEntry[] {
  if (entries.some((entry) => entry.path === 'package.json')) return entries;

  const firstSegments = new Set(entries.map((entry) => entry.path.split('/')[0] ?? ''));
  if (firstSegments.size !== 1) return entries;
  const root = [...firstSegments][0];
  if (root === undefined || root === '') return entries;

  const stripped: TarEntry[] = [];
  for (const entry of entries) {
    const prefix = `${root}/`;
    if (entry.path === root) continue;
    if (!entry.path.startsWith(prefix)) return entries;
    stripped.push({ ...entry, path: entry.path.slice(prefix.length) });
  }
  return stripped.length > 0 ? stripped : entries;
}

function assertContained(base: string, target: string): void {
  const rel = relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw archiveUnsafe('entry escapes the destination directory');
  }
  if (isAbsolute(rel)) throw archiveUnsafe('entry resolves outside the destination');
}

/** Write parsed entries under `destination` (which must not exist yet). */
export async function extractEntries(entries: TarEntry[], destination: string): Promise<number> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const base = resolve(destination);
  let written = 0;

  for (const entry of entries) {
    const target = resolve(base, entry.path);
    assertContained(base, target);
    if (entry.type === 'directory') {
      await mkdir(target, { recursive: true, mode: 0o755 });
      continue;
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    try {
      await writeFile(target, entry.data, { mode: 0o644, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw archiveInvalid(`duplicate entry ${entry.path}`);
      }
      throw error;
    }
    written += entry.data.byteLength;
  }
  return written;
}
