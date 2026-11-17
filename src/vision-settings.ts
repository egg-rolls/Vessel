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

import type { VesselConfig } from '../packages/config/src/index';
import type { VisionSettings } from '../packages/core/src/index';
import { visionDisabled } from '../packages/core/src/vision/index';
import { VISION_SURFACE_INLINE, VISION_SURFACE_OFF, type VisionSurface } from './refs-notice-hook';

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

/**
 * 视觉面探针（0.56 P1）：`[refs]` 尾注该说「图已附上，别再读」还是 0.55 老文案。
 *
 * 两个判据都必须**同时**成立才算「会内联」：
 * 1. provider 有 `VisionBackend`（`provider.vision`，插件挂的；`undefined` = 这家的模型
 *    不支持看图）。装配层不认识「哪个模型支持视觉」，所以只透传这个存在性；
 * 2. kill switch 没打开（`config.vision.disabled` / `VESSEL_DISABLE_VISION=1`）——
 *    与 core 用**同一个**判据函数（`visionDisabled`），避免两处各判一次、漂移成
 *    「尾注说附上了、请求里其实没有」。
 *
 * 任一不成立 ⇒ `off`（老文案逐字不变）。探针本身不抛错（抛错由调用方退化成 `off`）。
 */
export function visionSurfaceOf(input: {
  config: VesselConfig;
  /** provider 的 `vision`（`VisionBackend`）；只需要「有没有」 */
  backend?: unknown;
}): VisionSurface {
  if (input.backend === undefined) return VISION_SURFACE_OFF;
  if (visionDisabled(visionSettingsOf(input.config))) return VISION_SURFACE_OFF;
  return VISION_SURFACE_INLINE;
}
