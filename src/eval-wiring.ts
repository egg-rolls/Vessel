/**
 * Eval harness 接线（0.4 A2）。
 *
 * - `@vessel-agent/evals` 是库 + runner，不向 PluginHost 注册工具；
 * - 默认离线 mock；真实 provider 必须 `config.evals.allowNetwork === true`
 *   且 CLI `--allow-network` 同时成立（Addendum C §12.1.3 / Addendum D §13.4）；
 * - 报告命名 / 写盘 / latest 查找由 ext 的 report.ts 负责；asm 只传 outDir/--out
 *   并处理 `--json` 的 stdout（Addendum D §13.2）。
 */

import { DEFAULT_EVALS_OPTIONS, type VesselConfig } from '../packages/config/src/index';
import type { EventStream, LLMProvider } from '../packages/core/src/index';
import type { EvalReport, EvalRunnerLike, EvalsModuleLike } from './control-plane-types';
import {
  isSafeSuiteName,
  resolveEvalSuite,
  resolveEvalsDir,
  resolveEvalsOutDir,
  type TenantPathOptions,
} from './path-resolution';
import type { PluginLoader } from './plugin-loader';

export interface ResolvedEvalsOptions {
  enabled: boolean;
  dir: string;
  outDir: string;
  allowNetwork: boolean;
}

/** config → eval 选项；路径解析为绝对路径（0.5：outDir 缺省落到 tenant） */
export function resolveEvalsOptions(
  config: VesselConfig,
  opts: TenantPathOptions = {},
): ResolvedEvalsOptions {
  return {
    enabled: config.evals?.enabled === true,
    dir: resolveEvalsDir(config),
    outDir: resolveEvalsOutDir(config, opts),
    allowNetwork: config.evals?.allowNetwork ?? DEFAULT_EVALS_OPTIONS.allowNetwork,
  };
}

/** 带稳定 code 的错误 */
export function evalError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** 网络双门控：config true 且 CLI flag（Addendum D §13.4） */
export function isNetworkAllowed(config: VesselConfig, cliAllowNetwork: boolean): boolean {
  return config.evals?.allowNetwork === true && cliAllowNetwork === true;
}

export interface EvalsRunnerOptions {
  config: VesselConfig;
  /** 0.5：tenant 根目录；缺省 outDir 落到 `<tenant>/evals` */
  tenantDir?: string;
  /** 0.5：tenant 作用域；事件与报告带 tenant_id */
  tenantId?: string;
  /** 0.5：`eval.run.*` 事件出口（trace 订阅同一流） */
  events?: EventStream;
  loader?: Pick<PluginLoader, 'loadModule'>;
  /** 测试注入口；优先于 loader */
  loadModule?: () => Promise<unknown | null>;
}

/**
 * 构造 eval runner。
 * @throws error.code=eval_invalid `evals.enabled !== true` 或模块缺失
 */
export async function createEvalsRunner(options: EvalsRunnerOptions): Promise<EvalRunnerLike> {
  if (options.config.evals?.enabled !== true) {
    const error = evalError('eval_invalid', 'evals.enabled is false (disabled)');
    throw error;
  }

  const load = options.loadModule ?? (async () => options.loader?.loadModule('evals') ?? null);
  const mod = (await load()) as EvalsModuleLike | null | undefined;

  if (!mod || typeof mod.createEvalsPlugin !== 'function') {
    throw evalError(
      'eval_invalid',
      'plugin "evals" not found or does not export createEvalsPlugin()',
    );
  }

  return mod.createEvalsPlugin({
    outDir: resolveEvalsOutDir(
      options.config,
      options.tenantDir !== undefined ? { tenantDir: options.tenantDir } : {},
    ),
    enabled: true,
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.events !== undefined ? { events: options.events } : {}),
  });
}

export interface ExecuteEvalOptions extends EvalsRunnerOptions {
  /** suite name 或路径（CLI 原样） */
  target: string;
  filters?: string[];
  /** `--out` 覆盖 */
  out?: string;
  /** CLI `--allow-network` */
  allowNetwork: boolean;
  /** 门控通过后由 asm 构造的真实 provider */
  provider?: LLMProvider;
}

export interface ExecuteEvalResult {
  report: EvalReport;
  exitCode: number;
}

/**
 * 执行一次 suite。报告由 ext 写盘；本函数不写文件。
 * 退出码：0 全部 passed/skipped；1 存在 failed/error。
 */
export async function executeEvalSuite(options: ExecuteEvalOptions): Promise<ExecuteEvalResult> {
  if (options.config.evals?.enabled !== true) {
    throw evalError('eval_invalid', 'evals.enabled is false (disabled)');
  }

  const resolved = await resolveEvalSuite(options.config, options.target);
  if (!resolved.ok) {
    throw evalError(resolved.code, resolved.error);
  }

  const wantNetwork = options.allowNetwork === true;
  if (wantNetwork && !isNetworkAllowed(options.config, true)) {
    throw evalError(
      'eval_network_required',
      'network use requires evals.allowNetwork: true and --allow-network',
    );
  }
  if (wantNetwork && !options.provider) {
    throw evalError('eval_network_required', 'network use requires a configured provider');
  }

  const runner = await createEvalsRunner(options);
  const report = await runner.runSuite(resolved.path, {
    outDir: resolveEvalsOutDir(
      options.config,
      options.tenantDir !== undefined ? { tenantDir: options.tenantDir } : {},
    ),
    ...(options.out !== undefined ? { outPath: options.out } : {}),
    ...(options.filters && options.filters.length > 0 ? { filterTags: options.filters } : {}),
    allowNetwork: wantNetwork,
    ...(wantNetwork && options.provider
      ? { providerFactory: () => options.provider as LLMProvider }
      : {}),
  });

  const exitCode = report.failed + report.errors > 0 ? 1 : 0;
  return { report, exitCode };
}

/**
 * gateway `/v1/evals/latest`：只读最近一次报告。
 * suite 必须是安全单段名；未启用 / 模块缺失 / 无报告 → null。
 */
export async function latestEvalReport(
  options: EvalsRunnerOptions,
  suite: string,
): Promise<EvalReport | null> {
  if (options.config.evals?.enabled !== true) return null;
  if (!isSafeSuiteName(suite)) return null;

  try {
    const runner = await createEvalsRunner(options);
    return await runner.getLatest(suite);
  } catch {
    return null;
  }
}
