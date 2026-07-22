/**
 * Vessel CLI 入口
 * @module vessel
 */

import { AgentRuntime, MemoryLLMProvider, MemoryToolRegistry, MemoryContextManager, MemoryEventStream, MemorySessionBackend } from '@vessel/core';
import { loadConfig, PROVIDER_PRESETS } from '@vessel/config';
import { StreamRenderer, CommandRegistry, createDefaultCommands } from '@vessel/tui';
import { runSetupWizard } from '@vessel/tui';
import * as readline from 'readline';

// 版本信息
const VERSION = '0.1.0';

// 解析命令行参数
function parseArgs(): { config?: string; setup?: boolean; help?: boolean; version?: boolean } {
  const args = process.argv.slice(2);
  const result: { config?: string; setup?: boolean; help?: boolean; version?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' || arg === '-c') {
      result.config = args[++i];
    } else if (arg === '--setup' || arg === '-s') {
      result.setup = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.version = true;
    }
  }

  return result;
}

// 显示帮助
function showHelp(): void {
  console.log(`
Vessel - AI Agent Harness

Usage: vessel [options]

Options:
  -c, --config <path>  Path to config file (default: vessel.yaml)
  -s, --setup          Run setup wizard
  -h, --help           Show this help message
  -v, --version        Show version

Examples:
  vessel                 Start interactive REPL
  vessel --setup         Run setup wizard
  vessel --config my.yaml  Use custom config file
`);
}

// 主函数
async function main(): Promise<void> {
  const args = parseArgs();

  // 显示版本
  if (args.version) {
    console.log(`Vessel v${VERSION}`);
    return;
  }

  // 显示帮助
  if (args.help) {
    showHelp();
    return;
  }

  // 运行设置向导
  if (args.setup) {
    await runSetupWizard({ configPath: args.config });
    return;
  }

  // 加载配置
  const { config, validation } = await loadConfig({
    configPath: args.config,
  });

  // 显示配置警告
  if (validation.warnings.length > 0) {
    console.log('\n⚠️  Configuration warnings:');
    for (const warning of validation.warnings) {
      console.log(`  - ${warning.message}`);
    }
  }

  // 检查 API Key
  if (!config.api_key) {
    console.log('\n❌ No API Key configured.');
    console.log('Run "vessel --setup" to configure your API Key.');
    return;
  }

  // 创建 Provider
  const providerName = config.provider?.name ?? 'openai';
  const providerConfig = {
    api_key: config.api_key,
    base_url: config.provider?.base_url ?? PROVIDER_PRESETS[providerName]?.base_url,
    model: config.provider?.model,
    temperature: config.provider?.temperature,
    max_tokens: config.provider?.max_tokens,
  };

  // 创建 Provider 实例
  let provider: import('@vessel/core').LLMProvider;
  
  // 这里需要根据 providerName 创建对应的 provider
  // 目前使用 MemoryLLMProvider 作为默认
  provider = new MemoryLLMProvider();

  // 创建工具注册表
  const tools = new MemoryToolRegistry();

  // 创建其他组件
  const context = new MemoryContextManager({
    maxTokens: config.context?.max_tokens,
    maxMessages: config.context?.max_messages,
    autoCompact: config.context?.auto_compact,
    compactThreshold: config.context?.compact_threshold,
  });

  const events = new MemoryEventStream();
  const session = new MemorySessionBackend();

  // 创建 Runtime
  const runtime = new AgentRuntime({
    provider,
    model: config.provider?.model ?? 'gpt-4',
    tools,
    context,
    events,
    limits: config.limits ?? {},
    termination: config.termination ?? {
      max_iterations: 20,
      stop_on_no_tool_calls: true,
    },
    session,
  });

  // 创建流式渲染器
  const renderer = new StreamRenderer();
  renderer.start(events);

  // 创建命令注册表
  const commands = new CommandRegistry();
  const defaultCommands = createDefaultCommands({
    runtime,
    tools,
    session,
    sessionId: 'default',
  });

  for (const cmd of defaultCommands) {
    commands.register(cmd);
  }

  // 创建 REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`\n🚀 Vessel v${VERSION}`);
  console.log('Type /help for available commands, or start chatting!\n');

  const prompt = () => {
    rl.question('vessel> ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      // 处理斜杠命令
      if (trimmed.startsWith('/')) {
        const handled = await commands.execute(trimmed);
        if (!handled) {
          console.log(`Unknown command: ${trimmed}`);
          console.log('Type /help for available commands.');
        }
        prompt();
        return;
      }

      // 处理普通消息
      try {
        const response = await runtime.run(trimmed);
        // 响应已经通过 StreamRenderer 渲染
      } catch (error) {
        console.error(`Error: ${error}`);
      }

      prompt();
    });
  };

  prompt();
}

// 运行主函数
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
