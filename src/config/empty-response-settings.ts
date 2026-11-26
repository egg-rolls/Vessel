/**
 * 空响应兜底配置 → core 的 `EmptyResponsePolicy`（q-empty-response）
 *
 * 模型偶发「空内容 + 无工具调用 + 终止原因」时，core loop 不再把空串当终稿：
 * 缺省走**无感重试**（seamless）——丢弃空轮、用已有 transcript 原样重调（零注入
 * 零疤痕），连续空耗尽 maxRetries 后升级一次 nudge 打破空模式；seamless=false
 * 走一期 nudge 注入路径。限次防死循环，耗尽落 `llm.empty_response`(exhausted)
 * 后抛 `EmptyResponseExhaustedError` ⇒ run 标 failed，既有 peer 链路通知 parent
 * （q-empty-exhaust，防静默早退）。
 *
 * ## 缺省 = 不注入 = core 内置缺省（启用、无感重试 2 次 + 升级一次 nudge）
 *
 * 与 vision 的「缺省不注入 = 旧行为」不同：本修复的缺省**就是启用**（用户硬要求）。
 * 整段缺省 / 全部字段缺省时返回 `undefined`，core loop 按内置缺省执行；
 * 只有显式覆盖（`enabled: false` / `seamless: false` / `maxRetries` / `nudge`）
 * 才注入策略对象。
 *
 * 生效面：装配进 tenant profile ⇒ 新 EU（owner + 成员）生效；已存活 EU 持构造时
 * 快照（与 vision 同语义，改配置后新会话生效）。
 *
 * @module vessel/empty-response-settings
 */

import type { VesselConfig } from '../../packages/config/src/index';
import type { EmptyResponsePolicy } from '../../packages/core/src/index';

/** nudge 重试上限的安全上界（与 config validator 的 [0, 10] 同界）。 */
export const MAX_EMPTY_RESPONSE_RETRIES_LIMIT = 10;

/** 配置 → `EmptyResponsePolicy`；没有显式覆盖时返回 `undefined`（= core 内置缺省）。 */
export function emptyResponsePolicyOf(config: VesselConfig): EmptyResponsePolicy | undefined {
  const section = config.emptyResponse;
  if (section === undefined) return undefined;
  const policy: EmptyResponsePolicy = {};
  // 只显式关：true 是缺省，不注入（与 vision.disabled 的「闸」风格一致）。
  if (section.enabled === false) policy.enabled = false;
  if (section.seamless === false) policy.seamless = false;
  if (
    typeof section.maxRetries === 'number' &&
    Number.isFinite(section.maxRetries) &&
    section.maxRetries >= 0
  ) {
    policy.maxRetries = Math.min(Math.floor(section.maxRetries), MAX_EMPTY_RESPONSE_RETRIES_LIMIT);
  }
  if (typeof section.nudge === 'string' && section.nudge.trim().length > 0) {
    policy.nudge = section.nudge;
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}
