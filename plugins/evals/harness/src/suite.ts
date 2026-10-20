/**
 * Suite 解析、严格校验与 suite 路径解析。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolCall } from '@vessel/core';
import { parse as parseYaml } from 'yaml';
import { invalid, notFound } from './errors.js';
import type {
  EvalAssertion,
  EvalAssertionType,
  EvalCase,
  EvalDefaults,
  EvalMock,
  EvalMockResponse,
  EvalSessionMode,
  EvalSuite,
} from './types.js';

const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const ASSERTION_TYPES: ReadonlySet<EvalAssertionType> = new Set([
  'output_contains',
  'output_matches',
  'no_error',
  'tool_called',
  'tool_not_called',
  'max_duration_ms',
  'max_iterations',
  'usage_under',
]);

const USAGE_FIELDS = ['total_tokens', 'prompt_tokens', 'completion_tokens'] as const;

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

function optionalStringArray(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw invalid(`${where} must be an array of non-empty strings`);
  }
  return value as string[];
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

function parseSession(value: unknown, where: string): EvalSessionMode | undefined {
  if (value === undefined) return undefined;
  if (value !== 'fresh' && value !== 'shared') {
    throw invalid(`${where}: "session" must be "fresh" or "shared"`);
  }
  return value;
}

function parseUsageUnder(value: unknown, where: string): Record<string, number> {
  if (!isRecord(value)) throw invalid(`${where}: "usage_under.value" must be an object`);
  assertKnownKeys(value, USAGE_FIELDS, where);
  const result: Record<string, number> = {};
  for (const field of USAGE_FIELDS) {
    const threshold = value[field];
    if (threshold === undefined) continue;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) {
      throw invalid(`${where}: "usage_under.value.${field}" must be a non-negative number`);
    }
    result[field] = threshold;
  }
  if (Object.keys(result).length === 0) {
    throw invalid(
      `${where}: "usage_under.value" requires at least one of ${USAGE_FIELDS.join(', ')}`,
    );
  }
  return result;
}

function parseAssertion(raw: unknown, where: string): EvalAssertion {
  if (!isRecord(raw)) throw invalid(`${where} must be an object`);
  assertKnownKeys(raw, ['type', 'value'], where);
  const type = raw.type;
  if (typeof type !== 'string' || !ASSERTION_TYPES.has(type as EvalAssertionType)) {
    throw invalid(`${where}: unknown assertion type "${String(type)}"`);
  }

  const assertionType = type as EvalAssertionType;
  const value = raw.value;

  switch (assertionType) {
    case 'no_error':
      return { type: assertionType };
    case 'output_contains':
    case 'tool_called':
    case 'tool_not_called':
      if (typeof value !== 'string') {
        throw invalid(`${where}: "${assertionType}" requires a string value`);
      }
      return { type: assertionType, value };
    case 'output_matches': {
      if (typeof value !== 'string') {
        throw invalid(`${where}: "output_matches" requires a string value`);
      }
      try {
        new RegExp(value);
      } catch {
        throw invalid(`${where}: "output_matches" value is not a valid regular expression`);
      }
      return { type: assertionType, value };
    }
    case 'max_duration_ms':
    case 'max_iterations':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw invalid(`${where}: "${assertionType}" requires a non-negative number value`);
      }
      return { type: assertionType, value };
    case 'usage_under':
      return { type: assertionType, value: parseUsageUnder(value, where) };
  }
}

function parseToolCalls(value: unknown, where: string): ToolCall[] {
  if (!Array.isArray(value)) throw invalid(`${where}: "tool_calls" must be an array`);
  return value.map((item, index) => {
    const callWhere = `${where}[${index}]`;
    if (!isRecord(item)) throw invalid(`${callWhere} must be an object`);
    assertKnownKeys(item, ['id', 'type', 'function'], callWhere);
    const id = requireString(item, 'id', callWhere);
    if (item.type !== 'function') throw invalid(`${callWhere}: "type" must be "function"`);
    const fn = item.function;
    if (!isRecord(fn)) throw invalid(`${callWhere}: "function" must be an object`);
    assertKnownKeys(fn, ['name', 'arguments'], `${callWhere}.function`);
    const name = requireString(fn, 'name', `${callWhere}.function`);
    const args = fn.arguments;
    if (typeof args !== 'string') {
      throw invalid(`${callWhere}.function: "arguments" must be a string`);
    }
    return { id, type: 'function', function: { name, arguments: args } };
  });
}

function parseMock(raw: unknown, where: string): EvalMock | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw invalid(`${where}: "mock" must be an object`);
  assertKnownKeys(raw, ['responses'], where);
  if (!Array.isArray(raw.responses)) {
    throw invalid(`${where}: "mock.responses" must be an array`);
  }
  const responses: EvalMockResponse[] = raw.responses.map((item, index) => {
    const responseWhere = `${where}.mock.responses[${index}]`;
    if (!isRecord(item)) throw invalid(`${responseWhere} must be an object`);
    assertKnownKeys(item, ['content', 'tool_calls'], responseWhere);
    if (typeof item.content !== 'string') {
      throw invalid(`${responseWhere}: "content" must be a string`);
    }
    const response: EvalMockResponse = { content: item.content };
    if (item.tool_calls !== undefined) {
      response.tool_calls = parseToolCalls(item.tool_calls, `${responseWhere}.tool_calls`);
    }
    return response;
  });
  return { responses };
}

function parseDefaults(raw: unknown, where: string): EvalDefaults | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw invalid(`${where}: "defaults" must be an object`);
  assertKnownKeys(raw, ['timeout_ms', 'tags', 'session'], where);
  const defaults: EvalDefaults = {};
  const timeout = optionalInteger(raw, 'timeout_ms', where, 1, 86_400_000);
  if (timeout !== undefined) defaults.timeout_ms = timeout;
  const tags = optionalStringArray(raw.tags, `${where}.tags`);
  if (tags !== undefined) defaults.tags = tags;
  const session = parseSession(raw.session, where);
  if (session !== undefined) defaults.session = session;
  return defaults;
}

function parseCase(raw: unknown, index: number): EvalCase {
  const where = `cases[${index}]`;
  if (!isRecord(raw)) throw invalid(`${where} must be an object`);
  assertKnownKeys(raw, ['id', 'input', 'tags', 'timeout_ms', 'session', 'mock', 'expect'], where);

  const id = requireString(raw, 'id', where);
  const input = raw.input;
  if (typeof input !== 'string') throw invalid(`${where}: "input" must be a string`);

  const testCase: EvalCase = { id, input, expect: [] };

  const tags = optionalStringArray(raw.tags, `${where}.tags`);
  if (tags !== undefined) testCase.tags = tags;

  const timeout = optionalInteger(raw, 'timeout_ms', where, 1, 86_400_000);
  if (timeout !== undefined) testCase.timeout_ms = timeout;

  const session = parseSession(raw.session, where);
  if (session !== undefined) testCase.session = session;

  const mock = parseMock(raw.mock, where);
  if (mock !== undefined) testCase.mock = mock;

  if (raw.expect !== undefined) {
    if (!Array.isArray(raw.expect)) throw invalid(`${where}: "expect" must be an array`);
    testCase.expect = raw.expect.map((item, assertionIndex) =>
      parseAssertion(item, `${where}.expect[${assertionIndex}]`),
    );
  }

  return testCase;
}

/** 解析并严格校验 suite 文本。 */
export function parseEvalSuite(source: string, sourcePath = '<suite>'): EvalSuite {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw invalid(
      `${sourcePath}: cannot parse eval suite: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!isRecord(raw)) throw invalid(`${sourcePath}: eval suite must be an object`);
  assertKnownKeys(raw, ['name', 'description', 'defaults', 'cases'], sourcePath);

  const name = requireString(raw, 'name', sourcePath);
  if (!SAFE_NAME.test(name)) {
    throw invalid(`${sourcePath}: suite name must match ${SAFE_NAME.source}`);
  }

  const suite: EvalSuite = { name, cases: [] };

  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string') {
      throw invalid(`${sourcePath}: "description" must be a string`);
    }
    suite.description = raw.description;
  }

  const defaults = parseDefaults(raw.defaults, `${sourcePath}.defaults`);
  if (defaults !== undefined) suite.defaults = defaults;

  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw invalid(`${sourcePath}: "cases" must be a non-empty array`);
  }

  const seen = new Set<string>();
  suite.cases = raw.cases.map((item, index) => {
    const testCase = parseCase(item, index);
    if (seen.has(testCase.id)) throw invalid(`${sourcePath}: duplicate case id "${testCase.id}"`);
    seen.add(testCase.id);
    return testCase;
  });

  return suite;
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

async function assertFile(target: string): Promise<void> {
  if (!(await isFile(target))) throw notFound(`eval suite not found: ${target}`);
}

/**
 * 解析 suite name-or-path。
 * - 提供 suiteDir 且是单段名：按 .yaml → .yml → .json 解析；多个命中 = eval_invalid；
 * - 其他情况按路径处理（相对进程 cwd）。
 */
export async function resolveSuitePath(nameOrPath: string, suiteDir?: string): Promise<string> {
  if (typeof nameOrPath !== 'string' || nameOrPath.trim() === '') {
    throw invalid('suite path is required');
  }

  if (!/[\\/]/.test(nameOrPath) && suiteDir !== undefined) {
    if (!SAFE_NAME.test(nameOrPath)) {
      throw invalid(`suite name must match ${SAFE_NAME.source}`);
    }
    const existing: string[] = [];
    for (const extension of ['yaml', 'yml', 'json']) {
      const candidate = path.join(suiteDir, `${nameOrPath}.${extension}`);
      if (await isFile(candidate)) existing.push(candidate);
    }
    if (existing.length === 0) {
      throw notFound(`eval suite "${nameOrPath}" not found in ${suiteDir}`);
    }
    if (existing.length > 1) {
      throw invalid(`eval suite name "${nameOrPath}" is ambiguous: ${existing.join(', ')}`);
    }
    return existing[0] as string;
  }

  const resolved = path.isAbsolute(nameOrPath)
    ? path.normalize(nameOrPath)
    : path.resolve(process.cwd(), nameOrPath);
  await assertFile(resolved);
  return resolved;
}

/** 读取、解析、校验 suite 文件。 */
export async function loadEvalSuite(filePath: string): Promise<EvalSuite> {
  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw notFound(`eval suite not found: ${filePath}`);
    throw invalid(
      `cannot read eval suite "${filePath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseEvalSuite(source, filePath);
}
