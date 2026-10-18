/**
 * Evals 工厂插件：install 为 no-op，不向 PluginHost 注册工具。
 * asm CLI 直接调用 runSuite / getLatest。
 */

import { EvalsError } from './errors.js';
import { findLatestReport } from './report.js';
import { runEvalSuite } from './runner.js';
import type { EvalPlugin, EvalPluginOptions, EvalReport, EvalRunOptions } from './types.js';

export function createEvalsPlugin(options: EvalPluginOptions = {}): EvalPlugin {
  return {
    name: 'evals',
    version: '0.3.0',
    description: 'Offline eval harness (suite schema, assertions, reports)',
    install(): void {
      // no-op：不向 PluginHost 注册工具
    },

    async runSuite(
      suitePath: string,
      runOptions: Omit<EvalRunOptions, 'suitePath'> = {},
    ): Promise<EvalReport> {
      return runEvalSuite(suitePath, {
        ...runOptions,
        ...(runOptions.outDir === undefined && options.outDir !== undefined
          ? { outDir: options.outDir }
          : {}),
        ...(runOptions.enabled === undefined && options.enabled !== undefined
          ? { enabled: options.enabled }
          : {}),
      });
    },

    async getLatest(suite: string): Promise<EvalReport | null> {
      if (options.outDir === undefined) {
        throw new EvalsError('eval_invalid', 'evals outDir is not configured');
      }
      return findLatestReport(options.outDir, suite);
    },
  };
}
