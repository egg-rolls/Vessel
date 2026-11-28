/**
 * path 寻址预览的客户端缓存（图片内嵌气泡精炼，承重验收点：防长历史多图翻页
 * RPC 风暴）。形状镜像 image-blob-cache.ts：LRU + inflight 去重 —— 同一 path
 * 被多张 chip / 卡 / 弹窗同时请求时只发一次 `attachments.preview`。
 *
 * 与 blob 缓存（内容寻址 ⇒ 永不变）不同，path 寻址的字节**会变**（活文件可被
 * 编辑；暂存副本会过期），所以缓存带时效：
 * - ok（非暂存）：短 TTL（60s）—— 活文件内容可能变，过期后重探；
 * - ok（暂存）：TTL 与服务端 expiresAt 取小 —— 副本字节不变，但到点要能探出 gone；
 * - gone：永久缓存 —— 暂存副本过期是不可逆事实（path 唯一），长历史里成排过期
 *   chip 重挂载不再各发一次探针（这正是 RPC 风暴的主源）；
 * - denied / too_large / not_image / 网络错：不缓存（下次挂载重试；把「暂时拿不到」
 *   钉成「永远拿不到」是 image-blob-cache 已裁过的坑）。
 *
 * 上限 64 条与 blob 缓存同一折中（8 MiB 图 base64 ≈ 10.7 MB）。缓存键只有 path：
 * 缓存里的字节一定是本 viewer 此前经 `attachments.preview` 合法取到的，命中不
 * 暴露新事实；每次首取仍由服务端做归属 / 大小 / 种类闸。
 */
import type { GatewayClient } from '../../gateway/client';
import type { AttachmentPreviewResult } from '../../gateway/node/attachments';

/** 最多缓存多少条（LRU：最近用过的放尾部）。 */
const MAX_CACHED = 64;

/** ok 结果的保守时效（活文件可能被编辑；暂存再与 expiresAt 取小）。 */
const OK_TTL_MS = 60_000;

interface CacheEntry {
  result: AttachmentPreviewResult;
  /** 缓存失效时刻（ms epoch）；gone = Infinity（不可逆事实）。 */
  until: number;
}

const entries = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<AttachmentPreviewResult>>();

function cacheUntil(result: AttachmentPreviewResult): number | undefined {
  if (result.status === 'gone') return Number.POSITIVE_INFINITY;
  if (result.status !== 'ok' || result.dataUrl === undefined) return undefined;
  const ttl = Date.now() + OK_TTL_MS;
  // 暂存副本：服务端给的过期时刻更早则以它为准（到点重探应得 gone）。
  if (result.staging === true && result.expiresAt !== undefined) {
    return Math.min(ttl, result.expiresAt);
  }
  return ttl;
}

/**
 * 取一个 path 的预览结果（缓存命中零 RPC；同 path 并发去重）。
 * 网络错原样 reject（不缓存），调用方按既有口径降级 unavailable。
 */
export function attachmentPreview(
  client: GatewayClient,
  path: string,
): Promise<AttachmentPreviewResult> {
  const hit = entries.get(path);
  if (hit !== undefined) {
    if (Date.now() < hit.until) {
      // LRU 触达：移到尾部。
      entries.delete(path);
      entries.set(path, hit);
      return Promise.resolve(hit.result);
    }
    entries.delete(path);
  }
  const pending = inflight.get(path);
  if (pending !== undefined) return pending;
  const task = (async (): Promise<AttachmentPreviewResult> => {
    try {
      const result = await client.previewAttachment(path);
      const until = cacheUntil(result);
      if (until !== undefined) {
        entries.set(path, { result, until });
        while (entries.size > MAX_CACHED) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          entries.delete(oldest);
        }
      }
      return result;
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, task);
  return task;
}
