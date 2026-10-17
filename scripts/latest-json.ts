#!/usr/bin/env bun

/**
 * 生成自动更新清单 latest.json。
 *
 * 0.1.0 不发布二进制：不传 --dir，assets 为空对象。
 * 0.2 若恢复二进制：传 --dir，同时生成 SHA256SUMS。
 *
 * 用法：
 *   bun run scripts/latest-json.ts --version 0.1.0 --channel latest --out latest.json
 *   bun run scripts/latest-json.ts --version 0.2.0 --channel beta \
 *     --tag v0.2.0-beta.1 --repo egg-rolls/Vessel --dir dist --out latest.json
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const ASSET_NAMES = {
  'windows-x64': 'vessel-windows-x64.exe',
  'linux-x64': 'vessel-linux-x64',
  'darwin-x64': 'vessel-darwin-x64',
  'darwin-arm64': 'vessel-darwin-arm64',
} as const;

export type Channel = 'latest' | 'beta';

export interface AssetEntry {
  url: string;
  sha256: string;
}

export interface LatestJson {
  version: string;
  channel: Channel;
  released_at: string;
  assets: Record<string, AssetEntry>;
}

export interface BuildOptions {
  version: string;
  channel: Channel;
  tag?: string;
  repo?: string;
  dir?: string;
  /** 便于测试注入固定时间。 */
  releasedAt?: string;
}

export async function buildLatestJson(options: BuildOptions): Promise<LatestJson> {
  const tag = options.tag ?? `v${options.version}`;
  const assets: Record<string, AssetEntry> = {};

  if (options.dir) {
    if (!options.repo) {
      throw new Error('--repo is required when --dir is provided');
    }

    for (const [platform, filename] of Object.entries(ASSET_NAMES)) {
      const path = join(options.dir, filename);
      if (!existsSync(path)) {
        throw new Error(`missing release asset: ${path}`);
      }

      const sha256 = new Bun.CryptoHasher('sha256').update(await readFile(path)).digest('hex');
      assets[platform] = {
        url: `https://github.com/${options.repo}/releases/download/${tag}/${filename}`,
        sha256,
      };
    }
  }

  return {
    version: options.version,
    channel: options.channel,
    released_at: options.releasedAt ?? new Date().toISOString(),
    assets,
  };
}

export async function writeLatestJson(filePath: string, data: LatestJson): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export async function writeChecksums(dir: string, data: LatestJson): Promise<string | null> {
  const entries = Object.entries(data.assets);
  if (entries.length === 0) return null;

  const lines = Object.keys(ASSET_NAMES)
    .filter((platform) => data.assets[platform] !== undefined)
    .map((platform) => {
      const asset = data.assets[platform];
      const filename = ASSET_NAMES[platform as keyof typeof ASSET_NAMES];
      return `${asset?.sha256}  ${filename}`;
    });

  const filePath = join(dir, 'SHA256SUMS');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

function parseArgs(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      values[key] = 'true';
    } else {
      values[key] = next;
      i += 1;
    }
  }

  return values;
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/latest-json.ts --version <x.y.z> [--channel latest|beta]
    [--tag vX.Y.Z] [--repo owner/name] [--dir dist] [--out latest.json]`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printUsage();
    return;
  }

  const version = args.version;
  if (!version) {
    printUsage();
    process.exit(1);
  }

  const channel = (args.channel ?? 'latest') as Channel;
  if (channel !== 'latest' && channel !== 'beta') {
    console.error(`invalid channel: ${channel}`);
    process.exit(1);
  }

  const out = args.out ?? 'latest.json';

  try {
    const data = await buildLatestJson({
      version,
      channel,
      tag: args.tag,
      repo: args.repo,
      dir: args.dir,
    });

    await writeLatestJson(out, data);
    const checksums = await writeChecksums(dirname(out), data);
    if (checksums) {
      console.log(`wrote ${checksums}`);
    }
    console.log(`wrote ${out}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
