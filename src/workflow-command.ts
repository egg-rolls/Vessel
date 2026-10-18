/**
 * `vessel workflow ...`（0.4 A2）。
 *
 * - list / show / cancel：controls-only，不注入 host/runtime，只读 workflow.path；
 * - run / resume：完整 bootstrap（必须有 host 或 runtime）；
 * - cancel 仅同进程（Addendum D §13.1）；
 * - SIGINT → 130；SIGTERM → 143；failed → 1；completed → 0（Addendum C/D）。
 */

import {
  type ConfigLoadOptions,
  loadConfig,
  type VesselConfig,
} from '../packages/config/src/index';
import {
  MemoryEventStream,
  MemoryPluginHost,
  resolveTenantPaths,
} from '../packages/core/src/index';
import { bootstrap } from './bootstrap';
import type { WorkflowCommand } from './cli-args';
import type { WorkflowOutcome, WorkflowRunDetail, WorkflowRunSummary } from './control-plane-types';
import { resolveDataDir } from './data-paths';
import { resolveWorkflowDefinition } from './path-resolution';
import { PluginLoader } from './plugin-loader';
import { createWorkflowControlsAdapter, createWorkflowControlsOnly } from './workflow-wiring';

export interface WorkflowCommandOptions {
  useMock?: boolean;
  configPath?: string;
  userConfigPath?: string;
  /** 0.5：全局 `--tenant` / VESSEL_TENANT 已由 CLI 传入 */
  tenantId?: string;
  /** 测试注入 data_dir */
  dataDir?: string;
  /** 测试注入口 */
  loadWorkflowModule?: () => Promise<unknown | null>;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printWarnings(warnings: Array<{ message: string }>): void {
  for (const warning of warnings) console.warn(`⚠ ${warning.message}`);
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function formatRun(run: WorkflowRunSummary): string {
  return [
    run.workflow_run_id.padEnd(36),
    run.workflow_name.padEnd(24),
    run.status.padEnd(12),
    `${run.completed_steps}/${run.step_count}`.padStart(7),
    formatTimestamp(run.updated_at),
    run.error ? `  ${run.error}` : '',
  ].join('  ');
}

function printRunList(runs: WorkflowRunSummary[]): void {
  if (runs.length === 0) {
    console.log('No workflow runs.');
    return;
  }
  console.log(`Workflow runs (${runs.length}, newest first):`);
  console.log(
    [
      'WORKFLOW RUN ID'.padEnd(36),
      'NAME'.padEnd(24),
      'STATUS'.padEnd(12),
      'STEPS'.padStart(7),
      'UPDATED',
    ].join('  '),
  );
  for (const run of runs) console.log(formatRun(run));
}

function printRunDetail(run: WorkflowRunDetail): void {
  console.log(`workflow ${run.workflow_run_id} [${run.status}] ${run.workflow_name}`);
  console.log(`  definition: ${run.definition_path}`);
  const inputs = Object.entries(run.inputs);
  console.log(`  inputs: ${inputs.length === 0 ? '(none)' : ''}`);
  for (const [key, value] of inputs) console.log(`    ${key}=${value}`);
  console.log(`  steps (${run.completed_steps}/${run.step_count}):`);
  for (const step of run.steps) {
    const detail = step.error ? ` error=${step.error}` : '';
    console.log(
      `    - ${step.id} (${step.type}) ${step.status} attempts=${step.attempts}${detail}`,
    );
  }
  if (run.error) console.log(`  error: ${run.error}`);
}

/** list / show / cancel：不需要 API Key，不构造 runtime */
async function runControlsOnly(
  cmd: Extract<WorkflowCommand, { kind: 'list' | 'show' | 'cancel' }>,
  config: VesselConfig,
  tenantId: string,
  tenantDir: string,
  loader: PluginLoader,
  options: WorkflowCommandOptions,
): Promise<number> {
  const engine = await createWorkflowControlsOnly({
    config,
    events: new MemoryEventStream(),
    pluginHost: new MemoryPluginHost(),
    tenantDir,
    tenantId,
    loader,
    ...(options.loadWorkflowModule ? { loadModule: options.loadWorkflowModule } : {}),
  });
  if (!engine) {
    console.error('workflow_disabled: workflow.enabled is false');
    return 2;
  }

  const controls = createWorkflowControlsAdapter(engine, { hasExecution: false });
  try {
    if (cmd.kind === 'list') {
      const runs = await controls.listRuns({
        ...(cmd.status !== undefined ? { status: cmd.status } : {}),
        ...(cmd.limit !== undefined ? { limit: cmd.limit } : {}),
      });
      printRunList(runs);
      return 0;
    }

    if (cmd.kind === 'show') {
      const run = await controls.getRun(cmd.workflowRunId);
      if (!run) {
        console.error(`workflow_not_found: ${cmd.workflowRunId}`);
        return 1;
      }
      printRunDetail(run);
      return 0;
    }

    // cancel
    await controls.cancel(cmd.workflowRunId);
    console.log(`workflow ${cmd.workflowRunId}: cancel requested`);
    return 0;
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  } finally {
    await engine.close();
  }
}

/** run / resume：完整 bootstrap（有 host/runtime） */
async function runWithRuntime(
  cmd: Extract<WorkflowCommand, { kind: 'run' | 'resume' }>,
  options: WorkflowCommandOptions,
): Promise<number> {
  const bootstrapOptions = {
    useMock: options.useMock ?? false,
    headless: true,
    configErrorExitCode: 2,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.loadWorkflowModule ? { loadWorkflowModule: options.loadWorkflowModule } : {}),
  };

  const result = await bootstrap(bootstrapOptions);
  let started: { workflowRunId: string; done: Promise<WorkflowOutcome> };
  try {
    if (!result.workflows) {
      console.error('workflow_disabled: workflow.enabled is false');
      return 2;
    }

    if (cmd.kind === 'run') {
      const resolved = await resolveWorkflowDefinition(result.config, cmd.target);
      if (!resolved.ok) {
        console.error(resolved.error);
        return 2;
      }
      started = await result.workflows.start(resolved.path, { inputs: cmd.inputs });
    } else {
      started = await result.workflows.resume(cmd.workflowRunId);
    }
  } catch (error) {
    console.error(errorMessage(error));
    const code = errorCode(error);
    // 定义/名称/启用态错误属于配置错误；not_resumable / already_running 属于运行失败。
    return code === 'workflow_not_found' ||
      code === 'workflow_invalid' ||
      code === 'workflow_disabled'
      ? 2
      : 1;
  }

  console.log(`workflow ${started.workflowRunId} started`);

  let signal: 'SIGINT' | 'SIGTERM' | undefined;
  const onInterrupt = (): void => {
    signal = 'SIGINT';
    void result.interruptWorkflows();
  };
  const onTerminate = (): void => {
    signal = 'SIGTERM';
    void result.interruptWorkflows();
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  try {
    const outcome = await started.done;
    if (outcome.error) console.error(outcome.error);
    console.log(`workflow ${outcome.workflow_run_id}: ${outcome.status}`);

    if (outcome.status === 'completed') return 0;
    if (outcome.status === 'failed') return 1;
    if (signal === 'SIGTERM') return 143;
    return 130;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    await result.shutdown();
  }
}

/**
 * 执行 `workflow` 子命令。
 * @returns 0 success / 1 runtime failure / 2 config or usage error / 130/143 signal
 */
export async function runWorkflowCommand(
  cmd: WorkflowCommand,
  options: WorkflowCommandOptions = {},
): Promise<number> {
  // run/resume 走 bootstrap（它自己加载配置）。
  if (cmd.kind === 'run' || cmd.kind === 'resume') {
    return runWithRuntime(cmd, options);
  }

  const loadOptions: ConfigLoadOptions = {
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
  };
  const { config, validation, tenantId } = await loadConfig(loadOptions);
  printWarnings(validation.warnings);
  if (validation.errors.length > 0) {
    for (const error of validation.errors) console.error(`✗ ${error.message}`);
    return 2;
  }
  if (config.workflow?.enabled !== true) {
    console.error('workflow_disabled: workflow.enabled is false');
    return 2;
  }

  const tenantPaths = resolveTenantPaths(options.dataDir ?? resolveDataDir(config), tenantId);

  try {
    return await runControlsOnly(
      cmd,
      config,
      tenantId,
      tenantPaths.root,
      new PluginLoader(),
      options,
    );
  } catch (error) {
    console.error(errorMessage(error));
    return 2;
  }
}
