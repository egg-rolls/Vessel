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
 * - `run`：每 run 首次请求前检测（run 级 gate 用 `HookContext.request_index` 判定）；
 * - `off`：完全静默——gate 整段跳过，不产事件、不注入（P2 粒度配置，设计 §4.1）。
 *   缺省表不含 off（缺省行为逐字节兼容）；只有用户显式配置才进入本档。
 */
export type EnvCadence = 'request' | 'run' | 'off';

/** `EnvCadence` 的枚举值（配置校验等运行时消费方用）。 */
export const ENV_CADENCE_VALUES = ['request', 'run', 'off'] as const;

/**
 * 投递通道（注入粒度框架的轴 C，P2 粒度配置，设计 §4.1）：
 * - `model+ui`：事件广播（UI 卡）+ 模型注入（缺省 = 现状，零回归）；
 * - `ui-only`：只广播事件（UI 可见），模型不注入。
 *
 * 与轴 A 正交：`off` 时通道被忽略（整段静默）；`request`/`run` 时通道决定
 * 「产出的通知给谁看」。领域无关叶类型，core 不认识 scope 业务词。
 */
export type EnvChannel = 'model+ui' | 'ui-only';

/** `EnvChannel` 的枚举值（配置校验等运行时消费方用）。 */
export const ENV_CHANNEL_VALUES = ['model+ui', 'ui-only'] as const;
