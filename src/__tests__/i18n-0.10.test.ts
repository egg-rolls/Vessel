/**
 * 0.10 R2-20：CLI i18n（locale 优先级 / catalog 对齐 / --help 与 headless 文案）。
 *
 * 子进程用临时 HOME 隔离真实配置；locale 环境显式清空，避免宿主 LANG 影响默认值。
 */
import { expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLocale, normalizeLocale, resolveLocale, setLocale, t } from '../i18n/index';
import { en } from '../i18n/messages/en';
import { zhCN } from '../i18n/messages/zh-CN';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');

async function runCli(
  args: string[],
  env: Record<string, string> = {},
  stdin = '',
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-i18n-'));
  try {
    const proc = Bun.spawn([process.execPath, cliPath, ...args], {
      cwd: tmpDir,
      env: { ...process.env, ...env, USERPROFILE: tmpDir, HOME: tmpDir },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: stdin === '' ? undefined : 'pipe',
    });
    if (stdin !== '') {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const CLEAN_LOCALE_ENV = { VESSEL_LANG: '', LANG: '', LC_ALL: '' };

it('resolveLocale 优先级与 TUI 一致：VESSEL_LANG > config > LANG > LC_ALL > zh-CN', () => {
  expect(
    resolveLocale({
      env: { VESSEL_LANG: 'en', LANG: 'zh_CN.UTF-8' },
      configLanguage: 'zh-CN',
    }),
  ).toBe('en');
  expect(resolveLocale({ env: { LANG: 'en_US.UTF-8' }, configLanguage: 'zh' })).toBe('zh-CN');
  expect(resolveLocale({ env: { LANG: 'en_US.UTF-8' }, configLanguage: 'fr' })).toBe('en');
  expect(resolveLocale({ env: { LC_ALL: 'en_GB.UTF-8' } })).toBe('en');
  expect(resolveLocale({ env: {} })).toBe('zh-CN');
  expect(resolveLocale({ env: { VESSEL_LANG: 'fr', LANG: 'en_US' } })).toBe('en');
});

it('normalizeLocale 接受 zh/en 前缀与 .UTF-8 后缀', () => {
  expect(normalizeLocale('zh_CN.UTF-8')).toBe('zh-CN');
  expect(normalizeLocale('zh-TW')).toBe('zh-CN');
  expect(normalizeLocale('EN_us')).toBe('en');
  expect(normalizeLocale('en')).toBe('en');
  expect(normalizeLocale('fr_FR')).toBeUndefined();
  expect(normalizeLocale('')).toBeUndefined();
});

it('catalog key 两语言一一对应', () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
});

it('t() 缺 key 回退 zh-CN，再回退 key 本身', () => {
  setLocale('en');
  expect(t('common.noInput')).toBe('No input.');
  expect(t('missing.key')).toBe('missing.key');
  expect(t('demo.needsTty')).toContain('VESSEL_MOCK=1');
  setLocale('zh-CN');
  expect(getLocale()).toBe('zh-CN');
  expect(t('common.noInput')).toBe('没有输入。');
});

it('--help 默认中文（既有文案逐字保留）', async () => {
  const { stdout, exitCode } = await runCli(['--help'], CLEAN_LOCALE_ENV);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('Vessel CLI — 自组织 Agent Harness');
  expect(stdout).toContain('用法');
  expect(stdout).toContain('启动 HTTP/WS gateway（Web 控制台后端）');
});

it('VESSEL_LANG=en --help 输出英文', async () => {
  const { stdout, exitCode } = await runCli(['--help'], {
    ...CLEAN_LOCALE_ENV,
    VESSEL_LANG: 'en',
  });
  expect(exitCode).toBe(0);
  expect(stdout).toContain('Vessel CLI — self-organizing agent harness');
  expect(stdout).toContain('Usage');
  expect(stdout).toContain('start the HTTP/WS gateway (Web console backend)');
  expect(stdout).not.toContain('用法');
});

it('headless 空输入：默认中文，VESSEL_LANG=en 英文', async () => {
  const zh = await runCli(['--run'], { ...CLEAN_LOCALE_ENV, VESSEL_MOCK: '1' }, '   ');
  expect(zh.exitCode).toBe(1);
  expect(zh.stderr).toContain('没有输入。');

  const english = await runCli(
    ['--run'],
    { ...CLEAN_LOCALE_ENV, VESSEL_LANG: 'en', VESSEL_MOCK: '1' },
    '   ',
  );
  expect(english.exitCode).toBe(1);
  expect(english.stderr).toContain('No input.');
});
