import { afterEach, describe, expect, it } from 'bun:test';
import {
  type LLMProvider,
  MemoryEventStream,
  MemoryPluginHost,
  MemoryRunStore,
  MemorySessionBackend,
} from '@vessel/core';
import {
  BUSY_REPLY_TEXT,
  createFeishuPlugin,
  ERROR_REPLY_TEXT,
  TIMEOUT_REPLY_TEXT,
} from '../src/index.js';
import { TRUNCATED_SUFFIX } from '../src/text.js';
import type { FeishuConfig, FeishuPlugin } from '../src/types.js';
import {
  delay,
  FakeTransport,
  hangingProvider,
  nonTextMessage,
  textMessage,
  textProvider,
  waitFor,
} from './fixtures/fake-transport.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface ChannelSetup {
  plugin: FeishuPlugin;
  transport: FakeTransport;
  events: MemoryEventStream;
  session: MemorySessionBackend;
  runStore: MemoryRunStore;
}

function makeChannel(
  options: {
    config?: Partial<FeishuConfig>;
    provider?: LLMProvider;
    transport?: FakeTransport;
    env?: Record<string, string | undefined>;
  } = {},
): ChannelSetup {
  const transport = options.transport ?? new FakeTransport();
  const events = new MemoryEventStream();
  const session = new MemorySessionBackend();
  const runStore = new MemoryRunStore();
  const plugin = createFeishuPlugin({
    config: {
      enabled: true,
      appId: 'app_1234',
      appSecret: 'secret_value',
      ...options.config,
    },
    events,
    provider: options.provider ?? textProvider('reply'),
    model: 'test-model',
    pluginHost: new MemoryPluginHost(),
    session,
    runStore,
    transport,
    env: options.env ?? {},
  });
  cleanups.push(async () => {
    await plugin.stop();
  });
  return { plugin, transport, events, session, runStore };
}

describe('feishu channel', () => {
  it('starts, reports status and publishes connection events', async () => {
    const { plugin, transport, events } = makeChannel();
    await plugin.start();

    expect(transport.started).toBe(true);
    expect(plugin.status().connected).toBe(true);
    expect(plugin.status().appIdMasked).toBe('app_***');
    expect(events.getHistory().some((event) => event.type === 'channel.feishu.connected')).toBe(
      true,
    );

    await plugin.stop();
    expect(plugin.status().connected).toBe(false);
    expect(transport.stopped).toBe(true);
    expect(events.getHistory().some((event) => event.type === 'channel.feishu.disconnected')).toBe(
      true,
    );
  });

  it('handles a text message and replies with the per-chat session', async () => {
    const { plugin, transport, session } = makeChannel();
    await plugin.start();

    transport.emit(textMessage('oc_a', 'hello'));
    await waitFor(() => transport.replies.length === 1);

    expect(transport.replies[0]?.text).toBe('reply');
    const ids = await session.list();
    expect(ids.some((id) => id.endsWith('/feishu:oc_a'))).toBe(true);
  });

  it('ignores self messages, non-text messages and duplicate ids', async () => {
    const { plugin, transport } = makeChannel();
    await plugin.start();

    transport.emit(textMessage('oc_a', 'self', { isSelf: true }));
    const nonText = nonTextMessage('oc_a');
    transport.emit(nonText);
    transport.emit({
      ...nonText,
      messageType: 'text',
      content: JSON.stringify({ text: 'same id' }),
    });

    await delay(30);
    expect(transport.replies).toHaveLength(0);

    const message = textMessage('oc_a', 'ok');
    transport.emit(message);
    transport.emit(message);
    await waitFor(() => transport.replies.length === 1);
    expect(transport.replies).toHaveLength(1);
  });

  it('filters chats by allowed_chat_ids', async () => {
    const { plugin, transport } = makeChannel({
      config: { allowedChatIds: ['oc_ok'] },
    });
    await plugin.start();

    transport.emit(textMessage('oc_no', 'ignored'));
    await delay(30);
    expect(transport.replies).toHaveLength(0);

    transport.emit(textMessage('oc_ok', 'hello'));
    await waitFor(() => transport.replies.length === 1);
    expect(transport.replies[0]?.chatId).toBe('oc_ok');
  });

  it('reuses one member/session per chat', async () => {
    const { plugin, transport, session } = makeChannel();
    await plugin.start();

    transport.emit(textMessage('oc_a', 'one'));
    transport.emit(textMessage('oc_a', 'two'));
    await waitFor(() => transport.replies.length === 2);

    const ids = await session.list();
    expect(ids.filter((id) => id.endsWith('/feishu:oc_a'))).toHaveLength(1);

    transport.emit(textMessage('oc_b', 'three'));
    await waitFor(() => transport.replies.length === 3);
    const after = await session.list();
    expect(after.some((id) => id.endsWith('/feishu:oc_b'))).toBe(true);
  });

  it('replies busy when the queue is full', async () => {
    const { plugin, transport } = makeChannel({
      provider: hangingProvider(),
      config: { replyTimeoutMs: 10_000 },
    });
    await plugin.start();

    for (let index = 0; index < 12; index += 1) {
      transport.emit(textMessage('oc_busy', `m${index}`));
    }

    await waitFor(() => transport.replies.some((reply) => reply.text === BUSY_REPLY_TEXT));
    expect(transport.replies.filter((reply) => reply.text === BUSY_REPLY_TEXT)).toHaveLength(1);
    expect(plugin.status().queued_messages).toBe(10);
    expect(plugin.status().active_chats).toBe(1);
  });

  it('times out a reply', async () => {
    const { plugin, transport } = makeChannel({
      provider: hangingProvider(),
      config: { replyTimeoutMs: 20 },
    });
    await plugin.start();

    transport.emit(textMessage('oc_slow', 'hello'));
    await waitFor(() => transport.replies.length === 1);
    expect(transport.replies[0]?.text).toBe(TIMEOUT_REPLY_TEXT);
  });

  it('truncates replies including the suffix', async () => {
    const { plugin, transport } = makeChannel({
      provider: textProvider('x'.repeat(200)),
      config: { maxReplyChars: 50 },
    });
    await plugin.start();

    transport.emit(textMessage('oc_long', 'hello'));
    await waitFor(() => transport.replies.length === 1);
    const reply = transport.replies[0]?.text ?? '';
    expect(reply.length).toBe(50);
    expect(reply.endsWith(TRUNCATED_SUFFIX)).toBe(true);
  });

  it('replies busy when max_members is reached', async () => {
    const { plugin, transport } = makeChannel({ config: { maxMembers: 1 } });
    await plugin.start();

    transport.emit(textMessage('oc_one', 'one'));
    await waitFor(() => transport.replies.length === 1);

    transport.emit(textMessage('oc_two', 'two'));
    await waitFor(() => transport.replies.length === 2);
    expect(transport.replies[1]?.text).toBe(BUSY_REPLY_TEXT);
  });

  it('masks credentials in errors and status', async () => {
    const transport = new FakeTransport();
    transport.failNextReply = new Error('boom app_1234 secret_value');
    const { plugin } = makeChannel({ transport });
    await plugin.start();

    transport.emit(textMessage('oc_error', 'hello'));
    await waitFor(() => transport.replies.length === 1);

    expect(transport.replies[0]?.text).toBe(ERROR_REPLY_TEXT);
    const lastError = plugin.status().last_error ?? '';
    expect(lastError).not.toContain('app_1234');
    expect(lastError).not.toContain('secret_value');
    expect(lastError).toContain('app_***');
  });

  it('rejects a disabled channel', async () => {
    const { plugin } = makeChannel({ config: { enabled: false } });
    try {
      await plugin.start();
      throw new Error('expected throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('channel_disabled');
      expect((error as { phase?: string }).phase).toBe('config');
    }
  });

  it('rejects missing credentials', async () => {
    const { plugin } = makeChannel({ config: { appId: '', appSecret: '' } });
    try {
      await plugin.start();
      throw new Error('expected throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('channel_auth_failed');
      expect((error as { phase?: string }).phase).toBe('config');
    }
  });

  it('marks transport start failures as runtime errors and masks secrets', async () => {
    const transport = new FakeTransport();
    transport.startError = new Error('auth failed secret_value');
    const { plugin } = makeChannel({ transport });
    try {
      await plugin.start();
      throw new Error('expected throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('channel_auth_failed');
      expect((error as { phase?: string }).phase).toBe('runtime');
      expect((error as Error).message).not.toContain('secret_value');
    }
  });

  it('stop aborts active runs and ignores later messages', async () => {
    const { plugin, transport } = makeChannel({ provider: hangingProvider() });
    await plugin.start();

    transport.emit(textMessage('oc_stop', 'hello'));
    await delay(10);
    await plugin.stop();
    await delay(20);

    expect(plugin.status().connected).toBe(false);
    expect(transport.replies).toHaveLength(0);

    transport.emit(textMessage('oc_stop', 'after'));
    await delay(20);
    expect(transport.replies).toHaveLength(0);
  });

  it('forwards dedicated Host events and writes run checkpoints', async () => {
    const { plugin, transport, events, runStore } = makeChannel();
    await plugin.start();

    transport.emit(textMessage('oc_events', 'hello'));
    await waitFor(() => transport.replies.length === 1);

    expect(events.getHistory().some((event) => event.type.startsWith('run.'))).toBe(true);
    expect((await runStore.list()).length).toBeGreaterThan(0);
  });
});
