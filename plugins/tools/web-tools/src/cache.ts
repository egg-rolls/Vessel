/**
 * 内存缓存（搜索结果 + 抓取结果）。
 *
 * 三条口径（设计 §5.2）：
 * 1. **只存归一后的条目，不存渲染后的字符串** —— 否则 `detail` 一变就把 brief 的成品
 *    当 full 返回，上限还在、内容却少了，而且没有任何报错（§9.1 的第二个坑）。
 * 2. 键字段清单写在各自的调用点（search/index.ts、index.ts 的 fetch 路径），顺序固定；
 *    漏一个影响输出的参数 = 静默给错内容 + 继续计费。
 * 3. 只在内存、进程退出即失；不缓存 header、不缓存 key、不落盘。
 */

import { createHash } from 'node:crypto';

export interface CacheHit<T> {
  value: T;
  /** 命中条目已经活了多久（毫秒） */
  ageMs: number;
}

export interface TtlLruCacheOptions {
  maxEntries: number;
  ttlMs: number;
  now?: () => number;
}

/** TTL + 容量上限的 LRU（Map 的插入顺序当 LRU 链；命中即刷新位置） */
export class TtlLruCache<T> {
  private readonly entries = new Map<string, { value: T; storedAt: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TtlLruCacheOptions) {
    this.maxEntries = Math.max(0, Math.trunc(options.maxEntries));
    this.ttlMs = Math.max(0, Math.trunc(options.ttlMs));
    this.now = options.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.maxEntries > 0 && this.ttlMs > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): CacheHit<T> | undefined {
    if (!this.enabled) return undefined;
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    const ageMs = this.now() - hit.storedAt;
    if (ageMs < 0 || ageMs >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // 命中即移到尾部（LRU 语义）
    this.entries.delete(key);
    this.entries.set(key, hit);
    return { value: hit.value, ageMs };
  }

  set(key: string, value: T): void {
    if (!this.enabled) return;
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** 键 = sha256(JSON 数组)：字段清单由调用点给定，顺序固定 */
export function hashKey(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * `max_chars` 归到最近的上档（{1000, 2000, 4000, 8000, 16000, 32000}）。
 *
 * 不归桶的话每个不同 `max_chars` 都算新键，缓存形同不存在（设计 §5.2）。
 */
export function bucketMaxChars(maxChars: number): number {
  const buckets = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000];
  for (const bucket of buckets) {
    if (maxChars <= bucket) return bucket;
  }
  return 32_000;
}
