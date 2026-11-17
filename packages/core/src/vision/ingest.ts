/**
 * 上传即落：附件引用 → sha256 + blob（0.56 决策 2）
 * @module @vessel-agent/core/vision
 *
 * ## 为什么在「入口」就把字节冻结
 *
 * 请求期只读 blob（`plan.ts` 的 `readImageBlob`），所以「同一张图第二次请求是同一串字节」
 * 变成**构造性成立**：读的不是用户随时能改的文件，而是一份只写一次的内容寻址副本。
 * 若改成「发送时才读 path」，用户改了原图 ⇒ 请求体里那段 base64 变了 ⇒ 前缀守卫
 * （逐字节比）报 `prompt.prefix_changed`，而失败表现只是「warning 变多」。
 *
 * ## 这里**不做**的三件事（各有主）
 *
 * 1. **不判格式**：magic bytes 是**后端**的能力（`VisionBackend.sniffImageMime`），入口
 *    这里连后端都还没有。非图片文件会带着 sha256 进池，然后在请求期被明确拒绝
 *    （`not_an_image` / `unsupported_format`）—— 那才是「有后端可比」的时刻。
 * 2. **不缩放 / 不转码**：P0 预处理 = identity（provider 自己缩到 ~1300²）。
 *    一旦启用「产出新字节」的预处理，**必须把新 sha256 写回 `refs`**（P1 硬约束）。
 * 3. **不判越权**：边界判定由装配层注入（`allowPath`，复用 basic-tools 的
 *    `evaluatePath` / `canonicalPath`）—— core 不认识 `allowed_roots` / `deny_paths`。
 *    缺省（没注入）= **fail-closed**：不读任何文件、不落任何 blob（只保留引用原样）。
 */

import { readFile, stat } from 'node:fs/promises';
import type { Message, MessageRef } from '../types/provider.js';
import { isSha256, putImageBlob } from './blobs.js';

/** 单图入池的字节上限（与 design §7.4 的 8 MiB 同一档；超了不落池、只留引用）。 */
export const IMAGE_INGEST_MAX_BYTES = 8 * 1024 * 1024;

/** 一次入池的结果 */
export interface ImageIngestResult {
  refs: MessageRef[];
  /** 落池了几张（去重后仍然算「这次入池过」） */
  ingested: number;
  /** 命中已有 blob（同一张图第二次出现）的张数 */
  deduped: number;
  /** 没落池的原因（逐条，可读；**不许静默**） */
  notes: string[];
}

export interface ImageIngestOptions {
  /** blob 池根（缺省 `imageBlobRoot()`） */
  root?: string;
  /**
   * 路径边界判定（装配层注入）。返回 `'allow'` 才读文件；
   * 缺省 = 没注入 ⇒ **一律不读**（fail-closed，图不内联但不报错）。
   */
  allowPath?: (target: string) => 'allow' | 'ask' | 'deny';
  /** 读文件（注入是为了可验证）；缺省 `node:fs/promises#readFile` */
  readFile?: (target: string) => Promise<Uint8Array>;
  /** 单图字节上限（缺省 8 MiB） */
  maxBytes?: number;
}

/**
 * 把一批引用里的图片落进 blob 池，并把 `sha256` 回填到返回的引用上。
 *
 * **幂等**：已经带合法 `sha256` 的引用原样透传（不重读文件、不重写 blob）——
 * 于是「同一条消息被重投 / 重放 / 恢复」不会产生第二份字节，也不会动 mtime。
 *
 * 返回**新数组**（不改入参：调用方手里那批引用可能已经进了 inbox / session）。
 */
export async function ingestImageRefs(
  refs: readonly MessageRef[],
  options: ImageIngestOptions = {},
): Promise<ImageIngestResult> {
  const maxBytes = options.maxBytes ?? IMAGE_INGEST_MAX_BYTES;
  const result: ImageIngestResult = { refs: [], ingested: 0, deduped: 0, notes: [] };
  for (const ref of refs) {
    if (ref.kind !== 'image' || isSha256(ref.sha256)) {
      result.refs.push(ref);
      continue;
    }
    const decision = options.allowPath?.(ref.path) ?? 'deny';
    if (decision !== 'allow') {
      result.notes.push(`image not ingested (${decision}): ${ref.path}`);
      result.refs.push({ ...ref });
      continue;
    }
    try {
      const info = await stat(ref.path);
      if (!info.isFile()) {
        result.notes.push(`image not ingested (not a file): ${ref.path}`);
        result.refs.push(ref);
        continue;
      }
      if (info.size > maxBytes) {
        result.notes.push(`image not ingested (too large ${String(info.size)} B): ${ref.path}`);
        result.refs.push(ref);
        continue;
      }
      const bytes = await (options.readFile ?? ((target: string) => readFile(target)))(ref.path);
      const blob = await putImageBlob({
        bytes,
        ...(ref.mime !== undefined ? { mimeHint: ref.mime } : {}),
        ...(options.root !== undefined ? { root: options.root } : {}),
      });
      if (blob.deduped) result.deduped += 1;
      else result.ingested += 1;
      result.refs.push({ ...ref, sha256: blob.sha256, bytes: blob.bytes });
    } catch (error) {
      result.notes.push(
        `image not ingested (${error instanceof Error ? error.message : String(error)}): ${ref.path}`,
      );
      result.refs.push(ref);
    }
  }
  return result;
}

/**
 * 一批消息里出现过的全部 `refs.sha256`（GC 的引用集合的**一半**）。
 *
 * 另一半必须由调用方从**事件日志**里扫（`user.message` / `tool.call.completed` 的
 * `refs`）：漏扫事件日志 = 删掉还在用的图 = 本设计最严重的一类故障（design §5.4）。
 */
export function collectReferencedShas(messages: readonly Message[]): Set<string> {
  const out = new Set<string>();
  for (const message of messages) {
    for (const ref of message.refs ?? []) {
      if (isSha256(ref.sha256)) out.add(ref.sha256);
    }
  }
  return out;
}
