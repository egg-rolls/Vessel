/**
 * 飞书渠道离线示例（0.4）。
 *
 * 使用真实 @vessel-agent/feishu 插件 + mock FeishuTransport + mock provider，
 * 不访问网络、不需要真实凭据。
 * 运行：bun run examples/feishu-mock.ts
 */

import type { VesselConfig } from '../packages/config/src/index';
import {
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  MemorySessionBackend,
} from '../packages/core/src/index';
import type {
  FeishuIncomingMessage,
  FeishuTransportHandlers,
} from '../plugins/im/feishu/src/index';
import { createFeishuFromConfig } from '../src/feishu-wiring';

async function main(): Promise<number> {
  let handlers: FeishuTransportHandlers | undefined;
  const replies: string[] = [];

  const transport = {
    start: async (next: FeishuTransportHandlers) => {
      handlers = next;
      next.onConnected?.();
    },
    stop: async () => {
      handlers = undefined;
    },
    reply: async (input: { messageId: string; chatId: string; text: string }) => {
      replies.push(input.text);
    },
  };

  const config: VesselConfig = {
    feishu: {
      enabled: true,
      // 示例假凭据，不是真实值。
      appId: 'cli_demo_id',
      appSecret: 'demo_secret',
      allowedChatIds: [],
      sessionPrefix: 'feishu',
      replyTimeoutMs: 10_000,
      maxReplyChars: 4_000,
      maxMembers: 2,
    },
  };

  const channel = await createFeishuFromConfig({
    config,
    provider: new MemoryLLMProvider(),
    model: 'mock-model',
    pluginHost: new MemoryPluginHost(),
    session: new MemorySessionBackend(),
    events: new MemoryEventStream(),
    contextFactory: () => new MemoryContextManager(),
    transport,
    loadModule: async () => import('../plugins/im/feishu/src/index'),
  });

  if (!channel) {
    console.error('feishu channel was not constructed.');
    return 1;
  }

  try {
    await channel.start();
    console.log(
      `status: connected=${channel.status().connected} app=${channel.status().appIdMasked}`,
    );

    const message: FeishuIncomingMessage = {
      messageId: 'demo-message-1',
      chatId: 'oc_demo_chat',
      chatType: 'p2p',
      senderType: 'user',
      isSelf: false,
      messageType: 'text',
      content: JSON.stringify({ text: 'hello' }),
      createTime: Date.now(),
    };
    handlers?.onMessage(message);

    const deadline = Date.now() + 2_000;
    while (replies.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    if (replies.length === 0) {
      console.error('no reply received before timeout.');
      return 1;
    }
    for (const reply of replies) console.log(`reply: ${reply}`);
    return 0;
  } finally {
    await channel.stop();
  }
}

process.exitCode = await main();
