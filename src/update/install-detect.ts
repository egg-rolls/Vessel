/**
 * 安装形态检测（0.12 DECISION-023 §2.4）。
 *
 * `vessel update` 需要知道自己是 npm 全局、bun 全局还是源码/开发模式：
 * - 入口在 `node_modules/vessel-agent` 下且路径含 `.bun` → bun；否则 npm；
 * - 入口是仓库内 `src/cli.ts`（或向上能找到 `.git`）→ dev；
 * - 其余 → unknown（按 dev 给提示，不自动改工作区）。
 *
 * 纯函数 + 注入，便于测试；不执行安装命令。
 *
 * @module vessel/update/install-detect
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 安装形态 */
export type InstallForm = 'npm' | 'bun' | 'dev' | 'unknown';

/** 检测选项 */
export interface DetectInstallFormOptions {
  /** 入口脚本（缺省 process.argv[1]） */
  entryPath?: string;
  homeDir?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  exists?: (filePath: string) => boolean;
}

/** 更新目标包（根包发布名） */
export const UPDATE_PACKAGE = 'vessel-agent@latest';

/** 显式覆盖（CI / 非常规安装布局） */
const FORM_OVERRIDES: ReadonlySet<string> = new Set(['npm', 'bun', 'dev']);

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function hasGitAncestor(start: string, exists: (filePath: string) => boolean): boolean {
  let current = path.resolve(start);
  for (let depth = 0; depth < 12; depth++) {
    if (exists(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/** 判断入口脚本属于哪种安装形态 */
export function detectInstallForm(options: DetectInstallFormOptions = {}): InstallForm {
  const env = options.env ?? process.env;
  const override = env.VESSEL_INSTALL_FORM;
  if (override !== undefined && FORM_OVERRIDES.has(override)) {
    return override as InstallForm;
  }

  const entry = options.entryPath ?? process.argv[1] ?? '';
  if (entry.trim() === '') return 'unknown';
  const exists = options.exists ?? fs.existsSync;
  const home = normalize(options.homeDir ?? os.homedir());
  const normalizedEntry = normalize(path.resolve(entry)).toLowerCase();
  const normalizedHome = home.toLowerCase();

  // bun 全局安装（默认位于 ~/.bun/install/global/node_modules）
  if (
    normalizedEntry.includes('/.bun/install/global/node_modules/') ||
    normalizedEntry.includes('/.bun/install/cache/')
  ) {
    return 'bun';
  }

  if (normalizedEntry.includes('/node_modules/vessel-agent/')) {
    if (
      normalizedEntry.includes('/.bun/') ||
      normalizedEntry.startsWith(`${normalizedHome}/.bun/`)
    ) {
      return 'bun';
    }
    return 'npm';
  }

  // Windows npm 前缀 / 其它全局布局（入口可能就是 bin 包装器）
  if (
    normalizedEntry.startsWith(`${normalizedHome}/appdata/roaming/npm/`) ||
    normalizedEntry.includes('/npm/node_modules/vessel-agent/') ||
    normalizedEntry.includes('/lib/node_modules/vessel-agent/')
  ) {
    return 'npm';
  }

  // 源码 / 开发模式：入口是仓库里的 src/cli.ts，或向上存在 .git
  if (/\/src\/cli\.(ts|js)$/.test(normalizedEntry)) return 'dev';
  if (hasGitAncestor(options.cwd ?? path.dirname(path.resolve(entry)), exists)) return 'dev';

  return 'unknown';
}

/** 自更新计划 */
export interface InstallPlan {
  form: InstallForm;
  /** npm / bun 的执行 argv；dev/unknown 为 undefined */
  command?: string[];
  /** dev/unknown 的可执行提示 */
  hint?: string;
}

/** 按形态给出安装命令或提示（不执行） */
export function buildInstallPlan(form: InstallForm): InstallPlan {
  if (form === 'npm') return { form, command: ['npm', 'i', '-g', UPDATE_PACKAGE] };
  if (form === 'bun') return { form, command: ['bun', 'add', '-g', UPDATE_PACKAGE] };
  return { form, hint: 'git pull && bun install' };
}
