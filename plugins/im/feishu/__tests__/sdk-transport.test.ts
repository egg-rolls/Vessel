import { describe, expect, it } from 'bun:test';
import { FeishuError } from '../src/errors.js';
import { createSdkTransport, mapSdkMessage } from '../src/sdk-transport.js';

const TEXT_EVENT = {
  sender: { sender_type: 'user' },
  message: {
    message_id: 'om_1',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: 'hello' }),
    create_time: '123',
  },
};

describe('mapSdkMessage', () => {
  it('maps a text event', () => {
    const message = mapSdkMessage(TEXT_EVENT);
    expect(message).toEqual({
      messageId: 'om_1',
      chatId: 'oc_1',
      chatType: 'p2p',
      senderType: 'user',
      isSelf: false,
      messageType: 'text',
      content: JSON.stringify({ text: 'hello' }),
      createTime: 123,
    });
  });

  it('marks app/bot senders as self', () => {
    const message = mapSdkMessage({
      ...TEXT_EVENT,
      sender: { sender_type: 'app' },
    });
    expect(message?.isSelf).toBe(true);
    expect(message?.senderType).toBe('app');
  });

  it('keeps non-text messages for dedupe registration', () => {
    const message = mapSdkMessage({
      ...TEXT_EVENT,
      message: { ...TEXT_EVENT.message, message_type: 'image' },
    });
    expect(message?.messageType).toBe('image');
  });

  it('returns null for malformed events', () => {
    expect(mapSdkMessage(null)).toBeNull();
    expect(mapSdkMessage({})).toBeNull();
    expect(mapSdkMessage({ message: { message_id: 'om' } })).toBeNull();
  });
});

describe('createSdkTransport', () => {
  it('does not connect or load the SDK until start()', async () => {
    const transport = createSdkTransport({
      appId: 'app',
      appSecret: 'secret',
      domain: 'feishu',
    });

    try {
      await transport.reply({ messageId: 'om_1', chatId: 'oc_1', text: 'hi' });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(FeishuError);
      expect((error as FeishuError).code).toBe('channel_not_connected');
    }
  });
});
