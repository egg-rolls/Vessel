/**
 * 定义文件解析、严格校验与路径解析。
 *
 * 路径规则（Addendum B §11.1.8/9）：
 * - 相对路径按 workflow.dir 解析，拒绝 `..` 越界与 symlink 逃逸；
 * - 单段 name 按 .yaml → .yml → .json 顺序解析，多个命中 = workflow_invalid；
 * - CLI 允许绝对路径。
 */

import * as nodeFs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { invalid, notFound } from './errors.js';
import { validateDependencies } from './graph.js';
import { validateDefinitionTemplates } from './template.js';
import type {
  WorkflowDefinition,
  WorkflowDirent,
  WorkflowFs,
  WorkflowOnError,
  WorkflowStepDefinition,
  WorkflowWhen,
  WorkflowWhenStatus,
} from './types.js';

export const nodeWorkflowFs: WorkflowFs = {
  mkdir: (target, options) => nodeFs.mkdir(target, options ?? {}),
  readFile: (target, encoding) => nodeFs.readFile(target, encoding),
  writeFile: (target, data, encoding) => nodeFs.writeFile(target, data, encoding),
  rename: (oldPath, newPath) => nodeFs.rename(oldPath, newPath),
  unlink: (target) => nodeFs.unlink(target),
  readdir: async (target, options) =>
    (await nodeFs.readdir(target, options)) as unknown as WorkflowDirent[],
  stat: (target) => nodeFs.stat(target),
  realpath: (target) => nodeFs.realpath(target),
};

const STEP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) throw invalid(`${where}: unknown key "${key}"`);
  }
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${where}: "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`${where}: "${key}" must be a string`);
  return value;
}

function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  where: string,
  min: number,
  max: number,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${where}: "${key}" must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function parseOnError(value: unknown, where: string): WorkflowOnError | undefined {
  if (value === undefined) return undefined;
  if (value !== 'fail' && value !== 'continue') {
    throw invalid(`${where}: "on_error" must be "fail" or "continue"`);
  }
  return value;
}

function parseWhen(value: unknown, where: string): WorkflowWhen | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalid(`${where}: "when" must be an object`);
  assertKnownKeys(value, ['step', 'status', 'contains', 'equals'], where);
  const step = requireString(value, 'step', where);
  const when: WorkflowWhen = { step };

  if (value.status !== undefined) {
    const status = value.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'skipped') {
      throw invalid(`${where}: "when.status" must be completed, failed or skipped`);
    }
    when.status = status as WorkflowWhenStatus;
  }
  if (value.contains !== undefined) {
    if (typeof value.contains !== 'string') {
      throw invalid(`${where}: "when.contains" must be a string`);
    }
    when.contains = value.contains;
  }
  if (value.equals !== undefined) {
    if (typeof value.equals !== 'string') {
      throw invalid(`${where}: "when.equals" must be a string`);
    }
    when.equals = value.equals;
  }
  if (when.contains !== undefined && when.equals !== undefined) {
    throw invalid(`${where}: "when.contains" and "when.equals" are mutually exclusive`);
  }
  return when;
}

function parseStep(raw: unknown, index: number): WorkflowStepDefinition {
  const where = `steps[${index}]`;
  if (!isRecord(raw)) throw invalid(`${where} must be an object`);
  assertKnownKeys(
    raw,
    ['id', 'type', 'agent', 'prompt', 'tool', 'args', 'depends_on', 'when', 'retry', 'on_error'],
    where,
  );

  const id = requireString(raw, 'id', where);
  if (!STEP_ID.test(id)) {
    throw invalid(`${where}: "id" must match ${STEP_ID.source}`);
  }

  const type = raw.type;
  if (type !== 'agent' && type !== 'tool') {
    throw invalid(`${where}: "type" must be "agent" or "tool"`);
  }

  const step: WorkflowStepDefinition = { id, type };

  const agent = optionalString(raw, 'agent', where);
  if (agent !== undefined) step.agent = agent;
  const prompt = optionalString(raw, 'prompt', where);
  if (prompt !== undefined) step.prompt = prompt;
  const tool = optionalString(raw, 'tool', where);
  if (tool !== undefined) step.tool = tool;

  if (type === 'agent' && prompt === undefined) {
    throw invalid(`${where}: agent step requires "prompt"`);
  }
  if (type === 'tool' && (tool === undefined || tool === '')) {
    throw invalid(`${where}: tool step requires "tool"`);
  }

  if (raw.args !== undefined) {
    if (!isRecord(raw.args)) throw invalid(`${where}: "args" must be an object`);
    step.args = raw.args;
  }

  if (raw.depends_on !== undefined) {
    if (!Array.isArray(raw.depends_on)) {
      throw invalid(`${where}: "depends_on" must be an array`);
    }
    const deps: string[] = [];
    for (const dep of raw.depends_on) {
      if (typeof dep !== 'string' || dep === '') {
        throw invalid(`${where}: "depends_on" entries must be non-empty strings`);
      }
      if (deps.includes(dep)) throw invalid(`${where}: duplicate dependency "${dep}"`);
      deps.push(dep);
    }
    step.depends_on = deps;
  }

  const when = parseWhen(raw.when, where);
  if (when !== undefined) step.when = when;

  if (raw.retry !== undefined) {
    if (!isRecord(raw.retry)) throw invalid(`${where}: "retry" must be an object`);
    assertKnownKeys(raw.retry, ['max_attempts', 'backoff_ms'], `${where}.retry`);
    const retry: WorkflowStepDefinition['retry'] = {};
    const maxAttempts = optionalInteger(raw.retry, 'max_attempts', `${where}.retry`, 1, 10);
    if (maxAttempts !== undefined) retry.max_attempts = maxAttempts;
    const backoff = optionalInteger(raw.retry, 'backoff_ms', `${where}.retry`, 0, 60_000);
    if (backoff !== undefined) retry.backoff_ms = backoff;
    step.retry = retry;
  }

  const onError = parseOnError(raw.on_error, where);
  if (onError !== undefined) step.on_error = onError;

  return step;
}

/** 解析并严格校验定义文本。 */
export function parseWorkflowDefinition(
  source: string,
  sourcePath = '<workflow>',
): WorkflowDefinition {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw invalid(
      `${sourcePath}: cannot parse workflow definition: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!isRecord(raw)) throw invalid(`${sourcePath}: workflow definition must be an object`);
  assertKnownKeys(
    raw,
    ['name', 'description', 'version', 'defaults', 'steps', 'on_error'],
    sourcePath,
  );

  const name = requireString(raw, 'name', sourcePath);
  const definition: WorkflowDefinition = { name, steps: [] };

  const description = optionalString(raw, 'description', sourcePath);
  if (description !== undefined) definition.description = description;

  if (raw.version !== undefined) {
    if (raw.version !== 1) throw invalid(`${sourcePath}: unsupported version (expected 1)`);
    definition.version = 1;
  }

  if (raw.defaults !== undefined) {
    if (!isRecord(raw.defaults)) throw invalid(`${sourcePath}: "defaults" must be an object`);
    assertKnownKeys(
      raw.defaults,
      ['agent', 'max_parallel', 'step_timeout_ms'],
      `${sourcePath}.defaults`,
    );
    const defaults: WorkflowDefinition['defaults'] = {};
    const agent = optionalString(raw.defaults, 'agent', `${sourcePath}.defaults`);
    if (agent !== undefined) defaults.agent = agent;
    const maxParallel = optionalInteger(
      raw.defaults,
      'max_parallel',
      `${sourcePath}.defaults`,
      1,
      8,
    );
    if (maxParallel !== undefined) defaults.max_parallel = maxParallel;
    const stepTimeout = optionalInteger(
      raw.defaults,
      'step_timeout_ms',
      `${sourcePath}.defaults`,
      1,
      86_400_000,
    );
    if (stepTimeout !== undefined) defaults.step_timeout_ms = stepTimeout;
    definition.defaults = defaults;
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw invalid(`${sourcePath}: "steps" must be a non-empty array`);
  }
  const steps: WorkflowStepDefinition[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.steps.length; i += 1) {
    const step = parseStep(raw.steps[i], i);
    if (seen.has(step.id)) throw invalid(`${sourcePath}: duplicate step id "${step.id}"`);
    seen.add(step.id);
    steps.push(step);
  }
  definition.steps = steps;

  const onError = parseOnError(raw.on_error, sourcePath);
  if (onError !== undefined) definition.on_error = onError;

  // type=agent 必须能解析出成员 id。
  for (const step of steps) {
    if (
      step.type === 'agent' &&
      step.agent === undefined &&
      definition.defaults?.agent === undefined
    ) {
      throw invalid(`${sourcePath}: step "${step.id}" requires "agent" or defaults.agent`);
    }
  }

  validateDependencies(steps);

  for (const step of steps) {
    if (step.when && !(step.depends_on ?? []).includes(step.when.step)) {
      throw invalid(
        `${sourcePath}: step "${step.id}" uses when.step "${step.when.step}" which is not in depends_on`,
      );
    }
  }

  validateDefinitionTemplates(definition);
  return definition;
}

async function isFile(target: string, fsOps: WorkflowFs): Promise<boolean> {
  try {
    const stat = await fsOps.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function assertFile(target: string, fsOps: WorkflowFs): Promise<void> {
  if (!(await isFile(target, fsOps))) {
    throw notFound(`workflow definition not found: ${target}`);
  }
}

async function assertWithinDir(target: string, dir: string, fsOps: WorkflowFs): Promise<void> {
  let dirReal: string;
  let fileReal: string;
  try {
    dirReal = await fsOps.realpath(dir);
  } catch {
    throw notFound(`workflow.dir does not exist: ${dir}`);
  }
  try {
    fileReal = await fsOps.realpath(target);
  } catch {
    throw notFound(`workflow definition not found: ${target}`);
  }
  const relative = path.relative(dirReal, fileReal);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalid(`definition path escapes workflow.dir: ${target}`);
  }
}

/**
 * 解析 name-or-path 为绝对路径。
 * 相对路径按 dir 解析并拒绝越界；绝对路径直接使用（CLI 允许）。
 */
export async function resolveDefinitionPath(
  nameOrPath: string,
  dir: string,
  fsOps: WorkflowFs = nodeWorkflowFs,
): Promise<string> {
  if (typeof nameOrPath !== 'string' || nameOrPath.trim() === '') {
    throw invalid('definition path is required');
  }

  if (path.isAbsolute(nameOrPath)) {
    const resolved = path.normalize(nameOrPath);
    await assertFile(resolved, fsOps);
    return resolved;
  }

  if (/[\\/]/.test(nameOrPath)) {
    const resolved = path.resolve(dir, nameOrPath);
    await assertWithinDir(resolved, dir, fsOps);
    await assertFile(resolved, fsOps);
    return resolved;
  }

  if (!SAFE_NAME.test(nameOrPath)) {
    throw invalid(`workflow name must match ${SAFE_NAME.source}`);
  }

  const existing: string[] = [];
  for (const extension of ['yaml', 'yml', 'json']) {
    const candidate = path.join(dir, `${nameOrPath}.${extension}`);
    if (await isFile(candidate, fsOps)) existing.push(candidate);
  }
  if (existing.length === 0) {
    throw notFound(`workflow "${nameOrPath}" not found in ${dir}`);
  }
  if (existing.length > 1) {
    throw invalid(`workflow name "${nameOrPath}" is ambiguous: ${existing.join(', ')}`);
  }
  return existing[0] as string;
}

/** 读取、解析、校验定义文件。 */
export async function loadWorkflowDefinition(
  filePath: string,
  fsOps: WorkflowFs = nodeWorkflowFs,
): Promise<WorkflowDefinition> {
  let source: string;
  try {
    source = await fsOps.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw notFound(`workflow definition not found: ${filePath}`);
    throw invalid(
      `cannot read workflow definition "${filePath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseWorkflowDefinition(source, filePath);
}

/** 解析并加载（asm/tui/gateway 的 name 入口）。 */
export async function resolveDefinition(
  nameOrPath: string,
  dir: string,
  fsOps: WorkflowFs = nodeWorkflowFs,
): Promise<{ path: string; definition: WorkflowDefinition }> {
  const resolved = await resolveDefinitionPath(nameOrPath, dir, fsOps);
  return { path: resolved, definition: await loadWorkflowDefinition(resolved, fsOps) };
}
