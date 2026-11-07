/**
 * Hub 连接存储（CONTRACT-0.49 §8）。
 *
 * 非 React、可注入：`createHubStorage(storage)` 接受任意 `getItem/setItem/removeItem`
 * 实现；默认实现才在首次调用时取 `sessionStorage`（模块顶层不捕获浏览器对象）。
 * 只写 `sessionStorage` 语义的槽：`vessel.hub.url` / `vessel.hub.token`；
 * 不写 localStorage / config / URL / query / 日志；token 不回显。
 */

export const HUB_URL_KEY = 'vessel.hub.url';
export const HUB_TOKEN_KEY = 'vessel.hub.token';

export interface HubConnection {
  url: string;
  token: string;
}

/** 注入面：与 `Storage` 同形的三元子集。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface HubStorage {
  read(): HubConnection;
  /** 保存 URL + token；空 token 等价于清除 token（回环 Hub 免 token）。 */
  save(url: string, token: string): void;
  /** 401 / 403 / WS 4401：只清 token，保留 URL 供 connect form 回填。 */
  clearToken(): void;
  /** 用户主动断开 / 切换 Hub：URL 与 token 一起清。 */
  clear(): void;
}

function guardedRead(storage: StorageLike, key: string): string {
  try {
    return storage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function guardedWrite(storage: StorageLike, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // 隐私模式 / 配额满：不降级到 localStorage，调用方保留内存态。
  }
}

function guardedRemove(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // 同上。
  }
}

export function createHubStorage(storage: StorageLike): HubStorage {
  return {
    read() {
      return {
        url: guardedRead(storage, HUB_URL_KEY),
        token: guardedRead(storage, HUB_TOKEN_KEY),
      };
    },
    save(url: string, token: string) {
      guardedWrite(storage, HUB_URL_KEY, url);
      if (token !== '') guardedWrite(storage, HUB_TOKEN_KEY, token);
      else guardedRemove(storage, HUB_TOKEN_KEY);
    },
    clearToken() {
      guardedRemove(storage, HUB_TOKEN_KEY);
    },
    clear() {
      guardedRemove(storage, HUB_URL_KEY);
      guardedRemove(storage, HUB_TOKEN_KEY);
    },
  };
}

/** 无浏览器存储时的内存回退；仅服务默认实例。 */
function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

let defaultStorage: HubStorage | null = null;

/** 默认存储：首次调用时才解析 `sessionStorage`（或回退内存）。 */
export function defaultHubStorage(): HubStorage {
  if (defaultStorage === null) {
    let storage: StorageLike;
    try {
      storage = typeof sessionStorage === 'undefined' ? memoryStorage() : sessionStorage;
    } catch {
      storage = memoryStorage();
    }
    defaultStorage = createHubStorage(storage);
  }
  return defaultStorage;
}

export function readHubConnection(): HubConnection {
  return defaultHubStorage().read();
}

export function saveHubConnection(url: string, token: string): void {
  defaultHubStorage().save(url, token);
}

export function clearHubToken(): void {
  defaultHubStorage().clearToken();
}

export function clearHubConnection(): void {
  defaultHubStorage().clear();
}

/**
 * 导航状态点：Hub 页直连 Hub，与 gateway 轮询无关。
 * 页面 hook 写入；未被访问过时，仅凭已存 URL 报 `unknown`（不谎报绿色）。
 */
export type HubNavStatus =
  | 'unconfigured'
  | 'loading'
  | 'connected'
  | 'empty'
  | 'unauthorized'
  | 'incompatible'
  | 'network'
  | 'unknown';

let navStatus: HubNavStatus | null = null;
const navListeners = new Set<() => void>();

export function getHubNavStatus(): HubNavStatus {
  if (navStatus === null) {
    navStatus = readHubConnection().url !== '' ? 'unknown' : 'unconfigured';
  }
  return navStatus;
}

export function setHubNavStatus(next: HubNavStatus): void {
  if (navStatus === next) return;
  navStatus = next;
  for (const listener of [...navListeners]) listener();
}

export function subscribeHubNavStatus(listener: () => void): () => void {
  navListeners.add(listener);
  return () => {
    navListeners.delete(listener);
  };
}
