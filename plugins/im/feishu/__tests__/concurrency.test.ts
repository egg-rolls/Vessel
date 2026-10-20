import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, MemoryPluginHost, MemorySessionBackend } from '@vessel/core';
import { resolveFeishuConfig } from '../src/config.js';
import { BUSY_REPLY_TEXT, createFeishuPlugin } from '../src/index.js';
import { ChatMemberRunner, isCapacityError, MemberLimitError } from '../src/runner.js';
import type { FeishuPlugin } from '../src/types.js';
import { FakeTransport, textMessage, textProvider, waitFor } from './fixtures/fake-transport.js';

function makeRunner(maxMembers: number): ChatMemberRunner {
  return new ChatMemberRunner({
    config: resolveFeishuConfig({
      enabled: true,
      appId: 'app_test',
      appSecret: 'secret_test',
      maxMembers,
    }),
    events: new MemoryEventStream(),
    provider: textProvider('reply'),
    model: 'test-model',
    pluginHost: new MemoryPluginHost(),
    session: new MemorySessionBackend(),
  });
}

function makeChannel(maxMembers: number): {
  plugin: FeishuPlugin;
  transport: FakeTransport;
} {
  const transport = new FakeTransport();
  const plugin = createFeishuPlugin({
    config: {
      enabled: true,
      appId: 'app_test',
      appSecret: 'secret_test',
      maxMembers,
      replyTimeoutMs: 5000,
    },
    events: new MemoryEventStream(),
    provider: textProvider('reply'),
    model: 'test-model',
    pluginHost: new MemoryPluginHost(),
    session: new MemorySessionBackend(),
    transport,
    env: {},
  });
  return { plugin, transport };
}

describe('feishu member concurrency', () => {
  it('maps host capacity errors to busy', () => {
    expect(isCapacityError(new Error('agent limit reached (max 8)'))).toBe(true);
    expect(isCapacityError(new Error('agent "feishu_x" already exists'))).toBe(true);
    expect(isCapacityError(new Error('boom'))).toBe(false);
    expect(isCapacityError('agent limit reached')).toBe(false);
  });

  it('coalesces 100 concurrent creations for the same chat into one member', async () => {
    const runner = makeRunner(8);
    try {
      const ids = await Promise.all(
        Array.from({ length: 100 }, () => runner.ensureMember('oc_same')),
      );
      expect(new Set(ids).size).toBe(1);
      expect(ids[0]).toBe('feishu_oc_same');
      expect(runner.memberCount).toBe(1);
      expect(runner.pendingMemberCount).toBe(0);
    } finally {
      await runner.stop();
    }
  });

  it('limits 100 concurrent new chats to maxMembers', async () => {
    const runner = makeRunner(8);
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 100 }, (_, index) => runner.ensureMember(`oc_${index}`)),
      );
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(8);
      expect(rejected).toHaveLength(92);
      for (const result of rejected) {
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(MemberLimitError);
      }
      expect(runner.memberCount).toBe(8);
      // 成功与失败的 in-flight 条目都已清理。
      expect(runner.pendingMemberCount).toBe(0);

      // 后续 wave：已有 chat 继续命中，新 chat 仍 busy；map 不增长。
      const secondWave = await Promise.allSettled(
        Array.from({ length: 20 }, (_, index) => runner.ensureMember(`oc_${index}`)),
      );
      expect(secondWave.filter((result) => result.status === 'fulfilled')).toHaveLength(8);
      expect(secondWave.filter((result) => result.status === 'rejected')).toHaveLength(12);
      expect(runner.memberCount).toBe(8);
      expect(runner.pendingMemberCount).toBe(0);
    } finally {
      await runner.stop();
    }
  });

  it('replies busy for new chats beyond maxMembers while existing chats continue', async () => {
    const { plugin, transport } = makeChannel(8);
    try {
      await plugin.start();

      for (let index = 0; index < 100; index += 1) {
        transport.emit(textMessage(`oc_${index}`, 'hi'));
      }
      await waitFor(() => transport.replies.length === 100, 10_000);

      const ok = transport.replies.filter((reply) => reply.text === 'reply').length;
      const busy = transport.replies.filter((reply) => reply.text === BUSY_REPLY_TEXT).length;
      expect(ok).toBeGreaterThan(0);
      expect(ok).toBeLessThanOrEqual(8);
      expect(busy).toBeGreaterThanOrEqual(92);

      const existingChat = transport.replies.find((reply) => reply.text === 'reply')?.chatId;
      expect(existingChat).toBeDefined();
      const followUp = textMessage(existingChat as string, 'again');
      transport.emit(followUp);
      await waitFor(
        () => transport.replies.some((reply) => reply.messageId === followUp.messageId),
        5000,
      );
      const followUpReply = transport.replies.find(
        (reply) => reply.messageId === followUp.messageId,
      );
      expect(followUpReply?.text).toBe('reply');
    } finally {
      await plugin.stop();
    }
  });
});
