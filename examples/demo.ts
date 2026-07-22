/**
 * Vessel 示例：演示当前功能
 * 
 * 运行方式：bun run examples/demo.ts
 */

import {
  AgentRuntime,
  MemoryLLMProvider,
  MemoryToolRegistry,
  MemoryContextManager,
  MemoryEventStream,
  MemorySessionBackend,
  EventType,
  type RunEvent,
} from '../packages/core/src/index';

async function main() {
  console.log('=== Vessel Demo ===\n');

  // 1. 创建 Provider
  const provider = new MemoryLLMProvider();

  // 2. 创建工具注册表
  const tools = new MemoryToolRegistry();

  // 注册天气工具
  tools.register({
    name: 'get_weather',
    description: 'Get weather information for a city',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
      },
      required: ['city'],
    },
    handler: async (args) => {
      const { city } = args as { city: string };
      return `The weather in ${city} is sunny, 25°C`;
    },
  });

  // 3. 创建其他组件
  const context = new MemoryContextManager();
  const events = new MemoryEventStream();
  const session = new MemorySessionBackend();

  // 4. 创建 Runtime
  const runtime = new AgentRuntime({
    provider,
    model: 'gpt-4',
    tools,
    context,
    events,
    limits: {
      request_limit: 100,
      tool_calls_limit: 50,
    },
    termination: {
      max_iterations: 10,
      stop_on_no_tool_calls: true,
    },
    session,
  });

  // 5. 订阅事件流
  const unsubscribe = events.subscribe((event: RunEvent) => {
    switch (event.type) {
      case EventType.RunStarted:
        console.log(`[Event] Run started`);
        break;
      case EventType.RunCompleted:
        console.log(`[Event] Run completed`);
        break;
    }
  });

  // 6. 演示基本对话
  console.log('--- Demo 1: Simple Text Response ---');
  const response1 = await runtime.run('Hello, how are you?');
  console.log(`User: Hello, how are you?`);
  console.log(`Assistant: ${response1}\n`);

  console.log('--- Demo 2: Session Persistence ---');
  const sessionId = 'demo-session-1';
  await runtime.run('Remember my name is Alice', sessionId);
  console.log(`User: Remember my name is Alice`);
  
  const savedState = await session.load(sessionId);
  console.log(`Session saved: ${savedState?.session_id}`);
  console.log(`Session status: ${savedState?.status}`);
  console.log(`Messages in session: ${savedState?.messages.length}\n`);

  console.log('--- Demo 3: Event History ---');
  const history = events.getHistory();
  console.log(`Total events captured: ${history.length}`);

  // 清理
  unsubscribe();
  console.log('\n=== Demo Complete ===');
}

main().catch(console.error);
