/**
 * Vessel 启动脚本
 * 
 * 运行方式：bun run start.ts
 */

import {
  AgentRuntime,
  MemoryLLMProvider,
  MemoryToolRegistry,
  MemoryContextManager,
  MemoryEventStream,
  SQLiteSessionBackend,
  EventType,
  type RunEvent,
} from './packages/core/src/index';
import * as readline from 'readline';

// 创建 Provider
const provider = new MemoryLLMProvider();

// 预设响应：当用户提到特定关键词时触发工具调用
provider.setResponse('weather', {
  content: '',
  finish_reason: 'tool_calls',
  tool_calls: [{
    id: 'call-weather',
    type: 'function',
    function: {
      name: 'get_weather',
      arguments: '{"city":"Beijing"}',
    },
  }],
});

provider.setResponse('calculate', {
  content: '',
  finish_reason: 'tool_calls',
  tool_calls: [{
    id: 'call-calc',
    type: 'function',
    function: {
      name: 'calculate',
      arguments: '{"expression":"2 + 2"}',
    },
  }],
});

// 使用特殊关键词触发 echo 工具
provider.setResponse('say hello', {
  content: '',
  finish_reason: 'tool_calls',
  tool_calls: [{
    id: 'call-echo',
    type: 'function',
    function: {
      name: 'echo',
      arguments: '{"message":"Hello from Vessel!"}',
    },
  }],
});

// 创建工具注册表
const tools = new MemoryToolRegistry();

// 注册一些示例工具
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
    const weatherData: Record<string, string> = {
      'beijing': 'Sunny, 25°C',
      'shanghai': 'Cloudy, 22°C',
      'guangzhou': 'Rainy, 28°C',
    };
    return weatherData[city.toLowerCase()] ?? `Weather data not available for ${city}`;
  },
});

tools.register({
  name: 'calculate',
  description: 'Calculate a mathematical expression',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Mathematical expression' },
    },
    required: ['expression'],
  },
  handler: async (args) => {
    const { expression } = args as { expression: string };
    try {
      const result = Function(`"use strict"; return (${expression})`)();
      return `${expression} = ${result}`;
    } catch (error) {
      return `Error: ${error}`;
    }
  },
});

tools.register({
  name: 'echo',
  description: 'Echo back the input message',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message to echo' },
    },
    required: ['message'],
  },
  handler: async (args) => {
    const { message } = args as { message: string };
    return message;
  },
});

// 创建其他组件
const context = new MemoryContextManager();
const events = new MemoryEventStream();
const session = new SQLiteSessionBackend('./vessel.db');  // SQLite 存储

// 当前会话 ID
let currentSessionId = 'default';

// 创建 Runtime
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
    max_iterations: 50,  // 增加到50次
    stop_on_no_tool_calls: true,
  },
  session,
});

// 订阅事件
events.subscribe((event: RunEvent) => {
  if (event.type === EventType.ToolCallStarted) {
    const data = event.data as { tool_name: string };
    console.log(`\n[Calling tool: ${data.tool_name}]`);
  }
});

// 创建 readline 接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// 显示帮助
function showHelp() {
  console.log(`
Available commands:
  /help              - Show this help message
  /tools             - List available tools
  /session           - Show current session information
  /sessions          - List all sessions
  /new <session_id>  - Create a new session
  /switch <session_id> - Switch to another session
  /delete <session_id> - Delete a session
  /history           - Show conversation history
  /clear             - Clear the screen
  /exit              - Exit the application

Special inputs:
  weather            - Test weather tool
  calculate          - Test calculator tool
  say hello          - Test echo tool
  `);
}

// 显示工具列表
function showTools() {
  const toolList = tools.list();
  console.log('\nAvailable tools:');
  for (const tool of toolList) {
    console.log(`  - ${tool.name}: ${tool.description}`);
  }
  console.log();
}

// 处理用户输入
async function handleInput(input: string): Promise<boolean> {
  const trimmed = input.trim();

  // 检查退出命令
  if (['/exit', '/quit', 'exit', 'quit'].includes(trimmed.toLowerCase())) {
    console.log('Goodbye!');
    return false;
  }

  // 检查帮助命令
  if (trimmed === '/help') {
    showHelp();
    return true;
  }

  // 检查工具列表命令
  if (trimmed === '/tools') {
    showTools();
    return true;
  }

  // 检查会话信息命令
  if (trimmed === '/session') {
    const saved = await session.load(currentSessionId);
    console.log('\nSession info:');
    console.log(`  Session ID: ${currentSessionId}`);
    console.log(`  Messages: ${saved?.messages.length ?? 0}`);
    console.log();
    return true;
  }

  // 检查列出所有会话命令
  if (trimmed === '/sessions') {
    const sessionIds = await session.list();
    if (sessionIds.length === 0) {
      console.log('\nNo sessions found.\n');
    } else {
      console.log('\nSessions:');
      for (const id of sessionIds) {
        const saved = await session.load(id);
        const marker = id === currentSessionId ? ' (current)' : '';
        console.log(`  - ${id}: ${saved?.messages.length ?? 0} messages${marker}`);
      }
      console.log();
    }
    return true;
  }

  // 检查创建新会话命令
  if (trimmed.startsWith('/new ')) {
    const newSessionId = trimmed.substring(5).trim();
    if (!newSessionId) {
      console.log('\nUsage: /new <session_id>\n');
      return true;
    }
    currentSessionId = newSessionId;
    // 初始化会话（保存一个空状态）
    await session.save({
      run_id: 'init',
      session_id: currentSessionId,
      messages: [],
      started_at: Date.now(),
      status: 'completed',
    });
    console.log(`\nCreated and switched to session: ${currentSessionId}\n`);
    return true;
  }

  // 检查切换会话命令
  if (trimmed.startsWith('/switch ')) {
    const switchSessionId = trimmed.substring(8).trim();
    if (!switchSessionId) {
      console.log('\nUsage: /switch <session_id>\n');
      return true;
    }
    currentSessionId = switchSessionId;
    console.log(`\nSwitched to session: ${currentSessionId}\n`);
    return true;
  }

  // 检查删除会话命令
  if (trimmed.startsWith('/delete ')) {
    const deleteSessionId = trimmed.substring(8).trim();
    if (!deleteSessionId) {
      console.log('\nUsage: /delete <session_id>\n');
      return true;
    }
    
    // 检查会话是否存在
    const saved = await session.load(deleteSessionId);
    if (!saved) {
      console.log(`\nSession not found: ${deleteSessionId}\n`);
      return true;
    }
    
    // 如果删除的是当前会话，切换到默认会话
    if (deleteSessionId === currentSessionId) {
      currentSessionId = 'default';
      console.log(`\nDeleted current session, switched to: ${currentSessionId}\n`);
    } else {
      console.log(`\nDeleted session: ${deleteSessionId}\n`);
    }
    
    await session.delete(deleteSessionId);
    return true;
  }

  // 检查清屏命令
  if (trimmed === '/clear') {
    console.clear();
    return true;
  }

  // 检查历史命令
  if (trimmed === '/history') {
    const saved = await session.load(currentSessionId);
    const messages = saved?.messages ?? [];
    if (messages.length === 0) {
      console.log('\nNo conversation history.\n');
    } else {
      console.log('\nConversation history:');
      for (const msg of messages) {
        const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
        console.log(`  [${role}]: ${msg.content}`);
      }
      console.log();
    }
    return true;
  }

  // 处理普通消息
  if (trimmed) {
    try {
      console.log('\nThinking...');
      const response = await runtime.run(trimmed, currentSessionId);
      console.log(`\nAssistant: ${response}\n`);
    } catch (error) {
      console.error(`\nError: ${error}\n`);
    }
  }

  return true;
}

// 显示会话选择菜单
async function showSessionMenu(): Promise<void> {
  console.log('\n=== Vessel - AI Agent Harness ===\n');
  console.log('Select a session:\n');

  const sessionIds = await session.list();
  
  if (sessionIds.length > 0) {
    for (let i = 0; i < sessionIds.length; i++) {
      const id = sessionIds[i];
      const saved = await session.load(id);
      console.log(`  ${i + 1}. ${id} (${saved?.messages.length ?? 0} messages)`);
    }
    console.log();
  }

  console.log('  N. Create new session');
  console.log('  D. Delete a session');
  console.log();
}

// 处理会话选择
async function handleSessionSelection(input: string): Promise<boolean> {
  const trimmed = input.trim().toUpperCase();

  // 创建新会话
  if (trimmed === 'N') {
    rl.question('\nEnter new session name: ', async (name) => {
      const sessionId = name.trim();
      if (sessionId) {
        currentSessionId = sessionId;
        await session.save({
          run_id: 'init',
          session_id: currentSessionId,
          messages: [],
          started_at: Date.now(),
          status: 'completed',
        });
        console.log(`\nCreated and switched to session: ${currentSessionId}\n`);
        console.log('Type /help for available commands\n');
        startChat();
      } else {
        console.log('\nInvalid session name.\n');
        showSessionMenu().then(() => {
          rl.question('Select option: ', handleSessionSelection);
        });
      }
    });
    return true;
  }

  // 删除会话
  if (trimmed === 'D') {
    const sessionIds = await session.list();
    if (sessionIds.length === 0) {
      console.log('\nNo sessions to delete.\n');
      showSessionMenu().then(() => {
        rl.question('Select option: ', handleSessionSelection);
      });
      return true;
    }

    console.log('\nSelect session to delete:\n');
    for (let i = 0; i < sessionIds.length; i++) {
      console.log(`  ${i + 1}. ${sessionIds[i]}`);
    }
    console.log();

    rl.question('Enter number (or C to cancel): ', async (choice) => {
      if (choice.toUpperCase() === 'C') {
        showSessionMenu().then(() => {
          rl.question('Select option: ', handleSessionSelection);
        });
        return;
      }

      const index = parseInt(choice) - 1;
      if (index >= 0 && index < sessionIds.length) {
        await session.delete(sessionIds[index]);
        console.log(`\nDeleted session: ${sessionIds[index]}\n`);
      } else {
        console.log('\nInvalid selection.\n');
      }
      
      showSessionMenu().then(() => {
        rl.question('Select option: ', handleSessionSelection);
      });
    });
    return true;
  }

  // 选择现有会话
  const index = parseInt(trimmed) - 1;
  const sessionIds = await session.list();
  
  if (index >= 0 && index < sessionIds.length) {
    currentSessionId = sessionIds[index];
    console.log(`\nSwitched to session: ${currentSessionId}\n`);
    console.log('Type /help for available commands\n');
    startChat();
    return true;
  }

  console.log('\nInvalid selection.\n');
  showSessionMenu().then(() => {
    rl.question('Select option: ', handleSessionSelection);
  });
  return true;
}

// 开始聊天模式
function startChat(): void {
  const prompt = () => {
    rl.question('vessel> ', async (input) => {
      const shouldContinue = await handleInput(input);
      if (shouldContinue) {
        prompt();
      } else {
        rl.close();
      }
    });
  };

  prompt();
}

// 主循环
async function main() {
  await showSessionMenu();
  rl.question('Select option: ', handleSessionSelection);
}

main().catch(console.error);
