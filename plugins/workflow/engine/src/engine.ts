/**
 * Workflow 引擎：DAG 调度、重试、超时、取消/中断、resume。
 *
 * 冻结工厂签名（Addendum B §11.1.11）：
 *   createWorkflowEngine({ host?, runtime?, pluginHost, config, events })
 */

import { randomUUID } from 'node:crypto';
import type {
  EventStream,
  PluginHost,
  RunnableAgent,
  RuntimeHost,
  ToolContext,
} from '@vessel/core';
import { invalid, notFound, WorkflowError } from './errors.js';
import { publishWorkflowEvent } from './events.js';
import { loadWorkflowDefinition, nodeWorkflowFs, resolveDefinitionPath } from './schema.js';
import {
  isTerminalRunStatus,
  isTerminalStepStatus,
  outputPreview,
  runDetail,
  runSummary,
} from './state.js';
import { WorkflowStore } from './store.js';
import {
  interpolate,
  interpolateValue,
  stepAgentId,
  type TemplateContext,
  validateDefinitionInputs,
} from './template.js';
import type {
  ResolvedWorkflowConfig,
  WorkflowDefinition,
  WorkflowEngine,
  WorkflowEngineOptions,
  WorkflowFs,
  WorkflowOutcome,
  WorkflowRunDetail,
  WorkflowRunFile,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowStepDefinition,
  WorkflowStepState,
} from './types.js';

const MAX_PARALLEL_LIMIT = 8;
const FINALIZE_GRACE_MS = 5000;

interface RunningStep {
  controller: AbortController;
  promise: Promise<void>;
}

interface ActiveRun {
  file: WorkflowRunFile;
  running: Map<string, RunningStep>;
  done: Promise<WorkflowOutcome>;
  resolveDone: (outcome: WorkflowOutcome) => void;
  cancelRequested: boolean;
  interruptRequested: boolean;
  failFast: boolean;
  failure?: string;
  finalizing: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function normalizeInputs(inputs?: Record<string, string>): Record<string, string> {
  if (inputs === undefined) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value !== 'string') {
      throw invalid(`workflow input "${key}" must be a string`);
    }
    result[key] = value;
  }
  return result;
}

function buildRunFile(
  workflowRunId: string,
  definitionPath: string,
  definition: WorkflowDefinition,
  inputs: Record<string, string>,
  now: number,
): WorkflowRunFile {
  return {
    schema_version: 1,
    workflow_run_id: workflowRunId,
    workflow_name: definition.name,
    definition_path: definitionPath,
    definition,
    inputs,
    status: 'pending',
    steps: definition.steps.map((step) => ({
      id: step.id,
      type: step.type,
      status: 'pending',
      attempts: 0,
      output: '',
    })),
    started_at: now,
    updated_at: now,
  };
}

export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  return new WorkflowEngineImpl(options);
}

class WorkflowEngineImpl implements WorkflowEngine {
  readonly name = 'workflow';
  readonly version = '0.3.0';
  readonly description = 'Declarative workflow engine (agent / tool steps, resume, events)';

  private readonly config: ResolvedWorkflowConfig;
  private readonly events: EventStream;
  private readonly pluginHost: PluginHost;
  private readonly host?: RuntimeHost;
  private readonly runtime?: RunnableAgent;
  private readonly fsOps: WorkflowFs;
  private readonly store: WorkflowStore;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: WorkflowEngineOptions) {
    this.config = options.config;
    this.events = options.events;
    this.pluginHost = options.pluginHost;
    if (options.host !== undefined) this.host = options.host;
    if (options.runtime !== undefined) this.runtime = options.runtime;
    this.fsOps = options.fs ?? nodeWorkflowFs;
    this.store = new WorkflowStore(this.config.path, this.fsOps);
  }

  /** 工具从构造时的 PluginHost 读取；install 不注册任何东西。 */
  install(_host: PluginHost): void {
    // no-op
  }

  async listRuns(opts?: {
    status?: WorkflowRunStatus;
    limit?: number;
  }): Promise<WorkflowRunSummary[]> {
    const files = await this.store.list(opts);
    return files.map(runSummary);
  }

  async getRun(workflowRunId: string): Promise<WorkflowRunDetail | null> {
    const file = await this.store.load(workflowRunId);
    return file ? runDetail(file) : null;
  }

  async start(
    definitionPath: string,
    opts?: { inputs?: Record<string, string> },
  ): Promise<{ workflowRunId: string; done: Promise<WorkflowOutcome> }> {
    this.assertEnabled();
    const absolute = await resolveDefinitionPath(definitionPath, this.config.dir, this.fsOps);
    const definition = await loadWorkflowDefinition(absolute, this.fsOps);
    const inputs = normalizeInputs(opts?.inputs);
    validateDefinitionInputs(definition, inputs);

    const workflowRunId = `wf_${randomUUID()}`;
    const file = buildRunFile(workflowRunId, absolute, definition, inputs, Date.now());
    this.validateRuntimeTools(file);
    await this.store.save(file);

    const active = this.createActive(file);
    this.active.set(workflowRunId, active);
    void this.execute(active, false);
    return { workflowRunId, done: active.done };
  }

  async resume(
    workflowRunId: string,
  ): Promise<{ workflowRunId: string; done: Promise<WorkflowOutcome> }> {
    this.assertEnabled();
    if (this.active.has(workflowRunId)) {
      throw new WorkflowError(
        'workflow_already_running',
        `workflow run "${workflowRunId}" is already running`,
      );
    }

    const file = await this.store.load(workflowRunId);
    if (!file) throw notFound(`workflow run not found: ${workflowRunId}`);
    if (file.status !== 'interrupted' && file.status !== 'failed' && file.status !== 'running') {
      throw new WorkflowError(
        'workflow_not_resumable',
        `workflow run "${workflowRunId}" is not resumable (status: ${file.status})`,
      );
    }

    for (const step of file.steps) {
      if (step.status === 'running' || step.status === 'pending' || step.status === 'failed') {
        step.status = 'pending';
        step.attempts = 0;
        step.output = '';
        step.output_preview = '';
        step.started_at = undefined;
        step.finished_at = undefined;
        step.error = undefined;
      }
    }

    file.status = 'running';
    file.error = undefined;
    file.finished_at = undefined;
    file.updated_at = Date.now();
    this.validateRuntimeTools(file);
    await this.store.save(file);

    const active = this.createActive(file);
    this.active.set(workflowRunId, active);
    void this.execute(active, true);
    return { workflowRunId, done: active.done };
  }

  async cancel(workflowRunId: string): Promise<void> {
    this.assertEnabled();
    const active = this.active.get(workflowRunId);
    if (active) {
      if (active.file.status === 'cancelled') return;
      if (isTerminalRunStatus(active.file.status)) {
        throw new WorkflowError(
          'workflow_invalid',
          `workflow run "${workflowRunId}" is not cancellable (status: ${active.file.status})`,
        );
      }
      active.cancelRequested = true;
      for (const running of active.running.values()) {
        running.controller.abort(new Error('workflow_cancelled'));
      }
      await active.done;
      return;
    }

    const file = await this.store.load(workflowRunId);
    if (!file) throw notFound(`workflow run not found: ${workflowRunId}`);
    if (file.status === 'cancelled') return;

    if (file.status === 'interrupted' || file.status === 'pending') {
      const now = Date.now();
      file.status = 'cancelled';
      file.updated_at = now;
      file.finished_at = now;
      await this.store.save(file);
      publishWorkflowEvent(this.events, 'workflow.cancelled', workflowRunId, {
        workflow_name: file.workflow_name,
        step_count: file.steps.length,
        completed_steps: file.steps.filter((step) => step.status === 'completed').length,
      });
      return;
    }

    throw new WorkflowError(
      'workflow_invalid',
      `workflow run "${workflowRunId}" is not cancellable (status: ${file.status})`,
    );
  }

  async interruptAll(reason?: string): Promise<void> {
    const runs = [...this.active.values()];
    for (const active of runs) {
      if (isTerminalRunStatus(active.file.status)) continue;
      active.interruptRequested = true;
      for (const running of active.running.values()) {
        running.controller.abort(new Error(reason ?? 'workflow_interrupted'));
      }
    }
    await Promise.allSettled(runs.map((active) => active.done));
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new WorkflowError('workflow_disabled', 'workflow is disabled');
    }
  }

  private createActive(file: WorkflowRunFile): ActiveRun {
    let resolveDone!: (outcome: WorkflowOutcome) => void;
    const done = new Promise<WorkflowOutcome>((resolve) => {
      resolveDone = resolve;
    });
    return {
      file,
      running: new Map(),
      done,
      resolveDone,
      cancelRequested: false,
      interruptRequested: false,
      failFast: false,
      finalizing: false,
    };
  }

  private validateRuntimeTools(file: WorkflowRunFile): void {
    for (const step of file.definition.steps) {
      if (step.type !== 'tool') continue;
      const state = file.steps.find((candidate) => candidate.id === step.id);
      if (state?.status !== 'pending') continue;
      if (this.pluginHost.getTool(step.tool ?? '') === undefined) {
        throw invalid(`tool "${step.tool ?? ''}" is not registered`);
      }
    }
  }

  private async execute(active: ActiveRun, resumed: boolean): Promise<void> {
    try {
      active.file.status = 'running';
      active.file.updated_at = Date.now();
      await this.store.save(active.file);

      publishWorkflowEvent(
        this.events,
        resumed ? 'workflow.resumed' : 'workflow.started',
        active.file.workflow_run_id,
        {
          workflow_name: active.file.workflow_name,
          ...(resumed ? {} : { definition_path: active.file.definition_path }),
          step_count: active.file.steps.length,
        },
      );

      await this.schedule(active);
      await this.finalize(active);
    } catch (error) {
      if (active.finalizing) return;
      active.failure ??= errorMessage(error);
      active.failFast = true;
      for (const running of active.running.values()) {
        running.controller.abort(new Error(active.failure));
      }
      await this.waitForRunning(active, FINALIZE_GRACE_MS);
      await this.finalize(active);
    }
  }

  private async schedule(active: ActiveRun): Promise<void> {
    const definition = active.file.definition;
    const maxParallel = this.maxParallel(definition);

    while (!active.cancelRequested && !active.interruptRequested && !active.failFast) {
      const ready = this.readySteps(active);
      let skipped = false;

      for (const step of ready) {
        if (active.cancelRequested || active.interruptRequested || active.failFast) break;
        if (!this.conditionHolds(active, step)) {
          await this.skipStep(active, step.id);
          skipped = true;
          continue;
        }
        if (active.running.size >= maxParallel) break;
        this.startStep(active, definition, step);
      }

      if (active.running.size === 0) {
        if (skipped) continue;
        if (active.file.steps.some((step) => step.status === 'pending')) {
          // 安全网：无就绪、无运行、仍有 pending，依赖不可满足。
          for (const step of active.file.steps) {
            if (step.status === 'pending') await this.skipStep(active, step.id);
          }
        }
        break;
      }

      await Promise.race([...active.running.values()].map((running) => running.promise));
    }

    await this.waitForRunning(active, FINALIZE_GRACE_MS);
  }

  private maxParallel(definition: WorkflowDefinition): number {
    // 单 agent 回退（无 Host）强制串行。
    if (this.host === undefined) return 1;
    const requested = definition.defaults?.max_parallel ?? this.config.maxParallel;
    return Math.max(1, Math.min(requested, this.config.maxParallel, MAX_PARALLEL_LIMIT));
  }

  private readySteps(active: ActiveRun): WorkflowStepDefinition[] {
    const byId = new Map(active.file.steps.map((step) => [step.id, step]));
    const ready: WorkflowStepDefinition[] = [];

    for (const step of active.file.definition.steps) {
      const state = byId.get(step.id);
      if (state?.status !== 'pending') continue;

      let dependenciesTerminal = true;
      for (const dependency of step.depends_on ?? []) {
        const dependencyState = byId.get(dependency);
        if (!dependencyState || !isTerminalStepStatus(dependencyState.status)) {
          dependenciesTerminal = false;
          break;
        }
      }
      if (!dependenciesTerminal) continue;

      if (step.when) {
        const target = byId.get(step.when.step);
        if (!target || !isTerminalStepStatus(target.status)) continue;
      }

      ready.push(step);
    }

    return ready;
  }

  private conditionHolds(active: ActiveRun, step: WorkflowStepDefinition): boolean {
    const byId = new Map(active.file.steps.map((candidate) => [candidate.id, candidate]));

    if (step.when) {
      const target = byId.get(step.when.step);
      if (!target) return false;
      if (step.when.status !== undefined && target.status !== step.when.status) return false;
      if (step.when.contains !== undefined && !target.output.includes(step.when.contains)) {
        return false;
      }
      if (step.when.equals !== undefined && target.output !== step.when.equals) return false;
      return true;
    }

    return (step.depends_on ?? []).every(
      (dependency) => byId.get(dependency)?.status === 'completed',
    );
  }

  private async skipStep(active: ActiveRun, stepId: string): Promise<void> {
    const state = active.file.steps.find((step) => step.id === stepId);
    if (state?.status !== 'pending') return;
    const now = Date.now();
    state.status = 'skipped';
    state.finished_at = now;
    active.file.updated_at = now;
    await this.store.save(active.file);
  }

  private startStep(
    active: ActiveRun,
    definition: WorkflowDefinition,
    step: WorkflowStepDefinition,
  ): void {
    const state = active.file.steps.find((candidate) => candidate.id === step.id);
    if (!state) return;

    const running: RunningStep = {
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    active.running.set(step.id, running);
    running.promise = this.runStep(active, definition, step, state, running)
      .catch(() => undefined)
      .finally(() => {
        active.running.delete(step.id);
      });
  }

  private async runStep(
    active: ActiveRun,
    definition: WorkflowDefinition,
    step: WorkflowStepDefinition,
    state: WorkflowStepState,
    running: RunningStep,
  ): Promise<void> {
    const maxAttempts = step.retry?.max_attempts ?? 1;
    const backoffMs = step.retry?.backoff_ms ?? 0;
    const timeoutMs = definition.defaults?.step_timeout_ms ?? this.config.stepTimeoutMs;
    const onError = step.on_error ?? definition.on_error ?? 'fail';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (active.cancelRequested || active.interruptRequested || active.failFast) return;

      const controller = new AbortController();
      running.controller = controller;

      state.status = 'running';
      state.attempts = attempt;
      state.started_at ??= Date.now();
      state.finished_at = undefined;
      state.error = undefined;
      active.file.updated_at = Date.now();
      await this.store.save(active.file);
      publishWorkflowEvent(this.events, 'workflow.step.started', active.file.workflow_run_id, {
        step_id: step.id,
        step_type: step.type,
        attempt,
      });

      const timer = setTimeout(() => {
        controller.abort(new Error(`step "${step.id}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let output: string;
      try {
        output = await this.executeStep(active, definition, step, controller.signal);
      } catch (error) {
        clearTimeout(timer);
        if (active.finalizing) return;

        if (active.cancelRequested || active.failFast) {
          state.status = 'cancelled';
          state.finished_at = Date.now();
          active.file.updated_at = state.finished_at;
          await this.store.save(active.file);
          return;
        }
        if (active.interruptRequested) return;

        state.status = 'failed';
        state.error = errorMessage(error);
        state.finished_at = Date.now();
        state.output = '';
        state.output_preview = '';
        active.file.updated_at = state.finished_at;
        await this.store.save(active.file);

        const willRetry = attempt < maxAttempts;
        publishWorkflowEvent(this.events, 'workflow.step.failed', active.file.workflow_run_id, {
          step_id: step.id,
          step_type: step.type,
          error: state.error,
          attempt,
          will_retry: willRetry,
        });

        if (willRetry) {
          await delay(backoffMs);
          continue;
        }

        if (onError === 'fail') {
          active.failure = state.error;
          active.failFast = true;
          for (const other of active.running.values()) {
            if (other !== running) {
              other.controller.abort(new Error('workflow failed'));
            }
          }
        }
        return;
      }

      clearTimeout(timer);
      if (active.finalizing) return;

      if (active.cancelRequested || active.failFast) {
        state.status = 'cancelled';
        state.finished_at = Date.now();
        active.file.updated_at = state.finished_at;
        await this.store.save(active.file);
        return;
      }
      if (active.interruptRequested) return;

      state.status = 'completed';
      state.output = output;
      state.output_preview = outputPreview(output);
      state.finished_at = Date.now();
      active.file.updated_at = state.finished_at;
      await this.store.save(active.file);
      publishWorkflowEvent(this.events, 'workflow.step.completed', active.file.workflow_run_id, {
        step_id: step.id,
        step_type: step.type,
        output_preview: state.output_preview,
        duration_ms: state.finished_at - (state.started_at ?? state.finished_at),
      });
      return;
    }
  }

  private async executeStep(
    active: ActiveRun,
    definition: WorkflowDefinition,
    step: WorkflowStepDefinition,
    signal: AbortSignal,
  ): Promise<string> {
    const context = this.templateContext(active, definition);

    if (step.type === 'tool') {
      const name = step.tool ?? '';
      const tool = this.pluginHost.getTool(name);
      if (!tool) throw new Error(`tool "${name}" is not registered`);

      const args = interpolateValue(step.args ?? {}, context);
      const toolContext: ToolContext = {
        run_id: active.file.workflow_run_id,
        session_id: active.file.workflow_run_id,
        messages: [],
        events: this.events,
        signal,
      };

      if (tool.checkPermission) {
        const decision = await raceAbort(
          Promise.resolve().then(() => tool.checkPermission?.(args, toolContext) ?? 'allow'),
          signal,
        );
        if (decision !== 'allow') throw new Error('permission_denied');
      }

      return await raceAbort(
        Promise.resolve().then(() => tool.handler(args, toolContext)),
        signal,
      );
    }

    const prompt = interpolate(step.prompt ?? '', context);
    const agentId = stepAgentId(step, definition);

    if (this.host) {
      if (agentId === undefined) throw new Error('agent step has no agent id');
      const handle = this.host.get(agentId);
      if (!handle) throw new Error(`agent "${agentId}" not found`);
      const run = await raceAbort(
        Promise.resolve().then(() => handle.run(prompt, { signal })),
        signal,
      );
      return await raceAbort(run.result, signal);
    }

    if (this.runtime) {
      return await raceAbort(
        Promise.resolve().then(() =>
          this.runtime?.run(prompt, `workflow:${active.file.workflow_run_id}`, { signal }),
        ),
        signal,
      ).then((value) => value ?? '');
    }

    throw new Error('no RuntimeHost or RunnableAgent injected; cannot run agent step');
  }

  private templateContext(active: ActiveRun, definition: WorkflowDefinition): TemplateContext {
    const steps = new Map<string, { output: string; status: string }>();
    for (const state of active.file.steps) {
      steps.set(state.id, { output: state.output, status: state.status });
    }
    return {
      inputs: active.file.inputs,
      steps,
      workflowName: definition.name,
    };
  }

  private async waitForRunning(active: ActiveRun, timeoutMs: number): Promise<void> {
    const promises = [...active.running.values()].map((running) => running.promise);
    if (promises.length === 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async finalize(active: ActiveRun): Promise<void> {
    if (active.finalizing) return;
    active.finalizing = true;

    const file = active.file;
    const now = Date.now();

    if (active.interruptRequested) {
      file.status = 'interrupted';
    } else if (active.cancelRequested) {
      file.status = 'cancelled';
      for (const step of file.steps) {
        if (step.status === 'running') step.status = 'cancelled';
        else if (step.status === 'pending') step.status = 'skipped';
      }
    } else {
      const failedSteps = file.steps.filter((step) => step.status === 'failed');
      if (active.failFast || failedSteps.length > 0) {
        file.status = 'failed';
        file.error = active.failure ?? failedSteps[0]?.error ?? 'workflow failed';
        for (const step of file.steps) {
          if (step.status === 'running') step.status = 'cancelled';
          else if (step.status === 'pending') step.status = 'skipped';
        }
      } else {
        file.status = 'completed';
        file.error = undefined;
      }
    }

    file.updated_at = now;
    file.finished_at = now;
    await this.store.save(file);
    this.active.delete(file.workflow_run_id);

    const completedSteps = file.steps.filter((step) => step.status === 'completed').length;
    const data: Record<string, unknown> = {
      workflow_name: file.workflow_name,
      step_count: file.steps.length,
      completed_steps: completedSteps,
    };
    if (file.error !== undefined) data.error = file.error;

    const eventType =
      file.status === 'completed'
        ? 'workflow.completed'
        : file.status === 'cancelled'
          ? 'workflow.cancelled'
          : file.status === 'interrupted'
            ? 'workflow.interrupted'
            : 'workflow.failed';
    publishWorkflowEvent(this.events, eventType, file.workflow_run_id, data);

    const outcome: WorkflowOutcome = {
      workflow_run_id: file.workflow_run_id,
      status: file.status,
    };
    if (file.error !== undefined) outcome.error = file.error;
    active.resolveDone(outcome);
  }
}
