#!/usr/bin/env node
/**
 * Registry PR validation (copy this file next to index.json).
 *
 * Checks:
 *   - schema 1, unique plugin ids, semver versions unique + ascending
 *   - `latest` exists
 *   - every asset has https URL + 64-hex sha256 + positive integer size
 *   - engines.vessel parses and covers VESSEL_STABLE (default 0.33.0)
 *   - the asset downloads, and sha256/size match byte-for-byte
 *
 * No GitHub API and no token: public release assets only.
 *
 * Usage: node validate.mjs [index.json]
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const VESSEL_STABLE = process.env.VESSEL_STABLE || '0.33.0';
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE_RE = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

const errors = [];
const fail = (message) => errors.push(message);

function parseVersion(value) {
  const match = SEMVER_RE.exec(String(value || '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compare(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) {
      if (Number(a) !== Number(b)) return Number(a) - Number(b);
    } else if (aNumber !== bNumber) {
      return aNumber ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const release = { major: parsed.major, minor: parsed.minor, patch: parsed.patch };
  for (const alternative of String(range).split('||')) {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) continue;
    let ok = true;
    for (const token of comparators) {
      const match = RANGE_RE.exec(token);
      if (!match) return false;
      const target = {
        major: Number(match[2]),
        minor: match[3] !== undefined ? Number(match[3]) : 0,
        patch: match[4] !== undefined ? Number(match[4]) : 0,
      };
      const delta = compare(release, target);
      const op = match[1] || '=';
      const passed =
        op === '>='
          ? delta >= 0
          : op === '<='
            ? delta <= 0
            : op === '>'
              ? delta > 0
              : op === '<'
                ? delta < 0
                : delta === 0;
      if (!passed) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateIndex(index) {
  if (!isObject(index)) return fail('root must be an object');
  if (index.schema !== 1) return fail(`schema must be 1, got ${JSON.stringify(index.schema)}`);
  if (!Array.isArray(index.plugins)) return fail('plugins must be an array');

  const ids = new Set();
  index.plugins.forEach((plugin, position) => {
    const field = `plugins[${position}]`;
    if (!isObject(plugin)) {
      fail(`${field} must be an object`);
      return;
    }
    if (typeof plugin.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(plugin.id)) {
      fail(`${field}.id is invalid`);
    } else if (ids.has(plugin.id)) {
      fail(`${field}.id "${plugin.id}" is duplicated`);
    } else {
      ids.add(plugin.id);
    }
    if (typeof plugin.name !== 'string' || plugin.name.trim() === '')
      fail(`${field}.name is required`);
    if (!parseVersion(plugin.latest)) fail(`${field}.latest must be a full semver`);

    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
      fail(`${field}.versions must be a non-empty array`);
      return;
    }
    const versions = new Set();
    let previous = null;
    plugin.versions.forEach((version, versionPosition) => {
      const versionField = `${field}.versions[${versionPosition}]`;
      if (!isObject(version)) {
        fail(`${versionField} must be an object`);
        return;
      }
      if (!parseVersion(version.version)) {
        fail(`${versionField}.version must be a full semver`);
      } else if (versions.has(version.version)) {
        fail(`${versionField}.version "${version.version}" is duplicated`);
      } else {
        versions.add(version.version);
        const parsed = parseVersion(version.version);
        if (previous !== null && compare(previous, parsed) >= 0) {
          fail(`${field}.versions must be unique and ascending`);
        }
        previous = parsed;
      }

      if (version.engines !== undefined) {
        if (!isObject(version.engines)) {
          fail(`${versionField}.engines must be an object`);
        } else if (version.engines.vessel !== undefined) {
          if (!satisfies(VESSEL_STABLE, version.engines.vessel)) {
            fail(
              `${versionField}.engines.vessel "${version.engines.vessel}" does not cover Vessel ${VESSEL_STABLE}`,
            );
          }
        }
      }

      const asset = version.asset;
      if (!isObject(asset)) {
        fail(`${versionField}.asset is required`);
        return;
      }
      if (typeof asset.url !== 'string' || !asset.url.startsWith('https://')) {
        fail(`${versionField}.asset.url must be https`);
      }
      if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.sha256)) {
        fail(`${versionField}.asset.sha256 must be 64 hex characters`);
      }
      if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
        fail(`${versionField}.asset.size must be a positive integer`);
      }
    });

    if (!versions.has(plugin.latest)) fail(`${field}.latest "${plugin.latest}" is not in versions`);
  });
}

async function verifyAssets(index) {
  for (const plugin of index.plugins) {
    if (!isObject(plugin) || !Array.isArray(plugin.versions)) continue;
    for (const version of plugin.versions) {
      if (!isObject(version) || !isObject(version.asset)) continue;
      const asset = version.asset;
      if (typeof asset.url !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '')) continue;
      const label = `${plugin.id}@${version.version}`;
      let response;
      try {
        response = await fetch(asset.url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(120_000),
        });
      } catch (error) {
        fail(`${label}: download failed (${error.message})`);
        continue;
      }
      if (!response.ok) {
        fail(`${label}: download returned HTTP ${response.status}`);
        continue;
      }
      if (response.url && !response.url.startsWith('https://')) {
        fail(`${label}: redirect is not https (${response.url})`);
      }
      const declared = Number(response.headers.get('content-length') || Number.NaN);
      if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
        fail(`${label}: asset exceeds ${MAX_ASSET_BYTES} bytes`);
        continue;
      }
      const hash = createHash('sha256');
      let size = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_ASSET_BYTES) {
            await reader.cancel();
            fail(`${label}: asset exceeds ${MAX_ASSET_BYTES} bytes`);
            size = -1;
            break;
          }
          hash.update(value);
        }
      } finally {
        reader.releaseLock();
      }
      if (size < 0) continue;
      if (size !== asset.size)
        fail(`${label}: size mismatch (index ${asset.size}, actual ${size})`);
      const digest = hash.digest('hex');
      if (digest !== String(asset.sha256).toLowerCase()) {
        fail(`${label}: sha256 mismatch (index ${asset.sha256}, actual ${digest})`);
      }
    }
  }
}

const file = process.argv[2] || 'index.json';
let index;
try {
  index = JSON.parse(await readFile(file, 'utf-8'));
} catch (error) {
  console.error(`cannot read ${file}: ${error.message}`);
  process.exit(1);
}

validateIndex(index);
if (errors.length === 0) await verifyAssets(index);

if (errors.length > 0) {
  console.error(`registry validation failed (${errors.length} error(s)):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`registry OK: ${index.plugins.length} plugin(s), Vessel ${VESSEL_STABLE}`);
