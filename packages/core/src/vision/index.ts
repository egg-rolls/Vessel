/**
 * 视觉基座在核心的**形状与注册点**（0.56 P0）
 * @module @vessel-agent/core/vision
 *
 * 这里只有「机制」，没有任何一种 provider 的块形状（宪法第十三条）：
 * - `types/vision.ts`：`VisionBackend` 接口 + 规范部件 + 计划形状；
 * - `blobs.ts`：内容寻址存储（写一次永不重写）与 GC —— **必须**在核心，
 *   因为「同一张图两次请求同一串字节」是前缀守卫的不变量；
 * - `ingest.ts`：上传即落（refs → sha256 + blob）；
 * - `plan.ts`：请求期把 refs 解析成「这一轮发哪几张图」（确定性，只读 blob）。
 * - `notice.ts`：请求期丢图时的模型侧事实注记卡（q-vision-image-budget-fix ③）。
 *
 * 第一份具体实现（OpenAI `image_url` 形状 + magic bytes 嗅探）在
 * `plugins/provider/openai/src/vision.ts`，通过 `provider.vision` 挂到实例上。
 */

export type {
  AttachmentPlan,
  CanonicalImagePart,
  DroppedImage,
  ImageDropReason,
  PlannedImage,
  RequestContentPart,
  VisionBackend,
  VisionBackendKind,
  VisionSettings,
} from '../types/vision.js';
export { conservativeTokenCost, EMPTY_ATTACHMENT_PLAN } from '../types/vision.js';
export {
  type CollectImageBlobsOptions,
  type CollectImageBlobsResult,
  collectImageBlobs,
  DEFAULT_IMAGE_BLOB_TTL_DAYS,
  DEFAULT_ORPHAN_GRACE_HOURS,
  IMAGE_BLOB_POOL_MAX_BYTES,
  type ImageBlobStats,
  imageBlobRoot,
  imageExtOf,
  isSha256,
  readImageBlob,
  scanImageBlobs,
  sha8Of,
  sha256Of,
} from './blobs.js';
export {
  collectReferencedShas,
  IMAGE_INGEST_MAX_BYTES,
  type ImageIngestOptions,
  type ImageIngestResult,
  ingestImageRefs,
} from './ingest.js';
export { renderImageDropNotice } from './notice.js';
export {
  type AttachmentPlanInput,
  DEFAULT_IMAGE_TOKEN_BUDGET,
  DEFAULT_IMAGE_TOKEN_BUDGET_RATIO,
  imageDropLabel,
  imageDropStatus,
  type ReadImageBlob,
  resolveAttachmentPlan,
  summarizeAttachmentPlan,
  visionDisabled,
} from './plan.js';
