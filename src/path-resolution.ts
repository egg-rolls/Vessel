/**
 * 0.4 路径与名称解析（纯函数 + 只读 fs）。
 *
 * 规则（DECISION-009 Addendum B §11.1.8/§11.1.9 / Addendum D §13.1）：
 * - 配置路径：相对 cwd，`~` 展开（与 durable.path 一致）。
 * - workflow 定义：name 只允许单段安全名，在 workflow.dir 下解析；
 *   显式相对路径按 workflow.dir 解析；绝对路径允许；
 *   拒绝 `..` 越界与 symlink 逃逸；多个同名定义 → workflow_invalid。
 * - eval suite：name 在 evals.dir 下解析；显式路径按 cwd。
 */

import { realpathSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_EVALS_OPTIONS,
  DEFAULT_WORKFLOW_OPTIONS,
  type VesselConfig,
} from '../packages/config/src/index';

/** workflow 定义 / gateway name 的安全字符集 */
export const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const DEFINITION_EXTENSIONS = ['yaml', 'yml', 'json'] as const;

export type ResolutionCode =
  | 'workflow_not_found'
  | 'workflow_invalid'
  | 'eval_not_found'
  | 'eval_invalid';

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

export function resolveWorkflowDir(config: VesselConfig): string {
  return resolveFromCwd(config.workflow?.dir ?? DEFAULT_WORKFLOW_OPTIONS.dir);
}

/** tenant 最终路径选项（A-3 §10.7：插件不得自行追加 tenants/<id>） */
export interface TenantPathOptions {
  /** tenant 根目录（`<data_dir>/tenants/<id>`） */
  tenantDir?: string;
}

/**
 * workflow run 状态目录：
 * 显式 `workflow.path` → `<tenant>/workflows` → legacy 默认。
 */
export function resolveWorkflowStorePath(
  config: VesselConfig,
  opts: TenantPathOptions = {},
): string {
  const explicit = config.workflow?.path;
  if (explicit !== undefined && explicit.trim() !== '') return resolveFromCwd(explicit);
  if (opts.tenantDir) return path.join(opts.tenantDir, 'workflows');
  return resolveFromCwd(DEFAULT_WORKFLOW_OPTIONS.path);
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

export function isSafeWorkflowName(name: string): boolean {
  return SAFE_NAME_RE.test(name);
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
    return invalid(invalidCode, `definition escapes workflow.dir: ${match}`);
  }
  return { ok: true, path: await realpath(match) };
}

/**
 * CLI `workflow run <name-or-path>`：
 * - 绝对路径：直接用；
 * - 含分隔符：按 workflow.dir 解析并做包含性校验；
 * - 单段 name：安全字符集 + `.yaml|yml|json`。
 */
export async function resolveWorkflowDefinition(
  config: VesselConfig,
  nameOrPath: string,
): Promise<ResolutionResult> {
  const raw = nameOrPath.trim();
  if (raw === '') return invalid('workflow_invalid', 'definition path is required');

  const dir = resolveWorkflowDir(config);

  if (path.isAbsolute(raw)) {
    const normalized = path.normalize(raw);
    if (!(await isFile(normalized))) return notFound('workflow_not_found', raw);
    return { ok: true, path: await realpath(normalized) };
  }

  if (/[\\/]/.test(raw)) {
    const candidate = path.resolve(dir, raw);
    // 先做词法包含性校验：`..` 逃逸报 workflow_invalid，且不泄露目录外文件是否存在。
    const rel = path.relative(dir, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return invalid('workflow_invalid', `definition escapes workflow.dir: ${raw}`);
    }
    if (!(await isFile(candidate))) return notFound('workflow_not_found', raw);
    // 再防 symlink 逃逸。
    if (!(await assertWithinDir(candidate, dir))) {
      return invalid('workflow_invalid', `definition escapes workflow.dir: ${raw}`);
    }
    return { ok: true, path: await realpath(candidate) };
  }

  if (!isSafeWorkflowName(raw)) {
    return invalid('workflow_invalid', `workflow name must match ${SAFE_NAME_RE.source}`);
  }

  return resolveDefinitionCandidates(dir, raw, 'workflow_not_found', 'workflow_invalid');
}

/**
 * gateway / TUI 专用：只接受单段安全名；失败返回 undefined。
 * 永不接受用户给的任意路径。
 */
export async function resolveWorkflowDefPath(
  config: VesselConfig,
  name: string,
): Promise<string | undefined> {
  if (!isSafeWorkflowName(name)) return undefined;
  const resolved = await resolveWorkflowDefinition(config, name);
  return resolved.ok ? resolved.path : undefined;
}

/**
 * gateway 同步版（Addendum A §10.3 冻结 `resolveDefinition(name): string | undefined`）。
 * 只接受单段安全名；多个命中 / 越界 / 不存在 → undefined。
 */
export function resolveWorkflowDefPathSync(config: VesselConfig, name: string): string | undefined {
  if (!isSafeWorkflowName(name)) return undefined;

  try {
    const dir = resolveWorkflowDir(config);
    const dirReal = realpathSync.native(dir);
    const matches: string[] = [];
    for (const extension of DEFINITION_EXTENSIONS) {
      const candidate = path.join(dir, `${name}.${extension}`);
      try {
        if (statSync(candidate).isFile()) matches.push(candidate);
      } catch {
        // 不存在则跳过
      }
    }
    if (matches.length !== 1) return undefined;

    const fileReal = realpathSync.native(matches[0] as string);
    const rel = path.relative(dirReal, fileReal);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return fileReal;
  } catch {
    return undefined;
  }
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
