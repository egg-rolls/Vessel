/**
 * 已失效（过期）的 interaction id —— **跨刷新记住**（0.59）。
 *
 * 为什么需要：rotate 的批准等待超时后，本端会收到 `tool.permission.expired` 并把卡片收起，
 * 但服务端那条记录在 run 结束前仍是 `pending`。于是刷新一次，`interactions.list` 又把
 * 这张**已经没人等人答**的卡带回来 —— 用户点「允许」，响应发进一条没人订阅的事件流，
 * 界面显示「已应答」而模型早已走了。这正是「看着能点、点了什么都没发生」的形状。
 *
 * 这里把「我确知已经失效」的 id 记在 sessionStorage（同标签页生命周期，关掉即失去意义），
 * 启动时喂给 `settled` 集合，hydration 就不会再把它们补回来。
 *
 * 只存 id、只存最近 {@link MAX_REMEMBERED} 条；任何读失败（无 storage / 旧脏数据）都当空。
 */

const STORAGE_KEY = 'vessel.gateway.expired-interactions';
/** 上限：permission id 是 UUID，500 条约 20KB，足够覆盖一个标签页的寿命。 */
const MAX_REMEMBERED = 500;

function defaultStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // 隐私模式下访问 storage 可能直接抛（Safari），那时退化成不记忆。
    return null;
  }
}

/** 读回已失效的 id（新→旧无关；坏数据一律当空，不让它拖垮启动）。 */
export function readExpiredRequestIds(storage: Storage | null = defaultStorage()): string[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null || raw === '') return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

/** 记住一条已失效的 id（去重、保序、截断到上限）。返回写入后的全集，便于调用方断言。 */
export function rememberExpiredRequestId(
  requestId: string,
  storage: Storage | null = defaultStorage(),
): string[] {
  if (storage === null || requestId.length === 0) return [];
  const next = [...new Set([...readExpiredRequestIds(storage), requestId])];
  const trimmed = next.slice(Math.max(0, next.length - MAX_REMEMBERED));
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // 配额满 / 被禁用：不记忆也不报错（记忆是优化，不是正确性前提）。
  }
  return trimmed;
}

/** 清空（断开连接时调用：换了节点，旧 id 与当前服务端无关）。 */
export function clearExpiredRequestIds(storage: Storage | null = defaultStorage()): void {
  if (storage === null) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // 同上：失败无害。
  }
}

export const EXPIRED_REQUESTS_STORAGE_KEY = STORAGE_KEY;
export const EXPIRED_REQUESTS_MAX = MAX_REMEMBERED;
