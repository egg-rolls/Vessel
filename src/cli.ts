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
import {
  buildConfigSnapshot,
  isLoopbackHostname,
  resolveEffectiveApiKey,
} from '../packages/config/src/index';
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
  type DurableGatewayOptions,
  type Gateway,
  type GatewayOptions,
  type MetricsProvider,
  startGateway,
} from '../packages/serve/src/index';
import { startInkRepl } from '../packages/tui/src/index';
import { runSetupWizard } from '../packages/tui/src/wizard/setup-wizard';
import { type BootstrapResult, bootstrap } from './bootstrap';
import { parseArgs } from './cli-args';
import { buildCliConfigOverrides } from './cli-overrides';
import { matchCommand } from './commands/registry';
import { sanitizeConfigForSnapshot } from './config-snapshot';
import type { FeishuChannelLike } from './control-plane-types';
import { resolveDataDir } from './data-paths';
import { createDurableFor } from './durable-wiring';
import { feishuExitCode, signalExitCode, startFeishuChannel } from './feishu-command';
import { renderGatewayBanner } from './gateway-banner';
import { buildGatewayControlPlane, buildWorkflowControlPlane } from './gateway-wiring';
import { runHeadless } from './headless-runner';
import { type MockScenarioName, resolveMockScenario } from './mock/scenarios';
import { createEventStream } from './observability-wiring';
import { resolveGatewayAuth } from './serve-auth';
import { checkTlsFiles, resolveServeOptions } from './serve-config';
import {
  resolveContinueSessionId,
  runSessionList,
  validateResumeSessionId,
} from './session-resume';
import { planTeamWiring } from './team-wiring';
import { createTenantControl } from './tenant-command';
import { createTenantRuntimeFactory, type TenantRuntimeFactory } from './tenant-runtime-factory';
import {
  resolveGatewayToken,
  tryCreateLoopbackTransport,
  tryCreateRemoteTransport,
} from './transport-factory';
import { scheduleUpdateCheck } from './update/background';
import { readPackageVersion } from './version';

// ── 终端排版辅助 ─────────────────────────────────

/** 对齐两列（命令 + 说明）并缩进 */
function align(rows: Array<[string, string]>, width: number): string {
  return rows.map(([cmd, desc]) => `  ${cmd.padEnd(width)}  ${desc}`).join('\n');
}

/** --help 输出：分组 + 对齐列，命令保持不变 */
function printHelp(): void {
  const usage: Array<[string, string]> = [
    ['vessel', '交互式 REPL（直进对话）'],
    ['vessel demo', '无 Key 演示（真实工具调用与权限确认）'],
  ];
  const session: Array<[string, string]> = [
    ['vessel -c', '续接最近的非空会话（--continue）'],
    ['vessel -r <id>', '恢复指定会话（--resume）'],
    ['vessel -r', '列出当前 tenant 的会话'],
    ['vessel --session <id>', '指定会话（不校验存在）'],
  ];
  const headless: Array<[string, string]> = [
    ['vessel -p "<prompt>"', 'headless 单轮（--print / --run 同义）'],
    ['vessel --run @path', 'headless：.json=多轮 seeding，其它=文本 prompt'],
    ['echo "..." | vessel --run', 'headless 单轮（stdin）'],
    ['vessel -c --run "..."', '续接最近会话并运行一轮'],
    ['vessel --resume-run <runId>', '恢复中断的 durable run'],
  ];
  const serve: Array<[string, string]> = [
    ['vessel --serve 8642', '启动 HTTP/WS gateway（Web 控制台后端）'],
  ];
  const capability: Array<[string, string]> = [
    ['vessel workflow list', '列出 workflow runs'],
    ['vessel workflow run <name>', '启动 workflow（workflow.dir 下解析）'],
    ['vessel workflow show <id>', '查看步骤状态'],
    ['vessel workflow resume <id>', '恢复 interrupted/failed/running'],
    ['vessel workflow cancel <id>', '取消同进程 run'],
    ['vessel eval <suite>', '离线评测'],
    ['vessel eval <suite> --json --out <path>', '评测输出 JSON / 指定报告'],
    ['vessel --feishu', '附加飞书渠道（可与 --serve / REPL 同用）'],
  ];
  const config: Array<[string, string]> = [
    ['vessel --tenant <id> ...', '选择 tenant（也可用 VESSEL_TENANT）'],
    [
      'vessel --connect <url> --connect-token <t> --ca <pem> ...',
      '连接 gateway（非回环必须 https；token 也可用 VESSEL_CONNECT_TOKEN）',
    ],
    ['vessel --serve --allowed-origin <origin>', '独立 Web 前端的 CORS/WS Origin 白名单'],
    ['vessel config path', '打印用户/项目配置路径'],
    ['vessel config init', '生成用户配置模板'],
    ['vessel config show --sources', '查看脱敏配置与来源'],
  ];
  const tenant: Array<[string, string]> = [
    ['vessel tenant list', '列出 tenant'],
    ['vessel tenant get <id>', '查看 tenant 元数据'],
    ['vessel tenant create <id>', '创建 tenant'],
    ['vessel tenant update <id> --status disabled', '更新 tenant'],
  ];
  const plugins: Array<[string, string]> = [
    ['vessel plugin list', '列出仓库/用户/项目/node_modules 插件'],
    ['vessel plugin install <path> [--force]', '安装本地插件目录到 ~/.vessel/plugins'],
    ['vessel plugin remove <name>', '从 ~/.vessel/plugins 移除插件'],
  ];
  const migrate: Array<[string, string]> = [
    ['vessel migrate --from sqlite --to file-v2', '迁移（默认 dry-run）'],
    ['vessel migrate --from file-v1 --to file-v2 --apply', '执行迁移'],
    ['vessel trace prune --dry-run', '清理 trace（默认 dry-run）'],
  ];
  const debug: Array<[string, string]> = [
    ['VESSEL_MOCK=1 vessel --run "x"', 'mock 模式（不调 API）'],
  ];
  const meta: Array<[string, string]> = [
    ['vessel doctor', '本机配置/环境自检'],
    ['vessel --resume-run', '列出可恢复的 interrupted run'],
    ['vessel update --check', '检查新版本（只提示，不自替换）'],
    ['vessel update --channel beta', '检查预发布通道'],
    ['vessel --version', '显示版本'],
    ['vessel --tools', '列出已注册工具（不需要 API Key）'],
    ['vessel --help', '显示本帮助'],
  ];
  const width = Math.max(
    ...[
      ...usage,
      ...session,
      ...headless,
      ...serve,
      ...capability,
      ...config,
      ...tenant,
      ...plugins,
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
      '  会话',
      align(session, width),
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
      '  插件（0.6.1）',
      align(plugins, width),
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

/**
 * --serve 启动 banner：对齐 box，含 gateway + 控制台提示。
 * 不打印任何 token（含前缀），也不在 URL 中拼接 token。
 */
// ── argv 解析 ────────────────────────────────────

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.error}\nRun with --help for usage.`);
  // 用法/解析错误统一 exit 2（Addendum A §6），与运行期失败（exit 1）区分。
  process.exit(2);
}
const args = parsed.args;
const demoRequested = args.demo;
const useMock =
  demoRequested || process.env.VESSEL_MOCK === '1' || process.env.VESSEL_MOCK === 'true';
// env 只在这里读一次；`vessel demo` 固定 tools，忽略 env 场景。
const resolvedScenario = demoRequested
  ? { name: 'tools' as MockScenarioName }
  : resolveMockScenario(process.env.VESSEL_MOCK_SCENARIO);
const mockScenario = resolvedScenario.name;
if (useMock && !demoRequested && resolvedScenario.unknown !== undefined) {
  console.error(
    `Unknown VESSEL_MOCK_SCENARIO "${resolvedScenario.unknown}"; falling back to "echo".`,
  );
}

// 一次性命令在 bootstrap 之前短路：不加载 config / provider / gateway。
if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.version) {
  console.log(readPackageVersion());
  process.exit(0);
}
// `vessel demo` 走现有 bootstrap / REPL 路径；非 TTY 无法交互，直接失败。
if (demoRequested) {
  if (process.stdin.isTTY !== true) {
    console.error(
      '`vessel demo` needs an interactive terminal (TTY). ' +
        'For a non-interactive check, run: VESSEL_MOCK=1 vessel --run "hello"',
    );
    process.exit(1);
  }
  console.log(
    [
      'Vessel demo (no API key required)',
      '- The assistant will run one harmless bash command: echo vessel-demo-ok',
      '- You will see the tool call, the permission prompt, and the final reply',
      '- Press Ctrl+C to exit',
      'Next: run `vessel config init` to add your API key, then `vessel` for a real session.',
      'This demo uses an isolated data directory and does not read your existing sessions.',
    ].join('\n'),
  );
}
// 一次性命令注册表：按注册顺序命中第一个，执行后直接退出。
// 命中后不进入 bootstrap / REPL / serve / headless 主流程。
const command = matchCommand(args);
if (command) {
  process.exit((await command.run(args, { useMock })) ?? 0);
}
// `-r/--resume` 无 id：列出当前 tenant 的会话（connect 模式无法本地列出）。
if (args.resumeArg === '') {
  if (args.connectArg !== null || (process.env.VESSEL_CONNECT ?? '').trim() !== '') {
    console.error('--resume without an id requires a local session store (not with --connect).');
    process.exit(2);
  }
  process.exit(
    await runSessionList({
      ...(args.tenantArg !== null ? { tenantId: args.tenantArg } : {}),
    }),
  );
}
const { runArg, pipeMode, sessionArg, servePort, resumeRunArg } = args;

// ── 会话续接解析（0.6.1 E8）─────────────────────
// connect 模式交给 bootstrapConnect（远端是唯一数据源）；本地先校验/选择 id。
const connectConfigured =
  args.connectArg !== null || (process.env.VESSEL_CONNECT ?? '').trim() !== '';
let resolvedSessionId = sessionArg ?? undefined;
let continueLatest = false;
let resumeSessionId: string | undefined;
if (args.continueArg) {
  if (connectConfigured) {
    continueLatest = true;
  } else {
    const resolved = await resolveContinueSessionId({
      ...(args.tenantArg !== null ? { tenantId: args.tenantArg } : {}),
    });
    if (!resolved.ok) {
      console.error(resolved.error);
      process.exit(1);
    }
    resolvedSessionId = resolved.sessionId;
  }
} else if (args.resumeArg !== null && args.resumeArg !== '') {
  if (connectConfigured) {
    resumeSessionId = args.resumeArg;
  } else {
    const checked = await validateResumeSessionId(args.resumeArg, {
      ...(args.tenantArg !== null ? { tenantId: args.tenantArg } : {}),
    });
    if (!checked.ok) {
      console.error(checked.error);
      process.exit(1);
    }
    resolvedSessionId = args.resumeArg;
  }
}
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

// CLI 层只组装一次：serve / connect / allowed-origin 全部经 config loader 合并。
const cliOverrides = buildCliConfigOverrides({
  servePort: args.servePort,
  servePortExplicit: args.servePortExplicit,
  serveHost: args.serveHost,
  allowRemote: args.allowRemote,
  tlsCert: args.tlsCert,
  tlsKey: args.tlsKey,
  allowedOrigins: args.allowedOrigins,
  connectToken: args.connectTokenArg,
  caFile: args.caArg,
});

// 引导应用启动
const initialResult = await bootstrap({
  useMock,
  mockScenario,
  ...(demoRequested ? { dataDirSubdir: 'demo' } : {}),
  sessionId: resolvedSessionId,
  headless,
  interactive,
  registerAskUser: interactive,
  acquireLock: true,
  cliOverrides,
  ...(continueLatest ? { continueLatest: true } : {}),
  ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
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
if (!useMock && interactive && !resolveEffectiveApiKey(config)) {
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
      mockScenario,
      ...(demoRequested ? { dataDirSubdir: 'demo' } : {}),
      sessionId: resolvedSessionId,
      headless,
      interactive,
      registerAskUser: interactive,
      acquireLock: true,
      cliOverrides,
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
  /**
   * A2：headless 不在这里直接 `process.exit`，否则会跳过末尾的
   * gateway / tenantFactory / transport / shutdown 清理（`--serve --run`
   * 会残留 tenant `.lock`）。只记录退出码，统一走公共清理后再退出。
   */
  let headlessExitCode: number | undefined;

  // 0.6 A4：connect 模式下展示远端 node/tenant。headless 写 stderr，避免污染 stdout。
  if (result.remote) {
    const node = result.remote.nodeId ?? 'unknown';
    const line = `Remote gateway: node=${node} tenant=${result.remote.tenantId} (${result.remote.endpoint})`;
    if (headless) console.error(line);
    else console.log(line);
  }

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
    // CLI flag 已由 loader 合并进 config.serve；这里只做补全与校验。
    const resolved = resolveServeOptions(config);
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
        mockScenario,
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
    // 0.6.1 P0-2：非 default tenant 只走 per-tenant runStore；
    // default tenant 由上面的 `durable` 提供（gateway 优先 opts.durable）。
    const durableFor = createDurableFor(tenantFactory, result.tenantId);
    const gatewayOptions: GatewayOptions & {
      durableFor?: (tenantId: string) => DurableGatewayOptions | undefined;
    } = {
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
      // 0.6 A5：CLI 覆盖已在 loader 合并；两端同名 allowed_origins。
      ...(config.serve?.allowedOrigins ? { allowedOrigins: config.serve.allowedOrigins } : {}),
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
            // 0.6.1：per-tenant durable（缺失 → 非 default tenant 403）。
            durableFor,
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
      // 0.5.4 P2-1：非 default tenant 使用自己的 workflow / feishu 实例。
      // 只对工厂已构造 bundle 的 tenant 返回；未配置 / 未启用 → undefined。
      ...(tenantFactory
        ? {
            workflowsFor: (tenantId: string) => {
              const bundle = tenantFactory?.bundleFor(tenantId);
              return bundle?.workflows
                ? buildWorkflowControlPlane(bundle.workflows, bundle.config)
                : undefined;
            },
            feishuFor: (tenantId: string) => {
              const feishu = tenantFactory?.bundleFor(tenantId)?.feishu;
              return feishu ? { status: () => feishu.status() } : undefined;
            },
          }
        : {}),
    });

    gateway = startGateway(Object.assign(gatewayOptions, controlPlane) as GatewayOptions);
  }

  // ── Team / transport 接线（A4；0.6 remote）────────────
  // gateway 必须先启动：loopback 的 endpoint/token 来自实际监听端口；remote 使用静态 nodes。
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
    } else if (teamPlan.useRemote) {
      const remote = await tryCreateRemoteTransport({
        config,
        nodeId: result.nodeId,
        // B4：远端事件带 origin node_id 回灌到 gateway 共享事件流。
        onEvent: (event) => {
          const sink = sharedEvents ?? ctx.events;
          try {
            sink.publish(event);
          } catch {
            // 事件订阅者异常不影响其它节点
          }
        },
      });
      if (remote.ok) {
        teamTransport = remote.transport;
        result.transport?.resolve(teamTransport);
      } else {
        result.transport?.fail(new Error(remote.error));
        console.warn(`⚠ Remote transport unavailable (${remote.error}); team is in-process only.`);
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
    headlessExitCode = await runHeadless(runtime, ctx.session, {
      runArg,
      pipeMode,
      sessionId: ctx.currentSessionId,
      provider: ctx.provider,
    });
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

  // A2：清理完成后再落 headless 退出码（其余模式保持自然退出 0）。
  if (headlessExitCode !== undefined) process.exitCode = headlessExitCode;
}
