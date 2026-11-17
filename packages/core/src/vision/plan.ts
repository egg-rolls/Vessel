/**
 * 图片计划：`messages[].refs` 里 `kind:'image'` → 这一轮要发哪几张图（0.56 P0）
 * @module @vessel-agent/core/vision
 *
 * 这是「refs 可内联的最后一段」（design §15 P0-01）：把引用解析成**这一条消息要发哪几张
 * 图**，适配器据此把该条 `content` 由 `string` 升成块数组；plan 不含的消息 ⇒ 原分支
 * 一字不改。
 *
 * ## 确定性是硬要求（不是风格）
 *
 * 同一份 `messages` + 同一组字节 ⇒ **必须**产出同一份 plan（同一 base64、同一顺序）。
 * 判据在 `runtime/prompt-prefix-guard.ts:75`（逐条 `JSON.stringify(message)` 比字节）：
 * plan 里任何一处「看起来一样但字节不同」（换序、每次重算的 uuid、重编码）都会让它误报
 * `prompt.prefix_changed`。所以这里：
 * - 顺序 = `refs` 里的顺序（不排序、不按大小、不按 mtime）；
 * - 字节 = 只从 blob 读（`readImageBlob`），**永不**回源读 `refs[].path`；
 * - 没有任何时间 / 随机 / 环境相关的字段进 plan（`part` 里也不许有）。
 *
 * ## 只读两处（安全边界）
 *
 * (a) `refs[].sha256` 对应的 blob；(b) 别的什么都不读 —— 不扫目录、不猜路径、不读 URL、
 * 不递归。`refs[].path` 只用来给人的文案（`dropped[].path` / `[refs]` 尾注），不进请求。
 *
 * ## 预算按「先到先得」裁（P0 的取舍，写清）
 *
 * 超过单请求上限时丢的是**后面**的图（保持已在历史里发过的那些），不是「最近 N 张」：
 * 按 recency 裁会让**早前已发出的消息**在图消失时改写内容 = 段内改写历史 = 前缀变化。
 * 真正的「只保留最近 3 条带图消息」属于压缩（段边界，允许一次带 reason 的前缀变化），
 * 那是 P1 的冻结集合，不在请求期做。
 */

import type { Message, MessageRef } from '../types/provider.js';
import type {
  AttachmentPlan,
  CanonicalImagePart,
  DroppedImage,
  ImageDropReason,
  PlannedImage,
  VisionBackend,
  VisionSettings,
} from '../types/vision.js';
import { readImageBlob, sha8Of, sha256Of } from './blobs.js';

/** 单请求张数上限的缺省（design §7.5：6 张 ≈ 6,144 token） */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 6;

/** 读 blob 的注入口（**唯一**的 I/O；缺省用 `blobs.ts` 的实现，注入是为了可验证）。 */
export type ReadImageBlob = (sha256: string) => Promise<Uint8Array | undefined>;

/** `resolveAttachmentPlan` 的输入 */
export interface AttachmentPlanInput {
  /** 本次请求视图（`buildRequestMessages` 之后、占位替换之后的那一份） */
  messages: readonly Message[];
  /** 主模型的视觉后端；`undefined` = 该模型没有视觉能力 */
  backend?: VisionBackend;
  /** 运行期设置（kill switch / 张数上限 / 精度） */
  settings?: VisionSettings;
  /** 读 blob；缺省 `blobs.ts` */
  readBlob?: ReadImageBlob;
}

/** kill switch 命中（`vision.disabled` 或 `VESSEL_DISABLE_VISION=1`）。 */
export function visionDisabled(settings?: VisionSettings): boolean {
  if (settings?.disabled === true) return true;
  const env = process.env.VESSEL_DISABLE_VISION;
  return env === '1' || env === 'true';
}

/** 一条消息里的图片引用（`kind:'image'`），顺序原样保留。 */
function imageRefsOf(message: Message): MessageRef[] {
  const refs = message.refs;
  if (refs === undefined || refs.length === 0) return [];
  return refs.filter((ref) => ref.kind === 'image');
}

/** 收集「这次请求里出现的全部图片引用」+ 它们所在的消息下标。 */
function collectImageRefs(
  messages: readonly Message[],
): Array<{ messageIndex: number; ref: MessageRef }> {
  const out: Array<{ messageIndex: number; ref: MessageRef }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    for (const ref of imageRefsOf(message)) out.push({ messageIndex: index, ref });
  }
  return out;
}

/**
 * 把 `refs` 里的图片解析成计划。
 *
 * 步骤（顺序即判定顺序，每一步都留一条可读原因）：
 * 0. kill switch ⇒ 一律不内联（`vision_disabled`），**不是静默**；
 * 1. 没有后端 / 后端不接受图 ⇒ `no_vision`；
 * 2. 每条引用：没 sha256 ⇒ `not_ingested`（不回源读 path）；blob 缺失 ⇒ `blob_missing`；
 * 3. magic bytes 嗅探 ⇒ 不认识 `not_an_image`、不在 `formats()` 里 `unsupported_format`；
 * 4. 单图 / 整包字节上限 ⇒ `too_large` / `bytes_budget`；
 * 5. 张数上限 ⇒ `budget`（**丢后面的**，见模块头）。
 *
 * 没有任何图片引用时返回空计划（`tokens: 0`），调用方照旧把它显式传给估算器。
 */
export async function resolveAttachmentPlan(input: AttachmentPlanInput): Promise<AttachmentPlan> {
  const settings = input.settings;
  const collected = collectImageRefs(input.messages);
  const byMessageIndex = new Map<number, PlannedImage[]>();
  const dropped: DroppedImage[] = [];
  const empty = (extra?: Partial<AttachmentPlan>): AttachmentPlan => ({
    byMessageIndex,
    tokens: 0,
    images: 0,
    bytes: 0,
    dropped,
    ...extra,
  });
  if (collected.length === 0) {
    return empty(input.backend === undefined ? {} : { backend: backendTag(input.backend) });
  }

  // 步 0：kill switch（决策 1 的**唯一**回退通道，不是默认门）。
  if (visionDisabled(settings)) {
    for (const { messageIndex, ref } of collected) {
      dropped.push(dropOf(messageIndex, ref, 'vision_disabled'));
    }
    return empty({ disabled: true });
  }

  const backend = input.backend;
  // 步 1：没有视觉能力（`undefined` = 没有，不是「可能支持」）。
  if (backend === undefined || !backend.supportsImage()) {
    for (const { messageIndex, ref } of collected) {
      dropped.push(dropOf(messageIndex, ref, 'no_vision'));
    }
    return empty(backend === undefined ? {} : { backend: backendTag(backend) });
  }

  const formats = new Set(backend.formats().map((entry) => entry.toLowerCase()));
  const details = backend.detailLevels();
  const detail =
    settings?.detail !== undefined && details.includes(settings.detail)
      ? settings.detail
      : undefined;
  const configuredMax = settings?.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST;
  const descriptorMax = backend.maxImagesPerRequest();
  const maxImages = Math.max(0, Math.min(configuredMax, descriptorMax > 0 ? descriptorMax : 0));
  const maxBytesPerImage = backend.maxBytesPerImage();
  const maxBytesPerRequest = backend.maxBytesPerRequest();
  const readBlob = input.readBlob ?? ((sha256: string) => readImageBlob(sha256));

  let images = 0;
  let bytes = 0;
  for (const { messageIndex, ref } of collected) {
    const sha256 = ref.sha256;
    if (sha256 === undefined || sha256 === '') {
      dropped.push(dropOf(messageIndex, ref, 'not_ingested'));
      continue;
    }
    const raw = await readBlob(sha256);
    if (raw === undefined) {
      dropped.push(dropOf(messageIndex, ref, 'blob_missing'));
      continue;
    }
    // 读回来的字节必须还是那个 sha256（blob 被手改 / 盘上损坏）：不符合就**不发**。
    if (sha256Of(raw) !== sha256) {
      dropped.push(dropOf(messageIndex, ref, 'blob_missing'));
      continue;
    }
    if (images >= maxImages) {
      dropped.push(dropOf(messageIndex, ref, 'budget'));
      continue;
    }
    if (maxBytesPerImage > 0 && raw.length > maxBytesPerImage) {
      dropped.push(dropOf(messageIndex, ref, 'too_large'));
      continue;
    }
    if (maxBytesPerRequest > 0 && bytes + raw.length > maxBytesPerRequest) {
      dropped.push(dropOf(messageIndex, ref, 'bytes_budget'));
      continue;
    }
    const sniffed = backend.sniffImageMime?.(raw);
    if (sniffed === undefined) {
      dropped.push(dropOf(messageIndex, ref, 'not_an_image'));
      continue;
    }
    if (!formats.has(sniffed.toLowerCase())) {
      dropped.push(dropOf(messageIndex, ref, 'unsupported_format'));
      continue;
    }
    const part: CanonicalImagePart = {
      media_type: sniffed,
      bytes: raw,
      sha256,
      ...(detail !== undefined ? { detail } : {}),
      source: { path: ref.path, ...(ref.name !== undefined ? { name: ref.name } : {}) },
    };
    const planned: PlannedImage = {
      message_index: messageIndex,
      sha256,
      media_type: sniffed,
      bytes: raw.length,
      path: ref.path,
      ...(ref.name !== undefined ? { name: ref.name } : {}),
      part: backend.toRequestPart(part),
    };
    const bucket = byMessageIndex.get(messageIndex);
    if (bucket === undefined) byMessageIndex.set(messageIndex, [planned]);
    else bucket.push(planned);
    images += 1;
    bytes += raw.length;
  }

  return {
    byMessageIndex,
    tokens: images > 0 ? backend.tokenCost(images) : 0,
    images,
    bytes,
    dropped,
    backend: backendTag(backend),
  };
}

function backendTag(backend: VisionBackend): { id: string; kind: VisionBackend['kind'] } {
  return { id: backend.id, kind: backend.kind };
}

function dropOf(messageIndex: number, ref: MessageRef, reason: ImageDropReason): DroppedImage {
  return {
    message_index: messageIndex,
    ...(ref.sha256 !== undefined ? { sha256: ref.sha256 } : {}),
    path: ref.path,
    reason,
  };
}

/** 丢弃原因的稳定短标签（事件 / chip / 日志共用一套词，别各写一份）。 */
export function imageDropLabel(reason: ImageDropReason): string {
  switch (reason) {
    case 'budget':
      return 'over per-request budget';
    case 'bytes_budget':
      return 'over per-request byte budget';
    case 'unsupported_format':
      return 'unsupported_format';
    case 'not_an_image':
      return 'not_an_image';
    case 'too_large':
      return 'too_large';
    case 'blob_missing':
      return 'attachment_blob_missing';
    case 'not_ingested':
      return 'not_ingested';
    case 'vision_disabled':
      return 'vision_disabled';
    case 'no_vision':
      return 'no_vision_backend';
    case 'placeholder':
      return 'placeholder';
    case 'compaction':
      return 'compaction';
  }
}

/** 丢弃原因 → GUI 的三态（`sent` 由 `image.sent` 事件表达，不在这里）。 */
export function imageDropStatus(reason: ImageDropReason): 'dropped' | 'not_sent' {
  return reason === 'vision_disabled' || reason === 'no_vision' || reason === 'not_ingested'
    ? 'not_sent'
    : 'dropped';
}
/** 一次请求的图片摘要（日志 / `llm.request` 落盘元信息用；**只有数字与 sha8**）。 */
export function summarizeAttachmentPlan(plan: AttachmentPlan): {
  images: number;
  tokens: number;
  bytes: number;
  dropped: number;
  sha8?: string[];
} {
  if (plan.images === 0 && plan.dropped.length === 0) {
    return { images: 0, tokens: 0, bytes: 0, dropped: 0 };
  }
  const shas: string[] = [];
  for (const images of plan.byMessageIndex.values()) {
    for (const image of images) shas.push(sha8Of(image.sha256));
  }
  return {
    images: plan.images,
    tokens: plan.tokens,
    bytes: plan.bytes,
    dropped: plan.dropped.length,
    ...(shas.length > 0 ? { sha8: shas } : {}),
  };
}
