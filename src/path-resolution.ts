/**
 * 0.4 路径与名称解析（纯函数 + 只读 fs）。
 *
 * 规则（DECISION-009 Addendum B §11.1.8/§11.1.9 / Addendum D §13.1）：
 * - 配置路径：相对 cwd，`~` 展开（与 durable.path 一致）。
 * - eval suite：name 在 evals.dir 下解析；显式路径按 cwd。
 */

import { realpath, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_EVALS_OPTIONS, type VesselConfig } from '../packages/config/src/index';

/** name 的安全字符集 */
export const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const DEFINITION_EXTENSIONS = ['yaml', 'yml', 'json'] as const;

export type ResolutionCode = 'eval_not_found' | 'eval_invalid';

export type ResolutionResult =
  | { ok: true; path: string }
  | { ok: false; code: ResolutionCode; error: string };

/** `~` / `~/` / `~\` 展开；其余原样 */
export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/** 相对路径按 cwd 解析；绝对路径 normalize */
function resolveFromCwd(input: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);
}

/**
 * 解析默认工作目录（0.11.1，DECISION-022 §2.4）。
 * 支持 `~`；相对路径按进程 cwd 解析为绝对路径。未配置/空串返回 undefined。
 * 只做路径解析，不检查目录是否存在（存在性由工具/插件在调用时处理）。
 */
export function resolveAgentCwd(config: VesselConfig): string | undefined {
  const raw = config.agent?.cwd;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return resolveFromCwd(raw.trim());
}

/** tenant 最终路径选项（A-3 §10.7：插件不得自行追加 tenants/<id>） */
export interface TenantPathOptions {
  /** tenant 根目录（`<data_dir>/tenants/<id>`） */
  tenantDir?: string;
}

export function resolveEvalsDir(config: VesselConfig): string {
  return resolveFromCwd(config.evals?.dir ?? DEFAULT_EVALS_OPTIONS.dir);
}

/**
 * eval 报告目录：
 * 显式 `evals.outDir` → `<tenant>/evals` → legacy 默认。
 */
export function resolveEvalsOutDir(config: VesselConfig, opts: TenantPathOptions = {}): string {
  const explicit = config.evals?.outDir;
  if (explicit !== undefined && explicit.trim() !== '') return resolveFromCwd(explicit);
  if (opts.tenantDir) return path.join(opts.tenantDir, 'evals');
  return resolveFromCwd(DEFAULT_EVALS_OPTIONS.outDir);
}

export function isSafeSuiteName(name: string): boolean {
  return SAFE_NAME_RE.test(name);
}

function notFound(code: ResolutionCode, target: string): ResolutionResult {
  return { ok: false, code, error: `${code}: ${target}` };
}

function invalid(code: ResolutionCode, detail: string): ResolutionResult {
  return { ok: false, code, error: `${code}: ${detail}` };
}

/** 文件存在且是普通文件 */
async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** realpath 后必须在 dir 内（防 `..` 与 symlink 逃逸） */
async function assertWithinDir(filePath: string, dir: string): Promise<boolean> {
  try {
    const [fileReal, dirReal] = await Promise.all([realpath(filePath), realpath(dir)]);
    const rel = path.relative(dirReal, fileReal);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

async function resolveDefinitionCandidates(
  dir: string,
  name: string,
  notFoundCode: ResolutionCode,
  invalidCode: ResolutionCode,
): Promise<ResolutionResult> {
  const matches: string[] = [];
  for (const extension of DEFINITION_EXTENSIONS) {
    const candidate = path.join(dir, `${name}.${extension}`);
    if (await isFile(candidate)) matches.push(candidate);
  }

  if (matches.length === 0) return notFound(notFoundCode, name);
  if (matches.length > 1) {
    return invalid(
      invalidCode,
      `multiple definitions match "${name}": ${matches
        .map((match) => path.basename(match))
        .join(', ')}`,
    );
  }

  const match = matches[0] as string;
  // 单段 name 也必须做包含性校验：目录本身可能是 symlink。
  if (!(await assertWithinDir(match, dir))) {
    return invalid(invalidCode, `definition escapes directory: ${match}`);
  }
  return { ok: true, path: await realpath(match) };
}

/**
 * CLI `eval <suite-name-or-path>`：
 * - name 在 evals.dir 下解析；
 * - 显式相对/绝对路径按 cwd。
 */
export async function resolveEvalSuite(
  config: VesselConfig,
  nameOrPath: string,
): Promise<ResolutionResult> {
  const raw = nameOrPath.trim();
  if (raw === '') return invalid('eval_invalid', 'suite path is required');

  if (path.isAbsolute(raw)) {
    const normalized = path.normalize(raw);
    if (!(await isFile(normalized))) return notFound('eval_not_found', raw);
    return { ok: true, path: await realpath(normalized) };
  }

  if (/[\\/]/.test(raw)) {
    const candidate = path.resolve(raw);
    if (!(await isFile(candidate))) return notFound('eval_not_found', raw);
    return { ok: true, path: await realpath(candidate) };
  }

  if (!isSafeSuiteName(raw)) {
    return invalid('eval_invalid', `suite name must match ${SAFE_NAME_RE.source}`);
  }

  return resolveDefinitionCandidates(
    resolveEvalsDir(config),
    raw,
    'eval_not_found',
    'eval_invalid',
  );
}
