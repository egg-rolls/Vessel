/**
 * @vessel/evals — 默认离线的 eval harness。
 *
 * 库 + 运行器；不向 PluginHost 注册工具。默认导出是工厂函数，
 * 因此列入 `FACTORY_PLUGINS`（短名 evals）。
 */

export { evaluateAssertions } from './assertions.js';
export { EvalsError } from './errors.js';
export {
  ScriptedProvider,
  SwitchableProvider,
} from './mock-provider.js';
export { createEvalsPlugin, createEvalsPlugin as default } from './plugin.js';
export {
  findLatestReport,
  findLatestReport as getLatestReport,
  reportExitCode,
  reportFileName,
  reportTimestamp,
  writeReport,
} from './report.js';
export { defaultReportPath, runEvalSuite, runEvalSuite as runSuite } from './runner.js';
export { loadEvalSuite, parseEvalSuite, resolveSuitePath } from './suite.js';
export type {
  EvalAssertion,
  EvalAssertionResult,
  EvalAssertionType,
  EvalCase,
  EvalCaseContext,
  EvalCaseResult,
  EvalCaseStatus,
  EvalDefaults,
  EvalErrorCode,
  EvalMock,
  EvalMockResponse,
  EvalPlugin,
  EvalPluginOptions,
  EvalReport,
  EvalRunner,
  EvalRunOptions,
  EvalRuntimeFactory,
  EvalSessionMode,
  EvalSuite,
  EvalUsage,
} from './types.js';

export const DEFAULT_EVAL_TIMEOUT_MS = 30_000;
