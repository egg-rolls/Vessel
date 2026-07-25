/**
 * Vessel 启动脚本
 * 
 * 运行方式：bun run start.ts
 */

import {
  AgentRuntime,
  OpenAICompatibleProvider,
  MemoryToolRegistry,
  MemoryContextManager,
  MemoryEventStream,
  SQLiteSessionBackend,
  EventType,
  type RunEvent,
  type Plugin,
} from './packages/core/src/index';
import * as readline from 'readline';

// 导入插件
import { metaToolsPlugin } from './plugins/meta-tools/src/index';
import { skillsLoaderPlugin } from './plugins/skills-loader/src/index';

// 创建真实 Provider（OpenAI 兼容格式）
const provider = new OpenAICompatibleProvider({
  api_key: 'tp-cfn2ag2rg1b7q2sbl02wncyp50vu7noqogfbvx6ftiogxso4',
  base_url: 'https://token-plan-cn.xiaomimimo.com/v1',
  model: 'mimo-v2.5-pro',
});

// 创建工具注册表
const tools = new MemoryToolRegistry();

// 创建其他组件
const context = new MemoryContextManager();
const events = new MemoryEventStream();
const session = new SQLiteSessionBackend('./vessel.db');  // SQLite 存储

// 当前会话 ID
let currentSessionId = 'default';

// 插件列表
const plugins: Plugin[] = [
  metaToolsPlugin,
  skillsLoaderPlugin,
];

// 系统提示词
const systemPrompt = `你是一个有用的 AI 助手，可以通过工具来完成任务。

## 工具使用规则

1. 当用户询问你有什么技能或工具时，调用 list_skills 工具
2. 工具会返回结果，你应该直接使用工具返回的结果来回答用户
3. 不要重复调用同一个工具
4. 如果工具返回了结果，就用那个结果来回答用户，不要说"我没有技能"或"我的技能库是空的"

## 重要：工具返回格式

当工具返回结果时，消息格式如下：
- role: "tool" - 这表示这是工具返回的结果
- content: "..." - 这是工具返回的内容

你应该：
1. 读取 role 为 "tool" 的消息
2. 使用 content 中的内容来回答用户
3. 不要说"我没有技能"或"我的技能库是空的"

## 示例

用户问：你有什么技能？
你调用：list_skills 工具
工具返回：role: "tool", content: "技能列表：asset-introspection, code-writing"
你应该回答：我有以下技能：asset-introspection, code-writing

## 回答规则

- 当工具返回结果时，直接使用那个结果
- 不要编造信息
- 保持回答简洁
- 如果工具返回"技能列表：xxx, yyy"，你就说"我有以下技能：xxx, yyy"
`;

// 创建 Runtime
const runtime = new AgentRuntime({
  provider,
  model: 'mimo-v2.5-pro',
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
  plugins,  // 注入插件
  systemPrompt,  // 添加系统提示词
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
