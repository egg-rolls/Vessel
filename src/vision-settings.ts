/**
 * 视觉配置 → core 的 `VisionSettings`（0.56）
 *
 * ## 这里**不**回答「能不能看图」
 *
 * 能力问 `provider.vision`（插件挂的 `VisionBackend` 描述符）：核心与装配层都不认识
 * 「哪个模型支持视觉」，也不该认识（那张「模型名 → 能力」表注定与 provider 配置漂移）。
 * 本模块只把用户配置里的**运行期**四件事翻成 core 的形状：
 * kill switch / 单请求张数 / 精度意图 / 预处理策略。
 *
 * ## 没有 `enable`
 *
 * 决策 1：模型支持就直通。「贴图即见」是默认行为；`vision.disabled` 是**出事时的闸**
 * （一键退回 0.55：图不内联、尾注回落老文案），不是使用前的门。
 * 两条通道等价：`vision.disabled: true` 与 `VESSEL_DISABLE_VISION=1`（core 侧判 env）。
 *
 * ## 缺省 = 不注入
 *
 * 全部字段都缺省时返回 `undefined` —— 与「从没有 vision 配置」逐字节相同（旧装配行为不变）。
 *
 * @module vessel/vision-settings
 */

import type { VisionSettings } from '../packages/core/src/index';
import type { VesselConfig } from '../packages/config/src/index';

/** 单请求张数的安全上界（夹取风格与 `temporaryTtlHours` 一类配置一致）。 */
export const MAX_IMAGES_PER_REQUEST_LIMIT = 32;

/** 配置 → `VisionSettings`；没有可用的键时返回 `undefined`（= 不注入）。 */
export function visionSettingsOf(config: VesselConfig): VisionSettings | undefined {
  const vision = config.vision;
  if (vision === undefined) return undefined;
  const settings: VisionSettings = {};
  if (vision.disabled === true) settings.disabled = true;
  if (
    typeof vision.maxImagesPerRequest === 'number' &&
    Number.isFinite(vision.maxImagesPerRequest) &&
    vision.maxImagesPerRequest >= 0
  ) {
    settings.maxImagesPerRequest = Math.min(
      Math.floor(vision.maxImagesPerRequest),
      MAX_IMAGES_PER_REQUEST_LIMIT,
    );
  }
  if (typeof vision.detail === 'string' && vision.detail.length > 0) {
    settings.detail = vision.detail;
  }
  if (typeof vision.preprocess === 'string' && vision.preprocess.length > 0) {
    settings.preprocess = vision.preprocess;
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}
