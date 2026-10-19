/**
 * Workflow 工厂插件接线（0.4 A2）。
 *
 * - 默认关闭：`workflow.enabled !== true` 时不 import、不构造。
 * - `createWorkflowEngine({ host?, runtime?, pluginHost, config, events })` 由 ext 提供；
 *   本模块用结构类型 + 动态 import（PluginLoader.loadModule），不静态依赖 ext。
 * - controls-only：CLI list/show/cancel 不注入 host/runtime；start/resume 缺二者 →
 *   workflow_disabled（Addendum D §13.1）。
 */

import { mkdir, stat } from 'node:fs/promises';
import { DEFAULT_WORKFLOW_OPTIONS, type VesselConfig } from '../packages/config/src/index';
import {
  createToolPipeline,
  type EventStream,
  type PluginHost,
  type RunnableAgent,
  type RuntimeHost,
  type RuntimePermissionConfig,
} from '../packages/core/src/index';
import {
  GuardrailRunner,
  HookRunner,
  PermissionPolicy,
} from '../packages/core/src/runtime/policy/index';
import type { WorkflowsControl } from '../packages/tui/src/index';
import type {
  ResolvedWorkflowConfigLike,
  WorkflowControlsLike,
  WorkflowEngineLike,
  WorkflowModuleLike,
} from './control-plane-types';
import {
  resolveWorkflowDefinition,
  resolveWorkflowDir,
  resolveWorkflowStorePath,
  type TenantPathOptions,
} from './path-resolution';
import type { PluginLoader } from './plugin-loader';

export interface ResolvedWorkflowOptions extends ResolvedWorkflowConfigLike {}

export interface WorkflowCreateOptions {
  config: VesselConfig;
  events: EventStream;
  pluginHost: PluginHost;
  host?: RuntimeHost;
  runtime?: RunnableAgent;
  /** 0.5：tenant 根目录；缺省路径落到 `<tenant>/workflows` */
  tenantDir?: string;
  /** 0.5：tenant 作用域；传给引擎，事件带 tenant_id */
  tenantId?: string;
  /**
   * 0.8.2 Wave 2B1：与 runtime 相同的 resolved 权限配置（default + autoApprove）。
   * 缺省回退 `config.permission`；headless 的 allow 口径由装配层显式传入。
   */
  permission?: RuntimePermissionConfig;
  loader?: Pick<PluginLoader, 'loadModule'>;
  /** 测试注入口；优先于 loader */
  loadModule?: () => Promise<unknown | null>;
}

/** 带稳定 code 的错误（CLI / gateway 直接读 code） */
export function workflowError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** 配置了 workflow 但 ext 模块缺失 */
export class WorkflowPluginUnavailableError extends Error {
  readonly code = 'workflow_plugin_unavailable';

  constructor(detail?: string) {
    super(
      detail
        ? `workflow_plugin_unavailable: ${detail}`
        : 'workflow_plugin_unavailable: install @vessel/workflow (plugins/workflow/engine)',
    );
    this.name = 'WorkflowPluginUnavailableError';
  }
}

/** config → 引擎选项；路径解析为绝对路径，默认值只在 config 层一处 */
export function resolveWorkflowOptions(
  config: VesselConfig,
  options: TenantPathOptions = {},
): ResolvedWorkflowOptions {
  const workflow = config.workflow;
  return {
    enabled: workflow?.enabled === true,
    dir: resolveWorkflowDir(config),
    path: resolveWorkflowStorePath(config, options),
    maxParallel: workflow?.maxParallel ?? DEFAULT_WORKFLOW_OPTIONS.maxParallel,
    stepTimeoutMs: workflow?.stepTimeoutMs ?? DEFAULT_WORKFLOW_OPTIONS.stepTimeoutMs,
  };
}

/**
 * 启用态目录检查：`workflow.dir` 必须存在且是目录。
 * 启动前检查（不在 validator 做 IO）。
 */
export async function checkWorkflowDir(
  config: VesselConfig,
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const dir = resolveWorkflowDir(config);
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      return { ok: false, error: `workflow.dir is not a directory: ${dir}` };
    }
    return { ok: true, dir };
  } catch {
    return { ok: false, error: `workflow.dir does not exist: ${dir}` };
  }
}

/** `workflow.path` 不存在则递归创建（Addendum B §11.1.13） */
export async function ensureWorkflowStorePath(
  config: VesselConfig,
  options: TenantPathOptions = {},
): Promise<string> {
  const storePath = resolveWorkflowStorePath(config, options);
  try {
    await mkdir(storePath, { recursive: true });
    return storePath;
  } catch (error) {
    throw workflowError(
      'workflow_invalid',
      `cannot create workflow.path "${storePath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function loadWorkflowModule(options: WorkflowCreateOptions): Promise<WorkflowModuleLike> {
  const load = options.loadModule ?? (async () => options.loader?.loadModule('workflow') ?? null);
  const mod = (await load()) as WorkflowModuleLike | null | undefined;

  if (!mod || typeof mod.createWorkflowEngine !== 'function') {
    throw new WorkflowPluginUnavailableError(
      'plugin "workflow" not found or does not export createWorkflowEngine()',
    );
  }
  return mod;
}

/**
 * 构造 workflow 引擎。
 * @returns 未启用 / 未配置时 undefined
 * @throws WorkflowPluginUnavailableError 模块缺失
 * @throws error.code=workflow_invalid 目录/存储路径不可用
 */
export async function createWorkflowFromConfig(
  options: WorkflowCreateOptions,
): Promise<WorkflowEngineLike | undefined> {
  if (options.config.workflow?.enabled !== true) return undefined;

  const dirCheck = await checkWorkflowDir(options.config);
  if (!dirCheck.ok) throw workflowError('workflow_invalid', dirCheck.error);

  await ensureWorkflowStorePath(
    options.config,
    options.tenantDir !== undefined ? { tenantDir: options.tenantDir } : {},
  );
  const mod = await loadWorkflowModule(options);

  // 0.8.2 Wave 2B1：workflow `type: tool` 与 runtime 共用权限 / guardrail / hook。
  // 权限配置优先用装配层传入的 resolved 值（headless allow 等），否则回退 config。
  const permissionConfig = options.permission ?? options.config.permission;
  const toolPipeline = createToolPipeline({
    pluginHost: options.pluginHost,
    events: options.events,
    permission: new PermissionPolicy(options.events, permissionConfig, options.tenantId),
    guardrails: new GuardrailRunner(options.pluginHost, options.events, options.tenantId),
    hooks: new HookRunner(options.pluginHost, options.events, options.tenantId),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
  });

  return mod.createWorkflowEngine({
    ...(options.host ? { host: options.host } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    pluginHost: options.pluginHost,
    config: resolveWorkflowOptions(
      options.config,
      options.tenantDir !== undefined ? { tenantDir: options.tenantDir } : {},
    ),
    events: options.events,
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    toolPipeline,
  });
}

/**
 * controls-only（CLI list/show/cancel）：host / runtime 都不注入，只读 workflow.path。
 * 目录检查跳过；start/resume 由调用方经 `createWorkflowControlsAdapter` 拒绝。
 */
export async function createWorkflowControlsOnly(
  options: WorkflowCreateOptions,
): Promise<WorkflowEngineLike | undefined> {
  if (options.config.workflow?.enabled !== true) return undefined;
  await ensureWorkflowStorePath(
    options.config,
    options.tenantDir !== undefined ? { tenantDir: options.tenantDir } : {},
  );
  const mod = await loadWorkflowModule(options);
  return mod.createWorkflowEngine({
    pluginHost: options.pluginHost,
    config: resolveWorkflowOptions(
      options.config,
      options.tenantDir !== undefined ? { tenantDir: options.tenantDir } : {},
    ),
    events: options.events,
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
  });
}

/**
 * 引擎路径接口 + 执行态守卫。
 * - list/get/cancel 总是可用；
 * - start/resume 在 `hasExecution=false` 时抛 workflow_disabled（exit 2）。
 */
export function createWorkflowControlsAdapter(
  engine: WorkflowControlsLike,
  options: { hasExecution: boolean },
): WorkflowControlsLike {
  const requireExecution = (): void => {
    if (!options.hasExecution) {
      throw workflowError('workflow_disabled', 'workflow start/resume requires a host or runtime');
    }
  };

  return {
    listRuns: (opts) => engine.listRuns(opts),
    getRun: (id) => engine.getRun(id),
    start: async (definitionPath, opts) => {
      requireExecution();
      return engine.start(definitionPath, opts);
    },
    resume: async (id) => {
      requireExecution();
      return engine.resume(id);
    },
    cancel: (id) => engine.cancel(id),
  };
}

/**
 * TUI name 版适配器：在 workflow.dir 下解析 name，再调用引擎路径接口。
 * start/resume 的 done 形状与 TUI 冻结契约一致（失败用 status/error，不 reject）。
 */
export function adaptWorkflowsControl(
  engine: WorkflowControlsLike,
  config: VesselConfig,
): WorkflowsControl {
  return {
    listRuns: (opts) => engine.listRuns(opts),
    getRun: (id) => engine.getRun(id),
    start: async (name, opts) => {
      const resolved = await resolveWorkflowDefinition(config, name);
      if (!resolved.ok) {
        throw workflowError(resolved.code, resolved.error);
      }
      return engine.start(resolved.path, opts);
    },
    resume: (id) => engine.resume(id),
    cancel: (id) => engine.cancel(id),
  };
}
