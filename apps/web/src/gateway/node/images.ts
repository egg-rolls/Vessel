/**
 * 图片域方法：`images.blob`（q-media-image-card，内容寻址 blob 只读）。
 *
 * GUI 图片卡（缩略图 / 点击放大）的字节来源：只按 sha256 读 blob 池，
 * 没有路径入参 —— 池里的字节都已经过入池边界闸（media view / 用户上传同一道）。
 *
 * **会话可见性闸**（服务端）：`session_id` 必填，sha256 必须真实出现在该会话的
 * 消息 refs 里；归属不明 / 无权限一律 `found: false`（fail-closed）。所以调用方
 * 必须传「这张图所属的那个会话」—— 图片卡渲染在哪个会话的转录里，就传哪个。
 *
 * 旧 gateway 没有这个方法（`not_found`）：调用方退回纯元数据 chip（文件名 +
 * 投递状态），不显示破图 —— 与 `attachments.list` 的降级同口径。
 */
import { AttachmentsClient } from './attachments';

/** 缺 blob / 超限的稳定码（与服务端 `ImageBlobReason` 同一闭集）。 */
export type ImageBlobReason = 'blob_missing' | 'too_large';

/** `images.blob` 的结果体（sparse：未命中不带 bytes/mime/base64）。 */
export interface ImageBlobResult {
  sha256: string;
  found: boolean;
  bytes?: number;
  mime?: string;
  base64?: string;
  reason?: ImageBlobReason;
}

/**
 * 图片域客户端方法。
 *
 * `ImagesClient` 由 `GatewayClient` 的继承链接进来（见 `index.ts`）；
 * 方法只做一层 `rpc` 包装。缓存不在这里（传输层无状态）—— 见 `image-blob-cache.ts`。
 */
export abstract class ImagesClient extends AttachmentsClient {
  /**
   * 按内容地址读一张已入池的图（只读；未命中折进结果体，不抛业务错）。
   * `sessionId` = 这张图所属的会话（服务端据此做归属校验，fail-closed）。
   */
  imageBlob(sha256: string, sessionId: string): Promise<ImageBlobResult> {
    return this.rpc<ImageBlobResult>('images.blob', { sha256, session_id: sessionId });
  }
}
