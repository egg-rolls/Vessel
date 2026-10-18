/**
 * message_id LRU 去重（默认 1000）。
 * 去重先于业务过滤；非文本消息也会登记。
 */

export class LruSet {
  private readonly entries = new Map<string, true>();

  constructor(private readonly limit: number) {}

  /** 已存在返回 true；不存在则登记并返回 false。 */
  seen(value: string): boolean {
    if (this.entries.has(value)) return true;
    this.entries.set(value, true);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return false;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
