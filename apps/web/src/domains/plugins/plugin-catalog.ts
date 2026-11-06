/**
 * CONTRACT-0.47 §2：宿主 → 插件 catalog 推送。
 *
 * `plugins.catalog` 是宿主只读 RPC，插件 iframe 不直接调用。失败 / 旧 gateway /
 * 结果形状不符时返回 `null`，调用方不得发送 `vessel.catalog`（也不得伪造空数组）。
 * 空数组是合法 catalog，照常推送。
 */
import type { PluginCatalogItem, PluginCatalogResponse } from '../../gateway/types';

export const CATALOG_MESSAGE = 'vessel.catalog';
export const CATALOG_REQUEST_MESSAGE = 'vessel.catalog.request';

/**
 * CONTRACT-0.47 §2 首帧握手：插件监听器挂载后发 `vessel.catalog.request`，宿主收到
 * 立即再推一次。只接受当前 iframe `contentWindow` 发出的消息；source / origin 校验
 * 与 RPC 分支一致（opaque sandbox 的 origin 序列化为 `"null"`）。
 */
export function isCatalogRequest(
  event: { source: unknown; origin: unknown; data: unknown },
  frame: { window: unknown; origin: string },
): boolean {
  if (frame.window === null || event.source !== frame.window) return false;
  if (event.origin !== 'null' && event.origin !== frame.origin) return false;
  const data = event.data;
  if (data === null || typeof data !== 'object') return false;
  return (data as { type?: unknown }).type === CATALOG_REQUEST_MESSAGE;
}

export interface CatalogRpcClient {
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/** 拉取 catalog；不可用返回 null。永不抛错，便于调用方统一走“不发送”分支。 */
export async function fetchPluginCatalog(
  client: CatalogRpcClient,
): Promise<PluginCatalogItem[] | null> {
  try {
    const body = await client.rpc<PluginCatalogResponse>('plugins.catalog', {});
    if (body === null || typeof body !== 'object') return null;
    const items = (body as { items?: unknown }).items;
    return Array.isArray(items) ? (items as PluginCatalogItem[]) : null;
  } catch {
    return null;
  }
}

/**
 * 拉取并推送一次 catalog。返回是否真的发送。
 * 只有 fetch 成功且 items 是数组时才 post；失败分支不产生任何消息。
 */
export async function pushPluginCatalog(
  client: CatalogRpcClient,
  post: (message: unknown) => void,
): Promise<boolean> {
  const items = await fetchPluginCatalog(client);
  if (items === null) return false;
  post({ type: CATALOG_MESSAGE, items });
  return true;
}
