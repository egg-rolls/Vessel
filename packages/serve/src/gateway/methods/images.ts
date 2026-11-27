/**
 * images.* 方法（q-media-image-card）：**内容寻址**的图片 blob 只读出口。
 *
 * ## 为什么需要它
 *
 * media 工具 `action=view` 把图片入 blob 池后，时间线上那条 `[tool image]` 注入消息
 * 只有引用（path + sha256），没有字节 —— GUI 想给用户看**图片内容本身**（缩略图 /
 * 点击放大），就需要一条把 blob 字节送到浏览器的路。
 *
 * ## 为什么这不违反「attachments.read 不该存在」
 *
 * `attachments.ts` 禁的是**按路径读任意文件**（那会绕过 allowed_roots / deny 边界）。
 * 这里恰好相反：
 * - 入参**只有 sha256 + session_id**，没有路径、没有目录、没有递归、没有 URL；
 * - 池里的字节**全部**经 `ingestImageRefs` 的边界判定后才落盘（media view / 用户上传
 *   同一道闸）—— 读池 = 读「已经过闸的内容」，不构成新的绕过面；
 * - 只读、永不写、永不回源读 `refs[].path`（与 `vision/plan.ts` 同一条不变量）。
 *
 * ## 会话可见性闸（main 评审必加项）
 *
 * 入池边界闸是**写入时**的 allowed_roots；读取时还要过**会话级可见性**，否则知道
 * hash 就能读他人会话的图（跨会话信息泄漏）。实现：
 * - `session_id` 必填；会话经**与 `sessions.get` 同一个读口**（`sessionFor` →
 *   `loadForRead` / `load`）加载 —— viewer 对该会话的可见性与读转录完全同口径
 *   （permission `read`，dispatcher 统一闸）；
 * - sha256 必须**真实出现在该会话某条消息的 refs 里**（归属反查，只扫这一个会话，
 *   不做全局索引）；
 * - **fail-closed**：没有会话读口 / 会话不存在 / 读失败 / 归属不命中，一律折成
 *   `found: false, reason: 'blob_missing'` —— 与「blob 真缺失」不可区分，不泄漏
 *   「这个 hash 存在但你无权」这一事实。
 *
 * ## 形状
 *
 * 命中：`{ sha256, found: true, bytes, mime, base64 }`（mime 由魔数嗅探，不信扩展名）。
 * 未命中：`{ sha256, found: false, reason: 'blob_missing' | 'too_large' }`（折进结果体，
 * 不抛 500 —— 与 `attachments.list` 的 fail-soft 同口径；前端据此退回纯元数据 chip）。
 *
 * 字节上限与入池同档（8 MiB）：池里本就不该有更大的图；真出现（手工塞入 / 旧数据）
 * 时折成 `reason: 'too_large'`，不为一张异常图撑爆 RPC 响应。
 *
 * @module @vessel-agent/serve
 */

import { isSha256, readImageBlob, type SessionStore } from '@vessel-agent/core';
import { RpcError, type RpcMethodDefinition } from '../../rpc.js';

/** 单图响应上限（与 `IMAGE_INGEST_MAX_BYTES` 同档；base64 后 ≈ 10.7 MB）。 */
export const IMAGE_BLOB_MAX_BYTES = 8 * 1024 * 1024;

/** 缺 blob / 超限 / 归属不命中的稳定码（闭集，前端按 code 查词）。 */
export type ImageBlobReason = 'blob_missing' | 'too_large';

/** `images.blob` 的结果体（sparse：未命中不带 bytes/mime/base64）。 */
export interface ImageBlobResult {
  sha256: string;
  found: boolean;
  bytes?: number;
  /** 魔数嗅探出的 MIME（认不出 = `application/octet-stream`）。 */
  mime?: string;
  /** 图片字节的 base64（前端拼 data URL 渲染）。 */
  base64?: string;
  reason?: ImageBlobReason;
}

/** blob 读口（装配层可注入替换；缺省 = core 的 `readImageBlob`，只按 sha256 读）。 */
export type ImageBlobReader = (sha256: string) => Promise<Uint8Array | undefined>;

export interface ImageMethodsDeps {
  read?: ImageBlobReader;
  /**
   * 会话读口（**与 `sessions.get` 同源**：装配层注入同一个 `sessionFor`）。
   * 缺省 = 没有可校验归属的会话 ⇒ fail-closed（`found: false`），不猜。
   */
  sessionFor?: () => SessionStore | undefined;
}

/**
 * 魔数 → MIME（只认 media view 收的那几种格式；认不出不猜）。
 * 与 `vision/blobs.ts` 的 EXT_BY_MIME 互为镜像，但这里**不信扩展名**：
 * blob 文件名后缀只是入池时的 mime 提示，字节才是事实。
 */
function sniffMime(bytes: Uint8Array): string {
  const at = (index: number): number => bytes[index] ?? -1;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  // GIF: "GIF8"
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  // WEBP: "RIFF" .... "WEBP"
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return 'image/webp';
  }
  // BMP: "BM"
  if (at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp';
  // TIFF: II*\0 / MM\0*
  if (
    (at(0) === 0x49 && at(1) === 0x49 && at(2) === 0x2a && at(3) === 0x00) ||
    (at(0) === 0x4d && at(1) === 0x4d && at(2) === 0x00 && at(3) === 0x2a)
  ) {
    return 'image/tiff';
  }
  return 'application/octet-stream';
}

/** 未命中（缺 blob / 无权限 / 归属不明）的统一形状：不可区分，不泄漏存在性。 */
function missing(sha256: string): ImageBlobResult {
  return { sha256, found: false, reason: 'blob_missing' };
}

export function createImageMethods(deps: ImageMethodsDeps = {}): RpcMethodDefinition[] {
  const read = deps.read ?? ((sha256: string) => readImageBlob(sha256));
  return [
    {
      name: 'images.blob',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['sha256', 'session_id'],
        properties: {
          sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          session_id: { type: 'string', minLength: 1 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['sha256', 'found'],
        properties: {
          sha256: { type: 'string' },
          found: { type: 'boolean' },
          bytes: { type: 'integer', minimum: 0 },
          mime: { type: 'string' },
          base64: { type: 'string' },
          reason: { type: 'string', enum: ['blob_missing', 'too_large'] },
        },
      },
      handler: async (params) => {
        const sha256 = params.sha256;
        if (!isSha256(sha256)) {
          throw new RpcError('invalid_params', 'sha256 must be a 64-char lowercase hex digest');
        }
        const sessionId = params.session_id;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new RpcError('invalid_params', 'session_id is required');
        }
        // ── 会话可见性闸（fail-closed）──
        // 会话读口与 sessions.get 同源；归属反查只扫这一个会话的 refs。
        const backend = deps.sessionFor?.();
        if (backend === undefined) return missing(sha256);
        let state: Awaited<ReturnType<SessionStore['load']>>;
        try {
          state =
            backend.loadForRead !== undefined
              ? await backend.loadForRead(sessionId)
              : await backend.load(sessionId);
        } catch {
          return missing(sha256);
        }
        if (state === null) return missing(sha256);
        const owned = (state.messages ?? []).some((message) =>
          (message.refs ?? []).some((ref) => ref.sha256 === sha256),
        );
        if (!owned) return missing(sha256);
        // ── 字节读（只按 sha256，永不回源读路径）──
        const bytes = await read(sha256);
        if (bytes === undefined) return missing(sha256);
        if (bytes.byteLength > IMAGE_BLOB_MAX_BYTES) {
          return { sha256, found: false, reason: 'too_large' };
        }
        return {
          sha256,
          found: true,
          bytes: bytes.byteLength,
          mime: sniffMime(bytes),
          base64: Buffer.from(bytes).toString('base64'),
        };
      },
    },
  ];
}
