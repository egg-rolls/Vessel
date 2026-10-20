/**
 * 单 chat FIFO 队列。
 *
 * 上限只计 pending，running 不占名额（Addendum B §11.3.6）。
 * 同一 chat 串行；不同 chat 独立并行。
 */

interface ChatState {
  pending: Array<() => Promise<void>>;
  running: boolean;
}

export class PerChatQueues {
  private readonly chats = new Map<string, ChatState>();

  constructor(private readonly limit: number) {}

  /** 入队；超出 pending 上限返回 false。 */
  enqueue(chatId: string, task: () => Promise<void>): boolean {
    let state = this.chats.get(chatId);
    if (!state) {
      state = { pending: [], running: false };
      this.chats.set(chatId, state);
    }
    if (state.pending.length >= this.limit) return false;

    state.pending.push(task);
    void this.drain(chatId);
    return true;
  }

  pendingCount(): number {
    let total = 0;
    for (const state of this.chats.values()) total += state.pending.length;
    return total;
  }

  activeChats(): number {
    let total = 0;
    for (const state of this.chats.values()) {
      if (state.running || state.pending.length > 0) total += 1;
    }
    return total;
  }

  /** 清空 pending；running 任务由调用方 abort。 */
  clear(): void {
    this.chats.clear();
  }

  private async drain(chatId: string): Promise<void> {
    const state = this.chats.get(chatId);
    if (!state || state.running) return;

    state.running = true;
    try {
      while (state.pending.length > 0) {
        const task = state.pending.shift();
        if (!task) break;
        try {
          await task();
        } catch {
          // task 自身负责发布错误；队列继续。
        }
      }
    } finally {
      state.running = false;
      if (state.pending.length === 0) this.chats.delete(chatId);
    }
  }
}
