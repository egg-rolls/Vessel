import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webDepsNeedInstall } from '../dev-web';

/** 显式时间戳，避免依赖真实时钟（Windows 文件时间粒度也不影响判定）。 */
const LOCK_AT = Date.UTC(2026, 0, 1);
const INSTALLED_AT = Date.UTC(2026, 0, 2);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setMtime(file: string, at: number): Promise<void> {
  await utimes(file, new Date(at), new Date(at));
}

async function makeWebDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vessel-dev-web-'));
  roots.push(root);
  await writeFile(join(root, 'package-lock.json'), '{}');
  await setMtime(join(root, 'package-lock.json'), LOCK_AT);
  return root;
}

async function writeInstalledDeps(root: string, installedAt: number): Promise<void> {
  const modules = join(root, 'node_modules');
  await mkdir(join(modules, 'vite', 'bin'), { recursive: true });
  await writeFile(join(modules, 'vite', 'bin', 'vite.js'), '');
  await mkdir(join(modules, '@tailwindcss', 'vite'), { recursive: true });
  await writeFile(join(modules, '@tailwindcss', 'vite', 'package.json'), '{}');
  await writeFile(join(modules, '.package-lock.json'), '{}');
  await setMtime(join(modules, '.package-lock.json'), installedAt);
}

describe('webDepsNeedInstall', () => {
  it('installs when Vite is missing', async () => {
    const root = await makeWebDir();

    expect(webDepsNeedInstall(root)).toBe(true);
  });

  it('installs when the Tailwind plugin is missing', async () => {
    const root = await makeWebDir();
    const modules = join(root, 'node_modules');
    await mkdir(join(modules, 'vite', 'bin'), { recursive: true });
    await writeFile(join(modules, 'vite', 'bin', 'vite.js'), '');
    await writeFile(join(modules, '.package-lock.json'), '{}');
    await setMtime(join(modules, '.package-lock.json'), INSTALLED_AT);

    expect(webDepsNeedInstall(root)).toBe(true);
  });

  it('installs when package-lock.json is newer than the installed lock', async () => {
    const root = await makeWebDir();
    await writeInstalledDeps(root, LOCK_AT);
    await setMtime(join(root, 'package-lock.json'), INSTALLED_AT);

    expect(webDepsNeedInstall(root)).toBe(true);
  });

  it('does not install when dependencies and lock are up to date', async () => {
    const root = await makeWebDir();
    await writeInstalledDeps(root, INSTALLED_AT);

    expect(webDepsNeedInstall(root)).toBe(false);
  });
});
