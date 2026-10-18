/**
 * 离线 transport / provider 夹具；CI 零网络。
 */

import type { ChatRequest, LLMProvider, LLMResponse } from '@vessel/core';
import type {
  FeishuIncomingMessage,
  FeishuTransport,
  FeishuTransportHandlers,
} from '../../src/types.js';

export class FakeTransport implements FeishuTransport {
  handlers?: FeishuTransportHandlers;
  replies: Array<{ messageId: string; chatId: string; text: string }> = [];
  started = false;
  stopped = false;
  startError?: Error;
  replyError?: Error;
  failNextReply?: Error;

  async start(handlers: FeishuTransportHandlers): Promise<void> {
    if (this.startError) throw this.startError;
    this.handlers = handlers;
    this.started = true;
    handlers.onConnected?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async reply(input: { messageId: string; chatId: string; text: string }): Promise<void> {
    if (this.replyError) throw this.replyError;
    if (this.failNextReply) {
      const error = this.failNextReply;
      this.failNextReply = undefined;
      throw error;
    }
    this.replies.push(input);
  }

  emit(message: FeishuIncomingMessage): void {
    this.handlers?.onMessage(message);
  }

  disconnect(reason?: string): void {
    this.handlers?.onDisconnected?.(reason);
  }

  fail(error: Error): void {
    this.handlers?.onError?.(error);
  }
}

let counter = 0;

export function textMessage(
  chatId = 'oc_chat',
  text = 'hi',
  overrides: Partial<FeishuIncomingMessage> = {},
): FeishuIncomingMessage {
  counter += 1;
  return {
    messageId: `om_${counter}`,
    chatId,
    chatType: 'p2p',
    senderType: 'user',
    messageType: 'text',
    content: JSON.stringify({ text }),
    ...overrides,
  };
}

export function nonTextMessage(
  chatId = 'oc_chat',
  overrides: Partial<FeishuIncomingMessage> = {},
): FeishuIncomingMessage {
  counter += 1;
  return {
    messageId: `om_${counter}`,
    chatId,
    chatType: 'group',
    senderType: 'user',
    messageType: 'image',
    content: JSON.stringify({ image_key: 'img' }),
    ...overrides,
  };
}

export function textProvider(text: string, delayMs = 0): LLMProvider {
  return {
    async chat(_req: ChatRequest): Promise<LLMResponse> {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        content: text,
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
}

export function hangingProvider(): LLMProvider {
  return {
    chat(req: ChatRequest): Promise<LLMResponse> {
      return new Promise((_resolve, reject) => {
        if (req.signal?.aborted === true) {
          reject(new Error('aborted'));
          return;
        }
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await delay(5);
  }
}
