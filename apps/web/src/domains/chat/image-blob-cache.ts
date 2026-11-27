/**
 * 图片 blob 的客户端缓存（q-media-image-card）。
 *
 * sha256 → data URL 的 LRU（内容寻址 ⇒ 同一 sha256 的字节永不改变，缓存无需失效；
 * 跨 node 重连也命中 —— 字节身份与哪台机器无关）。inflight 去重：同一张图被多张卡
 * / 缩略图 + 放大预览同时请求时只发一次 RPC。
 *
 * **缓存键只有 sha256，不含 session_id**：服务端闸校验的是「这个 viewer 能不能经
 * 这个会话看到这张图」，而缓存里的字节一定是本 viewer 此前**已经过闸**合法取到的
 * （内容寻址 ⇒ 与哪次会话无关）；图片卡又只在「当前会话转录里真有这条 ref」时才渲染，
 * 所以命中缓存不暴露任何新事实。每次首取仍带 session_id 过服务端的归属闸。
 *
 * **只缓存成功**：缺 blob / 归属不命中 / 旧 gateway not_found / 网络错都不缓存
 * （下次挂载重试；失败缓存会把「暂时拿不到」钉成「永远拿不到」）。上限 64 条：
 * 8 MiB 图的 base64 ≈ 10.7 MB，64 条是内存与命中率之间的保守折中。
 */
import type { GatewayClient } from '../../gateway/client';

/** 最多缓存多少张（LRU：最近用过的放尾部）。 */
const MAX_CACHED = 64;

const urls = new Map<string, string>();
const inflight = new Map<string, Promise<string | undefined>>();

/**
 * 取一张已入池图片的 data URL；拿不到（缺 blob / 归属不命中 / 旧 gateway / 网络错）
 * 返回 `undefined` —— 调用方退回纯元数据展示，不显示破图。
 * `sessionId` = 这张图所属的会话（服务端可见性闸用，见 node/images.ts）。
 */
export function imageBlobUrl(
  client: GatewayClient,
  sha256: string,
  sessionId: string,
): Promise<string | undefined> {
  const hit = urls.get(sha256);
  if (hit !== undefined) {
    // LRU 触达：移到尾部。
    urls.delete(sha256);
    urls.set(sha256, hit);
    return Promise.resolve(hit);
  }
  const pending = inflight.get(sha256);
  if (pending !== undefined) return pending;
  const task = (async (): Promise<string | undefined> => {
    try {
      const result = await client.imageBlob(sha256, sessionId);
      if (!result.found || result.base64 === undefined || result.base64.length === 0) {
        return undefined;
      }
      const url = `data:${result.mime ?? 'application/octet-stream'};base64,${result.base64}`;
      urls.set(sha256, url);
      while (urls.size > MAX_CACHED) {
        const oldest = urls.keys().next().value;
        if (oldest === undefined) break;
        urls.delete(oldest);
      }
      return url;
    } catch {
      return undefined;
    } finally {
      inflight.delete(sha256);
    }
  })();
  inflight.set(sha256, task);
  return task;
}
