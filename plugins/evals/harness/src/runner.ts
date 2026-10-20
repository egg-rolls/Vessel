/**
 * Eval 运行器：逐 case 执行、fresh/shared、超时、断言与报告。
 * 默认完全离线（ScriptedProvider）；真实 provider 必须显式 allowNetwork。
 */

import * as path from 'node:path';
import {
  AgentRuntime,
  type EventStream,
  type LLMProvider,
  MemoryContextManager,
  MemoryEventStream,
  type RunEvent,
  type RunnableAgent,
} from '@vessel-agent/core';
import { evaluateAssertions } from './assertions.js';
import { EvalsError, invalid } from './errors.js';
import { ScriptedProvider, SwitchableProvider } from './mock-provider.js';
import { reportFileName, reportTimestamp, writeReport } from './report.js';
import { loadEvalSuite, resolveSuitePath } from './suite.js';
import type {
  EvalCase,
  EvalCaseResult,
  EvalReport,
  EvalRunOptions,
  EvalSessionMode,
  EvalSuite,
  EvalUsage,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = 'eval-mock';
const NETWORK_MODEL = 'eval-network';
const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function normalizeTenantId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!TENANT_ID_RE.test(value)) throw invalid(`invalid tenant id "${value}"`);
  return value;
}

function publishEvalEvent(
  events: EventStream | undefined,
  tenantId: string | undefined,
  type: string,
  suite: string,
  data: Record<string, unknown>,
  ts: number,
): void {
  if (!events) return;
  events.publish({
    type,
    run_id: `eval:${suite}`,
    data,
    ts,
    ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
  });
}

interface RuntimeBundle {
  runtime: RunnableAgent;
  events: EventStream;
  captured: RunEvent[];
  scripted?: ScriptedProvider;
  switchable?: SwitchableProvider;
}

interface SharedRuntime {
  bundle?: RuntimeBundle;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createDefaultBundle(
  options: Omit<EvalRunOptions, 'suitePath'>,
  provider: LLMProvider,
  extras: { scripted?: ScriptedProvider; switchable?: SwitchableProvider } = {},
): Promise<RuntimeBundle> {
  const events = new MemoryEventStream();
  const runtime = await AgentRuntime.create({
    provider,
    model: options.model ?? (options.providerFactory ? NETWORK_MODEL : DEFAULT_MODEL),
    context: new MemoryContextManager(),
    events,
    limits: {},
    termination: { maxIterations: 10 },
    ...(options.plugins ? { plugins: options.plugins } : {}),
  });

  const captured: RunEvent[] = [];
  events.subscribe((event) => {
    captured.push(event);
  });

  return {
    runtime,
    events,
    captured,
    ...(extras.scripted ? { scripted: extras.scripted } : {}),
    ...(extras.switchable ? { switchable: extras.switchable } : {}),
  };
}

function attachCollector(runtime: RunnableAgent): RuntimeBundle {
  const captured: RunEvent[] = [];
  runtime.events.subscribe((event) => {
    captured.push(event);
  });
  return { runtime, events: runtime.events, captured };
}

function toolNames(caseEvents: RunEvent[]): string[] {
  const names: string[] = [];
  for (const event of caseEvents) {
    if (event.type !== 'tool.call.started') continue;
    const data = event.data as Record<string, unknown>;
    if (typeof data.tool_name === 'string') names.push(data.tool_name);
  }
  return names;
}

function lastCompleted(caseEvents: RunEvent[]): Record<string, unknown> | undefined {
  let completed: Record<string, unknown> | undefined;
  for (const event of caseEvents) {
    if (event.type === 'run.completed') completed = event.data as Record<string, unknown>;
  }
  return completed;
}

function usageFromEvent(value: unknown): EvalUsage | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = value.prompt_tokens;
  const completion = value.completion_tokens;
  const total = value.total_tokens;
  if (typeof prompt !== 'number' && typeof completion !== 'number' && typeof total !== 'number') {
    return undefined;
  }
  return {
    prompt_tokens: typeof prompt === 'number' ? prompt : 0,
    completion_tokens: typeof completion === 'number' ? completion : 0,
    total_tokens: typeof total === 'number' ? total : 0,
  };
}

function usageFromEvents(caseEvents: RunEvent[]): EvalUsage | undefined {
  const completed = lastCompleted(caseEvents);
  const direct = usageFromEvent(completed?.usage);
  if (direct) return direct;

  let prompt = 0;
  let completion = 0;
  let total = 0;
  let seen = false;
  for (const event of caseEvents) {
    if (event.type !== 'llm.response') continue;
    const usage = usageFromEvent((event.data as Record<string, unknown>).usage);
    if (!usage) continue;
    seen = true;
    prompt += usage.prompt_tokens;
    completion += usage.completion_tokens;
    total += usage.total_tokens;
  }
  return seen
    ? { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }
    : undefined;
}

function iterationsFromEvents(caseEvents: RunEvent[]): number | undefined {
  const completed = lastCompleted(caseEvents);
  const iterations = completed?.iterations;
  return typeof iterations === 'number' ? iterations : undefined;
}

function skippedResult(id: string): EvalCaseResult {
  return { id, status: 'skipped', duration_ms: 0, assertions: [] };
}

async function runCase(
  suite: EvalSuite,
  testCase: EvalCase,
  index: number,
  options: Omit<EvalRunOptions, 'suitePath'>,
  shared: SharedRuntime,
  network: boolean,
): Promise<EvalCaseResult> {
  const session: EvalSessionMode = testCase.session ?? suite.defaults?.session ?? 'fresh';
  const timeoutMs = testCase.timeout_ms ?? suite.defaults?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const sessionId =
    session === 'shared' ? `eval:${suite.name}` : `eval:${suite.name}:${testCase.id}`;

  let bundle: RuntimeBundle | undefined;
  let disposable = false;

  try {
    if (options.createRuntime) {
      if (session === 'shared') {
        if (!shared.bundle) {
          const runtime = await options.createRuntime({ suite, testCase, session, index });
          shared.bundle = attachCollector(runtime);
        }
        bundle = shared.bundle;
      } else {
        const runtime = await options.createRuntime({ suite, testCase, session, index });
        bundle = attachCollector(runtime);
        disposable = true;
      }
    } else if (session === 'shared') {
      if (!shared.bundle) {
        if (network) {
          shared.bundle = await createDefaultBundle(
            options,
            (options.providerFactory as () => LLMProvider)(),
          );
        } else {
          const switchable = new SwitchableProvider();
          shared.bundle = await createDefaultBundle(options, switchable, { switchable });
        }
      }
      bundle = shared.bundle;
      bundle.switchable?.set(testCase.mock?.responses ?? []);
    } else if (network) {
      bundle = await createDefaultBundle(options, (options.providerFactory as () => LLMProvider)());
      disposable = true;
    } else {
      const scripted = new ScriptedProvider(testCase.mock?.responses ?? []);
      bundle = await createDefaultBundle(options, scripted, { scripted });
      disposable = true;
    }

    const mark = bundle.captured.length;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const started = (options.now ?? Date.now)();
    let output = '';
    let error: string | undefined;
    try {
      output = await bundle.runtime.run(testCase.input, sessionId, {
        signal: controller.signal,
      });
    } catch (cause) {
      error = timedOut ? `timed out after ${timeoutMs}ms` : errorMessage(cause);
    } finally {
      clearTimeout(timer);
    }
    const duration = (options.now ?? Date.now)() - started;

    const caseEvents = bundle.captured.slice(mark);
    const iterations = iterationsFromEvents(caseEvents);
    const usage = usageFromEvents(caseEvents);
    const assertions = evaluateAssertions(testCase.expect, {
      output,
      ...(error !== undefined ? { error } : {}),
      duration_ms: duration,
      ...(iterations !== undefined ? { iterations } : {}),
      ...(usage !== undefined ? { usage } : {}),
      toolNames: toolNames(caseEvents),
    });

    const status: EvalCaseResult['status'] =
      error !== undefined
        ? 'error'
        : assertions.every((assertion) => assertion.ok)
          ? 'passed'
          : 'failed';

    const result: EvalCaseResult = {
      id: testCase.id,
      status,
      duration_ms: duration,
      assertions,
      output,
    };
    if (error !== undefined) result.error = error;
    if (usage !== undefined) result.usage = usage;
    const mockExhausted =
      bundle.scripted?.exhausted === true || bundle.switchable?.exhausted === true;
    if (mockExhausted) result.warnings = ['mock_exhausted'];
    return result;
  } catch (cause) {
    return {
      id: testCase.id,
      status: 'error',
      duration_ms: 0,
      assertions: [],
      error: errorMessage(cause),
    };
  } finally {
    if (disposable) bundle?.runtime.dispose();
  }
}

export async function runEvalSuite(
  suitePath: string,
  options: Omit<EvalRunOptions, 'suitePath'> = {},
): Promise<EvalReport> {
  if (options.enabled === false) {
    throw invalid('evals are disabled (evals.enabled=false)');
  }

  const suiteFile = await resolveSuitePath(suitePath, options.suiteDir);
  const suite = await loadEvalSuite(suiteFile);

  const network = options.providerFactory !== undefined;
  if (network && options.allowNetwork !== true) {
    throw new EvalsError(
      'eval_network_required',
      'network provider requires --allow-network (or allowNetwork: true)',
    );
  }

  const tenantId = normalizeTenantId(options.tenantId);
  const now = options.now ?? Date.now;
  const startedAt = now();
  publishEvalEvent(
    options.events,
    tenantId,
    'eval.run.started',
    suite.name,
    {
      network,
      total: suite.cases.length,
    },
    startedAt,
  );
  const filterTags = options.filterTags ?? [];
  const shared: SharedRuntime = {};
  const results: EvalCaseResult[] = [];

  try {
    for (let index = 0; index < suite.cases.length; index += 1) {
      const testCase = suite.cases[index] as EvalCase;
      if (filterTags.length > 0 && !(testCase.tags ?? []).some((tag) => filterTags.includes(tag))) {
        results.push(skippedResult(testCase.id));
        continue;
      }
      results.push(await runCase(suite, testCase, index, options, shared, network));
    }
  } finally {
    shared.bundle?.runtime.dispose();
  }

  const finishedAt = now();
  const report: EvalReport = {
    suite: suite.name,
    network,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: finishedAt - startedAt,
    total: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    errors: results.filter((result) => result.status === 'error').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    cases: results,
    ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
  };
  publishEvalEvent(
    options.events,
    tenantId,
    'eval.run.completed',
    suite.name,
    {
      network,
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      errors: report.errors,
      skipped: report.skipped,
      duration_ms: report.duration_ms,
    },
    finishedAt,
  );

  const timestamp = options.timestamp ?? reportTimestamp(new Date(finishedAt));
  const outPath =
    options.outPath ??
    (options.outDir !== undefined
      ? path.join(options.outDir, reportFileName(suite.name, timestamp))
      : undefined);
  if (outPath === undefined) {
    throw invalid('either outDir or outPath is required');
  }

  await writeReport(report, outPath);
  return report;
}

/** 供测试/诊断：显式构造默认路径。 */
export function defaultReportPath(outDir: string, suite: string, timestamp: string): string {
  return path.join(outDir, reportFileName(suite, timestamp));
}
