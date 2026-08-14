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
 * - plugin-registry.ts：PluginProvider 接口 + StaticRegistry（构建时扫描，见 ADR-028）
 * - headless-runner.ts：headless 模式运行器
 * - Ink REPL：React 组件式终端 UI
 */

import { type Gateway, startGateway } from '../packages/serve/src/index';
import { startInkRepl } from '../packages/tui/src/index';
import { runSetupWizard } from '../packages/tui/src/wizard/setup-wizard';
import { type BootstrapResult, bootstrap } from './bootstrap';
import { runHeadless } from './headless-runner';

// ── 终端排版辅助 ─────────────────────────────────

/** 估算字符串在终端的显示宽度（宽字符按 2 列计） */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x2190 && code <= 0x21ff) ||
      (code >= 0x2300 && code <= 0x27bf);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 按显示宽度右补空格 */
function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** 用 ─/│ 边框绘制标题面板（纯 console 排版，不引入 Ink） */
function boxPanel(title: string, lines: string[]): string {
  const inner = Math.max(title.length + 2, ...lines.map(displayWidth));
  const rule = '─'.repeat(inner + 2);
  const top = `┌${rule}┐`;
  const titleRow = `│ ${padDisplay(title, inner)} │`;
  const sep = `├${rule}┤`;
  const body = lines.map((l) => `│ ${padDisplay(l, inner)} │`).join('\n');
  const bottom = `└${rule}┘`;
  return [top, titleRow, sep, body, bottom].join('\n');
}

/** 对齐两列（命令 + 说明）并缩进 */
function align(rows: Array<[string, string]>, width: number): string {
  return rows.map(([cmd, desc]) => `  ${cmd.padEnd(width)}  ${desc}`).join('\n');
}

/** --help 输出：分组 + 对齐列，命令保持不变 */
function printHelp(): void {
  const usage: Array<[string, string]> = [['bun run src/cli.ts', '交互式 REPL（直进对话）']];
  const headless: Array<[string, string]> = [
    ['bun run src/cli.ts --run "<prompt>"', 'headless 单轮（文本参数）'],
    ['bun run src/cli.ts --run @path', 'headless：.json=多轮 seeding，其它=文本 prompt'],
    ['echo "..." | bun run src/cli.ts --run', 'headless 单轮（stdin）'],
    ['bun run src/cli.ts --session <id> --run "..."', '续接会话'],
  ];
  const serve: Array<[string, string]> = [
    ['bun run src/cli.ts --serve 8642', '启动 HTTP/WS gateway（Web 控制台后端）'],
  ];
  const debug: Array<[string, string]> = [
    ['VESSEL_MOCK=1 bun run src/cli.ts --run "x"', 'mock 模式（不调 API）'],
  ];
  const width = Math.max(...[...usage, ...headless, ...serve, ...debug].map(([cmd]) => cmd.length));

  console.log(
    [
      'Vessel CLI — 自组织 Agent Harness',
      '',
      '  用法',
      align(usage, width),
      '',
      '  Headless 模式',
      align(headless, width),
      '',
      '  服务模式',
      align(serve, width),
      '',
      '  调试',
      align(debug, width),
    ].join('\n'),
  );
}

/** --serve 启动 banner：对齐 box，含 gateway/token/SSE/WS + 控制台提示 */
function renderGatewayBanner(gateway: Gateway): string {
  const rows: Array<[string, string]> = [
    ['Gateway', gateway.url],
    ['Token', `${gateway.token}  ← 复制到浏览器`],
    ['SSE', `${gateway.url}/events?token=${gateway.token}`],
    ['WS', `${gateway.url}/ws?token=${gateway.token}`],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`);
  lines.push('', '👉 启动 Web 控制台：打开 Gateway 地址并粘贴 Token');
  return boxPanel('Vessel Gateway', lines);
}

// ── argv 解析 ────────────────────────────────────

const argv = process.argv.slice(2);
// runArg: null=非 headless；''=无参（读 stdin）；非空=文本 prompt 或 @file
let runArg: string | null = null;
let pipeMode = false; // --pipe 隐藏别名，等价 --run 无参（读 stdin）
let sessionArg: string | null = null;
let servePort = 0; // --serve [port] 启动 HTTP/WS gateway（0=关闭，默认 8642）
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
  } else if (a === '--serve') {
    const next = argv[i + 1];
    servePort = next !== undefined && !next.startsWith('-') ? Number.parseInt(next, 10) : 8642;
    if (next !== undefined && !next.startsWith('-')) i++;
  } else if (a === '--help' || a === '-h') {
    printHelp();
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${a}\nRun with --help for usage.`);
    process.exit(1);
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

  // HTTP/WS gateway（--serve）：Web 控制台后端。SSE/WS 广播事件流，/sessions /run 提供控制。
  const gateway =
    servePort > 0
      ? startGateway({ events: ctx.events, session: ctx.session, runtime, port: servePort })
      : null;
  if (gateway) {
    console.log(`\n${renderGatewayBanner(gateway)}\n`);
  }

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

  gateway?.stop();
  cleanup();
}
