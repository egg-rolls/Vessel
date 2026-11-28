/**
 * 环境信息注入节奏：内置默认表 + resolver（声明层）。
 *
 * 两轴框架的轴 A（检测节奏）：`request` = 每 LLM 请求前检测；`run` = 每 run 首次
 * 请求前检测；`off` = 整段静默（P2）。轴 C（投递通道）：`model+ui`（缺省）/ `ui-only`
 * （只广播事件，模型不注入；P2，`resolveEnvChannel`）。轴 B（抑制去重：believed-value /
 * 游标 / 签名 / 预算）恒开，不在这里。
 *
 * 分层：core 只认识 `EnvCadence` 类型（领域无关）；scope 业务词与默认节奏表在
 * config（本文件）；agent 词表（`ENV_INFO_SCOPES`）与插件字面量副本人工对拍。
 *
 * @module @vessel-agent/config
 */

import type { EnvCadence, EnvChannel } from '@vessel-agent/core';
import type { EnvInjectionConfig } from './types.js';

/**
 * 内置默认节奏表（= 今天行为，零回归基线）。
 *
 * env 词（agent `ENV_INFO_SCOPES`）+ bus legacy 词（config/permission/mcp/update/peer，
 * 不在 agent 词表里、历史消息仍在用）。files / trim 默认 run，其余默认 request。
 * 缺省配置（无 `env_injection`）时 `resolveEnvCadence` 走本表 ⇒ producer 行为不变。
 */
export const DEFAULT_ENV_CADENCE: Record<string, EnvCadence> = {
  restart: 'request',
  identity: 'request',
  fields: 'request',
  model: 'request',
  tools: 'request',
  lock: 'request',
  conflict: 'request',
  files: 'run',
  health: 'run',
  context: 'request',
  trim: 'run',
  pii: 'request',
  // runtime.notice bus legacy 词
  config: 'request',
  permission: 'request',
  mcp: 'request',
  update: 'request',
  peer: 'request',
};

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
