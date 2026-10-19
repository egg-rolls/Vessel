#!/usr/bin/env bun
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
 * - plugin-loader.ts：运行时扫描 plugins/ 发现插件（见 ADR-028）
 * - headless-runner.ts：headless 模式运行器
 * - Ink REPL：React 组件式终端 UI
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildConfigSnapshot, isLoopbackHostname, loadConfig } from '../packages/config/src/index';
import {
  type EventStream,
  pruneTrace,
  type ReadTraceOptions,
  readTraceEvents,
  rebuildMetrics,
  resolveTenantPaths,
  type Transport,
} from '../packages/core/src/index';
import {
  type ConfigSnapshotLike,
  type Gateway,
  type GatewayOptions,
  type MetricsProvider,
  startGateway,
} from '../packages/serve/src/index';
import { startInkRepl } from '../packages/tui/src/index';
import { runSetupWizard } from '../packages/tui/src/wizard/setup-wizard';
import { type BootstrapResult, bootstrap } from './bootstrap';
import { parseArgs } from './cli-args';
import { runUpdateCommand } from './cli-update';
import { configInitCommand, configPathCommand, configShowCommand } from './config-command';
import { sanitizeConfigForSnapshot } from './config-snapshot';
import type { FeishuChannelLike } from './control-plane-types';
import { resolveDataDir } from './data-paths';
import { runEvalCommand } from './eval-command';
import { feishuExitCode, signalExitCode, startFeishuChannel } from './feishu-command';
import { buildGatewayControlPlane } from './gateway-wiring';
import { runHeadless } from './headless-runner';
import { migrateCommand } from './migrate-command';
import { createEventStream } from './observability-wiring';
import { runResumeList } from './resume-command';
import { resolveGatewayAuth } from './serve-auth';
import { checkTlsFiles, resolveServeOptions } from './serve-config';
import { planTeamWiring } from './team-wiring';
import {
  createTenantControl,
  tenantCreateCommand,
  tenantGetCommand,
  tenantListCommand,
  tenantUpdateCommand,
} from './tenant-command';
import { createTenantRuntimeFactory, type TenantRuntimeFactory } from './tenant-runtime-factory';
import { listTools } from './tools-list';
import { tracePruneCommand } from './trace-command';
import { resolveGatewayToken, tryCreateLoopbackTransport } from './transport-factory';
import { scheduleUpdateCheck } from './update/background';
import { readPackageVersion } from './version';
import { runWorkflowCommand } from './workflow-command';

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
    ['bun run src/cli.ts --resume-run <runId>', '恢复中断的 durable run'],
  ];
  const serve: Array<[string, string]> = [
    ['bun run src/cli.ts --serve 8642', '启动 HTTP/WS gateway（Web 控制台后端）'],
  ];
  const capability: Array<[string, string]> = [
    ['bun run src/cli.ts workflow list', '列出 workflow runs'],
    ['bun run src/cli.ts workflow run <name>', '启动 workflow（workflow.dir 下解析）'],
    ['bun run src/cli.ts workflow show <id>', '查看步骤状态'],
    ['bun run src/cli.ts workflow resume <id>', '恢复 interrupted/failed/running'],
    ['bun run src/cli.ts workflow cancel <id>', '取消同进程 run'],
    ['bun run src/cli.ts eval <suite>', '离线评测'],
    ['bun run src/cli.ts eval <suite> --json --out <path>', '评测输出 JSON / 指定报告'],
    ['bun run src/cli.ts --feishu', '附加飞书渠道（可与 --serve / REPL 同用）'],
  ];
  const config: Array<[string, string]> = [
    ['bun run src/cli.ts --tenant <id> ...', '选择 tenant（也可用 VESSEL_TENANT）'],
    ['bun run src/cli.ts --connect <url> ...', '连接本机 gateway（不加 tenant 写锁）'],
    ['bun run src/cli.ts config path', '打印用户/项目配置路径'],
    ['bun run src/cli.ts config init', '生成用户配置模板'],
    ['bun run src/cli.ts config show --sources', '查看脱敏配置与来源'],
  ];
  const tenant: Array<[string, string]> = [
    ['bun run src/cli.ts tenant list', '列出 tenant'],
    ['bun run src/cli.ts tenant get <id>', '查看 tenant 元数据'],
    ['bun run src/cli.ts tenant create <id>', '创建 tenant'],
    ['bun run src/cli.ts tenant update <id> --status disabled', '更新 tenant'],
  ];
  const migrate: Array<[string, string]> = [
    ['bun run src/cli.ts migrate --from sqlite --to file-v2', '迁移（默认 dry-run）'],
    ['bun run src/cli.ts migrate --from file-v1 --to file-v2 --apply', '执行迁移'],
    ['bun run src/cli.ts trace prune --dry-run', '清理 trace（默认 dry-run）'],
  ];
  const debug: Array<[string, string]> = [
    ['VESSEL_MOCK=1 bun run src/cli.ts --run "x"', 'mock 模式（不调 API）'],
  ];
  const meta: Array<[string, string]> = [
    ['bun run src/cli.ts --resume-run', '列出可恢复的 interrupted run'],
    ['bun run src/cli.ts update --check', '检查新版本（只提示，不自替换）'],
    ['bun run src/cli.ts update --channel beta', '检查预发布通道'],
    ['bun run src/cli.ts --version', '显示版本'],
    ['bun run src/cli.ts --tools', '列出已注册工具（不需要 API Key）'],
    ['bun run src/cli.ts --help', '显示本帮助'],
  ];
  const width = Math.max(
    ...[
      ...usage,
      ...headless,
      ...serve,
      ...capability,
      ...config,
      ...tenant,
      ...migrate,
      ...debug,
      ...meta,
    ].map(([cmd]) => cmd.length),
  );

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
      '  能力（0.4）',
      align(capability, width),
      '',
      '  配置（0.5）',
      align(config, width),
      '',
      '  多租户（0.5）',
      align(tenant, width),
      '',
      '  迁移与 trace（0.5）',
      align(migrate, width),
      '',
      '  调试',
      align(debug, width),
      '',
      '  其它',
      align(meta, width),
    ].join('\n'),
  );
}

/** `--tools`：列出当前配置下的工具（headless 口径，不需要 Key） */
async function printTools(): Promise<void> {
  const { tools, warnings } = await listTools();
  for (const w of warnings) console.warn(`⚠ ${w}`);
  console.log(`Tools (${tools.length}):`);
  for (const t of tools) console.log(`  - ${t.name}: ${t.description}`);
  console.log('ask_user (interactive only)');
}

/** 打印一次性命令结果并返回退出码 */
function printCommandResult(result: { exitCode: number; stdout: string; stderr: string }): number {
  if (result.stdout !== '') console.log(result.stdout);
  if (result.stderr !== '') console.error(result.stderr);
  return result.exitCode;
}

/** tenant 命令的数据根（本地命令，不 bootstrap） */
async function resolveCommandDataDir(): Promise<string> {
  const { config } = await loadConfig();
  return resolveDataDir(config);
}

/**
 * Web 控制台静态目录：`VESSEL_STATIC_DIR` 覆盖；否则用仓库内 `apps/web/dist`。
 * 目录不存在时不传（gateway 不托管静态站点）。
 */
function resolveStaticDir(): string | undefined {
  const fromEnv = process.env.VESSEL_STATIC_DIR;
  if (fromEnv) return fromEnv;
  const dist = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
  return existsSync(dist) ? dist : undefined;
}

/** --serve 启动 banner：对齐 box，含 gateway/token/SSE/WS + 控制台提示 */
function renderGatewayBanner(gateway: Gateway): string {
  const rows: Array<[string, string]> = [
    ['Gateway', gateway.url],
    ['Token', `${gateway.token}  ← 复制到浏览器`],
    ['SSE', `${gateway.url}/events?token=${gateway.token}`],
    ['WS', `${gateway.url}/ws?token=${gateway.token}`],
  ];
  if (gateway.tls) rows.push(['TLS', 'on']);
  if (!isLoopbackHostname(new URL(gateway.url).hostname)) {
    rows.push(['Remote', 'listening beyond loopback (allow_remote)']);
  }
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`);
  lines.push('', '👉 启动 Web 控制台：打开 Gateway 地址并粘贴 Token');
  return boxPanel('Vessel Gateway', lines);
}

// ── argv 解析 ────────────────────────────────────

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.error}\nRun with --help for usage.`);
  // 用法/解析错误统一 exit 2（Addendum A §6），与运行期失败（exit 1）区分。
  process.exit(2);
}
const args = parsed.args;
const useMock = process.env.VESSEL_MOCK === '1' || process.env.VESSEL_MOCK === 'true';

// 一次性命令在 bootstrap 之前短路：不加载 config / provider / gateway。
if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.version) {
  console.log(readPackageVersion());
  process.exit(0);
}
if (args.tools) {
  await printTools();
  process.exit(0);
}
if (args.update) {
  process.exit(await runUpdateCommand(args.update));
}
// 无参 --resume-run 是一次性列表命令：不构造 runtime、不需要 API Key。
if (args.resumeRunArg === '') {
  process.exit(await runResumeList());
}
// 0.4 子命令：workflow / eval 自己加载配置并决定退出码。
if (args.workflow) {
  process.exit(
    await runWorkflowCommand(args.workflow, {
      useMock,
      ...(args.tenantArg !== null ? { tenantId: args.tenantArg } : {}),
    }),
  );
}
if (args.eval) {
  process.exit(
    await runEvalCommand(args.eval, {
      useMock,
      ...(args.tenantArg !== null ? { tenantId: args.tenantArg } : {}),
    }),
  );
}

// 0.5 一次性本地命令：不 bootstrap、不加载 provider、不获取 tenant 锁。
if (args.configCommand) {
  const command = args.configCommand;
  if (command.kind === 'path') {
    process.exit(printCommandResult(await configPathCommand({ json: command.json })));
  }
  if (command.kind === 'init') {
    process.exit(
      printCommandResult(await configInitCommand({ json: command.json, force: command.force })),
    );
  }
  process.exit(
    printCommandResult(
      await configShowCommand({
        json: command.json,
        sources: command.sources,
        ...(command.tenantId !== undefined ? { tenantId: command.tenantId } : {}),
      }),
    ),
  );
}
if (args.tenantCommand) {
  const command = args.tenantCommand;
  const base = { dataDir: await resolveCommandDataDir(), json: command.json };
  const result =
    command.kind === 'list'
      ? await tenantListCommand(base)
      : command.kind === 'get'
        ? await tenantGetCommand(command.id, base)
        : command.kind === 'create'
          ? await tenantCreateCommand(command.id, {
              ...base,
              ...(command.name !== undefined ? { name: command.name } : {}),
            })
          : await tenantUpdateCommand(command.id, {
              ...base,
              ...(command.name !== undefined ? { name: command.name } : {}),
              ...(command.status !== undefined ? { status: command.status } : {}),
            });
  process.exit(printCommandResult(result));
}
if (args.migrate) {
  process.exit(
    printCommandResult(
      await migrateCommand({
        from: args.migrate.from,
        to: args.migrate.to,
        apply: args.migrate.apply,
        json: args.migrate.json,
        ...(args.migrate.tenantId !== undefined ? { tenantId: args.migrate.tenantId } : {}),
        ...(args.migrate.source !== undefined ? { source: args.migrate.source } : {}),
      }),
    ),
  );
}
if (args.trace) {
  process.exit(
    printCommandResult(
      await tracePruneCommand({
        dryRun: args.trace.dryRun,
        json: args.trace.json,
        ...(args.trace.tenantId !== undefined ? { tenantId: args.trace.tenantId } : {}),
      }),
    ),
  );
}

const { runArg, pipeMode, sessionArg, servePort, resumeRunArg } = args;
const resumeRunId = resumeRunArg !== null && resumeRunArg !== '' ? resumeRunArg : null;
// 恢复模式：TTY 下恢复完进 REPL；非 TTY 下恢复完打印结果退出。
const headless =
  runArg !== null || pipeMode || (resumeRunId !== null && process.stdin.isTTY !== true);
// 只有真正进入 Ink REPL 且 stdin 是 TTY 才算交互：
// serve-only（--serve 无 --run）与管道输入都不算，避免无 TTY 时进首启向导。
const serveRequested = servePort !== null;
const entersRepl = !headless && !serveRequested;
const interactive = entersRepl && process.stdin.isTTY === true;

// ── 主流程 ──────────────────────────────────────

// 引导应用启动
const initialResult = await bootstrap({
  useMock,
  sessionId: sessionArg ?? undefined,
  headless,
  interactive,
  registerAskUser: interactive,
  acquireLock: true,
  ...(args.tenantArg !== null ? { tenantId: args.tenantArg } : {}),
  ...(args.connectArg !== null
    ? { connect: args.connectArg }
    : process.env.VESSEL_CONNECT !== undefined
      ? { connect: process.env.VESSEL_CONNECT }
      : {}),
  // `--feishu` 的配置错误按 Addendum C/D 使用 exit 2；0.3 入口保持 1。
  configErrorExitCode: args.feishu ? 2 : 1,
});
const { config } = initialResult;

// 首启向导（仅真正交互的 REPL；serve-only / 管道无 TTY 时已由 bootstrap 快速失败）
if (!useMock && interactive && !config.apiKey) {
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
    await initialResult.shutdown();
    const result = await bootstrap({
      useMock,
      sessionId: sessionArg ?? undefined,
      headless,
      interactive,
      registerAskUser: interactive,
      acquireLock: true,
      ...(args.tenantArg !== null ? { tenantId: args.tenantArg } : {}),
      ...(args.connectArg !== null
        ? { connect: args.connectArg }
        : process.env.VESSEL_CONNECT !== undefined
          ? { connect: process.env.VESSEL_CONNECT }
          : {}),
      configErrorExitCode: args.feishu ? 2 : 1,
    });
    await runWithConfig(result);
  } else {
    console.error('未配置 API Key，退出。');
    process.exit(args.feishu ? 2 : 1);
  }
} else {
  await runWithConfig(initialResult);
}

// ── 入口分发 ────────────────────────────────────

/** resume 错误：保留稳定 code，便于脚本判定 */
function formatResumeError(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    const coded = error as { code: string; message?: string };
    const message = coded.message ?? '';
    return message.startsWith(coded.code) ? message : `${coded.code}: ${message}`;
  }
  return `resume_failed: ${error instanceof Error ? error.message : String(error)}`;
}

async function runWithConfig(result: BootstrapResult) {
  const { runtime, ctx, config } = result;

  // ── Durable resume（0.3）────────────────────────
  // --resume-run 与 --serve/--run 互斥（cli-args 已保证），这里直接恢复后分流。
  if (resumeRunId !== null) {
    let exitCode = 0;
    try {
      const outcome = await result.resumeRun(resumeRunId);
      console.log(outcome.result);
      ctx.currentSessionId = outcome.sessionId;
      ctx.onSessionChange(outcome.sessionId);
      if (entersRepl) await startInkRepl(ctx);
    } catch (error) {
      console.error(formatResumeError(error));
      exitCode = 1;
    } finally {
      await result.shutdown();
    }
    process.exit(exitCode);
  }

  // ── Feishu（0.4）────────────────────────────────
  // `--feishu` 是附加开关：先 start 渠道，再按模式（serve / REPL / 仅渠道）继续。
  let feishuChannel: FeishuChannelLike | undefined;
  if (args.feishu) {
    try {
      feishuChannel = await startFeishuChannel(result);
      console.log(`Feishu channel connected (${feishuChannel.status().appIdMasked}).`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      await result.shutdown();
      process.exit(feishuExitCode(error));
    }
  }

  // HTTP/WS gateway（--serve）：Web 控制台后端。SSE/WS 广播事件流，/sessions /run 提供控制。
  let gateway: Gateway | null = null;
  /** A-6：--serve 时除 bootstrap 默认 tenant 外的执行面 */
  let tenantFactory: TenantRuntimeFactory | undefined;
  /** gateway 共享事件流：与任何 tenant 流分离，避免 trace 串租户 */
  let sharedEvents: EventStream | undefined;
  let unsubSharedBridge: (() => void) | undefined;
  if (servePort !== null) {
    const resolved = resolveServeOptions(config, {
      port: servePort,
      portExplicit: args.servePortExplicit,
      hostname: args.serveHost,
      allowRemote: args.allowRemote,
      tlsCert: args.tlsCert,
      tlsKey: args.tlsKey,
    });
    if (!resolved.ok) {
      console.error(resolved.error);
      await result.shutdown();
      process.exit(1);
    }

    const tlsError = checkTlsFiles(resolved.options.tls);
    if (tlsError) {
      console.error(tlsError);
      await result.shutdown();
      process.exit(1);
    }

    // 0.5：token → principal（A-3 §10.4）。无 token + 回环 = 匿名 default/admin。
    const authResult = resolveGatewayAuth(config, {
      hostname: resolved.options.hostname,
      allowRemote: resolved.options.allowRemote,
    });
    if (!authResult.ok) {
      console.error(authResult.error);
      await result.shutdown();
      process.exit(1);
    }

    // 远程 + 无显式 token：gateway 会生成 token（仍强制鉴权），但重启即变——醒目提示。
    const remote = !isLoopbackHostname(resolved.options.hostname);
    if (remote && resolved.options.allowRemote && resolveGatewayToken(config) === undefined) {
      console.warn(
        '⚠ Remote listening with an auto-generated gateway token; ' +
          'set VESSEL_GATEWAY_TOKEN for stable authentication.',
      );
    }

    // A-6 §13.2：为每个 active tenant 构建独立执行面；默认 tenant 复用 bootstrap bundle。
    // 每个 tenant 持有自己的 writer lock；任一失败由工厂回滚并让进程退出。
    try {
      // 共享流必须独立：若直接复用 ctx.events（默认 tenant 流），
      // 其它 tenant 的事件桥接进来会污染默认 tenant 的 trace。
      sharedEvents = createEventStream(config);
      const seedEvents = result.bundle?.events;
      if (seedEvents) {
        unsubSharedBridge = seedEvents.subscribe((event) => {
          const withTenant =
            event.tenant_id === undefined ? { ...event, tenant_id: result.tenantId } : event;
          try {
            sharedEvents?.publish(withTenant);
          } catch {
            // 共享流订阅者异常不影响 tenant 执行
          }
        });
      }

      tenantFactory = await createTenantRuntimeFactory({
        config,
        ...(result.bundle ? { seededTenants: [result.bundle] } : {}),
        useMock,
        headless,
        nodeId: result.nodeId,
        sharedEvents,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      await result.shutdown();
      process.exit(1);
    }

    const dataDir = resolveDataDir(config);
    const gatewayOptions: GatewayOptions = {
      // capabilities.list 需要真实版本；缺省会退化为 0.0.0。
      version: readPackageVersion(),
      events: sharedEvents ?? ctx.events,
      session: ctx.session,
      runtime,
      // web 控制台需要的装配面：会话切换 clear 上下文、工具清单、静态站点托管
      context: ctx.context,
      pluginHost: ctx.pluginHost,
      staticDir: resolveStaticDir(),
      nodeId: result.nodeId,
      auth: authResult.auth,
      token: resolveGatewayToken(config),
      hostname: resolved.options.hostname,
      port: resolved.options.port,
      allowRemote: resolved.options.allowRemote,
      ...(resolved.options.tls ? { tls: resolved.options.tls } : {}),
      ...(result.runStore
        ? {
            durable: {
              store: result.runStore,
              ...(result.runs
                ? {
                    resume: async (runId: string) => {
                      // 受理即 resolve；不等待 run 完成（gateway 202 语义）。
                      const handle = await result.runs?.resume(runId);
                      void handle?.done;
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(result.mcp ? { mcp: { listServers: () => result.mcp?.list() ?? [] } } : {}),
      // A-6 §13.3：per-tenant 执行面 / 插件 / trace / session 数据 / 配置。
      ...(tenantFactory
        ? {
            defaultTenantId: result.tenantId,
            // A6-13：tenants.get/list/create/update 的数据源。
            // A6-14：配置的 status/quota 是权威来源，tenant.json 兜底。
            tenants: createTenantControl(dataDir, {
              ...(config.tenant?.tenants ? { configured: config.tenant.tenants } : {}),
            }),
            runtimeFor: (tenantId: string) => tenantFactory?.runtimeFor(tenantId),
            sessionFor: (tenantId: string) => tenantFactory?.sessionFor(tenantId),
            contextFor: (tenantId: string) => tenantFactory?.contextFor(tenantId),
            pluginHostFor: (tenantId: string) => tenantFactory?.pluginHostFor(tenantId),
            pluginsFor: (tenantId: string) => tenantFactory?.pluginsFor(tenantId) ?? [],
            plugins: () => tenantFactory?.pluginsFor(result.tenantId) ?? [],
            // 无 metrics 的 tenant 返回 undefined；gateway 已按 undefined 处理。
            metricsFor: ((tenantId: string) => {
              const metrics = tenantFactory?.metricsFor(tenantId);
              return metrics ? () => metrics.snapshot() : undefined;
            }) as unknown as (tenantId: string) => MetricsProvider,
            config: {
              snapshot: (tenantId: string) => {
                const bundle = tenantFactory?.bundleFor(tenantId) ?? result.bundle;
                if (!bundle) {
                  throw Object.assign(
                    new Error(`forbidden: tenant "${tenantId}" is not configured`),
                    { code: 'forbidden' },
                  );
                }
                return buildConfigSnapshot({
                  // A6-10：不向当前 tenant 暴露其它 tenant 的 overlay。
                  config: sanitizeConfigForSnapshot(bundle.config),
                  sources: bundle.configSources,
                  paths: bundle.configPaths ?? { user: '', project: 'vessel.yaml' },
                  tenantId,
                  tenantOverlayKeys: bundle.tenantOverlayKeys,
                }) as unknown as ConfigSnapshotLike;
              },
            },
            trace: {
              readEvents: (filter: Record<string, unknown>, tenantId?: string) =>
                readTraceEvents(
                  resolveTenantPaths(dataDir, tenantId ?? result.tenantId).events_dir,
                  filter as ReadTraceOptions,
                ),
              prune: (params: Record<string, unknown>) => {
                const requestedTenant =
                  typeof params.tenant_id === 'string' && params.tenant_id !== ''
                    ? params.tenant_id
                    : result.tenantId;
                // 工厂已持有该 tenant 的写锁，不能再嵌套获取。
                return pruneTrace(resolveTenantPaths(dataDir, requestedTenant).events_dir, {
                  ...(typeof params.older_than_days === 'number'
                    ? { retentionDays: params.older_than_days }
                    : {}),
                  ...(typeof params.max_runs === 'number' ? { maxRuns: params.max_runs } : {}),
                  ...(typeof params.max_bytes === 'number' ? { maxBytes: params.max_bytes } : {}),
                });
              },
            },
            sessionData: {
              deleteSessionData: async (sessionId: string, tenantId?: string) => {
                const resolvedTenant = tenantId ?? result.tenantId;
                const bundle =
                  tenantFactory?.bundleFor(resolvedTenant) ??
                  (resolvedTenant === result.tenantId ? result.bundle : undefined);
                if (!bundle) {
                  throw Object.assign(
                    new Error(`forbidden: tenant "${resolvedTenant}" is not configured`),
                    { code: 'forbidden' },
                  );
                }
                return bundle.sessionControl.delete(sessionId);
              },
            },
            metricsControl: {
              rebuild: (tenantId: string) =>
                rebuildMetrics(resolveTenantPaths(dataDir, tenantId).events_dir),
              // A6-09：只重置该 tenant 的 collector；无 metrics 的 tenant → not_found。
              reset: (tenantId?: string) => {
                const id = tenantId ?? result.tenantId;
                const metrics =
                  tenantFactory?.metricsFor(id) ??
                  (id === result.tenantId ? result.metrics : undefined);
                const reset = (metrics as { reset?: () => void } | undefined)?.reset;
                if (typeof reset !== 'function') {
                  throw Object.assign(
                    new Error(`not_found: metrics are not available for tenant "${id}"`),
                    { code: 'not_found' },
                  );
                }
                reset.call(metrics);
              },
            },
          }
        : {}),
    };

    // 0.4 控制面：web 的 GatewayOptions 尚未合入本分支，用 Object.assign 注入
    // 冻结形状；合并后可直接写进 GatewayOptions。
    const controlPlane = buildGatewayControlPlane({
      config,
      ...(result.metrics ? { metrics: result.metrics } : {}),
      ...(result.workflows ? { workflows: result.workflows } : {}),
      ...(result.feishu ? { feishu: result.feishu } : {}),
    });

    gateway = startGateway(Object.assign(gatewayOptions, controlPlane) as GatewayOptions);
  }

  // ── Team / loopback 接线（A4）────────────────────
  // gateway 必须先启动：loopback 的 endpoint/token 来自实际监听端口。
  const teamPlan = planTeamWiring({
    config,
    hasGateway: gateway !== null,
    hasHost: Boolean(result.host),
  });
  for (const warning of teamPlan.warnings) console.warn(`⚠ ${warning}`);

  let teamTransport: Transport | undefined;
  if (gateway && teamPlan.attachToGateway && result.host) {
    if (teamPlan.useLoopback) {
      const loopback = await tryCreateLoopbackTransport({
        config,
        nodeId: result.nodeId,
        endpoint: gateway.url,
        gatewayToken: gateway.token,
        // 发布本节点成员，远端才能用短 id 发现（qa P1-1）
        agents: () => result.host?.list() ?? [],
      });
      if (loopback.ok) {
        teamTransport = loopback.transport;
        // team 插件已持有 DeferredTransport：这里绑定真实实现。
        // 入站由 ext 的 RoutingTeamHost 单点处理（task 执行 / inbox / result / cancel），
        // asm 不再注册 receive(host.send)，避免与 routing 双投递。
        result.transport?.resolve(teamTransport);
      } else {
        result.transport?.fail(new Error(loopback.error));
        console.warn(
          `⚠ Loopback transport unavailable (${loopback.error}); team is in-process only.`,
        );
      }
    }
    gateway.attachTeam({
      nodeId: result.nodeId,
      ...(teamTransport ? { transport: teamTransport } : {}),
      host: result.host,
      ...(result.spawnAgent ? { spawn: result.spawnAgent } : {}),
    });
  }

  if (gateway) {
    console.log(`\n${renderGatewayBanner(gateway)}\n`);
  }

  let shutdownSignal: 'SIGINT' | 'SIGTERM' | undefined;
  const waitForSignal = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      const onInterrupt = (): void => {
        shutdownSignal = 'SIGINT';
        resolve();
      };
      const onTerminate = (): void => {
        shutdownSignal = 'SIGTERM';
        resolve();
      };
      process.once('SIGINT', onInterrupt);
      process.once('SIGTERM', onTerminate);
    });
  };

  // 纯 serve 模式（--serve 且无 --run）：gateway 常驻，不进 REPL，直到 SIGINT/SIGTERM。
  if (gateway && !headless) {
    console.log('Gateway 运行中… 按 Ctrl+C 停止。\n');
    await waitForSignal();
  } else if (headless) {
    const exitCode = await runHeadless(runtime, ctx.session, {
      runArg,
      pipeMode,
      sessionId: ctx.currentSessionId,
      provider: ctx.provider,
    });
    await result.shutdown();
    process.exit(exitCode);
  } else if (args.feishu && process.stdin.isTTY !== true) {
    // Addendum D §13.3：非 TTY + 无 --serve → 仅渠道前台，不启动 REPL。
    console.log('Feishu channel running… 按 Ctrl+C 停止。\n');
    await waitForSignal();
  } else {
    // REPL 启动后台检查：只提示、每天最多一次、失败静默。
    // 有新版本时发布 `update.available` 事件，由 TUI 消费。
    if (
      interactive &&
      !useMock &&
      process.stdout.isTTY === true &&
      config.update?.autoCheck !== false &&
      !process.env.VESSEL_NO_UPDATE_CHECK
    ) {
      void scheduleUpdateCheck(ctx, config);
    }
    await startInkRepl(ctx);
  }

  gateway?.stop();
  unsubSharedBridge?.();
  unsubSharedBridge = undefined;
  if (result.transport) {
    try {
      await result.transport.close();
    } catch {
      // 关闭注册表失败不阻断退出
    }
  } else if (teamTransport) {
    try {
      await teamTransport.close();
    } catch {
      // 关闭注册表失败不阻断退出
    }
  }

  // 0.4：有 workflow / 显式 --feishu 时，SIGINT/SIGTERM 走 130/143；
  // 纯 0.3 serve 保持原来的自然退出（0）。
  if (shutdownSignal && (result.workflows || args.feishu)) {
    if (result.workflows) await result.interruptWorkflows();
    await tenantFactory?.closeAll();
    await result.shutdown();
    process.exit(signalExitCode(shutdownSignal));
  }
  await tenantFactory?.closeAll();

  await result.shutdown();
}
