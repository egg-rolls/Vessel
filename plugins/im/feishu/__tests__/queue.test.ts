import { describe, expect, it } from 'bun:test';
import { PerChatQueues } from '../src/queue.js';
import { delay } from './fixtures/fake-transport.js';

describe('PerChatQueues', () => {
  it('serializes tasks for the same chat', async () => {
    const queues = new PerChatQueues(10);
    const order: string[] = [];

    queues.enqueue('a', async () => {
      order.push('a1-start');
      await delay(10);
      order.push('a1-end');
    });
    queues.enqueue('a', async () => {
      order.push('a2');
    });

    await delay(30);
    expect(order).toEqual(['a1-start', 'a1-end', 'a2']);
  });

  it('runs different chats in parallel', async () => {
    const queues = new PerChatQueues(10);
    const started: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    queues.enqueue('a', async () => {
      started.push('a');
      await blocker;
    });
    queues.enqueue('b', async () => {
      started.push('b');
      await blocker;
    });

    await delay(10);
    expect(started).toEqual(['a', 'b']);
    release();
    await delay(10);
  });

  it('caps pending at the limit and does not count the running task', async () => {
    const queues = new PerChatQueues(2);
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    expect(queues.enqueue('a', async () => await blocker)).toBe(true);
    expect(queues.enqueue('a', async () => undefined)).toBe(true);
    expect(queues.enqueue('a', async () => undefined)).toBe(true);
    expect(queues.enqueue('a', async () => undefined)).toBe(false);

    expect(queues.pendingCount()).toBe(2);
    expect(queues.activeChats()).toBe(1);

    release();
    await delay(20);
    expect(queues.pendingCount()).toBe(0);
    expect(queues.activeChats()).toBe(0);
  });

  it('clears pending tasks', async () => {
    const queues = new PerChatQueues(10);
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    queues.enqueue('a', async () => await blocker);
    queues.enqueue('a', async () => undefined);
    queues.clear();
    expect(queues.pendingCount()).toBe(0);
    release();
    await delay(10);
  });
});
