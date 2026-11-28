/**
 * 环境信息注入节奏：内置默认表 + resolver（声明层）。
 *
 * 两轴框架的轴 A（检测节奏）：`request` = 每 LLM 请求前检测；`run` = 每 run 首次
 * 请求前检测；`off` = 整段静默（P2）。轴 C（投递通道）：`model+ui`（缺省）/ `ui-only`
 * （只广播事件，模型不注入；P2，`resolveEnvChannel`）。轴 B（抑制去重：believed-value /
 * 游标 / 签名 / 预算）恒开，不在这里。
 *
 * 分层：core 只认识 `EnvCadence` 类型（领域无关）；scope 业务词与默认节奏表在
 * config（本文件，**单一事实源**）。config 侧消费点一律派生，漂移结构上不可能：
 * ui-settings `ENV_GRANULARITY_SCOPES` / `SettableConfigKey`、serve `SETTABLE_KEYS`、
 * Web `settings-registry` / `env-notice` 词表均 `Object.keys(DEFAULT_ENV_CADENCE)`
 * （类型层用 `EnvScopeWord`）。agent 词表（`ENV_INFO_SCOPES`，有序子集）与插件
 * 字面量副本（依赖方向不能 import config）仍人工核对。
 *
 * @module @vessel-agent/config
 */

// 类型走 core 的零依赖叶导出（./types/env-cadence）：本文件被 apps/web 按源码消费
// （R-10 单源），包根 / types 桶导出会把 core 运行时图（node 依赖）拖进 web 的 tsc 程序。
import type { EnvCadence, EnvChannel } from '@vessel-agent/core/types/env-cadence';
import type { EnvInjectionConfig } from './types.js';

/**
 * 内置默认节奏表（= 今天行为，零回归基线）。
 *
 * env 词（agent `ENV_INFO_SCOPES`）+ bus legacy 词（config/permission/mcp/update/peer，
 * 不在 agent 词表里、历史消息仍在用）。files / trim / health 默认 run，其余默认 request。
 * 缺省配置（无 `env_injection`）时 `resolveEnvCadence` 走本表 ⇒ producer 行为不变。
 *
 * 表体先在 `ENV_CADENCE_TABLE` 上 `as const` 固化字面量，再以 `Record<string, EnvCadence>`
 * 导出（公开形状不变，string 索引消费点零改动）；`EnvScopeWord` 从同一张表派生词联合，
 * 供 `SettableConfigKey` 等类型层消费点用 —— 值表与词联合共用一个对象，无第二份字面量。
 */
const ENV_CADENCE_TABLE = {
  restart: 'request',
  identity: 'request',
  fields: 'request',
  model: 'request',
  tools: 'request',
  lock: 'request',
  conflict: 'request',
  files: 'run',
  health: 'run',
  // 订阅脚本（q-subscription-script）：通用检测脚本订阅的兜底 scope 词（案 B 注册制，
  // 内置专词 doc-lag / code-heaviness P1 加）；默认 run = 每 run 首请求 kickoff/drain。
  script: 'run',
  context: 'request',
  trim: 'run',
  pii: 'request',
  // runtime.notice bus legacy 词
  config: 'request',
  permission: 'request',
  mcp: 'request',
  update: 'request',
  peer: 'request',
} as const;

/** scope 词联合（类型层单源：与 `DEFAULT_ENV_CADENCE` 派生自同一张表）。 */
export type EnvScopeWord = keyof typeof ENV_CADENCE_TABLE;

/** 内置默认节奏表（公开形状：string 索引；词表消费点 `Object.keys` 派生）。 */
export const DEFAULT_ENV_CADENCE: Record<string, EnvCadence> = ENV_CADENCE_TABLE;

/**
 * 钉死为 run 的 scope：配 `request` 由校验**拒绝**（不静默钳制）。
 * - `trim`：段起点冻结 = 前缀不变量，每请求重算会打破请求前缀；
 * - `model`：模型通知钉死在 EU 首 run 生命周期。
 */
export const PINNED_REQUEST_SCOPES = ['trim', 'model'] as const;

/**
 * 解析一个 scope 的检测节奏：显式 per-scope 配置 > 内置默认表 > 配置兜底 default > 'run'。
 * 缺省配置走内置表 = 今天节奏（零回归）。
 */
export function resolveEnvCadence(scope: string, cfg?: EnvInjectionConfig): EnvCadence {
  return cfg?.scopes?.[scope] ?? DEFAULT_ENV_CADENCE[scope] ?? cfg?.default ?? 'run';
}

/**
 * 一组 scope 取**最细**节奏：任一 request ⇒ request，否则 run；**off 组忽略**
 * （P2，设计 §4.1）：off 的 scope 不参与最细计算（它们整段静默，不该把整 hook
 * 拖成 request/run）；组内**全 off ⇒ 'off'**（整 hook 不注入）。
 *
 * 给「整 hook 一个 gate、不做 per-kind 分裂」的生产者用（self-card-delta /
 * runtime.notice bus）：混合配置整 hook 取 request，要整体推迟须把组内 scope 全配 run。
 * agent 与 asm 共用（agent 不能 import src/）。
 */
export function finestCadence(scopes: readonly string[], cfg?: EnvInjectionConfig): EnvCadence {
  const active = scopes.filter((scope) => resolveEnvCadence(scope, cfg) !== 'off');
  if (active.length === 0) return 'off';
  return active.some((scope) => resolveEnvCadence(scope, cfg) === 'request') ? 'request' : 'run';
}

/**
 * 解析一个 scope 的投递通道（轴 C，P2）：显式 channels 覆盖 > 'model+ui'（缺省 = 现状）。
 * 缺省配置（无 channels）⇒ 全部 model+ui，事件与注入行为逐字节兼容。
 * `off`（轴 A）时通道被忽略——生产者 gate 整段跳过，先于通道判定。
 */
export function resolveEnvChannel(scope: string, cfg?: EnvInjectionConfig): EnvChannel {
  return cfg?.channels?.[scope] ?? 'model+ui';
}
