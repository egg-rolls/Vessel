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
  getUserConfigPath,
  isLoopbackHostname,
  loadConfig,
  resolveEffectiveApiKey,
  type VesselConfig,
} from '../packages/config/src/index';
import {
  type EventStream,
  pruneTrace,
  type ReadTraceOptions,
  readTraceEvents,
  rebuildMetrics,
  resolveTenantPaths,
} from '../packages/core/src/index';
import {
  type ConfigSnapshotLike,
  createGatewayEventHub,
  type DurableGatewayOptions,
  type Gateway,
  type GatewayOptions,
  type MetricsProvider,
  startGateway,
  type TenantEventHub,
} from '../packages/serve/src/index';
import { startInkRepl } from '../packages/tui/src/index';
import { runSetupWizard } from '../packages/tui/src/wizard/setup-wizard';
import { type BootstrapResult, bootstrap } from './bootstrap';
import { DEFAULT_SERVE_PORT, parseArgs } from './cli-args';
import { buildCliConfigOverrides } from './cli-overrides';
import { applyCommandLocale, matchCommand } from './commands/registry';
import { sanitizeConfigForSnapshot } from './config-snapshot';
import { type ConfigWatchHandle, startConfigWatch, toConfigReloadOutcome } from './config-watch';
import type { FeishuChannelLike } from './control-plane-types';
import { resolveDataDir } from './data-paths';
import { createDurableFor } from './durable-wiring';
import { feishuExitCode, signalExitCode, startFeishuChannel } from './feishu-command';
import type { GatewayInstanceLock } from './gateway/instance-lock';
import { DEFAULT_GATEWAY_INSTANCE } from './gateway/pid';
import { renderGatewayBanner } from './gateway-banner';
import {
  deriveGatewayInstance,
  isForegroundGatewayCommand,
  prepareForegroundGatewayStart,
  resolveGatewayTargets,
  stopGateway,
  writeForegroundGatewayPid,
} from './gateway-command';
import { createGatewayConfigSet } from './gateway-config-control';
import {
  createGatewayReloadRunner,
  type GatewayReconfigureTarget,
  type GatewayReloadApplier,
} from './gateway-reload-wiring';
import { buildGatewayControlPlane } from './gateway-wiring';
import { installHeadlessPermissionAutoAllow, runHeadless } from './headless-runner';
import {
  applyTools,
  createMcpApplier,
  createMcpServerToggle,
  createPermissionApplier,
  type PermissionApplierState,
  pluginManagedToolNames,
} from './hot-apply-appliers';
import {
  assemblePluginTools,
  collectPermissionTargets,
  type PermissionApplyTarget,
  permissionConfigFor,
  registerRuntimeNoticeHook,
} from './hot-apply-assembly';
import { type StartedHubNodeOutbound, startHubNodeOutbound } from './hub/outbound-wiring';
import { type LocalHubHandle, startLocalHub } from './hub-local';
import { applyLocale, resolveLocale, setLocale, t } from './i18n';
import { ensureInteractionsDir } from './interactions-dir';
import { createCliLogger } from './logging';
import { type MockScenarioName, resolveMockScenario } from './mock/scenarios';
import { setToolPolicy } from './permission-store';
import { buildPluginConfigMap, declarativePluginEntries } from './plugin-config';
import { isAddressInUse } from './port-in-use';
import { installProcessErrorHandlers } from './process-handlers';
import { createRunControl } from './run-control';
import { createRuntimeNoticeBus } from './runtime-notice';
import { resolveGatewayAuth } from './serve-auth';
import { checkTlsFiles, resolveServeOptions } from './serve-config';
import {
  reconcileStaleSessions,
  type SessionLivenessContext,
  withLivenessRepair,
} from './session-liveness';
import {
  resolveContinueSessionId,
  runSessionList,
  validateResumeSessionId,
} from './session-resume';
import { shutdownServeStack } from './shutdown-sequence';
import { createTenantControl } from './tenant-command';
import { createTenantRuntimeFactory, type TenantRuntimeFactory } from './tenant-runtime-factory';
import { resolveGatewayToken } from './transport-factory';
import { ui } from './ui-style';
import { scheduleUpdateCheck } from './update/background';
import { type GatewayUpdateCheckHandle, startGatewayUpdateCheck } from './update/gateway-check';
import { readPackageVersion } from './version';
import { ensureWebDist, webDistWarning } from './web-dist';

/**
 * 由专用装配路径管理的工厂式插件：tools applier 不能把它们当普通插件装
 * （MCP 建连 / evals 报告 / feishu 渠道各有自己的 applier 或启动面）。
 */
const MCP_FACTORY_PLUGINS: ReadonlySet<string> = new Set(['mcp-client', 'evals', 'feishu']);

// ── 终端排版辅助 ─────────────────────────────────

/** 对齐两列（命令 + 说明）并缩进；命令列走暗金，说明保持纯文本 */
function align(rows: Array<[string, string]>, width: number): string {
  return rows.map(([cmd, desc]) => `  ${ui.brand(cmd.padEnd(width))}  ${desc}`).join('\n');
}

/** --help 输出：分组 + 对齐列，命令保持不变；描述跟随 locale。 */
function printHelp(): void {
  const usage: Array<[string, string]> = [
    ['vessel', t('help.cmd.repl')],
    ['vessel demo', t('help.cmd.demo')],
  ];
  const session: Array<[string, string]> = [
    ['vessel -c', t('help.cmd.continue')],
    ['vessel -r <id>', t('help.cmd.resume')],
    ['vessel -r', t('help.cmd.resumeList')],
    ['vessel --session <id>', t('help.cmd.session')],
  ];
  const headless: Array<[string, string]> = [
    ['vessel -p "<prompt>"', t('help.cmd.print')],
    ['vessel --run @path', t('help.cmd.runFile')],
    ['echo "..." | vessel --run', t('help.cmd.stdin')],
    ['vessel -c --run "..."', t('help.cmd.continueRun')],
    ['vessel --resume-run <runId>', t('help.cmd.resumeRun')],
  ];
  const gateway: Array<[string, string]> = [
    ['vessel status [--json]', t('help.cmd.status')],
    ['vessel agents [--json]', t('help.cmd.agents')],
    ['vessel attention [--connect <url>] [--json] [--interactive]', t('help.cmd.attention')],
    ['vessel attention [--node <name>|--all-nodes] [--json]', t('help.cmd.attentionNodes')],
    [
      'vessel attention respond <id> --allow|--deny|--answers <json>',
      t('help.cmd.attentionRespond'),
    ],
    ['vessel team list [--json]', t('help.cmd.teamList')],
    ['vessel team get <team_id> [--limit N]', t('help.cmd.teamGet')],
    ['vessel team post <team_id> <content...> [--mention <name|id>]', t('help.cmd.teamPost')],
    ['vessel team members <team_id> add|remove <member>', t('help.cmd.teamMembers')],
    ['vessel team budget <team_id> [--conversation <id>] [--json]', t('help.cmd.teamBudget')],
    [
      'vessel team budget override <team_id> --conversation <id> --dimension <d> --max <n|unlimited>',
      t('help.cmd.teamBudgetOverride'),
    ],
    ['vessel team freeze <team_id> [--json]', t('help.cmd.teamFreeze')],
    ['vessel team unfreeze <team_id> [--json]', t('help.cmd.teamUnfreeze')],
    [
      'vessel federation post --to <principal@node:team> --from <principal@node:team> <content...>',
      t('help.cmd.federationPost'),
    ],
    [
      'vessel federation team-info --to <principal@node:team> [--members N] [--json]',
      t('help.cmd.federationTeamInfo'),
    ],
    ['vessel federation peers [--json]', t('help.cmd.federationPeers')],
    ['vessel errors [--json]', t('help.cmd.errors')],
    ['vessel gateway start [--daemon] [--instance <name>]', t('help.cmd.gatewayStart')],
    ['vessel gateway list [--json]', t('help.cmd.gatewayList')],
    ['vessel gateway stop [--instance <name>|--port N|--all]', t('help.cmd.gatewayStop')],
    ['vessel gateway status [--json] [--rpc]', t('help.cmd.gatewayStatus')],
    ['vessel gateway restart [--daemon] [--instance <name>|--all]', t('help.cmd.gatewayRestart')],
    ['vessel gateway reload [--scope config,plugins]', t('help.cmd.gatewayReload')],
    ['vessel gateway install-service', t('help.cmd.gatewayInstall')],
    ['vessel gateway uninstall-service', t('help.cmd.gatewayUninstall')],
  ];
  const hub: Array<[string, string]> = [
    ['vessel hub start [--host H] [--port N] [--allow-remote]', t('help.cmd.hubStart')],
    ['vessel hub directory [--hub-url URL] [--json]', t('help.cmd.hubDirectory')],
    ['vessel hub watch [--hub-url URL]', t('help.cmd.hubWatch')],
    ['vessel hub pair [--tenant ID] [--ttl N]', t('help.cmd.hubPair')],
    [
      'vessel hub join-code [--data-dir DIR] [--tenant ID] [--ttl N] [--json]',
      t('help.cmd.hubJoinCode'),
    ],
    ['vessel hub join [<hub-url>] --code <CODE> [--data-dir DIR]', t('help.cmd.hubJoin')],
    ['vessel hub node add <url> --code <CODE>', t('help.cmd.hubNodeAdd')],
    ['vessel hub node list [--json]', t('help.cmd.hubNodeList')],
    ['vessel hub node remove <pairing_id>', t('help.cmd.hubNodeRemove')],
    ['vessel hub token exchange <node-url> --team <id>', t('help.cmd.hubTokenExchange')],
    ['vessel hub token revoke <node-url> --token-id <id>', t('help.cmd.hubTokenRevoke')],
    ['vessel hub token list <node-url>', t('help.cmd.hubTokenList')],
    ['vessel hub data-token <pairing_id> --team <id>', t('help.cmd.hubDataToken')],
  ];
  const capability: Array<[string, string]> = [
    ['vessel eval <suite>', t('help.cmd.eval')],
    ['vessel eval <suite> --json --out <path>', t('help.cmd.evalOut')],
    ['vessel --feishu', t('help.cmd.feishu')],
  ];
  const config: Array<[string, string]> = [
    ['vessel --data-dir <path> ...', t('help.cmd.dataDir')],
    ['vessel --exclusive ...', t('help.cmd.exclusive')],
    ['vessel --tenant <id> ...', t('help.cmd.tenant')],
    ['vessel --connect <url> --connect-token <t> --ca <pem> ...', t('help.cmd.connect')],
    ['vessel config path', t('help.cmd.configPath')],
    ['vessel config init', t('help.cmd.configInit')],
    ['vessel config show --sources', t('help.cmd.configShow')],
    ['vessel config set <key> <value>', t('help.cmd.configSet')],
  ];
  const tenant: Array<[string, string]> = [
    ['vessel tenant list', t('help.cmd.tenantList')],
    ['vessel tenant get <id>', t('help.cmd.tenantGet')],
    ['vessel tenant create <id>', t('help.cmd.tenantCreate')],
    ['vessel tenant update <id> --status disabled', t('help.cmd.tenantUpdate')],
  ];
  const plugins: Array<[string, string]> = [
    ['vessel plugin list', t('help.cmd.pluginList')],
    ['vessel plugin install <path> [--force]', t('help.cmd.pluginInstall')],
    ['vessel plugin remove <name>', t('help.cmd.pluginRemove')],
  ];
  const migrate: Array<[string, string]> = [
    ['vessel migrate --from sqlite --to file-v2', t('help.cmd.migrate')],
    ['vessel migrate --from file-v1 --to file-v2 --apply', t('help.cmd.migrateApply')],
    ['vessel trace prune --dry-run', t('help.cmd.tracePrune')],
  ];
  const debug: Array<[string, string]> = [['VESSEL_MOCK=1 vessel --run "x"', t('help.cmd.mock')]];
  const meta: Array<[string, string]> = [
    ['vessel doctor [--deep]', t('help.cmd.doctor')],
    ['vessel logs tail [--json] [--lines N]', t('help.cmd.logsTail')],
    ['vessel --resume-run', t('help.cmd.resumeRunList')],
    ['vessel update [--yes]', t('help.cmd.update')],
    ['vessel update --check', t('help.cmd.updateCheck')],
    ['vessel update --channel beta', t('help.cmd.updateBeta')],
    ['vessel --version', t('help.cmd.version')],
    ['vessel --tools', t('help.cmd.tools')],
    ['vessel completion <shell>', t('help.cmd.completion')],
    ['vessel --help', t('help.cmd.help')],
  ];
  const width = Math.max(
    ...[
      ...usage,
      ...session,
      ...headless,
      ...gateway,
      ...hub,
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
      ui.title(t('help.title')),
      ui.rule(48),
      '',
      `  ${ui.section(t('help.section.usage'))}`,
      align(usage, width),
      '',
      `  ${ui.section(t('help.section.session'))}`,
      align(session, width),
      '',
      `  ${ui.section(t('help.section.headless'))}`,
      align(headless, width),
      '',
      `  ${ui.section(t('help.section.gateway'))}`,
      align(gateway, width),
      '',
      `  ${ui.section(t('help.section.hub'))}`,
      align(hub, width),
      '',
      `  ${ui.section(t('help.section.capability'))}`,
      align(capability, width),
      '',
      `  ${ui.section(t('help.section.config'))}`,
      align(config, width),
      '',
      `  ${ui.section(t('help.section.tenant'))}`,
      align(tenant, width),
      '',
      `  ${ui.section(t('help.section.plugins'))}`,
      align(plugins, width),
      '',
      `  ${ui.section(t('help.section.migrate'))}`,
      align(migrate, width),
      '',
      `  ${ui.section(t('help.section.debug'))}`,
      align(debug, width),
      '',
      `  ${ui.section(t('help.section.other'))}`,
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
// ── 入口环境（locale / logger / 未捕获兜底）────────
// locale 先按环境变量解析，保证解析错误与 --help 也跟随 VESSEL_LANG；
// bootstrap 后再用 config.ui.language 重新应用（完整优先级）。
setLocale(resolveLocale({ env: process.env }));
const logger = createCliLogger();
let activeResult: BootstrapResult | undefined;
let activeEvents: EventStream | undefined;
let activeCleanup: (() => Promise<void>) | undefined;
installProcessErrorHandlers({
  logger,
  events: () => activeEvents,
  shutdown: async () => {
    if (activeCleanup) return activeCleanup();
    await activeResult?.shutdown();
  },
});

// ── argv 解析 ────────────────────────────────────

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${ui.err(parsed.error)}\n${ui.dim(t('common.helpHint'))}`);
  // 用法/解析错误统一 exit 2（Addendum A §6），与运行期失败（exit 1）区分。
  process.exit(2);
}
const args = parsed.args;
// 0.15: one-shot commands call loadConfig() without cliOverrides; mirror the
// explicit --data-dir into the env layer so they resolve the same data root.
// The main bootstrap path still passes it through buildCliConfigOverrides().
if (args.dataDirArg !== null) process.env.VESSEL_DATA_DIR = args.dataDirArg;
const demoRequested = args.demo;
const useMock =
  demoRequested || process.env.VESSEL_MOCK === '1' || process.env.VESSEL_MOCK === 'true';
// env 只在这里读一次；`vessel demo` 固定 tools，忽略 env 场景。
const resolvedScenario = demoRequested
  ? { name: 'tools' as MockScenarioName }
  : resolveMockScenario(process.env.VESSEL_MOCK_SCENARIO);
const mockScenario = resolvedScenario.name;
if (useMock && !demoRequested && resolvedScenario.unknown !== undefined) {
  console.error(t('cli.unknownMockScenario', { name: resolvedScenario.unknown }));
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
    console.error(t('demo.needsTty'));
    process.exit(1);
  }
  console.log(
    [
      ui.title(t('demo.title')),
      t('demo.line.command'),
      t('demo.line.flow'),
      t('demo.line.exit'),
      t('demo.line.next'),
      t('demo.line.isolated'),
    ].join('\n'),
  );
}
// 一次性命令注册表：按注册顺序命中第一个，执行后直接退出。
// 命中后不进入 bootstrap / REPL / serve / headless 主流程。
const command = matchCommand(args);
if (command) {
  await applyCommandLocale();
  process.exit((await command.run(args, { useMock })) ?? 0);
}
// 0.12：`gateway start` / `gateway restart` 前台 = 现有 `--serve` 管线。
// `--daemon` 及其它 gateway 子命令已由注册表处理。
const foregroundGateway = args.gateway !== null && isForegroundGatewayCommand(args.gateway);
let foregroundGatewayLock: GatewayInstanceLock | undefined;
let foregroundGatewayInstance: string = DEFAULT_GATEWAY_INSTANCE;
if (foregroundGateway && args.gateway !== null) {
  const gatewayArgs = args.gateway;
  let targetInstance =
    gatewayArgs.kind === 'start' || gatewayArgs.kind === 'restart'
      ? gatewayArgs.instance
      : undefined;
  let targetPort = gatewayArgs.kind === 'start' ? gatewayArgs.port : undefined;
  let targetHost = gatewayArgs.kind === 'start' ? gatewayArgs.host : undefined;

  if (gatewayArgs.kind === 'restart') {
    // 选择器命中的实例在停止前读取实际 port/host，用于原样重启。
    const { config } = await loadConfig();
    const targets = await resolveGatewayTargets(resolveDataDir(config), gatewayArgs);
    const previous = targets.ok ? targets.entries[0] : undefined;
    if (previous !== undefined) {
      targetInstance = previous.instance;
      if (previous.state.kind === 'running' || previous.state.kind === 'stale') {
        targetPort = previous.state.record.port;
        targetHost = previous.state.record.host;
      }
    }
    const stopCode = await stopGateway({ selector: gatewayArgs });
    if (stopCode !== 0) process.exit(stopCode);
  }

  const instance = deriveGatewayInstance(targetInstance, targetPort);
  const prepared = await prepareForegroundGatewayStart({ instance });
  if (!prepared.ok) {
    console.error(ui.err(prepared.error));
    process.exit(1);
  }
  foregroundGatewayLock = prepared.lock;
  foregroundGatewayInstance = prepared.instance;
  process.once('exit', () => foregroundGatewayLock?.releaseSync());
  // 端口/主机缺省沿用 serve 配置；显式 flag 才进 CLI 覆盖层。
  args.servePort = targetPort ?? DEFAULT_SERVE_PORT;
  args.servePortExplicit = gatewayArgs.kind === 'start' ? gatewayArgs.port !== undefined : true;
  if (targetHost !== undefined) args.serveHost = targetHost;
} else if (args.servePort !== null) {
  // `--serve` 是 default 实例的前台别名：先准备（运行中拒绝 + 实例锁），
  // 修复 0.12 直接覆盖 gateway.pid 的问题。
  // 0.15：help 不再列出；保留解析并提示改用 `vessel gateway start`。
  console.error(t('cli.serveDeprecated'));
  const prepared = await prepareForegroundGatewayStart({ instance: DEFAULT_GATEWAY_INSTANCE });
  if (!prepared.ok) {
    console.error(ui.err(prepared.error));
    process.exit(1);
  }
  foregroundGatewayLock = prepared.lock;
  foregroundGatewayInstance = prepared.instance;
  process.once('exit', () => foregroundGatewayLock?.releaseSync());
}
// 启动诊断：静态产物缺失/过期时自动重建（`VESSEL_NO_WEB_AUTOBUILD=1` 关闭）；
// 重建失败只告警，不改退出码，继续以现有产物提供服务。
if (foregroundGateway || args.servePort !== null) {
  const status = await ensureWebDist({ warn: (line) => console.error(ui.warn(line)) });
  const warning = webDistWarning(status);
  if (warning) console.error(ui.warn(warning));
}
// `-r/--resume` 无 id：列出当前 tenant 的会话（connect 模式无法本地列出）。
if (args.resumeArg === '') {
  if (args.connectArg !== null || (process.env.VESSEL_CONNECT ?? '').trim() !== '') {
    console.error(t('cli.resumeNeedsLocalStore'));
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
// 0.15：交互 REPL 或 gateway/serve 才有 ask_user 应答者；
// `--run` / headless / 管道一律不注册（否则只能等 120s 超时）。
// `ui.askUser: false` 在 bootstrap / tenant factory 内按配置关闭。
const askUserClient = interactive || (serveRequested && !headless);

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
  dataDir: args.dataDirArg,
});

// 引导应用启动
const initialResult = await bootstrap({
  useMock,
  mockScenario,
  ...(demoRequested ? { dataDirSubdir: 'demo' } : {}),
  sessionId: resolvedSessionId,
  headless,
  interactive,
  registerAskUser: askUserClient,
  acquireLock: true,
  exclusive: args.exclusive,
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
  logger,
});
const { config } = initialResult;
activeResult = initialResult;
activeEvents = initialResult.ctx.events;
// 完整 locale 优先级：VESSEL_LANG > config.ui.language > LANG > LC_ALL > zh-CN
applyLocale((config.ui as { language?: string } | undefined)?.language);

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
      registerAskUser: askUserClient,
      acquireLock: true,
      exclusive: args.exclusive,
      cliOverrides,
      ...(args.tenantArg !== null ? { tenantId: args.tenantArg } : {}),
      ...(args.connectArg !== null
        ? { connect: args.connectArg }
        : process.env.VESSEL_CONNECT !== undefined
          ? { connect: process.env.VESSEL_CONNECT }
          : {}),
      configErrorExitCode: args.feishu ? 2 : 1,
      logger,
    });
    activeResult = result;
    activeEvents = result.ctx.events;
    await runWithConfig(result);
  } else {
    console.error(t('common.noApiKeyExit'));
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
   * 活配置（CONTRACT-tool-policy-ui §1）：启动配置的快照只在服务启动时有效；
   * 热应用 / 写回成功后必须更新这里，否则 `config.get` 与 `gateway.reload`
   * 的 diff 基线会一直滞后。
   */
  let liveConfig: VesselConfig = config;
  /**
   * A2：headless 不在这里直接 `process.exit`，否则会跳过末尾的
   * gateway / tenantFactory / transport / shutdown 清理（`--serve --run`
   * 会残留 tenant `.lock`）。只记录退出码，统一走公共清理后再退出。
   */
  let headlessExitCode: number | undefined;

  // 0.6 A4：connect 模式下展示远端 node/tenant。headless 写 stderr，避免污染 stdout。
  if (result.remote) {
    const node = result.remote.nodeId ?? 'unknown';
    const line = t('cli.remoteGateway', {
      node,
      tenant: result.remote.tenantId,
      endpoint: result.remote.endpoint,
    });
    if (headless) console.error(line);
    else console.log(line);
  }

  // ── Durable resume（0.3）────────────────────────
  // --resume-run 与 --serve/--run 互斥（cli-args 已保证），这里直接恢复后分流。
  if (resumeRunId !== null) {
    let exitCode = 0;
    // headless resume 没有 TUI 订阅者，与 --run 一致自动允许权限请求（ADR-029），
    // 否则 permission policy 会无限等待 tool.permission.response。
    // TTY resume（headless === false）进 REPL，由用户应答，不得自动 allow。
    const uninstallPermissionAutoAllow = headless
      ? installHeadlessPermissionAutoAllow(ctx.events)
      : undefined;
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
      uninstallPermissionAutoAllow?.();
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
      console.log(t('cli.feishuConnected', { appId: feishuChannel.status().appIdMasked }));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      await result.shutdown();
      process.exit(feishuExitCode(error));
    }
  }

  // HTTP/WS gateway（--serve）：Web 控制台后端。SSE/WS 广播事件流，/sessions /run 提供控制。
  let gateway: Gateway | null = null;
  /** CONTRACT-hot-apply §2：用户配置监听（关闭时取消，不泄漏句柄）。 */
  let configWatch: ConfigWatchHandle | undefined;
  /** gateway 侧版本检查；与热应用共用 runtime.notice 通路。 */
  let gatewayUpdateCheck: GatewayUpdateCheckHandle | undefined;
  /** 用户配置路径（写回 / 监听同源）。 */
  let hotApplyConfigPath = getUserConfigPath();
  /** debounce：默认常量，`VESSEL_CONFIG_WATCH_DEBOUNCE_MS=0` 可关掉合并（测试 / 调试）。 */
  const hotApplyDebounceMs = ((): number | undefined => {
    const raw = process.env.VESSEL_CONFIG_WATCH_DEBOUNCE_MS;
    if (raw === undefined || raw.trim() === '') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  })();
  /** S5.1：node → hub 出站；仅在 `hub.direction: node` 时启动。 */
  let hubNodeOutbound: StartedHubNodeOutbound | undefined;
  /** S10.2：gateway 同进程本地 hub（回环）；`hub.autoStart !== false` 时启动。 */
  let localHub: LocalHubHandle | undefined;
  /** A-6：--serve 时除 bootstrap 默认 tenant 外的执行面 */
  let tenantFactory: TenantRuntimeFactory | undefined;
  /** 0.18：tenant 事件流的唯一扇入面（shared 流已删除）。 */
  let eventHub: TenantEventHub | undefined;
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
      ...(result.agent?.nodeTokens !== undefined ? { tokenStore: result.agent.nodeTokens } : {}),
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
      // 0.18：tenant 运行时流是唯一事件面。bootstrap 的默认 tenant bundle 由这里注册；
      // 其余 tenant 由工厂在构建时注册。
      eventHub = createGatewayEventHub({
        ...(result.bundle
          ? { streams: [{ tenantId: result.tenantId, stream: result.bundle.runtimeEvents }] }
          : {}),
        // 0.18：live hub 与 trace 同源；bundle.redactor 已是 core+ext 组合实例。
        // 缺 bundle 是不可达的理论路径，保留 hub 默认 redactor。
        ...(result.bundle ? { redactor: result.bundle.redactor } : {}),
      });

      tenantFactory = await createTenantRuntimeFactory({
        config,
        ...(result.bundle ? { seededTenants: [result.bundle] } : {}),
        useMock,
        mockScenario,
        headless,
        nodeId: result.nodeId,
        // 0.15：非 default tenant 同样注册 ask_user；每个 tenant 的 ui.askUser 再单独关闭。
        registerAskUser: askUserClient,
        ...(args.exclusive ? { exclusive: true } : {}),
        hub: eventHub,
        // 0.18：所有 tenant 共用 default bundle 的 ext 实例（trace 与 live 同源）。
        ...(result.bundle?.extRedactor ? { redactor: result.bundle.extRedactor } : {}),
        logger,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      await result.shutdown();
      process.exit(1);
    }

    if (eventHub === undefined) {
      console.error('Gateway event hub is not initialized.');
      await result.shutdown();
      process.exit(1);
    }

    const dataDir = resolveDataDir(config);
    // 0.18：硬崩后 session 会永久停在 running（事件无终态）。启动 sweep + 读时兜底共用
    // 同一修复函数；锁活着 → 跳过，绝不误杀其它实例的活 run / resume。
    const livenessContextFor = (tenantId: string): SessionLivenessContext | undefined => {
      const bundle =
        tenantFactory?.bundleFor(tenantId) ??
        (tenantId === result.tenantId ? result.bundle : undefined);
      if (!bundle) return undefined;
      return {
        tenantDir: bundle.tenantPaths.root,
        session: bundle.session,
        ...(bundle.eventLog ? { eventLog: bundle.eventLog } : {}),
        ...(bundle.runStore ? { runStore: bundle.runStore } : {}),
        logger,
      };
    };
    const livenessSessionFor = (tenantId: string) => {
      const livenessContext = livenessContextFor(tenantId);
      return livenessContext !== undefined
        ? withLivenessRepair(livenessContext.session, livenessContext)
        : undefined;
    };
    for (const tenantId of tenantFactory?.tenantIds() ?? []) {
      const livenessContext = livenessContextFor(tenantId);
      if (!livenessContext) continue;
      const sweep = await reconcileStaleSessions(livenessContext);
      if (sweep.repaired.length > 0 || sweep.errors.length > 0) {
        logger.warn('session liveness sweep', {
          tenant_id: tenantId,
          repaired: sweep.repaired.length,
          errors: sweep.errors.length,
        });
      }
    }
    // 0.6.1 P0-2：非 default tenant 只走 per-tenant runStore；
    // default tenant 由上面的 `durable` 提供（gateway 优先 opts.durable）。
    const durableFor = createDurableFor(tenantFactory, result.tenantId);
    // 0.15：serve 的 config.set 写回面（对象变量避免对 ConfigGatewayOptionsLike 的
    // 多余属性检查；serve 合入 0.15 后该字段会被正式识别）。
    const tenantConfigControl = {
      snapshot: (tenantId: string): ConfigSnapshotLike => {
        const bundle = tenantFactory?.bundleFor(tenantId) ?? result.bundle;
        if (!bundle) {
          throw Object.assign(new Error(`forbidden: tenant "${tenantId}" is not configured`), {
            code: 'forbidden',
          });
        }
        return buildConfigSnapshot({
          // A6-10：不向当前 tenant 暴露其它 tenant 的 overlay。
          // 默认 tenant 读活配置，写回 / 热应用后 `config.get` 立即反映新策略；
          // 非默认 tenant 仍读各自 bundle 的配置。
          config: sanitizeConfigForSnapshot(
            tenantId === result.tenantId ? liveConfig : bundle.config,
          ),
          sources: bundle.configSources,
          paths: bundle.configPaths ?? { user: '', project: 'vessel.yaml' },
          tenantId,
          tenantOverlayKeys: bundle.tenantOverlayKeys,
        }) as unknown as ConfigSnapshotLike;
      },
      set: createGatewayConfigSet({ defaultTenantId: result.tenantId }),
    };
    // ── 热应用（CONTRACT-hot-apply）────────────────
    /**
     * 重新读取配置；校验不通过就抛错（调用方据此**不应用**）。
     * 与 `gateway.reload` 的 `reloadConfig` 同源，避免两条读数口径。
     */
    const reloadVesselConfig = async (): Promise<VesselConfig> => {
      const loaded = await loadConfig();
      if (loaded.validation.errors.length > 0) {
        throw new Error(
          loaded.validation.errors.map((error) => `${error.path}: ${error.message}`).join('; '),
        );
      }
      liveConfig = loaded.config;
      return loaded.config;
    };
    // 事件出口：notice 同时进事件流（Web/TUI）与模型上下文（BeforeLlm hook）。
    hotApplyConfigPath = getUserConfigPath();
    const noticeBus = createRuntimeNoticeBus({
      events: result.bundle?.runtimeEvents ?? ctx.events,
      tenantId: result.tenantId,
    });
    registerRuntimeNoticeHook(ctx.pluginHost, noticeBus);

    /** 存活 runtime 的集合：owner（bundle / ctx）+ 每个 tenant bundle。 */
    const liveTargets = (): PermissionApplyTarget[] =>
      collectPermissionTargets({
        runtime: ctx.runtime,
        bundleRuntime: result.bundle?.runtime,
        tenantRuntimes: () => [
          ...(tenantFactory?.tenantIds() ?? []).map((id) => tenantFactory?.runtimeFor(id)),
          ...(tenantFactory?.tenantIds() ?? []).map((id) => tenantFactory?.bundleFor(id)?.runtime),
        ],
      });

    const permissionState: PermissionApplierState = {
      current: permissionConfigFor(config, headless),
    };
    // 启动时**插件装配实际产出**：tools applier 只管辖「插件工具 ∪ 热装配过的插件工具」。
    // 入口注册的 agent / ask_user 与 MCP 工具（toolSource 非 null）不在管辖域内，
    // 否则一次 reload 会把它们判成 removed（D1）。
    const managedPluginTools = new Set(pluginManagedToolNames(ctx.pluginHost, result.mcp));
    // 插件安装配置基线（用于识别「定义没变但行为配置变了」）：
    // `computeTargetTools` 每次读到的配置写入 `lastToolsConfigKey`，`targetKey` 读它。
    const pluginConfigKeyOf = (value: VesselConfig): string =>
      JSON.stringify(buildPluginConfigMap(value.plugins, declarativePluginEntries(value)));
    const lastToolsConfigKey: { current?: string } = { current: pluginConfigKeyOf(config) };
    const toolsConfigKey: { value?: string } = { value: lastToolsConfigKey.current };

    const reloadAppliers: Record<string, GatewayReloadApplier> = {
      permission: createPermissionApplier(
        {
          loadPermission: async () => permissionConfigFor(await reloadVesselConfig(), headless),
          apply: async (rules) => {
            let applied = 0;
            for (const runtime of liveTargets()) {
              if (typeof runtime.applyPermissionRules !== 'function') continue;
              try {
                runtime.applyPermissionRules(rules);
                applied += 1;
              } catch (error) {
                logger.warn('hot_apply.permission_failed', {
                  runtime: runtime.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            // 成员 Body 走 AgentService 的唯一转发入口（没有 agent 时返回 0）。
            if (result.agent !== undefined) {
              applied += await result.agent.service.applyPermissionRules(rules);
            }
            return applied;
          },
        },
        permissionState,
      ),
      tools: async () => {
        const outcome = await applyTools({
          host: ctx.pluginHost,
          // 旁路重建：先在临时 host 上算出目标集，再一次性替换真实宿主。
          computeTargetTools: async () => {
            const next = await reloadVesselConfig();
            lastToolsConfigKey.current = pluginConfigKeyOf(next);
            const assembled = await assemblePluginTools({
              config: next,
              tenantId: result.tenantId,
              excludePlugins: MCP_FACTORY_PLUGINS,
            });
            for (const tool of assembled.tools) managedPluginTools.add(tool.name);
            return assembled.tools;
          },
          managedNames: () => [...managedPluginTools],
          // 插件安装配置（basic-tools 的 cwd 等）变了就整体刷新，否则行为不会生效。
          targetKey: () => lastToolsConfigKey.current ?? '',
          previousKey: toolsConfigKey,
        });
        // 成员 Body 的工具面是 spawn 时快照：owner 宿主更新后在同一具 body 上刷新，
        // 不重建 session / context（有 active run 时由执行内核延迟到轮边界）。
        // 传入应用后的全量工具面（含 agent / ask_user / MCP），成员侧再按白名单过滤。
        await result.agent?.service.refreshTools?.(ctx.pluginHost.listTools());
        return outcome.summaries;
      },
    };

    // MCP：没有控制面时不注册该 scope（请求即 `unknown reload scope`）。
    const mcpPlugin = result.bundle?.mcpPlugin;
    if (result.mcp !== undefined && mcpPlugin !== undefined) {
      const toggle = createMcpServerToggle({
        control: result.mcp,
        plugin: mcpPlugin,
        host: ctx.pluginHost,
      });
      reloadAppliers.mcp = createMcpApplier({
        control: result.mcp,
        toggle,
        desiredEnabled: async () => {
          const next = await reloadVesselConfig();
          const servers = next.mcpServers ?? {};
          const desired: Record<string, boolean> = {};
          for (const [name, server] of Object.entries(servers)) {
            desired[name] = server.enabled !== false;
          }
          return desired;
        },
      });
    }

    const reloadRunner = createGatewayReloadRunner({
      // web 尚未合入 reconfigure 时该字段不存在；按结构化可选入口处理。
      gateway: () => gateway as GatewayReconfigureTarget | null,
      currentConfig: () => liveConfig,
      reloadConfig: reloadVesselConfig,
      refreshPlugins: () => {
        tenantFactory?.refreshPlugins();
        result.bundle?.pluginLoader.refresh();
      },
      appliers: reloadAppliers,
    });

    // 配置监听（CONTRACT-hot-apply §2）：校验通过才应用，失败只记日志 + 发失败 notice。
    // gateway 启动后再挂监听（此时 reload 面已就绪）；关闭时在 activeCleanup 里取消。
    configWatch = startConfigWatch({
      configPath: hotApplyConfigPath,
      debounceMs: hotApplyDebounceMs,
      logger,
      validate: async () => toConfigReloadOutcome(await loadConfig()),
      apply: async () => {
        // 只请求已注册的 applier：没有 MCP 的部署不该因为 mcp scope 失败。
        const registered = new Set(reloadRunner.registeredScopes());
        const scopes = ['config', 'permission', 'tools', 'mcp'].filter(
          (scope) => scope === 'config' || registered.has(scope),
        );
        const outcome = await reloadRunner.reloadWithSummaries(scopes);
        // 每个 scope 的差异行汇总为一条 notice 的 details（最多 10 行由总线裁剪）。
        const lines = Object.entries(outcome.summaries)
          .filter(([, summary]) => summary.length > 0)
          .flatMap(([, summary]) => summary);
        return lines.length > 0
          ? lines
          : [`config: reloaded ${outcome.reloaded.join(', ') || 'nothing'}`];
      },
      notify: (notice) => {
        noticeBus.publish(notice);
      },
    });
    if (configWatch === undefined) {
      logger.warn('config.watch.unavailable', { path: hotApplyConfigPath });
    }

    const gatewayOptions: GatewayOptions & {
      durableFor?: (tenantId: string) => DurableGatewayOptions | undefined;
    } = {
      // capabilities.list 需要真实版本；缺省会退化为 0.0.0。
      version: readPackageVersion(),
      // 0.13 Addendum A：权限交互持久化目录（serve 负责文件格式与原子写）。
      // 0.15：命名实例落到 <dataDir>/instances/<instance>，避免同 dataDir 互相覆盖。
      interactionsDir: ensureInteractionsDir(dataDir, foregroundGatewayInstance),
      // 0.12 / CONTRACT-hot-apply：`gateway.reload` 的唯一热应用入口。
      // serve 只做 scope 枚举校验；这里注入 `scope -> applier`。
      reload: reloadRunner.reload,
      // CONTRACT-hot-apply §7：permissions.setToolPolicy 的写盘面（用户 YAML）。
      permissions: {
        setToolPolicy: ({ tool, policy }) => {
          const written = setToolPolicy(tool, policy, { configPath: hotApplyConfigPath });
          // 写盘成功后同步活配置（重新赋值而非原地修改），让随后的 config.get 返回新数组。
          liveConfig = {
            ...liveConfig,
            permission: {
              ...liveConfig.permission,
              autoApprove: written.autoApprove,
              neverAutoApprove: written.neverAutoApprove,
            },
          };
          return {
            auto_approve: written.autoApprove,
            never_auto_approve: written.neverAutoApprove,
          };
        },
      },
      hub: eventHub,
      // 0.18：events.list 的二次脱敏与 live hub / trace 同源（ext 幂等）。
      ...(result.bundle ? { redactor: result.bundle.redactor } : {}),
      session: livenessSessionFor(result.tenantId) ?? ctx.session,
      runtime,
      // web 控制台需要的装配面：会话切换 clear 上下文、工具清单、静态站点托管
      context: ctx.context,
      pluginHost: ctx.pluginHost,
      staticDir: resolveStaticDir(),
      nodeId: result.nodeId,
      nodeName: result.nodeName,
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
      // 0.27：default tenant 的 `runs.*` 控制面（AgentService.admit + tenant
      // scheduler）；agent 关闭时缺省不注入（runs.start 保持 forbidden）。
      // 非 default tenant 的 `runControlFor` 是后续切片，这里不 stub。
      ...(result.agent !== undefined && result.bundle !== undefined
        ? {
            runControl: createRunControl(
              result.agent.service,
              result.bundle.scheduler,
              result.tenantId,
            ),
          }
        : {}),
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
            sessionFor: (tenantId: string) =>
              livenessSessionFor(tenantId) ?? tenantFactory?.sessionFor(tenantId),
            contextFor: (tenantId: string) => tenantFactory?.contextFor(tenantId),
            pluginHostFor: (tenantId: string) => tenantFactory?.pluginHostFor(tenantId),
            pluginsFor: (tenantId: string) => tenantFactory?.pluginsFor(tenantId) ?? [],
            plugins: () => tenantFactory?.pluginsFor(result.tenantId) ?? [],
            // 无 metrics 的 tenant 返回 undefined；gateway 已按 undefined 处理。
            metricsFor: ((tenantId: string) => {
              const metrics = tenantFactory?.metricsFor(tenantId);
              return metrics ? () => metrics.snapshot() : undefined;
            }) as unknown as (tenantId: string) => MetricsProvider,
            config: tenantConfigControl,
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
      nodeId: result.nodeId,
      logger,
      ...(result.metrics ? { metrics: result.metrics } : {}),
      ...(result.feishu ? { feishu: result.feishu } : {}),
      // 0.19 S3：canonical teams.* 只在默认 tenant 的 AgentService 存在时注入。
      ...(result.agent?.team ? { teams: result.agent.team } : {}),
      // 0.25：canonical agents.create|update|close（同一 AgentService 适配器）。
      ...(result.agent?.control ? { agentControl: result.agent.control } : {}),
      // S5：hub 目录投影 / 动态 token / session→team 归属。
      ...(result.agent?.hubControl ? { hubControl: result.agent.hubControl } : {}),
      ...(result.agent?.nodeTokens ? { nodeTokens: result.agent.nodeTokens } : {}),
      ...(result.agent?.teamScope ? { teamScope: result.agent.teamScope } : {}),
      // 0.5.4 P2-1：非 default tenant 使用自己的 feishu 实例。
      // 只对工厂已构造 bundle 的 tenant 返回；未配置 / 未启用 → undefined。
      ...(tenantFactory
        ? {
            feishuFor: (tenantId: string) => {
              const feishu = tenantFactory?.bundleFor(tenantId)?.feishu;
              return feishu ? { status: () => feishu.status() } : undefined;
            },
          }
        : {}),
    });

    try {
      gateway = startGateway(Object.assign(gatewayOptions, controlPlane) as GatewayOptions);
    } catch (error) {
      if (isAddressInUse(error)) {
        // 端口被外部进程占用：退出 1，且不写 PID 文件（实例锁随 exit 释放）。
        console.error(
          `port_in_use: ${resolved.options.hostname}:${resolved.options.port} is already in use. ` +
            'Stop the other process or choose another --port/--instance.',
        );
        await result.shutdown();
        process.exit(1);
      }
      throw error;
    }

    // 版本检查（CONTRACT-hot-apply update scope）：与热应用共用 runtime.notice。
    // 只读、静默失败；关闭路径上 stop()，不留下定时器。
    gatewayUpdateCheck = startGatewayUpdateCheck({
      notice: noticeBus,
      config,
      logger,
      currentVersion: gatewayOptions.version,
    });

    // 0.12：PID 文件供 `gateway status/stop/restart/reload` 使用。
    // `gateway start` 写失败视为启动失败；`--serve` 保持兼容，只告警。
    try {
      await writeForegroundGatewayPid({
        dataDir,
        host: resolved.options.hostname,
        port: gateway.port,
        version: gatewayOptions.version,
        instance: foregroundGatewayInstance,
        ...(result.nodeId ? { nodeId: result.nodeId } : {}),
      });
    } catch (error) {
      const message =
        `failed to write ${dataDir}/gateway.pid: ` +
        (error instanceof Error ? error.message : String(error));
      if (foregroundGateway) {
        console.error(message);
        await result.shutdown();
        process.exit(1);
      }
      console.warn(`⚠ ${message}`);
    }

    // S5.1：node → hub 出站。gateway 已在监听；出站只拨号，不新开入站端口。
    if (config.hub?.direction === 'node') {
      if (result.agent?.hubControl === undefined) {
        logger.warn('hub.node.no_agent_projection', { node_id: result.nodeId });
      } else {
        try {
          hubNodeOutbound = await startHubNodeOutbound({
            config,
            dataDir,
            nodeId: result.nodeId,
            tenantId: result.tenantId,
            hubControl: result.agent.hubControl,
            logger,
          });
          if (hubNodeOutbound.status === 'skipped') {
            logger.warn('hub.node.outbound_skipped', {
              node_id: result.nodeId,
              reason: hubNodeOutbound.reason ?? 'unknown',
            });
          }
        } catch (error) {
          logger.warn('hub.node.outbound_start_failed', {
            node_id: result.nodeId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // S10.2：gateway 同进程本地 hub。失败只告警，gateway 继续运行。
    if (result.agent?.hubControl !== undefined) {
      try {
        localHub = await startLocalHub({
          config,
          gatewayDataDir: dataDir,
          nodeId: result.nodeId,
          tenantId: result.tenantId,
          hubControl: result.agent.hubControl,
          logger,
        });
        if (localHub.status === 'started') {
          logger.info('hub.local.started', { url: localHub.url });
        } else if (localHub.status === 'reused') {
          logger.info('hub.local.reused', { reason: localHub.reason ?? 'hub_already_running' });
        } else {
          logger.info('hub.local.skipped', { reason: localHub.reason ?? 'unknown' });
        }
      } catch (error) {
        logger.warn('hub.local.start_failed', {
          node_id: result.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (config.hub?.autoStart !== false && config.hub?.direction !== 'node') {
      logger.warn('hub.local.no_agent_projection', { node_id: result.nodeId });
    }
  }

  if (gateway) {
    console.log(`\n${renderGatewayBanner(gateway)}\n`);
  }

  // 未捕获异常时的清理入口：停 gateway / 关闭额外 tenant / 释放默认 tenant。
  // gateway.stop() 自带 interrupt('shutdown') + 5s drain，后续关闭传 drain:false。
  activeCleanup = async () => {
    // 先停配置监听 / 版本检查与出站 / 本地 hub，避免 gateway drain 期间继续触发热应用或重连。
    gatewayUpdateCheck?.stop();
    gatewayUpdateCheck = undefined;
    configWatch?.close();
    configWatch = undefined;
    await hubNodeOutbound?.close();
    hubNodeOutbound = undefined;
    await localHub?.stop();
    localHub = undefined;
    await shutdownServeStack({
      gateway,
      closeTenants: async (options) => {
        await tenantFactory?.closeAll(options);
        eventHub?.close();
        eventHub = undefined;
      },
      shutdown: (options) => result.shutdown(options),
    });
    await foregroundGatewayLock?.release();
  };

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
    console.log(`${ui.ok(t('cli.gatewayRunning'))}\n`);
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
    console.log(`${t('cli.feishuRunning')}\n`);
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

  // 固定顺序：await gateway.stop()（自带 interrupt + 5s drain）
  // → closeAll → shutdown；后两步 drain:false，避免重复限时等待。
  const finish = async (beforeClose?: () => Promise<void>): Promise<void> => {
    // 先停出站 / 本地 hub，避免 gateway drain 期间继续重连或刷新目录。
    await hubNodeOutbound?.close();
    hubNodeOutbound = undefined;
    await localHub?.stop();
    localHub = undefined;
    await shutdownServeStack({
      gateway,
      closeTransport: async () => {},
      ...(beforeClose ? { beforeClose } : {}),
      closeTenants: async (options) => {
        await tenantFactory?.closeAll(options);
        eventHub?.close();
        eventHub = undefined;
      },
      shutdown: (options) => result.shutdown(options),
    });
    await foregroundGatewayLock?.release();
  };

  // 0.4：显式 --feishu 时，SIGINT/SIGTERM 走 130/143；
  // 纯 0.3 serve 保持原来的自然退出（0）。
  if (shutdownSignal && args.feishu) {
    await finish();
    process.exit(signalExitCode(shutdownSignal));
  }
  await finish();

  // A2：清理完成后再落 headless 退出码（其余模式保持自然退出 0）。
  if (headlessExitCode !== undefined) process.exitCode = headlessExitCode;
}
