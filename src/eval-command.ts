/**
 * `vessel eval <suite>`（0.4 A2）。
 *
 * - 默认离线 mock；真实 provider 需 `evals.allowNetwork: true` **且** `--allow-network`；
 * - 报告写盘由 @vessel-agent/evals report.ts 负责；asm 只传 outDir/--out 并处理 --json；
 * - 退出码：0 全 pass/skip；1 有 failed/error；2 参数/配置/网络门控错误。
 */

import { type ConfigLoadOptions, loadConfig } from '../packages/config/src/index';
import { type LLMProvider, resolveTenantPaths, type TenantPaths } from '../packages/core/src/index';
import type { EvalCommand } from './cli-args';
import { formatConfigErrors } from './config-error-format';
import type { EvalReport } from './control-plane-types';
import { resolveDataDir } from './data-paths';
import { executeEvalSuite } from './eval-wiring';
import { createEventStream } from './observability-wiring';
import { PluginLoader } from './plugin-loader';
import { createProvider } from './provider-factory';
import { acquireTenantLock, type TenantLock, TenantLockError } from './tenant-lock';
import { installTrace, type TraceControl } from './trace-wiring';
import { ui } from './ui-style';

export interface EvalCommandOptions {
  useMock?: boolean;
  configPath?: string;
  userConfigPath?: string;
  /** 0.5：全局 `--tenant` / VESSEL_TENANT 已由 CLI 传入 */
  tenantId?: string;
  /** 0.5：测试注入 data_dir */
  dataDir?: string;
  /** 测试注入口 */
  loadEvalsModule?: () => Promise<unknown | null>;
}

function sendWarnings(warnings: Array<{ message: string }>): void {
  for (const warning of warnings) console.warn(`⚠ ${warning.message}`);
}

function printSummary(report: EvalReport): void {
  const summaryLine =
    `Eval "${report.suite}": total=${report.total} passed=${report.passed} ` +
    `failed=${report.failed} errors=${report.errors} skipped=${report.skipped} ` +
    `duration=${report.duration_ms}ms network=${report.network}`;
  console.log(report.failed > 0 || report.errors > 0 ? ui.err(summaryLine) : ui.ok(summaryLine));
  for (const result of report.cases) {
    if (result.status !== 'failed' && result.status !== 'error') continue;
    const failedAssertions = result.assertions
      .filter((assertion) => !assertion.ok)
      .map((assertion) =>
        assertion.detail ? `${assertion.type}: ${assertion.detail}` : assertion.type,
      );
    console.log(
      ui.err(`  - ${result.id}: ${result.status}${result.error ? ` (${result.error})` : ''}`),
    );
    for (const detail of failedAssertions) console.log(ui.dim(`      ${detail}`));
  }
}

/**
 * 执行 `eval` 子命令。
 * @returns 0 / 1 / 2
 */
export async function runEvalCommand(
  cmd: EvalCommand,
  options: EvalCommandOptions = {},
): Promise<number> {
  const loadOptions: ConfigLoadOptions = {
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
  };
  const { config, validation, tenantId, paths } = await loadConfig(loadOptions);
  sendWarnings(validation.warnings);
  if (validation.errors.length > 0) {
    console.error(formatConfigErrors(validation.errors, { paths }));
    return 2;
  }

  if (config.evals?.enabled === false) {
    console.error('eval_invalid: evals.enabled is false (disabled)');
    return 2;
  }

  // 真实 provider 的双门控：config 与 CLI flag 同时成立（Addendum D §13.4）。
  let provider: LLMProvider | undefined;
  if (cmd.allowNetwork) {
    if (config.evals?.allowNetwork !== true) {
      console.error(
        'eval_network_required: network use requires evals.allowNetwork: true and --allow-network',
      );
      return 2;
    }
    try {
      const resolved = await createProvider(config, new PluginLoader(), options.useMock ?? false);
      provider = resolved.provider;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  // 0.5：报告与 trace 落到 tenant 目录；eval.run.* 事件经 events 进入 trace。
  const tenantPaths: TenantPaths = resolveTenantPaths(
    options.dataDir ?? resolveDataDir(config),
    tenantId,
  );
  // eval 写 tenant trace / 报告：与 migrate / tenant / trace prune 一致走 exclusive。
  let tenantLock: TenantLock | undefined;
  try {
    tenantLock = await acquireTenantLock({
      tenantDir: tenantPaths.root,
      tenantId,
      mode: 'exclusive',
    });
  } catch (error) {
    if (error instanceof TenantLockError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const events = createEventStream(config);
  const trace: TraceControl | undefined = installTrace({
    events,
    config,
    tenantPaths,
    tenantId,
  });

  try {
    const result = await executeEvalSuite({
      config,
      target: cmd.target,
      filters: cmd.filters,
      tenantId,
      tenantDir: tenantPaths.root,
      events,
      ...(cmd.out !== undefined ? { out: cmd.out } : {}),
      allowNetwork: cmd.allowNetwork,
      ...(provider ? { provider } : {}),
      loader: new PluginLoader(),
      ...(options.loadEvalsModule ? { loadModule: options.loadEvalsModule } : {}),
    });

    if (cmd.json) {
      console.log(JSON.stringify(result.report, null, 2));
    } else {
      printSummary(result.report);
    }
    return result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    if (trace) {
      try {
        await trace.flush();
        await trace.close();
      } catch {
        // trace 收尾失败不改变 eval 退出码
      }
    }
    await tenantLock?.release().catch(() => undefined);
  }
}
