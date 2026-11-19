/**
 * 环境信息检测节奏（注入粒度框架的轴 A）。
 *
 * 领域无关的叶类型：core 只认识「多久检测一次」，**不认识 scope 业务词**
 * （scope 词表在 agent 的 `env-info-scope.ts`，内置默认节奏表在 config 的
 * `env-injection.ts`）。抑制去重（believed-value / 游标 / 签名 / 预算）是轴 B，
 * 恒开，与本类型正交。
 *
 * @module @vessel-agent/core/types
 */

/**
 * 检测节奏：
 * - `request`：每 LLM 请求前检测；
 * - `run`：每 run 首次请求前检测（run 级 gate 用 `HookContext.request_index` 判定）。
 */
export type EnvCadence = 'request' | 'run';

/** `EnvCadence` 的枚举值（配置校验等运行时消费方用）。 */
export const ENV_CADENCE_VALUES = ['request', 'run'] as const;
