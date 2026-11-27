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
import * as path from 'node:path';
import {
  buildConfigSnapshot,
  DATA_DIR_CLI_MARKER_ENV,
  getUserConfigPath,
  isLoopbackHostname,
  loadConfig,
  type PluginExposeConfig,
  resolveEffectiveApiKey,
  resolveGatewayNodePorts,
  resolveServeProxySecret,
  type VesselConfig,
} from '../packages/config/src/index';
import {
  configureLogging,
  type EventStream,
  type LoggingConfig,
  pruneTrace,
  rebuildMetrics,
} from '../packages/core/src/index';
import {
  buildPluginCatalog,
  type ConfigSnapshotLike,
  createGatewayEventHub,
  type Gateway,
  type GatewayOptions,
  normalizeAllowedOrigins,
  type PluginHostManager,
  type PluginReloadResult,
  runShutdownStep,
  type ShutdownStepEmit,
  startGateway,
  type TenantEventHub,
} from '../packages/serve/src/index';
import { listAsyncBashJobs, readAsyncBashJobLogTail } from '../plugins/tools/basic-tools/src/index';
// 0.57：**不**静态导入 Ink REPL。`ink-repl.tsx` 的传递闭包是 React + ink + 十几个组件，
// 实测（本机）单是求值它就要数百毫秒到数秒 —— 而 `node start` / `gateway start` /
// `--run` 永远不会进那个界面。它现在按需加载（见 {@link startInkRepl}）。
import { createAskAnswerDelivery } from './agent/ask-answer-delivery';
import { DEFAULT_SERVE_PORT, parseArgs } from './cli/args';
import {
  deriveGatewayInstance,
  isForegroundGatewayCommand,
  prepareForegroundGatewayStart,
  printSplitModePortError,
  resolveGatewayTargets,
  resolveRestartDaemonMode,
  stopGateway,
  writeForegroundGatewayPid,
} from './cli/commands/gateway/gateway-command';
import { isForegroundNodeCommand } from './cli/commands/node-command';
import { runPluginCliCommand } from './cli/commands/plugin/plugin-cli-command';
import type { FeishuChannelLike } from './cli/control-plane-types';
import { feishuExitCode, signalExitCode, startFeishuChannel } from './cli/feishu-command';
import {
  HEADLESS_ASK_SUSPENDED_EXIT_CODE,
  installHeadlessAskSuspend,
  installHeadlessPermissionAutoAllow,
  printSuspendedAsk,
  runHeadless,
} from './cli/headless-runner';
import { planCliHelp, renderGlobalHelp, renderUsageError } from './cli/help';
import { ui } from './cli/output';
import { buildCliConfigOverrides } from './config/cli-overrides';
import { sanitizeConfigForSnapshot } from './config/config-snapshot';
import {
  type ConfigWatchHandle,
  startConfigWatch,
  toConfigReloadOutcome,
} from './config/config-watch';
import { createWrittenConfigApplier } from './config/config-write-apply';
import {
  applyRegistrations,
  createMcpApplier,
  createMcpServerToggle,
  createPermissionApplier,
  type PermissionApplierState,
  pluginManagedGuardrailNames,
  pluginManagedToolNames,
} from './config/hot-apply-appliers';
import {
  assemblePluginRegistrations,
  collectPermissionTargets,
  type PermissionApplyTarget,
  permissionConfigFor,
  registerRefsNoticeHook,
  registerRuntimeNoticeHook,
} from './config/hot-apply-assembly';
import { visionSurfaceOf } from './config/vision-settings';
import { createConfigAttachmentLister } from './data/attachments-list';
import { expandHome, resolveDataDir } from './data/data-paths';
import { resolveAgentCwd } from './data/path-resolution';
import { setToolPolicy } from './data/permission-store';
import { REFS_NOTICE_HOOK } from './data/refs-notice-hook';
import {
  applyFederationOptions,
  type FederationRuntimeOptions,
  federationOptionsFingerprint,
  resolveFederationOptions,
} from './federation/federation-config';
import { createFederationPairingPort } from './federation/federation-pairing';
import { loadFederationPeerSecrets } from './federation/federation-secrets';
import {
  renderGatewayBanner,
  renderGatewayBannerOneLine,
  wantsBoxBanner,
} from './gateway/gateway-banner';
import { createGatewayConfigSet } from './gateway/gateway-config-control';
import {
  createGatewayReloadRunner,
  type GatewayReconfigureTarget,
  type GatewayReloadApplier,
  stableValue,
} from './gateway/gateway-reload-wiring';
import { buildGatewayControlPlane } from './gateway/gateway-wiring';
import type { GatewayInstanceLock } from './gateway/instance-lock';
import { ensureInteractionsDir, resolveInteractionsDir } from './gateway/interactions-dir';
import { collectGatewayState, DEFAULT_GATEWAY_INSTANCE, GATEWAY_DAEMON_ENV } from './gateway/pid';
import { resolveGatewayAuth } from './gateway/serve-auth';
import { checkTlsFiles, resolveServeOptions } from './gateway/serve-config';
import { shutdownServeStack } from './gateway/shutdown-sequence';
import { resolveGatewayToken } from './gateway/transport-factory';
import {
  ensureWebDist,
  explicitWebDistDir,
  interruptWebBuild,
  resolveWebDistDir,
  webDistWarning,
} from './gateway/web-dist';
import { readHubNodeTrustedOrigins } from './hub/node-state';
import { type StartedHubNodeOutbound, startHubNodeOutbound } from './hub/outbound-wiring';
import { applyLocale, resolveLocale, setLocale, t } from './i18n';
import { type MockScenarioName, resolveMockScenario } from './mock/scenarios';
import { abnormalExitCardText } from './node/node-resume';
// 0.56：派生 token（root-secret → HKDF；显式配置永远优先）。
import { effectiveNodeToken } from './node/token-derive';
import { createCliLogger, diffLogOptions, resolveLogOptions } from './observability/logging';
import {
  flushStartupTiming,
  markStartup,
  noteStartup,
  timeStartup,
} from './observability/startup-timing';
import {
  buildPluginConfigMap,
  declarativePluginEntries,
  factoryPluginDisplayEnabled,
  pluginEntryEnabled,
  setPluginConfigValue,
} from './plugin/plugin-config';
import {
  activateStartupPlugins,
  createPluginHostManager,
  createPluginReloader,
  type PluginReloader,
  pluginSettingsFor,
} from './plugin/plugin-host-assembly';
import { derivePluginLifecycle, type PluginLifecycle } from './plugin/plugin-lifecycle';
import { FACTORY_PLUGINS } from './plugin/plugin-loader';
import { type PluginWatchHandle, startPluginWatch } from './plugin/plugin-watch';
import { createRunControl } from './run/run-control';
import { type BootstrapResult, bootstrap } from './runtime/bootstrap';
import { hasBootRegistryKey } from './runtime/model-registry-wiring';
import { installProcessErrorHandlers } from './runtime/process-handlers';
import { createRuntimeNoticeBus } from './runtime/runtime-notice';
import { RUNTIME_NOTICE_HOOK } from './runtime/runtime-notice-hook';
import { normalizeBridgeDeny } from './runtime/vessel-meta';
import { createContextUsageSource } from './session/context-usage';
import { createImageDeliverySource } from './session/image-delivery';
import { createSessionEventsSource } from './session/session-events';
import {
  reconcileStaleSessions,
  type SessionLivenessContext,
  withLivenessRepair,
} from './session/session-liveness';
import { resolveContinueSessionId, resumeSession, runSessionList } from './session/session-resume';
import { createSystemContextSource } from './session/system-context';
// 0.54 B1 末块：实时尾随端口（发布点扇出 → serve 的时间线 epoch）。
// 0.54 C：`events.list` 的按 run 读端口（同一模块）。
import { createTimelineRunEventsPort, timelineTailPort } from './session/timeline-dual-write';
import { isAddressInUse } from './shared/port-in-use';
import { readPackageVersion } from './shared/version';
import { syncBasicToolsEngineWiring, syncCallbackToolsEngineWiring } from './tools-engine/wiring';
import { scheduleUpdateCheck } from './update/background';
import { type GatewayUpdateCheckHandle, startGatewayUpdateCheck } from './update/gateway-check';

/**
 * 由专用装配路径管理的工厂式插件：tools applier 不能把它们当普通插件装
 * （MCP 建连 / evals 报告 / feishu 渠道 / engine-client 各有自己的 applier 或启动面）。
 * 唯一真源 = plugin-loader 的 FACTORY_PLUGINS（不再维护第二份名单）。
 */
const MCP_FACTORY_PLUGINS: ReadonlySet<string> = FACTORY_PLUGINS;

/**
 * Web 控制台静态目录（legacy `--serve` 托管面）：
 * `gateway.web_dist` config > `VESSEL_STATIC_DIR` env > 仓库内 `apps/web/dist`
 * （q-config-priority 用户裁定#2；解析共用 `gateway/web-dist.ts`）。
 * 显式目录原样返回（存在性由宿主判）；默认目录不存在时不传（不托管静态站点）。
 */
function resolveStaticDir(config?: VesselConfig): string | undefined {
  const explicit = explicitWebDistDir(config);
  if (explicit !== undefined) return explicit;
  const dist = resolveWebDistDir();
  return existsSync(dist) ? dist : undefined;
}

/**
 * 0.50：合并平台 spawn 注入的 Origin（内部 env 契约，不是用户配置）与
 * `node.allowed_origins`。注入值只接受合法 http(s) origin；解析失败时回落到
 * 用户配置，避免内部 env 污染让 node 启动失败。
 *
 * 0.61：`derived` 是 hub 注册表派生的来源集（loopback ∪ 已证明本机的私网）。
 * 缺省 `undefined` ⇒ 与今天逐字一致；传入时同样走 `normalizeAllowedOrigins`，
 * 非法条目整批回落到 `configured ∪ injected`（不因为一条坏 origin 就少放行别的）。
 */
function resolveGatewayAllowedOrigins(
  configured: readonly string[] | undefined,
  injected: string | undefined,
  derived?: readonly string[] | undefined,
): string[] {
  const base = configured !== undefined ? [...configured] : [];
  const derivedOrigins = derived !== undefined ? [...derived] : [];
  const injectedOrigins: string[] = [];
  if (injected !== undefined && injected.trim() !== '') {
    injectedOrigins.push(
      ...injected
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== ''),
    );
  }
  if (derivedOrigins.length === 0 && injectedOrigins.length === 0) return base;
  try {
    return normalizeAllowedOrigins([...base, ...injectedOrigins, ...derivedOrigins]);
  } catch {
    // 派生集坏了不能连累注入值；注入值也坏了就退回用户配置。
    try {
      return normalizeAllowedOrigins([...base, ...injectedOrigins]);
    } catch {
      return base;
    }
  }
}

/**
 * --serve 启动 banner：对齐 box，含 gateway + 控制台提示。
 * 不打印任何 token（含前缀），也不在 URL 中拼接 token。
 */
/**
 * 进入 Ink REPL（**按需加载**，0.57）。
 *
 * 为什么不在模块顶部 `import`：`ink-repl.tsx` 的传递闭包是 React + ink + 十几个组件。
 * 它只有「人类真的坐在终端里聊天」这一条路径需要；`node start`、`gateway start`、
 * `--run`、`--serve` 全都是无界面的，却因为一条静态 import 白付这笔启动费。
 * 这不是「把工作推后装作变快」——那些模式下这份代码**永远不会被执行**。
 */
async function startInkRepl(ctx: BootstrapResult['ctx']): Promise<void> {
  const { startInkRepl: enter } = await import('../packages/tui/src/repl/ink-repl');
  await enter(ctx);
}

// 启动分期第一段：模块图求值完、第一条语句即将执行。
// 这一段 = 解释器启动 + 全部 import 的传递闭包求值（`performance.now()` 是进程启动
// 以来的毫秒数，所以第一个语句读到多大的值，就是那件事花了多久）。
markStartup('bun');

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

// 0.48 M2：插件 CLI 命名空间预解析（`vessel <plugin> ...`）。内置命令优先：
// 首 token 是内置命令 / flag / 不是已发现的插件时，原样回落到 parseArgs。
// 它在首 token 是内置命令或 flag 时立即返回，因此下面的 help 早退仍然零 IO。
const pluginCli = await runPluginCliCommand(process.argv.slice(2));
if (pluginCli.handled) process.exit(pluginCli.exitCode);
markStartup('plugin-cli');

// 按位置 help：`vessel <cmd...> -h` / `vessel help <cmd...>`。
// 必须早于 parseArgs —— `-h` 在任何位置（含跟在 flag 后面）都先于参数校验生效。
// 全局总览与命令页都住在 src/cli-help.ts（一份声明式规格同时喂 help 与错误提示），
// 只读静态表，不加载 config / gateway / 网络。
const helpPlan = planCliHelp(process.argv.slice(2));
if (helpPlan !== null) {
  if (helpPlan.stdout !== '') console.log(helpPlan.stdout);
  if (helpPlan.stderr !== '') console.error(helpPlan.stderr);
  process.exit(helpPlan.exitCode);
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  // 用法/解析错误统一 exit 2（Addendum A §6），与运行期失败（exit 1）区分；
  // 提示由同一份 help 规格生成，指向用户刚敲的那条命令。
  console.error(renderUsageError(process.argv.slice(2), parsed.error));
  process.exit(2);
}
const args = parsed.args;
markStartup('args');
// 0.15: one-shot commands call loadConfig() without cliOverrides; mirror the
// explicit --data-dir into the env layer so they resolve the same data root.
// The main bootstrap path still passes it through buildCliConfigOverrides().
// q-config-priority（用户裁定#3）：--data-dir 是 CLI 级显式权威。镜像走 env，但
// 「显式 config > env」责任链下不得被用户配置 data_dir 压过 —— 伴生标记让 loader
// 把它移回 CLI 层；子进程继承标记，整条启动链（含热重载）口径一致。
if (args.dataDirArg !== null) {
  process.env.VESSEL_DATA_DIR = args.dataDirArg;
  process.env[DATA_DIR_CLI_MARKER_ENV] = '1';
}
// 0.56.1：`--user-config <path>` 只替换**用户层**配置路径。落到 env 是为了让
// 一次性命令与它 spawn 的 daemon / node / hub 子进程看到同一个用户层
// （否则子进程会去读真实 `~/.vessel/config.yaml`，「隔离开销」白做）。
if (args.userConfigArg !== null) process.env.VESSEL_USER_CONFIG = args.userConfigArg;
// 显式给了用户配置却读不到 → 立刻报错退出（解析层就拦住）。
// 放到这里而不是只靠 loader：`gateway list` 这类命令根本不加载配置，若只靠 loader
// 校验，打错的路径会被静默忽略 —— 那正是「以为验了隔离配置」的假绿来源。
if (args.userConfigArg !== null) {
  const userConfigPath = path.resolve(expandHome(args.userConfigArg));
  if (!existsSync(userConfigPath)) {
    console.error(
      `user config not found: ${userConfigPath}\n` +
        'It was given explicitly (--user-config), so it must exist: refusing to fall back ' +
        'to ~/.vessel/config.yaml. Create the file (an empty one is fine: {}) or drop the flag.',
    );
    process.exit(2);
  }
}
// 0.49 G3a：`node start --config <path>` 的配置路径；仅为 standalone node 生效，
// 不改全局配置发现规则。
const nodeConfigPath =
  args.node?.kind === 'start' && args.node.configPath !== undefined
    ? path.resolve(expandHome(args.node.configPath))
    : undefined;
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
// help 已在入口按位置解析并早退；这里只是 `args.help` 分支的兜底（全局总览）。
if (args.help) {
  console.log(renderGlobalHelp());
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
// restart 保持运行模式：未显式 --daemon 时，按目标实例 pid record 的 daemon
// 标记决定前台/后台。必须在注册表与前台分支之前解析（两条路由都按
// `daemon === false` 分流）；旧记录无标记 / 无运行实例 → 前台（历史行为）。
{
  const gatewayCommand = args.gateway;
  if (
    gatewayCommand !== null &&
    gatewayCommand.kind === 'restart' &&
    gatewayCommand.daemon === undefined
  ) {
    gatewayCommand.daemon = await resolveRestartDaemonMode(gatewayCommand);
  }
}
// 一次性命令注册表：按注册顺序命中第一个，执行后直接退出。
// 命中后不进入 bootstrap / REPL / serve / headless 主流程。
// dynamic import：--help / --version 早退路径不再加载注册表（S4 §2.3）。
{
  const { applyCommandLocale, matchCommand } = await import('./cli/registry');
  // 0.49 G3a：`gateway nodes ...` 是 registry 管理命令，不进 gateway 一次性分发
  // （后者不承载平台写语义）。
  const gatewayNodes = args.gatewayNodes;
  if (gatewayNodes !== null) {
    await applyCommandLocale();
    const { runGatewayNodesCommand } = await import('./cli/commands/gateway/gateway-nodes-command');
    process.exit(await runGatewayNodesCommand(gatewayNodes));
  }
  const command = matchCommand(args);
  if (command) {
    await applyCommandLocale();
    process.exit((await command.run(args, { useMock })) ?? 0);
  }
}
// 0.49 G3b（CONTRACT §4.1）：非 legacy 的 `gateway start/restart` 前台只跑
// **平台进程** —— 平台监听 + 每节点子进程监督；不进入 bootstrap / serve 管线，
// 因此不加载 node runtime / tenant 锁 / plugin host / node 监听。
// 用户裁定 #1（start 即退）：`gateway start` 缺省 detach，父进程由注册表处理
// （spawn 本分支后打印启动信息即退出）；只有显式 `--foreground` 才留在前台。
if (
  args.gateway !== null &&
  isForegroundGatewayCommand(args.gateway) &&
  process.env.VESSEL_LEGACY_SERVE !== '1'
) {
  const { applyCommandLocale } = await import('./cli/registry');
  await applyCommandLocale();
  // 启动诊断（0.50）：拆分路径**也**托管 dist（静态资源由平台 gateway 同源下发），
  // 所以产物缺失/过期时要就地自修复，而不是把「缺失 + 命令教学」丢给用户。
  //
  // 两种等待语义（见 `ensureWebDist` 的 `waitWhenMissing`）：过期但产物还在 →
  // 后台重建、立刻开始服务（静态资源每请求读盘，建好自然生效）；**完全缺失** →
  // 等它建完，因为本函数下面的 gateway 在 `index.html` 缺失时直接失败退出
  // （`runPlatformGatewayForeground` 的 fail-fast），没有「先起来再修」这条路。
  //
  // 只在仓库内默认目录生效：显式 `gateway.web_dist` / `VESSEL_STATIC_DIR` 指向的外部
  // 产物不归我们管；`VESSEL_NO_WEB_AUTOBUILD=1` 关掉自修复；构建失败只告警、不改退出码。
  // q-config-priority（用户裁定#2）：先读一次配置拿 `gateway.web_dist` —— 金丝雀舰队
  // 配置指向舰队 dist，无论从哪个 cwd 启动都宿那份。这里加载失败不报（前台入口
  // runPlatformGatewayForeground 会同口径再加载并统一报错），只回落 env/默认解析。
  let platformWebDistConfig: VesselConfig | undefined;
  try {
    platformWebDistConfig = (await loadConfig()).config;
  } catch {
    // 配置错误由前台入口统一报告
  }
  const platformExplicitDist = explicitWebDistDir(platformWebDistConfig);
  await ensureWebDist({
    ...(platformExplicitDist !== undefined ? { staticDir: platformExplicitDist } : {}),
    waitWhenMissing: true,
  });
  const { runPlatformGatewayForeground } = await import('./cli/commands/gateway/gateway-command');
  process.exit(
    await runPlatformGatewayForeground({
      command: args.gateway,
      staticDir: resolveWebDistDir(platformWebDistConfig),
      ...(args.dataDirArg !== null ? { dataDirOverride: args.dataDirArg } : {}),
    }),
  );
}
// 0.12：legacy `--serve` / `VESSEL_LEGACY_SERVE=1` 的 `gateway start/restart`
// 仍走现有 `--serve` 管线。`--daemon` 及其它 gateway 子命令已由注册表处理。
const foregroundGateway = args.gateway !== null && isForegroundGatewayCommand(args.gateway);
let foregroundGatewayLock: GatewayInstanceLock | undefined;
let foregroundGatewayInstance: string = DEFAULT_GATEWAY_INSTANCE;
/** 0.49 G1：`node start` 前台 = 只起 Node API 监听。 */
let nodeOnlyMode = false;

if (foregroundGateway && args.gateway !== null) {
  const gatewayArgs = args.gateway;
  let targetInstance =
    gatewayArgs.kind === 'start' || gatewayArgs.kind === 'restart'
      ? gatewayArgs.instance
      : undefined;
  let targetPort = gatewayArgs.kind === 'start' ? gatewayArgs.port : undefined;
  let targetHost = gatewayArgs.kind === 'start' ? gatewayArgs.host : undefined;

  if (gatewayArgs.kind === 'restart') {
    // 停前快照：保留 instance；有 PID 记录时原样保留 platform port/host（port 0 也保持）。
    const { config } = await loadConfig();
    const dataDir = resolveDataDir(config);
    const token = resolveGatewayToken(config);
    const entries = (
      await collectGatewayState(dataDir, { ...(token !== undefined ? { token } : {}) })
    ).entries;
    const targets = await resolveGatewayTargets(dataDir, gatewayArgs, { entries });
    const previous = targets.ok ? targets.entries[0] : undefined;
    if (previous !== undefined) {
      targetInstance = previous.instance;
      if (previous.record !== undefined) {
        targetPort = previous.record.port;
        targetHost = previous.record.host;
      }
    }
    const stopCode = await stopGateway({
      selector: gatewayArgs,
      entries,
      ...(gatewayArgs.force === true ? { force: true } : {}),
    });
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

  // 仅剩迁移期 legacy 路径（CONTRACT §9）：`VESSEL_LEGACY_SERVE=1` 强制旧组合
  // 进程（单监听、node 宿主 UI）。`--port/--host` 仍按旧语义指向该 node 监听。
  // 非 legacy 的 `gateway start/restart` 已在上面平台专用分支处理。
  args.servePort = targetPort ?? DEFAULT_SERVE_PORT;
  args.servePortExplicit = gatewayArgs.kind === 'start' ? gatewayArgs.port !== undefined : true;
  if (targetHost !== undefined) args.serveHost = targetHost;
} else if (args.node !== null && isForegroundNodeCommand(args.node)) {
  nodeOnlyMode = true;
  const { config: nodeConfig } = await loadConfig(
    nodeConfigPath !== undefined ? { configPath: nodeConfigPath } : {},
  );
  // 0.49 G1（1 裁定）：独立 node 模式同样拒绝 0 端口。
  const portError = printSplitModePortError(nodeConfig, 'node', (line) =>
    console.error(ui.err(line)),
  );
  if (portError !== null) process.exit(portError);
  const prepared = await prepareForegroundGatewayStart({
    instance: DEFAULT_GATEWAY_INSTANCE,
    config: nodeConfig,
  });
  if (!prepared.ok) {
    console.error(ui.err(prepared.error));
    process.exit(1);
  }
  foregroundGatewayLock = prepared.lock;
  foregroundGatewayInstance = prepared.instance;
  process.once('exit', () => foregroundGatewayLock?.releaseSync());
  args.servePort = resolveGatewayNodePorts(nodeConfig, 'gateway').nodePort;
  args.servePortExplicit = true;
  // `node start` 在进入 bootstrap 之前先读一遍配置（端口 / 实例锁）：这一笔算在
  // `cli.config` 里，bootstrap 里的那次另算 `config`（两次读是既有行为，不合并）。
  markStartup('cli.config');
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
// legacy `--serve` 启动诊断：静态产物缺失/过期时自修复（`VESSEL_NO_WEB_AUTOBUILD=1`
// 关闭）。语义和平台 gateway 分支一致：过期但产物还在 → 后台重建（不拖慢启动；
// 静态资源每请求读盘，建好即生效）；**完全缺失** → 等它建完，否则本进程的
// `resolveStaticDir()` 解析不到 dist，整个生命周期都不托管 Web 控制台。
// 0.50 起拆分路径（`gateway start` / `node start`）也在启动诊断里自修复；`node start`
// 本身不宿 WebUI（staticDir 只在 Gateway 解析）。
if (args.servePort !== null && !nodeOnlyMode) {
  // q-config-priority（用户裁定#2）：legacy 托管面同样尊重 `gateway.web_dist`
  // （显式目录不触发自动构建）；加载失败不报，bootstrap 会统一报告配置错误。
  let serveWebDistConfig: VesselConfig | undefined;
  try {
    serveWebDistConfig = (await loadConfig()).config;
  } catch {
    // 配置错误由 bootstrap 统一报告
  }
  const serveExplicitDist = explicitWebDistDir(serveWebDistConfig);
  const status = await ensureWebDist({
    ...(serveExplicitDist !== undefined ? { staticDir: serveExplicitDist } : {}),
    waitWhenMissing: true,
  });
  // 自修复能接管时 webDistWarning 返回 null（`web.build.*` 事件已经说过），只留真正修不了的情况。
  const warning = webDistWarning(status);
  if (warning) console.error(ui.warn(warning));
}
// `-r/--resume` 无 id：列出当前 tenant 的会话（connect 模式无法本地列出）。
if (args.resumeArg === '') {
  if (args.connectArg !== null || (process.env.VESSEL_CONNECT ?? '').trim() !== '') {
    console.error(t('cli.resumeNeedsLocalStore'));
    process.exit(2);
  }
  process.exit(await runSessionList({}));
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
    const resolved = await resolveContinueSessionId({});
    if (!resolved.ok) {
      console.error(resolved.error);
      process.exit(1);
    }
    resolvedSessionId = resolved.sessionId;
  }
} else if (args.resumeArg !== null && args.resumeArg !== '') {
  // 本地与 connect 都记录 resume 意图；本地由 bootstrap 首轮显式走
  // `resumeSession`（Q5），connect 由远端 `runs.start` 处理（不新增 RPC）。
  resumeSessionId = args.resumeArg;
  if (!connectConfigured) {
    const checked = await resumeSession(args.resumeArg, {});
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
// 0.15 / 0.33：交互 REPL、gateway/serve、headless 都注册 ask。
// headless 没有进程内应答者：由 headless runner 落盘后中断 run（可 resume），
// 不再用「不注册」把它藏起来。`ui.askUser: false` 仍在 bootstrap / tenant
// factory 内按配置关闭。
const askUserClient = interactive || (serveRequested && !headless) || headless;

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
const initialResult = await timeStartup(
  'bootstrap',
  bootstrap({
    useMock,
    mockScenario,
    ...(demoRequested ? { dataDirSubdir: 'demo' } : {}),
    sessionId: resolvedSessionId,
    headless,
    interactive,
    registerAskUser: askUserClient,
    cliOverrides,
    ...(nodeConfigPath !== undefined ? { configPath: nodeConfigPath } : {}),
    ...(continueLatest ? { continueLatest: true } : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    ...(args.connectArg !== null
      ? { connect: args.connectArg }
      : process.env.VESSEL_CONNECT !== undefined
        ? { connect: process.env.VESSEL_CONNECT }
        : {}),
    // `--feishu` 的配置错误按 Addendum C/D 使用 exit 2；0.3 入口保持 1。
    configErrorExitCode: args.feishu ? 2 : 1,
    logger,
  }),
);
const { config } = initialResult;
markStartup('agent');
activeResult = initialResult;
activeEvents = initialResult.ctx.events;
// 完整 locale 优先级：VESSEL_LANG > config.ui.language > LANG > LC_ALL > zh-CN
applyLocale((config.ui as { language?: string } | undefined)?.language);

// 首启向导（仅真正交互的 REPL；serve-only / 管道无 TTY 时已由 bootstrap 快速失败）
// registry 注册凭证已配置时同样不触向导（与 bootstrap 启动闸同口径）。
if (
  !useMock &&
  interactive &&
  !resolveEffectiveApiKey(config) &&
  !hasBootRegistryKey(config, resolveDataDir(config))
) {
  // 首启分支内 dynamic import：常规启动不加载 wizard（S4 §2.3）。
  const { runSetupWizard } = await import('../packages/tui/src/wizard/setup-wizard');
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
      cliOverrides,
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
  /** 0.43：体验型 plugin 宿主（gateway 启动时构造；关闭时 stopAll）。 */
  let pluginHostManager: PluginHostManager | undefined;
  /** 0.43 E3：`plugins.reload` 的 rescan + manager.reload 实现。 */
  let pluginsReload: (() => Promise<PluginReloadResult>) | undefined;
  /** q-plugin-lifecycle §6.2 R2：in-process 待重启追踪（pendingRestart 汇聚源之一）。 */
  let pluginReloader: PluginReloader | undefined;
  /** 0.43：项目/用户插件目录与 config 变更监听（关闭时停止）。 */
  let pluginWatch: PluginWatchHandle | undefined;
  /**
   * A2：headless 不在这里直接 `process.exit`，否则会跳过末尾的
   * gateway / transport / shutdown 清理（`--serve --run` 会残留监听与
   * session 锁）。只记录退出码，统一走公共清理后再退出。
   */
  let headlessExitCode: number | undefined;

  // 0.6 A4：connect 模式下展示远端 node。headless 写 stderr，避免污染 stdout。
  if (result.remote) {
    const node = result.remote.nodeId ?? 'unknown';
    const line = t('cli.remoteGateway', {
      node,
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
    // 0.33 A：恢复后的 run 若再提问，同样落盘并挂起（不无限等待）。
    const resumeAskController = headless ? new AbortController() : undefined;
    const resumeAskControl =
      resumeAskController !== undefined
        ? installHeadlessAskSuspend(
            ctx.events,
            {
              dir: resolveInteractionsDir(resolveDataDir(config), foregroundGatewayInstance),
              tenantId: result.tenantId,
            },
            resumeAskController,
          )
        : undefined;
    try {
      const outcome = await result.resumeRun(
        resumeRunId,
        resumeAskController !== undefined ? { signal: resumeAskController.signal } : undefined,
      );
      console.log(outcome.result);
      ctx.currentSessionId = outcome.sessionId;
      ctx.onSessionChange(outcome.sessionId);
      if (entersRepl) await startInkRepl(ctx);
    } catch (error) {
      await resumeAskControl?.flush();
      const suspendedAsk = resumeAskControl?.suspended() ? resumeAskControl.last() : undefined;
      if (suspendedAsk !== undefined) {
        printSuspendedAsk(
          suspendedAsk,
          resolveInteractionsDir(resolveDataDir(config), foregroundGatewayInstance),
        );
        exitCode = HEADLESS_ASK_SUSPENDED_EXIT_CODE;
      } else {
        console.error(formatResumeError(error));
        exitCode = 1;
      }
    } finally {
      resumeAskControl?.unsubscribe();
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
  /** 0.18：事件流的唯一扇入面（shared 流已删除）。 */
  let eventHub: TenantEventHub | undefined;
  if (servePort !== null) {
    // CLI flag 已由 loader 合并进 config.node；这里只做补全与校验。
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
    // 0.56：**派生 token** 兜底 —— 用户一个 token 都不用写。显式配置永远优先；
    // 只有派生值时 `resolveGatewayAuth` 仍保留回环匿名（不制造新的锁死形状）。
    const nodeTokenResolution = effectiveNodeToken({
      config,
      dataDir: resolveDataDir(config),
      nodeId: result.nodeId,
      env: process.env,
    });
    if (!nodeTokenResolution.ok) {
      console.error(`${nodeTokenResolution.code}: ${nodeTokenResolution.message}`);
      await result.shutdown();
      process.exit(1);
    }
    const nodeToken = nodeTokenResolution.value;
    const authResult = resolveGatewayAuth(config, {
      hostname: resolved.options.hostname,
      allowRemote: resolved.options.allowRemote,
      // F1/SD-2 链B：injected（平台 spawn 注入的 VESSEL_NODE_TOKEN）与 derived 一样
      // 注册为**追加**鉴权候选。注入值就是 gateway 代算的该 node 生效 token，停止方
      // （gateway stop / node stop）发的正是它；只认 derived 时 spawned node 只认匿名，
      // stop 发派生值必 401 → 静默强杀。与 derived 同口径：不进 `configured` 计数，
      // 回环匿名语义不变（显式配置仍然优先并关闭匿名）。
      ...((nodeToken.source === 'derived' || nodeToken.source === 'injected') &&
      nodeToken.token !== undefined
        ? {
            derivedToken: nodeToken.token,
            ...(nodeToken.detail !== undefined ? { derivedDetail: nodeToken.detail } : {}),
          }
        : {}),
    });
    if (!authResult.ok) {
      console.error(authResult.error);
      await result.shutdown();
      process.exit(1);
    }

    // 远程监听：现在有**稳定的**派生 token，不再是一重启就变的临时值。
    const remote = !isLoopbackHostname(resolved.options.hostname);
    if (remote && resolved.options.allowRemote && nodeToken.source !== 'explicit') {
      console.warn(
        '⚠ Remote listening with a derived gateway token (stable, from <dataDir>/root-secret). ' +
          'Use "vessel token show --purpose node --node <id>" to read it, ' +
          'or set node.token_env for an explicit value.',
      );
    }

    // T3 C1：唯一执行面 = bootstrap 构造的 bundle；缺失是启动错误，
    // 不得回退到任何工厂或重新构造。
    const gatewayBundle = result.bundle;
    if (gatewayBundle === undefined) {
      console.error('Gateway execution plane is not initialized.');
      await result.shutdown();
      process.exit(1);
    }
    // P1-w2d：已登记 in-process 能力插件的 plugins.list 基础行（provider 类不在
    // bundle.plugins 里）；manager 创建后赋值，bundlePluginEntries 按 name 去重并入。
    let inProcessPluginRows: Array<{ name: string; enabled: boolean }> = [];

    // 0.18：单流是唯一事件面；live hub 与 trace 同源（bundle.redactor 已组合 ext）。
    eventHub = createGatewayEventHub({
      stream: gatewayBundle.runtimeEvents,
      redactor: gatewayBundle.redactor,
    });

    if (eventHub === undefined) {
      console.error('Gateway event hub is not initialized.');
      await result.shutdown();
      process.exit(1);
    }

    const dataDir = resolveDataDir(config);
    // 0.43：体验型 plugin 宿主。v1 只用 default tenant 的配置 / settings；
    // 只预激活声明 `onStartup` / `*` 的 child plugin；`onPage:` / `onCommand:`
    // 等首次页面 / RPC 访问时由 serve 的 ensureActive 懒激活。
    if (result.bundle !== undefined) {
      pluginHostManager = createPluginHostManager({
        loader: result.bundle.pluginLoader,
        config: liveConfig,
        // 0.48 M4：expose 授权随 config watcher / reload 重新读取。
        getConfig: () => liveConfig,
        dataDir,
        logger,
        // q-plugin-lifecycle §6.5 P2：settings 读 liveConfig（拆 C4 启动钉死）。
        // 子进程重激活时 spawn 期 env 注入新值；settings 值已进 reload 指纹（descriptor.settings），
        // 改 settings → 指纹变 → manager.reload 重激活 child，无需重启 gateway。
        settingsFor: (id) => pluginSettingsFor(liveConfig, id),
      });
      // P1-w2d（D3）：install 后登记 in-process 能力插件的 RPC / 贡献面（w1a 接缝）。
      inProcessPluginRows = gatewayBundle.registerInProcessPlugins(pluginHostManager, liveConfig);
      const activated = await timeStartup(
        'plugin.activate',
        activateStartupPlugins(pluginHostManager, {
          loader: result.bundle.pluginLoader,
          config: liveConfig,
          tenantId: result.tenantId,
          logger,
        }),
      );
      if (activated.length > 0) {
        logger.info('plugin.activated', {
          plugins: activated,
          tenant: result.tenantId,
        });
        noteStartup('plugin.activated', activated.length);
      }

      // 0.43 E3：`plugins.reload` = 重新读配置 → rescan → manager.reload。
      // 先 reloadVesselConfig 让 config.yaml 的 enable/disable 立即进入 liveConfig。
      const reloader = createPluginReloader({
        loader: result.bundle.pluginLoader,
        manager: pluginHostManager,
        getConfig: () => liveConfig,
      });
      pluginReloader = reloader;
      pluginsReload = async (): Promise<PluginReloadResult> => {
        await reloadVesselConfig();
        return reloader.reload();
      };

      // 目录 / config 变更 → 300ms 去抖后执行同一 reload（gateway 会广播 plugin.changed）。
      pluginWatch = startPluginWatch({
        onChange: ({ paths }) => {
          const reload = pluginsReload;
          if (reload === undefined) return;
          void reload().catch((error) => {
            logger.warn('plugin.reload.failed', {
              error: error instanceof Error ? error.message : String(error),
              paths,
            });
          });
        },
      });
    }
    // 0.18：硬崩后 session 会永久停在 running（事件无终态）。启动 sweep + 读时兜底共用
    // 同一修复函数；锁活着 → 跳过，绝不误杀其它实例的活 run / resume。
    const livenessContext: SessionLivenessContext = {
      tenantDir: gatewayBundle.tenantPaths.root,
      session: gatewayBundle.session,
      ...(gatewayBundle.eventLog ? { eventLog: gatewayBundle.eventLog } : {}),
      ...(gatewayBundle.runStore ? { runStore: gatewayBundle.runStore } : {}),
      logger,
    };
    const livenessSession = withLivenessRepair(livenessContext.session, livenessContext);
    const sweep = await timeStartup('sweep', reconcileStaleSessions(livenessContext));
    if (sweep.repaired.length > 0 || sweep.errors.length > 0) {
      logger.warn('session liveness sweep', {
        repaired: sweep.repaired.length,
        errors: sweep.errors.length,
      });
    }
    noteStartup('sweep.checked', sweep.checked);
    noteStartup('sweep.repaired', sweep.repaired.length);
    markStartup('sweep');
    // 重启唤醒（runlost-graceful-restart-audit §4.5 / §5.1，补 G1 后半 / G5 / G6 / G7）：
    // 1) sweep 修复过的会话（force/崩溃无标记）发有疤恢复卡——至少「说得清」；
    // 2) 启动 dispatch sweep：重建 noticeDirty + 有界主动投递，有 pending 可直投条目
    //    的成员无需人类消息点火（冷成员特许 spawn，预算/cycle/hardStop 闸原样）。
    // 顺序在 recoverPendingInputs（bootstrap 内）与 liveness sweep 之后：孤儿已重放/held，
    // sweep 只点剩下的队头；失败不阻断启动（条目仍 unread，下次再试）。
    if (result.agent !== undefined) {
      for (const sessionId of sweep.repaired) {
        try {
          await result.agent.service.announceEnvironmentCard(sessionId, abnormalExitCardText());
        } catch (error) {
          logger.warn('session liveness card failed', {
            session_id: sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      try {
        const dispatchSweep = await result.agent.service.startupDispatchSweep();
        if (dispatchSweep.lit > 0) {
          logger.info('agent.inbox.sweep_done', { ...dispatchSweep });
        }
        noteStartup('sweep.dispatched', dispatchSweep.dispatched);
      } catch (error) {
        logger.warn('agent.inbox.sweep_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // 0.15：serve 的 config.set 写回面（对象变量避免对 ConfigGatewayOptionsLike 的
    // 多余属性检查；serve 合入 0.15 后该字段会被正式识别）。
    const gatewayConfigSet = createGatewayConfigSet({
      defaultTenantId: result.tenantId,
      // S5：工作区覆盖层写项目 vessel.yaml（configPaths 与 config.get paths 同源）。
      ...(gatewayBundle.configPaths?.project !== undefined
        ? { projectConfigPath: gatewayBundle.configPaths.project }
        : {}),
    });
    // 写后热应用：config.set 落盘后同步跑一次唯一热应用入口，保证 RPC 返回时
    // config.get 已是最新（单飞行 / 有上界 / 失败只 warn，见该模块契约）。
    const applyWrittenConfig = createWrittenConfigApplier({
      trigger: () => configWatch?.trigger(),
      logger,
    });

    const tenantConfigControl = {
      snapshot: (): ConfigSnapshotLike =>
        buildConfigSnapshot({
          // 单执行面：默认 tenant 读活配置，写回 / 热应用后 `config.get` 立即反映新策略。
          config: sanitizeConfigForSnapshot(liveConfig),
          sources: gatewayBundle.configSources,
          paths: gatewayBundle.configPaths ?? { user: '', project: 'vessel.yaml' },
          tenantId: result.tenantId,
          tenantOverlayKeys: gatewayBundle.tenantOverlayKeys,
        }) as unknown as ConfigSnapshotLike,
      set: async (request: { tenantId: string; key: string; value: string | boolean }) => {
        await gatewayConfigSet(request);
        await applyWrittenConfig();
      },
    };
    // ── 热应用（CONTRACT-hot-apply）────────────────
    /**
     * 重新读取配置；校验不通过就抛错（调用方据此**不应用**）。
     * 与 `gateway.reload` 的 `reloadConfig` 同源，避免两条读数口径。
     */
    const reloadVesselConfig = async (): Promise<VesselConfig> => {
      const loaded = await loadConfig(
        nodeConfigPath !== undefined ? { configPath: nodeConfigPath } : {},
      );
      if (loaded.validation.errors.length > 0) {
        throw new Error(
          loaded.validation.errors.map((error) => `${error.path}: ${error.message}`).join('; '),
        );
      }
      liveConfig = loaded.config;
      // P2：同步 bootstrap 活配置引用 ⇒ 总线 hook / EU envCadence / 成员 spawn 的
      // env_injection 闭包下一请求读到新值（热加载，无需重注册 / 重启）。
      result.liveConfigRef.current = loaded.config;
      return loaded.config;
    };
    // 事件出口：notice 同时进事件流（Web/TUI）与模型上下文（BeforeLlm hook）。
    // 总线唯一的构造点是 bootstrap（agent 装配时建，hook 也注册在那里）：这里复用同一个
    // 实例。自己再建一个会因为 hook 注册名相同被跳过，配置热应用的 notice 就再也进不了
    // 模型上下文。`result.notice` 缺省（无 agent 装配的入口）时才就地新建。
    hotApplyConfigPath = getUserConfigPath();
    const noticeBus =
      result.notice ??
      createRuntimeNoticeBus({
        events: result.bundle?.runtimeEvents ?? ctx.events,
        tenantId: result.tenantId,
      });
    registerRuntimeNoticeHook(ctx.pluginHost, noticeBus, undefined, () => liveConfig.envInjection);
    // 0.52：附件引用的环境信息行（同一 host、同一 BeforeLlm 阶段）。
    // 0.56 P1：视觉面探针——有 `provider.vision` 且没被 kill switch 关时，尾注改说
    // 「图已随本条消息附上，不要再读」（否则模型会把图再读一遍 = 双倍花费）。
    // 闭包每轮求值一次，读的是 `liveConfig`：热应用换掉 `vision.disabled` 后立刻生效。
    registerRefsNoticeHook(ctx.pluginHost, {
      vision: () =>
        visionSurfaceOf({ config: liveConfig, backend: result.bundle?.provider?.vision }),
    });

    /** 存活 runtime 的集合：单执行面的 owner（bundle / ctx）。 */
    const liveTargets = (): PermissionApplyTarget[] =>
      collectPermissionTargets({
        runtime: ctx.runtime,
        bundleRuntime: gatewayBundle.runtime,
      });

    const permissionState: PermissionApplierState = {
      current: permissionConfigFor(config, headless),
    };
    // 启动时**插件装配实际产出**：tools applier 只管辖「插件工具 ∪ 热装配过的插件工具」。
    // 入口注册的 agent / ask 与 MCP 工具（toolSource 非 null）不在管辖域内，
    // 否则一次 reload 会把它们判成 removed（D1）。
    const managedPluginTools = new Set(pluginManagedToolNames(ctx.pluginHost, result.mcp));
    // q-plugin-lifecycle §6.3：注册面差量管辖域（hook / guardrail / readSideMasker）。
    // hook 排除入口注册的 notice hook（runtime-notice / refs-notice，非插件来源）；
    // guardrail 排除装配层注册的 core vessel-bridge（ISSUE-PL5-1：旁路目标集只含插件
    // 贡献，不排除则每次热应用误删桥）；masker 只来自插件，全量管辖。
    // 与工具面同口径：只增删插件来源的面。
    const managedPluginHooks = new Set(
      ctx.pluginHost
        .getHooks()
        .map((hook) => hook.name)
        .filter((name) => name !== RUNTIME_NOTICE_HOOK && name !== REFS_NOTICE_HOOK),
    );
    const managedPluginGuardrails = new Set(pluginManagedGuardrailNames(ctx.pluginHost));
    const managedPluginMaskers = new Set(
      (ctx.pluginHost.getReadSideMaskers?.() ?? []).map((masker) => masker.name),
    );
    // 当前生效插件实例（启动装配产出）：热应用采纳 fresh 实例 / dispose 旧实例的记账起点。
    // bundle.plugins 即管辖选择集（provider / 工厂不经此路径），dispose 不会误伤结构性插件。
    const livePluginInstances = new Map(
      gatewayBundle.plugins.map((plugin) => [plugin.name, plugin]),
    );
    // 插件安装配置基线（用于识别「定义没变但行为配置变了」）：
    // `computeTargetTools` 每次读到的配置写入 `lastToolsConfigKey`，`targetKey` 读它。
    const pluginConfigKeyOf = (value: VesselConfig): string =>
      JSON.stringify(
        buildPluginConfigMap(
          value.plugins,
          declarativePluginEntries(value),
          undefined,
          undefined,
          value.envInjection,
        ),
      );
    const lastToolsConfigKey: { current?: string } = { current: pluginConfigKeyOf(config) };
    const toolsConfigKey: { value?: string } = { value: lastToolsConfigKey.current };
    // tools-engine P2：computeTargetTools 读到的最新配置（接线与装配同一份 buildPluginConfigMap）。
    let lastReloadedToolsConfig: VesselConfig | undefined;
    // O2：bridge_deny 随 permission applier 热应用（apply 成功才更新，与规则基线同口径）。
    let pendingBridgeDeny: string[] | undefined;

    // S7 热应用：入站 federation 运行时对象（controlPlane.federation，gateway 启动后
    // 赋值）。入站路由逐请求读它；config scope 的 applyFederation 原地更新。
    let liveFederationOptions: FederationRuntimeOptions | undefined;

    /**
     * q-plugin-lifecycle §6.2 R1 读写联动：按 liveConfig 同步已登记 in-process 插件的
     * 登记态（enabled + RPC / 贡献面）。manager.enable/disable 是现成实现（此前零生产
     * 调用方），这里接线 —— 热 disable → 翻 enabled + 注销 RPC + 贡献面收口；enable 反之。
     * 读面（bundlePluginEntries）随后读 liveConfig 同口径，四面一致。child 的启停由
     * manager.reload（enabled 进指纹）负责，不在此重复。
     */
    const syncInProcessRegistrationState = async (): Promise<string[]> => {
      const manager = pluginHostManager;
      if (manager === undefined) return [];
      const lines: string[] = [];
      const statusById = new Map(manager.statuses().map((status) => [status.id, status]));
      for (const row of inProcessPluginRows) {
        const desired = pluginEntryEnabled(liveConfig.plugins, row.name);
        const current = statusById.get(row.name)?.enabled;
        if (current === undefined || current === desired) continue;
        if (desired) {
          manager.enable(row.name);
          lines.push(`plugins: ${row.name} enabled`);
        } else {
          await manager.disable(row.name);
          lines.push(`plugins: ${row.name} disabled`);
        }
      }
      return lines;
    };

    const reloadAppliers: Record<string, GatewayReloadApplier> = {
      permission: createPermissionApplier(
        {
          loadPermission: async () => {
            const next = await reloadVesselConfig();
            pendingBridgeDeny = normalizeBridgeDeny(next.permission?.bridgeDeny);
            return permissionConfigFor(next, headless);
          },
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
            // 成员 ExecutionUnit 走 AgentService 的唯一转发入口（没有 agent 时返回 0）。
            if (result.agent !== undefined) {
              applied += await result.agent.service.applyPermissionRules(rules);
            }
            // O2：规则应用成功后同步 bridge_deny 活引用（guardrail 逐调用读，下一调用生效）。
            if (result.toolsEngine !== undefined && pendingBridgeDeny !== undefined) {
              result.toolsEngine.bridgeDeny.current = pendingBridgeDeny;
            }
            pendingBridgeDeny = undefined;
            return applied;
          },
        },
        permissionState,
      ),
      tools: async () => {
        // q-plugin-lifecycle §6.3：全注册面差量（tool / hook / guardrail / readSideMasker
        // 整体增删改 + fresh 实例采纳 / dispose），消除「工具进了但 guardrail 没进」半态。
        const outcome = await applyRegistrations({
          host: ctx.pluginHost,
          // 旁路重建：先在临时 host 上用 cache-busted 新实例算出目标集，再一次性替换真实宿主。
          computeTarget: async () => {
            const next = await reloadVesselConfig();
            lastToolsConfigKey.current = pluginConfigKeyOf(next);
            lastReloadedToolsConfig = next;
            return assemblePluginRegistrations({
              config: next,
              tenantId: result.tenantId,
              loader: gatewayBundle.pluginLoader,
              excludePlugins: MCP_FACTORY_PLUGINS,
              fresh: true,
            });
          },
          managed: {
            tools: managedPluginTools,
            hooks: managedPluginHooks,
            guardrails: managedPluginGuardrails,
            maskers: managedPluginMaskers,
          },
          liveInstances: livePluginInstances,
          // 插件安装配置（basic-tools 的 cwd 等）变了就整体刷新，否则行为不会生效。
          targetKey: () => lastToolsConfigKey.current ?? '',
          previousKey: toolsConfigKey,
        });
        // q-plugin-lifecycle §6.2 R1：工具差量之后同步 in-process 登记态（RPC / 贡献面
        // 随 liveConfig 启停），读面与生效态同源。
        const registrationLines = await syncInProcessRegistrationState();
        // q-plugin-lifecycle §6.2 R3：任何插件生效态变化 → 必有一次 plugin.changed。
        // tools applier 成功后广播（与 plugins.reload / plugins.config.set 同一出口），
        // node 专属 config / 项目 vessel.yaml 路径不再依赖 plugin-watch 间接补。
        gateway?.notifyPluginChanged();
        // tools-engine P2（seams §3.5）：applyTools 之后、refreshTools 之前重接线——
        // 热应用产生新 def 对象 → 重新 wireTool（新指纹覆盖）；移除的工具 unwire；
        // boundary/config 用本次 reload 的安装配置重建（与装配同一份 buildPluginConfigMap）。
        if (result.toolsEngine !== undefined && lastReloadedToolsConfig !== undefined) {
          const next = lastReloadedToolsConfig;
          const configMap = buildPluginConfigMap(
            next.plugins,
            declarativePluginEntries(next),
            resolveAgentCwd(next),
            resolveDataDir(next),
            next.envInjection,
          );
          syncBasicToolsEngineWiring(
            result.toolsEngine.client,
            ctx.pluginHost,
            configMap['basic-tools'],
          );
          // 批次 3：recall / pii_reveal 是插件管辖工具（热应用可能换 def）；ask 入口注册
          // 不被 applier 触碰，sync 幂等 no-op。agent / inbox 不在插件管辖域，无需在此重接。
          syncCallbackToolsEngineWiring(result.toolsEngine.client, ctx.pluginHost);
          // issue-0：push 前把 retain 设为 running 成员仍广告的工具名并集——引擎注册表立即
          // 生效，而 running 成员面延迟到轮边界才刷新；窗口期内引擎须保持这些工具可执行，
          // 否则模型被广告执行不了的工具（engine_tool_not_registered）。
          syncEngineRetain();
          try {
            await result.toolsEngine.client.pushRegistry();
          } catch (error) {
            logger.warn('tools-engine registry push failed after hot apply', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        // 成员 ExecutionUnit 的工具面是 spawn 时快照：owner 宿主更新后在同一具 body 上刷新，
        // 不重建 session / context（有 active run 时由执行内核延迟到轮边界）。
        // 传入应用后的全量工具面（含 agent / ask / MCP），成员侧再按白名单过滤。
        await result.agent?.service.refreshTools?.(ctx.pluginHost.listTools());
        return [...outcome.summaries, ...registrationLines];
      },
    };

    // issue-0：引擎注册表 retain 同步。running 成员的工具面只在轮边界刷新（ADR-054），
    // 窗口期内引擎须保持「活体成员面仍广告的工具」可执行（超集语义）。热应用 push 前设
    // retain（见 tools applier）；每具 body 在轮边界应用 pending 刷新后回调这里重算 retain，
    // 收缩时 push 冲刷已释放工具的移除——引擎注册表与成员工具面在同一轮边界收敛。
    let engineRetain = new Set<string>();
    const syncEngineRetain = (): boolean => {
      const engine = result.toolsEngine;
      if (engine === undefined) return false;
      const retain = result.agent?.service.runningToolNames?.() ?? new Set<string>();
      if (
        retain.size === engineRetain.size &&
        [...retain].every((name) => engineRetain.has(name))
      ) {
        return false;
      }
      engineRetain = retain;
      engine.client.setRegistryRetain(retain);
      return true;
    };
    result.agent?.service.setToolsRefreshListener?.(() => {
      if (!syncEngineRetain()) return;
      void result.toolsEngine?.client.pushRegistry().catch((error) => {
        logger.warn('tools-engine registry push failed after member tools refresh', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    // 日志中枢热应用（observability.log）：由 config-watch 的 scopes 列表触发，
    // 不新增 RPC scope（ADR-075：config 类改动走 config 通路）。只有 log 字段变化
    // 才产差异行（`log: level info→debug`），避免每次热应用多一条 notice。
    const logOptionsState: { current: LoggingConfig } = { current: resolveLogOptions(config) };
    reloadAppliers.log = async () => {
      const next = await reloadVesselConfig();
      const desired = resolveLogOptions(next);
      const lines = diffLogOptions(logOptionsState.current, desired);
      if (lines.length === 0) return [];
      configureLogging(desired);
      logOptionsState.current = desired;
      return lines;
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

    // 0.61：hub 派生的来源集（join 时下发并存档）。读盘失败 / 旧 hub / 未 join
    // ⇒ undefined，行为与今天逐字一致：node 绝不因为 hub 不可达而拒绝启动或放宽白名单。
    // 声明在这里（reload 闭包也要用），只读一次：热重载沿用同一份，直到下次 join。
    const hubDerivedOrigins = await readHubNodeTrustedOrigins(dataDir);

    // q-kanban-proxy：kanban deps 提为可变对象（同一引用进 gatewayOptions.kanban）。
    // kanban.* handler 每次调用读 deps.boardPath → 热应用原地改即活生效。
    // 解析表达式是启动装配与热应用共用的唯一真相（~ 展开、相对进程 cwd → 缺省板）。
    const resolveKanbanBoardPath = (kanban: VesselConfig['kanban']): string =>
      path.resolve(expandHome(kanban?.boardPath?.trim() || 'docs/dev/kanban/board.json'));
    const kanbanDeps: { boardPath: string } = { boardPath: resolveKanbanBoardPath(config.kanban) };

    const reloadRunner = createGatewayReloadRunner({
      // web 尚未合入 reconfigure 时该字段不存在；按结构化可选入口处理。
      // 0.50：config reload 重建 allowedOrigins 时仍并入平台注入的 Origin，
      // 否则用户改一次配置就会静默丢掉自动放行的平台页面 Origin。
      gateway: () => {
        if (gateway === null) return null;
        const target = gateway as GatewayReconfigureTarget;
        const reconfigure = target.reconfigure;
        if (typeof reconfigure !== 'function') return target;
        return {
          reconfigure: (options) =>
            reconfigure.call(target, {
              ...options,
              allowedOrigins: resolveGatewayAllowedOrigins(
                options.allowedOrigins,
                process.env.VESSEL_PLATFORM_ORIGINS,
                hubDerivedOrigins,
              ),
            }),
        };
      },
      currentConfig: () => liveConfig,
      reloadConfig: reloadVesselConfig,
      refreshPlugins: () => {
        gatewayBundle.pluginLoader.refresh();
      },
      appliers: reloadAppliers,
      // 第 6 修（SPAWN-03）：缺省身份预览走 registry 运行期同口径（legacyPresent
      // 单向闸）；mock 无 registry 时缺省，runner 回落只读保守口径。
      ...(gatewayBundle.previewDefaultModel !== undefined
        ? { previewDefaultModel: gatewayBundle.previewDefaultModel }
        : {}),
      // provider.model 热应用（P0-1 D4）：只替换节点缺省模型 —— owner profile（新 EU
      // 创建时读）+ 成员宿主缺省（此后 spawn 的 body 读）。live EU / body 的 model 是
      // 构造期只读快照（前缀不变量），本具仍旧值、下一具才生效；live 会话换模型须
      // rotate / 重启。config.agent.model 仍属 agent 域需重启，不在这里处理。
      // 第 6 修：from/to 是缺省身份（ref + wire）。宿主缺省写 ref（spawn 继承可重解析），
      // owner profile / 展示面写 wire；比较语义在 ref 级，摘要展示保留 wire。
      applyProviderModel: (from, to, next) => {
        if (to === undefined || to.ref === '') {
          // runner 只在解析出身份时调用；兜底失败进 scope 摘要，不假装生效。
          throw new Error('provider.model is empty');
        }
        // P1-w2d 泛化（D5）：next 转发 → 重建 registry 快照 + 清 provider 缓存；
        // 缺 next 的旧调用点只改 profile.model（兼容）。profile.model 是展示 / mock
        // 回落口径，保持 wire。
        gatewayBundle.applyProviderModel(to.wireModel, next);
        result.agent?.applyDefaultModel(to.ref, to.wireModel);
        if (from?.ref === to.ref) {
          // 缺省 ref 未变：同 wire = 真 unchanged；异 wire = 条目改名（缺省身份未变，
          // 只报 wire 改名，不误报节点缺省 changed）。
          return [
            from?.wireModel === to.wireModel
              ? `provider/models: hot-applied (node default unchanged: ${to.wireModel}; registry snapshot rebuilt + provider cache cleared; live bodies keep old routing until next body)`
              : `provider/models: hot-applied (node default unchanged: ${to.ref}; wire model ${from?.wireModel ?? '(unset)'} → ${to.wireModel}; registry snapshot rebuilt + provider cache cleared; live bodies keep old routing until next body)`,
          ];
        }
        // 缺省 ref 变了（含异键同 wire：路由 / 凭证已变，不得误报 unchanged）。
        return [
          `model: ${from?.wireModel ?? '(unset)'} → ${to.wireModel} (node default ${from?.ref ?? '(unset)'} → ${to.ref}; registry snapshot rebuilt + provider cache cleared; live bodies keep the old model until next body)`,
        ];
      },
      // S7 federation 热应用：重新解析 peer（env token + SecretStore token 只进内存），
      // 原地更新入站路由与出站端口持有的同一批运行时对象 —— 下一请求生效，不重启。
      // 摘要行只含身份 / 计数，绝不包含 token 值。
      applyFederation: async (next) => {
        const secrets = await loadFederationPeerSecrets({
          dataDir,
          federation: next.federation,
          logger,
        });
        const resolved = resolveFederationOptions({
          ...(next.federation !== undefined ? { federation: next.federation } : {}),
          nodeId: result.nodeId,
          secrets,
        });
        for (const issue of resolved.issues) {
          logger.warn('federation.peer.skipped', { peer: issue.peer, reason: issue.reason });
        }
        const target = liveFederationOptions;
        if (target === undefined) {
          return ['federation: requires restart (no live federation control plane)'];
        }
        const before = federationOptionsFingerprint(target);
        const peerCountBefore = target.peers.length;
        applyFederationOptions(target, resolved.options);
        const lines: string[] = [];
        if (result.federationApply !== undefined) {
          result.federationApply(resolved.options);
        } else if (resolved.options.enabled) {
          lines.push(
            'federation: outbound send port absent (disabled at startup); restart required for outbound',
          );
        }
        if (before !== federationOptionsFingerprint(resolved.options)) {
          lines.unshift(
            `federation: hot-applied (enabled=${resolved.options.enabled}, peers ${peerCountBefore} → ${resolved.options.peers.length})`,
          );
        }
        return lines;
      },
      // q-kanban-proxy：kanban 热应用——重解析 boardPath 原地更新 kanbanDeps
      // （handler 每次调用读 deps.boardPath，下一次 kanban.get/archive 即用新板）。
      // 解析结果未变（如仅 trim 差异）不产差异行，避免无意义 notice。
      applyKanban: (next) => {
        const from = kanbanDeps.boardPath;
        const to = resolveKanbanBoardPath(next.kanban);
        kanbanDeps.boardPath = to;
        return from === to ? [] : [`kanban: board path ${from} → ${to} (hot-applied)`];
      },
      // auto-gc P1：autoPrune 热应用——调度器自启动起读 live resolver 闭包（每趟求值
      // 最新 enabled / interval / olderThan / dryRun，cadence 不冻结启动值）；这里把
      // 重载配置喂进调度器持有的活引用并 reschedule 立即重排挂起定时器（O4：热改即
      // 重排）。无本地调度器（connectMode）时如实报 requires restart（同 applyFederation 口径）。
      applyAutoPrune: (next) => {
        if (result.applyAutoPruneConfig === undefined) {
          return ['autoPrune: requires restart (no local auto-prune scheduler)'];
        }
        return result.applyAutoPruneConfig(next);
      },
    });

    // 配置监听（CONTRACT-hot-apply §2）：校验通过才应用，失败只记日志 + 发失败 notice。
    // gateway 启动后再挂监听（此时 reload 面已就绪）；关闭时在 activeCleanup 里取消。
    configWatch = startConfigWatch({
      configPath: nodeConfigPath ?? hotApplyConfigPath,
      debounceMs: hotApplyDebounceMs,
      logger,
      validate: async () => {
        const loaded = await loadConfig(
          nodeConfigPath !== undefined ? { configPath: nodeConfigPath } : {},
        );
        // O6：内容指纹供 config-watch 同内容去重 —— 写后 trigger 已应用的那笔写入，
        // 其迟到 fs.watch 回声不再跑第二遍管线 / 发空 diff notice 盖掉 hot-applied 摘要。
        return { ...toConfigReloadOutcome(loaded), fingerprint: stableValue(loaded.config) };
      },
      apply: async () => {
        // 只请求已注册的 applier：没有 MCP 的部署不该因为 mcp scope 失败。
        const registered = new Set(reloadRunner.registeredScopes());
        const scopes = ['config', 'log', 'permission', 'tools', 'mcp'].filter(
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

    // 0.43：`plugins.list` / `plugin.changed` 的 base 列表要含体验型 child 插件；
    // 贡献字段由 gateway 与 manager.contributionsFor 合并。E10：附带
    // version / mode / status（serve 的 plugins 选项类型仍是 {name,enabled}，
    // 子类型可结构兼容，不额外造类型）。
    const pluginRuntimeEntries = (): Array<{
      name: string;
      enabled: boolean;
      version?: string;
      mode?: string;
      status?: string;
    }> => {
      const descriptors = new Map(
        gatewayBundle.pluginLoader
          .getChildMods()
          .map((descriptor) => [descriptor.name, descriptor]),
      );
      return (
        pluginHostManager?.statuses().map((status) => {
          const descriptor = descriptors.get(status.id);
          return {
            name: status.id,
            enabled: status.enabled,
            ...(descriptor !== undefined
              ? { version: descriptor.version, mode: descriptor.mode }
              : {}),
            status: status.status,
          };
        }) ?? []
      );
    };

    // 0.47：单执行面的 plugins 数据源（与 gateway `plugins` 同源）。
    const bundlePluginEntries = (): Array<{ name: string; enabled: boolean }> => {
      // q-plugin-lifecycle §6.2 R1：enabled 统一读 liveConfig 的共享判定
      // （pluginEntryEnabled，覆盖层语义），不再硬编码 true / 读启动 config ——
      // 热 disable / 热装载后面板如实翻转（读写联动见 tools applier 的登记态同步）。
      const loaded = new Set(gatewayBundle.plugins.map((plugin) => plugin.name));
      const listed = gatewayBundle.plugins.map((plugin) => ({
        name: plugin.name,
        enabled: pluginEntryEnabled(liveConfig.plugins, plugin.name),
      }));
      // P1-w2d：已登记 in-process 能力插件补基础行（provider 类不在 bundle.plugins），
      // 否则 plugins.list 的 contributions 没有行可合并（契约 §1）；按 name 去重。
      for (const row of inProcessPluginRows) {
        if (!loaded.has(row.name)) {
          listed.push({
            name: row.name,
            enabled: pluginEntryEnabled(liveConfig.plugins, row.name),
          });
          loaded.add(row.name);
        }
      }
      // 配置里显式 disabled 的插件不加载，但仍要出现在 plugins.list 中（读 liveConfig）。
      for (const configured of liveConfig.plugins ?? []) {
        if (configured.enabled === false && !loaded.has(configured.name)) {
          listed.push({ name: configured.name, enabled: false });
          loaded.add(configured.name);
        }
      }
      // 0.56.1：发现但未装载的插件也补基础行（否则面板/catalog 完全不可见——
      // catalog 缺行即跳过）。工厂式按实际装配门控标注（与 CLI 列表共用
      // factoryPluginDisplayEnabled，读 liveConfig）；其余未装载（opt-out / debug 门控 /
      // 加载失败）显示关。child 行由 manager.statuses() 提供，不在此补。
      for (const descriptor of gatewayBundle.pluginLoader.list()) {
        if (loaded.has(descriptor.name) || descriptor.mode === 'child') continue;
        listed.push({
          name: descriptor.name,
          enabled:
            FACTORY_PLUGINS.has(descriptor.name) &&
            factoryPluginDisplayEnabled(liveConfig, descriptor.name),
        });
        loaded.add(descriptor.name);
      }
      return listed;
    };
    const pluginEntries = (): Array<{ name: string; enabled: boolean }> => [
      ...bundlePluginEntries(),
      ...pluginRuntimeEntries(),
    ];

    // 0.47：catalog 单视图；descriptor 是发现结果（全局），status 只按 entry 名查找。
    // 0.48 M4：注入 config `expose` 与 manager 的 surface 级冲突状态。
    // q-plugin-lifecycle §6.1/§6.2：注入 per-capability lifecycle（宿主审计推导）与
    // pendingRestart（期望态 ≠ 已生效态 且该面 restart 的差异汇聚）。
    const settingsFingerprint = (settings: Record<string, unknown>): string =>
      JSON.stringify(
        Object.keys(settings)
          .sort()
          .map((key) => [key, settings[key]]),
      );
    const pluginCatalog = () => {
      const expose = new Map<string, PluginExposeConfig>();
      for (const plugin of liveConfig.plugins ?? []) {
        if (plugin.expose !== undefined) expose.set(plugin.name, plugin.expose);
      }
      const httpSurfaceDisabled = pluginHostManager?.httpSurfaceDisabled() === true;
      const descriptors = gatewayBundle.pluginLoader.list();
      const startupConfig = gatewayBundle.config;
      const codePending = pluginReloader?.pendingInProcessRestart() ?? new Set<string>();
      const lifecycle = new Map<string, PluginLifecycle>();
      const pendingRestart = new Map<string, boolean>();
      for (const descriptor of descriptors) {
        const profile = derivePluginLifecycle({
          name: descriptor.name,
          mode: descriptor.mode,
          surfaces: gatewayBundle.pluginSurfaces.get(descriptor.name),
          isFactory: FACTORY_PLUGINS.has(descriptor.name),
          category: descriptor.category,
          declared: (descriptor.manifest ?? descriptor.capabilityManifest)?.lifecycle,
          // child settings 热应用已接线（§6.5 P2）：settingsFor 读 liveConfig + settings
          // 值进 reload 指纹 → 子进程重激活，child settings 转热。
          childSettingsHot: true,
        });
        lifecycle.set(descriptor.name, profile);
        // pendingRestart：只在该面 lifecycle 为 restart 时，期望态 ≠ 已生效态才算。
        let pending = false;
        if (profile.toggle === 'restart') {
          // restart 类启停的已生效态 = 启动态（注册面不热翻）；期望态 = liveConfig。
          const desired = pluginEntryEnabled(liveConfig.plugins, descriptor.name);
          const effective = pluginEntryEnabled(startupConfig.plugins, descriptor.name);
          if (desired !== effective) pending = true;
        }
        if (profile.settings === 'restart') {
          const desired = settingsFingerprint(pluginSettingsFor(liveConfig, descriptor.name));
          const applied = settingsFingerprint(pluginSettingsFor(startupConfig, descriptor.name));
          if (desired !== applied) pending = true;
        }
        if (profile.code === 'restart' && codePending.has(descriptor.name)) pending = true;
        pendingRestart.set(descriptor.name, pending);
      }
      return buildPluginCatalog({
        entries: pluginEntries(),
        descriptors: new Map(descriptors.map((descriptor) => [descriptor.name, descriptor])),
        statuses: pluginHostManager?.statuses() ?? [],
        lifecycle,
        pendingRestart,
        ...(expose.size > 0 ? { expose } : {}),
        ...(httpSurfaceDisabled ? { httpSurfaceDisabled } : {}),
      });
    };

    // 0.50：平台 spawn 的子 Node 自动并入平台页面 Origin（内部 env 契约）。
    const allowedOrigins = resolveGatewayAllowedOrigins(
      config.node?.allowedOrigins,
      process.env.VESSEL_PLATFORM_ORIGINS,
      hubDerivedOrigins,
    );

    // 0.55 P0：反代共享密钥（opt-in）。只读环境变量；不配 = undefined = 旧行为。
    const serveProxySecret = resolveServeProxySecret(config);

    const gatewayOptions: GatewayOptions = {
      // capabilities.list 需要真实版本；缺省会退化为 0.0.0。
      version: readPackageVersion(),
      // 0.13 Addendum A：权限交互持久化目录（serve 负责文件格式与原子写）。
      // 0.15：命名实例落到 <dataDir>/instances/<instance>，避免同 dataDir 互相覆盖。
      interactionsDir: ensureInteractionsDir(dataDir, foregroundGatewayInstance),
      // q-kanban-view：任务看板读面 + 用户验收归档写面（kanban.*）。
      // 路径 = config kanban.board_path（~ 展开、相对进程 cwd）→ 缺省
      // <cwd>/docs/dev/kanban/board.json（cwd = repo 根 / 舰队 worktree 根）。
      // archive.json 恒取板同目录（serve 侧派生，不读文件内指针）。
      // q-kanban-proxy：kanbanDeps 是可变对象（声明在 reloadRunner 前），
      // config.set kanban.boardPath / 手改 YAML 经 applyKanban 原地热更新。
      kanban: kanbanDeps,
      // q-async-bash-viz：异步 bash 作业只读观察面（jobs.*）。注册表唯一真相源是
      // basic-tools 的进程级作业表（会话绑定经 sessionId 过滤）；serve 只出形状。
      jobs: {
        list: (sessionId) => listAsyncBashJobs(sessionId),
        logTail: (jobId, maxBytes) => readAsyncBashJobLogTail(jobId, maxBytes),
      },
      // 0.12 / CONTRACT-hot-apply：`gateway.reload` 的唯一热应用入口。
      // serve 只做 scope 枚举校验；这里注入 `scope -> applier`。
      reload: reloadRunner.reload,
      // P0-run-stops P1：`gateway.shutdown` 的优雅退出序列。Windows 上外部 stop 是
      // 无条件强杀（信号处理器跑不到），停止侧 CLI 先经本 RPC 触发进程内 drain
      // （drain-to-quiesce：fence + 不限时等活跃 run 自然跑完），再等进程自死。
      // 走与 SIGTERM 完全相同的 activeCleanup（shutdownServeStack），不另造退出路径。
      shutdown: async () => {
        try {
          if (activeCleanup) await activeCleanup();
          else await result.shutdown();
        } catch {
          // 退出序列各步已自带日志（shutdown.failed / node.drain.failed）；失败不阻断退出。
        }
        process.exit(0);
      },
      // 自重启 Option A：预约受理（写 continuation 标记后立即返回「正在重启」）。
      // 触发者 run 自然完成后由 detached 编排者执行 stop/start（vessel restart --self）。
      ...(result.selfRestart ? { selfRestart: result.selfRestart } : {}),
      // CONTRACT-hot-apply §7：permissions.setToolPolicy 的写盘面（用户 YAML）。
      permissions: {
        // AX 自服务 · 自观：permissions.show 的只读规则面（additive）。
        // 源 = 热应用基线 permissionState.current（启动 = permissionConfigFor，
        // reload 成功才更新）——与差异通知同一份「当前有效规则」，不读 YAML 原样。
        rules: () => {
          const current = permissionState.current ?? permissionConfigFor(liveConfig, headless);
          const bridgeDeny =
            result.toolsEngine?.bridgeDeny.current ??
            normalizeBridgeDeny(liveConfig.permission?.bridgeDeny);
          return {
            default: current.default ?? (headless ? 'allow' : 'ask'),
            autoApprove: current.autoApprove ?? [],
            neverAutoApprove: current.neverAutoApprove ?? [],
            bridgeDeny,
          };
        },
        // q-env-card-visibility-fix：写盘走 withConfigLock（async），与 config.set 同一把锁。
        setToolPolicy: async ({ tool, policy }) => {
          const written = await setToolPolicy(tool, policy, { configPath: hotApplyConfigPath });
          // 写盘成功后同步活配置（重新赋值而非原地修改），让随后的 config.get 返回新数组。
          liveConfig = {
            ...liveConfig,
            permission: {
              ...liveConfig.permission,
              autoApprove: written.autoApprove,
              neverAutoApprove: written.neverAutoApprove,
            },
          };
          result.liveConfigRef.current = liveConfig;
          return {
            auto_approve: written.autoApprove,
            never_auto_approve: written.neverAutoApprove,
          };
        },
      },
      hub: eventHub,
      // P3 收紧（两面重构 §11.1）：agents.create/update model 参数未注册 ref 校验。
      ...(gatewayBundle.validateModelRef !== undefined
        ? { modelRefError: gatewayBundle.validateModelRef }
        : {}),
      // 0.18：events.list 的二次脱敏与 live hub / trace 同源（ext 幂等）。
      redactor: gatewayBundle.redactor,
      session: livenessSession ?? ctx.session,
      runtime,
      // web 控制台需要的装配面：会话切换 clear 上下文、工具清单、静态站点托管
      context: ctx.context,
      pluginHost: ctx.pluginHost,
      // 0.43：体验型 plugin 宿主（子进程 / 动态 RPC / 静态 UI / 事件转发）。
      // 0.48 M1：同一 manager 提供插件 HTTP 路由匹配 / endpoint 解析。
      ...(pluginHostManager !== undefined
        ? { pluginHostManager, pluginHttp: pluginHostManager }
        : {}),
      ...(pluginsReload !== undefined ? { pluginsReload } : {}),
      // S4：插件设置写面（plugins.config.set）；值校验在 serve 方法层按 manifest spec。
      pluginsConfigSet: (plugin: string, key: string, value: string | number | boolean) =>
        setPluginConfigValue(plugin, key, value),
      // 单执行面的插件清单：bundle 插件 + 体验型 child 插件。
      plugins: pluginEntries,
      pluginCatalog,
      // 0.49 G1：拆分模式 node 不宿 WebUI（staticDir 只在 Gateway 启动路径解析）。
      ...(nodeOnlyMode ? {} : { staticDir: resolveStaticDir(config) }),
      nodeId: result.nodeId,
      nodeName: result.nodeName,
      auth: authResult.auth,
      // 0.56：显式配置优先，未配置则是派生值（稳定、可 `vessel token show` 读出）。
      token: nodeToken.token ?? resolveGatewayToken(config),
      // 0.55 P0：反代共享密钥（opt-in）。未配置 = 不传 = 旧行为逐字不变。
      ...(serveProxySecret !== undefined ? { proxySecret: serveProxySecret } : {}),
      hostname: resolved.options.hostname,
      port: resolved.options.port,
      allowRemote: resolved.options.allowRemote,
      // 0.6 A5：CLI 覆盖已在 loader 合并；两端同名 allowed_origins。
      ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
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
            // 0.52：async ask 的答案投放（答案作为 user 消息进成员 inbox + 起新 run）。
            askAnswerDelivery: createAskAnswerDelivery(result.agent.service),
          }
        : {}),
      // 0.52：attachments.list 的列举器（节点侧只读目录浏览）。与读文件工具同一份
      // basic-tools 配置（allowed_roots / deny_paths）—— 面板列出来的路径必须与读侧判定同源。
      listAttachments: createConfigAttachmentLister({ getConfig: () => liveConfig }),
      // 单执行面的 RPC 数据源：config / trace / session 数据 / metrics。
      defaultTenantId: result.tenantId,
      config: tenantConfigControl,
      // 0.54 C：`events.list` 换源到时间线（`seq` = `timeline_seq`）；旧 `readEvents`
      // （per-run seq 的 trace 读法）已删除，见 bootstrap 侧同一处注释。
      timelineRunEvents: createTimelineRunEventsPort({
        sessionsDir: gatewayBundle.tenantPaths.sessions_dir,
        logger,
        ...(gatewayBundle.runStore !== undefined
          ? {
              resolveSession: async (runId: string) => {
                const record = await gatewayBundle.runStore?.load(runId);
                return record?.session_id;
              },
            }
          : {}),
      }),
      trace: {
        prune: (params: Record<string, unknown>) =>
          pruneTrace(gatewayBundle.tenantPaths.events_dir, {
            ...(typeof params.older_than_days === 'number'
              ? { retentionDays: params.older_than_days }
              : {}),
            ...(typeof params.max_runs === 'number' ? { maxRuns: params.max_runs } : {}),
            ...(typeof params.max_bytes === 'number' ? { maxBytes: params.max_bytes } : {}),
          }),
      },
      sessionData: {
        // 0.34 Stage 3：sessionControl.delete 内部先 detach；冲突（active run /
        // 活 SessionLease）直接抛 `conflict`，不做任何删除。
        deleteSessionData: (sessionId: string) => gatewayBundle.sessionControl.delete(sessionId),
      },
      // 会话级上下文用量（additive `sessions.get.context_usage`）：从**时间线尾窗**派生，
      // 历史会话 / rotate 之后 / 进程重启之后都能恢复。内存注册表
      // （`agents.tree` 的 `context_used`）只覆盖 live body，不能当唯一来源。
      // `contextWindowTokens` 与 runtime 算百分比的分母同源（`config.context.maxTokens`，
      // 缺省走 `DEFAULT_CONFIG`）；已知边界：配置是全局一个值，见 addendum。
      //
      // 0.54 stop-write：读源是 `bundle.timelineLog`（只读口，没有 append）。
      ...(gatewayBundle.timelineLog !== undefined
        ? {
            contextUsage: createContextUsageSource({
              tail: gatewayBundle.timelineLog,
              watermark: (sessionId: string) => gatewayBundle.timelineLog!.watermark(sessionId),
              ...(liveConfig.context?.maxTokens !== undefined
                ? { contextWindowTokens: liveConfig.context.maxTokens }
                : {}),
            }),
            // 「模型这一轮看到了什么系统消息」（additive `sessions.get.system_context`）：
            // 同一个读口，只是取的是另一类事件（`prompt.system_context`）。事件不是 message，
            // 回放窗口淘汰 / 进程重启之后只有重新派生才能把会话页那张卡找回来。
            systemContext: createSystemContextSource({
              tail: gatewayBundle.timelineLog,
              watermark: (sessionId: string) => gatewayBundle.timelineLog!.watermark(sessionId),
            }),
            // 每张图的投递状态（additive `sessions.get` 的 `image_delivery`，0.56）：
            // 同一个读口，取 `image.sent` / `context.image_dropped` 两类事件。
            imageDelivery: createImageDeliverySource({
              log: gatewayBundle.timelineLog,
              watermark: (sessionId: string) => gatewayBundle.timelineLog!.watermark(sessionId),
            }),
            // `sessions.events` 回填 + `sessions.get.event_cursor`：同一个读口。
            sessionEvents: createSessionEventsSource({
              log: gatewayBundle.timelineLog,
              watermark: (sessionId: string) => gatewayBundle.timelineLog!.watermark(sessionId),
            }),
          }
        : {}),
      // 0.54 A：timeline 四字段（additive `sessions.get.event_cursor` 的
      // `timeline_head` / `wal_head` / `published_head` / `holes` / `tainted`）。只有双写
      // 开关开、且该会话真有 timeline 时才给；缺省 ⇒ 一起缺省（不报假零）。
      ...(gatewayBundle.timelineDualWrite !== undefined
        ? {
            timelineHeads: {
              lookup: (sessionId: string) =>
                gatewayBundle.timelineDualWrite?.heads(sessionId) ?? Promise.resolve(undefined),
            },
            // 0.54 B1：时间线 epoch 的两个端口（历史页 + 发布点实时尾随）。
            timelineRead: {
              readPage: (
                sessionId: string,
                options: { afterSeq: number; untilSeq?: number; limit?: number },
              ) =>
                gatewayBundle.timelineDualWrite?.readPage(sessionId, options) ??
                Promise.resolve([]),
            },
            timelineTail: timelineTailPort(gatewayBundle.timelineDualWrite),
          }
        : {}),
      metricsControl: {
        rebuild: () => rebuildMetrics(gatewayBundle.tenantPaths.events_dir),
        reset: () => {
          const metrics = gatewayBundle.metrics;
          const reset = (metrics as { reset?: () => void } | undefined)?.reset;
          if (typeof reset !== 'function') {
            throw Object.assign(
              new Error(`not_found: metrics are not available for tenant "${result.tenantId}"`),
              { code: 'not_found' },
            );
          }
          reset.call(metrics);
        },
      },
    };

    // 0.4 控制面：web 的 GatewayOptions 尚未合入本分支，用 Object.assign 注入
    // 冻结形状；合并后可直接写进 GatewayOptions。
    const controlPlane = await buildGatewayControlPlane({
      config,
      nodeId: result.nodeId,
      logger,
      dataDir,
      ...(result.metrics ? { metrics: result.metrics } : {}),
      ...(result.feishu ? { feishu: result.feishu } : {}),
      // 0.19 S3：canonical teams.* 只在默认 tenant 的 AgentService 存在时注入。
      ...(result.agent?.team ? { teams: result.agent.team } : {}),
      // 0.25：canonical agents.create|update|close（同一 AgentService 适配器）。
      ...(result.agent?.control ? { agentControl: result.agent.control } : {}),
    });
    // S7 热应用：入站路由读的就是这个对象；applyFederation 原地更新它。
    liveFederationOptions = controlPlane.federation as FederationRuntimeOptions | undefined;

    // q-fed-simple：入站自动配对端口（码 / 回环判定 + token 交换 + 自动写配置 +
    // 进程内热应用）。写盘走用户配置（与 federation peer add 同口径）；热应用复用
    // reloadRunner 的 config scope，失败由配置监听兜底。
    if (result.nodeId !== undefined) {
      controlPlane.pairing = createFederationPairingPort({
        dataDir,
        nodeId: result.nodeId,
        userConfigPath: getUserConfigPath(),
        allowFileSecrets: config.federation?.allowFileSecrets,
        ...(result.agent?.team ? { teams: result.agent.team } : {}),
        hotApply: () => reloadRunner.reloadWithSummaries(['config']),
        logger,
      });
    }

    try {
      gateway = startGateway(Object.assign(gatewayOptions, controlPlane) as GatewayOptions);
      markStartup('listen');
    } catch (error) {
      // node 没起来：停 watcher 并回收 plugin 子进程。
      pluginWatch?.close();
      pluginWatch = undefined;
      await pluginHostManager?.stopAll();
      pluginHostManager = undefined;
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

    // 0.12：node 侧 PID 文件供 `node status/stop/reload` 使用（平台进程走
    // `runPlatformGatewayForeground` 的 `platform.pid`，不再经过这里）。
    // 写失败视为启动失败；`--serve` 保持兼容，只告警。
    try {
      await writeForegroundGatewayPid({
        dataDir,
        host: resolved.options.hostname,
        port: gateway.port,
        version: gatewayOptions.version,
        instance: foregroundGatewayInstance,
        ...(foregroundGatewayLock !== undefined
          ? { startedAt: foregroundGatewayLock.startedAt }
          : {}),
        ...(result.nodeId ? { nodeId: result.nodeId } : {}),
        daemon: process.env[GATEWAY_DAEMON_ENV] === '1',
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
    // 「就绪」的判据 = 监听已在 + `gateway.pid` 已写（外部探活靠这两件事）：
    // 到这里启动分期收口，之后的时间不再算启动。
    markStartup('ready');
    flushStartupTiming({
      print: (line) => console.error(line),
      // 明细行（逐段 + 逐插件 + 时间线打开次数）默认不打；`VESSEL_STARTUP_DETAIL=1`
      // 或 debug 级别日志时给。理由：明细是归因用的，不是日常输出（宪法第十四条）。
      debug:
        (process.env.VESSEL_STARTUP_DETAIL ?? '').trim() !== '' ||
        (process.env.VESSEL_DEBUG ?? '').trim() !== '' ||
        (process.env.VESSEL_LOG_LEVEL ?? '').trim().toLowerCase() === 'debug',
    });

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
  }

  if (gateway) {
    // 0.51：box 只在人类终端打一次。非 TTY（daemon / 平台 spawn 的 node 子进程 / 管道）、
    // `--json`、`NO_COLOR` / `TERM=dumb` 降级成一行纯文本，避免 ASCII 框线翻进
    // `<dataDir>/logs/*.log` 并与结构化日志行交错。
    if (wantsBoxBanner()) {
      console.log(`\n${renderGatewayBanner(gateway)}\n`);
    } else {
      console.log(renderGatewayBannerOneLine(gateway, readPackageVersion()));
    }
  }

  // 未捕获异常时的清理入口：停 gateway / 关闭额外 tenant / 释放默认 tenant。
  // beginDrain 已 drain-to-quiesce（run 全部自然终态），后续关闭传 drain:false。
  // DR15-1：退出步永久进度日志发射口（activeCleanup 与 SIGTERM 的 finish 共用）。
  // 挂起时日志里最后一条 node.shutdown.step status=start 就是挂点。
  const shutdownStepEmit: ShutdownStepEmit = (level, event, fields) => {
    if (level === 'warn') logger.warn(event, fields);
    else logger.info(event, fields);
  };
  activeCleanup = async () => {
    // 0.43：先停 watcher 并回收 plugin 子进程（停订阅 / 动态 RPC / 子进程）。
    pluginWatch?.close();
    pluginWatch = undefined;
    await runShutdownStep(shutdownStepEmit, 'cleanup.plugin.stopAll', async () => {
      await pluginHostManager?.stopAll();
    });
    pluginHostManager = undefined;
    // 先停配置监听 / 版本检查与出站，避免 gateway drain 期间继续触发热应用或重连。
    gatewayUpdateCheck?.stop();
    gatewayUpdateCheck = undefined;
    configWatch?.close();
    configWatch = undefined;
    await runShutdownStep(shutdownStepEmit, 'cleanup.hubOutbound.close', async () => {
      await hubNodeOutbound?.close();
    });
    hubNodeOutbound = undefined;
    await shutdownServeStack({
      // drain-to-quiesce：fence + 不限时等活跃 run 自然跑完 + flush，
      // 必须早于 gateway.stop()（先关闸，退出期间不再起新 run）。
      ...(result.beginDrain ? { beginDrain: result.beginDrain } : {}),
      gateway,
      closeTenants: async () => {
        eventHub?.close();
        eventHub = undefined;
      },
      shutdown: (options) => result.shutdown(options),
      onStep: shutdownStepEmit,
    });
    await runShutdownStep(shutdownStepEmit, 'cleanup.foregroundLock.release', async () => {
      await foregroundGatewayLock?.release();
    });
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
      askChannel: {
        // 纯 headless 与 `--serve --run` 都落盘（后者与 gateway registry 写同一份
        // 一致记录）；这样即使进程立刻退出，suspended 请求也跨进程保留。
        dir: resolveInteractionsDir(resolveDataDir(config), foregroundGatewayInstance),
        tenantId: result.tenantId,
      },
      ...(result.runStore !== undefined ? { runStore: result.runStore } : {}),
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
      setTimeout(() => {
        void scheduleUpdateCheck(ctx, config);
      }, 0);
    }
    await startInkRepl(ctx);
  }

  // 固定顺序：await beginDrain（drain-to-quiesce）→ gateway.stop()
  // → closeAll → shutdown；后两步 drain:false，避免重复限时等待。
  const finish = async (beforeClose?: () => Promise<void>): Promise<void> => {
    // 构建中被叫停：先把构建子进程**真的**杀掉并留一行 `web.build.interrupted`，
    // 再走原有关闭顺序（否则构建还在这台机器上往 dist 里写，人却以为已经停了）。
    interruptWebBuild(shutdownSignal ?? 'SIGTERM');
    // 0.43：先停 watcher 并回收 plugin 子进程（停订阅 / 动态 RPC / 子进程）。
    pluginWatch?.close();
    pluginWatch = undefined;
    await runShutdownStep(shutdownStepEmit, 'cleanup.plugin.stopAll', async () => {
      await pluginHostManager?.stopAll();
    });
    pluginHostManager = undefined;
    // 先停出站，避免 gateway drain 期间继续重连或刷新目录。
    await runShutdownStep(shutdownStepEmit, 'cleanup.hubOutbound.close', async () => {
      await hubNodeOutbound?.close();
    });
    hubNodeOutbound = undefined;
    await shutdownServeStack({
      // 0.52 S1a：见上（feishu 退出路径同一段）。
      ...(result.beginDrain ? { beginDrain: result.beginDrain } : {}),
      gateway,
      closeTransport: async () => {},
      ...(beforeClose ? { beforeClose } : {}),
      closeTenants: async () => {
        eventHub?.close();
        eventHub = undefined;
      },
      shutdown: (options) => result.shutdown(options),
      onStep: shutdownStepEmit,
    });
    await runShutdownStep(shutdownStepEmit, 'cleanup.foregroundLock.release', async () => {
      await foregroundGatewayLock?.release();
    });
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
