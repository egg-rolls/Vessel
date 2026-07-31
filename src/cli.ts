/**
 * Vessel CLI 入口
 *
 * 运行方式：
 *   bun run src/cli.ts                           交互式 REPL（直进对话）
 *   bun run src/cli.ts --run "<prompt>"            headless 单轮（文本参数）
 *   bun run src/cli.ts --run @path                 headless：.json=多轮 seeding，其它=文本 prompt
 *   echo "..." | bun run src/cli.ts --run          headless 单轮（stdin）
 *   bun run src/cli.ts --session <id> --run "..."  续接指定会话
 *
 * --run 是唯一 headless 入口：有参=文本/@file，无参=stdin。--pipe 保留为隐藏别名（= --run 无参）。
 * 首次运行无 API Key 时自动触发首启向导（仅交互模式）。
 *
 * 架构：
 * - bootstrap.ts：config→provider→plugins→runtime→ReplContext
 * - plugin-registry.ts：插件注册表
 * - headless-runner.ts：headless 模式运行器
 * - Ink REPL：React 组件式终端 UI
 */

import { startInkRepl } from '../packages/tui/src/index';
import { runSetupWizard } from '../packages/tui/src/wizard/setup-wizard';
import { bootstrap, type BootstrapResult } from './bootstrap';
import { runHeadless } from './headless-runner';

// ── argv 解析 ────────────────────────────────────

const argv = process.argv.slice(2);
// runArg: null=非 headless；''=无参（读 stdin）；非空=文本 prompt 或 @file
let runArg: string | null = null;
let pipeMode = false; // --pipe 隐藏别名，等价 --run 无参（读 stdin）
let sessionArg: string | null = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--run' || a === '-r') {
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      runArg = next;
      i++;
    } else {
      runArg = '';
    }
  } else if (a === '--pipe') {
    pipeMode = true;
  } else if (a === '--session' || a === '-s') {
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      sessionArg = next;
      i++;
    }
    // 无值或下一个是 flag → sessionArg 保持 null，shell 会用 newSessionId()
  } else if (a === '--help' || a === '-h') {
    console.log(`Vessel CLI

  bun run src/cli.ts                              交互式 REPL（直进对话）
  bun run src/cli.ts --run "<prompt>"               headless 单轮（文本参数）
  bun run src/cli.ts --run @path                    headless：.json=多轮 seeding，其它=文本 prompt
  echo "..." | bun run src/cli.ts --run             headless 单轮（stdin）
  bun run src/cli.ts --session <id> --run "..."     续接会话
  VESSEL_MOCK=1 bun run src/cli.ts --run "x"        mock 模式（不调 API）`);
    process.exit(0);
  }
}
const headless = runArg !== null || pipeMode;

// ── 主流程 ──────────────────────────────────────

const useMock = process.env.VESSEL_MOCK === '1' || process.env.VESSEL_MOCK === 'true';

// 引导应用启动
const { runtime, ctx, config, cleanup } = await bootstrap({
  useMock,
  sessionId: sessionArg ?? undefined,
  headless,
});

// 首启向导（仅交互模式）
if (!useMock && !headless && !config.apiKey) {
  console.log('\n🔑 首次使用需要配置 API 连接\n');
  const userConfig = await runSetupWizard();
  if (userConfig.apiKey) {
    config.apiKey = userConfig.apiKey;
    if (userConfig.providers) {
      const p = Object.values(userConfig.providers)[0];
      if (p) {
        config.provider = {
          name: userConfig.defaultProvider ?? 'openai',
          apiKey: p.apiKey,
          baseUrl: p.baseUrl ?? config.provider?.baseUrl,
          model: userConfig.defaultModel ?? p.model ?? config.provider?.model,
        };
      }
    }
    // 重新引导以使用新配置
    cleanup();
    const result = await bootstrap({
      useMock,
      sessionId: sessionArg ?? undefined,
      headless,
    });
    await runWithConfig(result);
  } else {
    console.error('未配置 API Key，退出。');
    process.exit(1);
  }
} else {
  await runWithConfig({ runtime, ctx, config, cleanup });
}

// ── 入口分发 ────────────────────────────────────

async function runWithConfig(result: BootstrapResult) {
  const { runtime, ctx, cleanup } = result;

  if (headless) {
    await runHeadless(runtime, ctx.session, {
      runArg,
      pipeMode,
      sessionId: ctx.currentSessionId,
      provider: ctx.provider,
    });
  } else {
    await startInkRepl(ctx);
  }

  cleanup();
}
