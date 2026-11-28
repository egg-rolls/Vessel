/**
 * 应用引导模块
 *
 * 负责：config → provider → plugins → runtime → ReplContext
 * 从 cli.ts 中提取，解决 #16 issue
 */

import * as path from 'node:path';
import type { AgentService } from '@vessel-agent/agent';
import {
  createEngineClient,
  createPoolTransport,
  type PoolTransport,
} from '@vessel-agent/engine-client';
import {
  buildConfigSnapshot,
  getUserConfigDir,
  getUserConfigPath,
  loadConfig,
  resolveEffectiveApiKey,
  type VesselConfig,
} from '../../packages/config/src/index';
import {
  imageBlobRoot,
  MemoryWorkingContext,
  type Message,
  pruneTrace,
  type RunnableAgent,
  Runtime,
  rebuildMetrics,
  type TenantPaths,
  toolOutputRoot,
} from '../../packages/core/src/index';
import {
  type ConfigSnapshotLike,
  createGatewayEventHub,
  createLocalRpcDispatcher,
  type LocalRpcDispatcher,
} from '../../packages/serve/src/index';

import { resolveAgentWiring } from '../agent/agent-wiring';
import { createAskAnswerDelivery } from '../agent/ask-answer-delivery';
import { createLocalRunAdapter } from '../agent/local-run-adapter';
import type { PeerNoticeRouter } from '../agent/peer-notices';
import { formatConfigErrors } from '../config/config-error-format';
import { sanitizeConfigForSnapshot } from '../config/config-snapshot';
import { normalizeLegacyToolName } from '../config/legacy-tool-names';
import { DEFAULT_NEVER_AUTO_APPROVE } from '../config/permission-defaults';
import { createReplSettings } from '../config/ui-settings';
import {
  createConfigAttachmentPreviewer,
  createConfigAttachmentStager,
  type StagingGcRunner,
  startStagingGc,
} from '../data/attachment-staging';
import { createConfigAttachmentLister } from '../data/attachments-list';
import {
  type AutoPrunePassReport,
  type AutoPruneRunner,
  formatAutoPruneReport,
  startAutoPrune,
} from '../data/auto-prune';
import { withDataLock } from '../data/data-lock';
import {
  resolveDataDir,
  resolveEffectiveTenantId,
  resolveSingleTenantPaths,
} from '../data/data-paths';
import {
  formatImageBlobGcReport,
  type ImageBlobGcRunner,
  isBlobRootInsideDataDir,
  startImageBlobGc,
} from '../data/image-blob-gc';
import {
  addAutoApproveRule,
  listAutoApproveRules,
  removeAutoApproveRule,
} from '../data/permission-store';
import { createOnlinePrunePort } from '../data/prune-wiring';
import type { FederationRuntimeOptions } from '../federation/federation-config';
import { resolveGatewayAuth } from '../gateway/serve-auth';
import { t } from '../i18n';
import { resolveNodeIdentity } from '../node/node-identity';
import { configureLoggingFromConfig, createCliLogger } from '../observability/logging';
import { markStartup, timeStartup } from '../observability/startup-timing';
import { pruneTenantTrace } from '../observability/trace-wiring';
import { declarativePluginEntries, setPluginConfigValue } from '../plugin/plugin-config';
import {
  activateStartupPlugins,
  createPluginHostManager,
  createPluginReloader,
} from '../plugin/plugin-host-assembly';
import { PluginLoader } from '../plugin/plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from '../plugin/plugin-selection';
import { createPluginSurface } from '../plugin/plugin-surface';
import { startPluginWatch } from '../plugin/plugin-watch';
import { createLocalRpcClient } from '../rpc/index';
import { createRunControl } from '../run/run-control';
import { createContextCompositionSource } from '../session/context-composition';
import { createContextUsageSource } from '../session/context-usage';
import { createImageDeliverySource } from '../session/image-delivery';

import { createSessionEventsSource } from '../session/session-events';
import { acquireSessionLock, type SessionLock, SessionLockedError } from '../session/session-lock';
import { createSystemContextSource } from '../session/system-context';
// 0.54 B1 末块：实时尾随端口（发布点扇出 → serve 的时间线 epoch）。
// 只有双写开关开时才有 `timelineDualWrite`，此时才传；关闭路径与 0.53 逐字节相同。
// 0.54 C：`events.list` 的按 run 读端口（同一模块，共用 timeline 的读面与路径口径）。
import { createTimelineRunEventsPort, timelineTailPort } from '../session/timeline-dual-write';
import { readPackageVersion } from '../shared/version';
import type { McpEngineShell } from '../tools-engine/mcp-engine-wiring';
import { createEngineSupervisor, type EngineSupervisor } from '../tools-engine/supervisor';
import { assembleAgentWiring, finishAgentAssembly } from './agent-assembly';
import {
  bootstrapConnect,
  isRecordValue,
  resolveKanbanBoardPath,
  withConnectCliOverrides,
  withFirstRunResume,
} from './bootstrap-connect';
import type {
  BootstrapOptions,
  BootstrapResult,
  ReplContextWithPermissions,
} from './bootstrap-types';
import { hasBootRegistryKey } from './model-registry-wiring';
import type { NodeHealthWatch } from './node-health-watch';
import { createDurableResumeSurface, createNodeRestartSurface } from './node-restart';
import type { RuntimeNoticeBus } from './runtime-notice';
import { newSessionId } from './session-id';
import { createShutdownSequence } from './shutdown-sequence';
import { buildTenantRuntime } from './tenant-runtime-factory';
import { sanitizeToolOutputEnv } from './tool-output-env';
import { createVesselMetaSurface, normalizeBridgeDeny, type VesselRpcPort } from './vessel-meta';

export {
  resolveDefaultTeamAnchor,
  resolveDefaultTeamWorkspace,
  resolveKanbanBoardPath,
} from './bootstrap-connect';
export type { BootstrapOptions, BootstrapResult } from './bootstrap-types';

export { newSessionId } from './session-id';

/**
 * 引导应用启动
 */

export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const {
    useMock = false,
    sessionId,
    headless = false,
    interactive = !headless,
    registerAskUser = interactive,
    configErrorExitCode = 1,
  } = options;
  // 0.10 R2-14：诊断日志只写 stderr；嵌入方 / CLI 可注入自己的 sink。
  const logger = options.logger ?? createCliLogger();

  // ── 加载配置 ────────────────────────────────────
  // 单一 resolver：CLI 覆盖层（含旧式 connectToken/caFile）只在这里进入。
  const cliOverrides = withConnectCliOverrides(
    options.cliOverrides,
    options.connectToken,
    options.caFile,
  );
  const loaded = await loadConfig({
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
    ...(cliOverrides !== undefined ? { cliOverrides } : {}),
  });
  const { config, validation, tenantId: configTenantId, paths: configPaths } = loaded;
  markStartup('config');
  // P2 活配置引用（热加载）：bootstrap 的 `config` 是启动期 const，热应用换的是 cli 的
  // liveConfig（新对象），本对象不会被原地改。总线 hook / EU envCadence / 成员 spawn 的
  // env_injection 闭包统一读这个 ref ⇒ cli 热应用时同步 `.current`，下一请求即生效
  // （修「注册幂等导致冻结在启动值」）。形状照 toolsEngine.bridgeDeny { current } 先例。
  const liveConfigRef: { current: VesselConfig } = { current: config };

  if (!useMock && validation.errors.length > 0) {
    console.error(formatConfigErrors(validation.errors, { paths: configPaths }));
    process.exit(configErrorExitCode);
  }

  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) console.warn(`⚠ ${w.message}`);
  }

  // 日志中枢：配置加载后立即应用 observability.log（环境变量覆盖在中枢内仍优先）。
  // 此前（import / 配置加载阶段）的日志按环境变量与默认值输出，量很少，可接受。
  configureLoggingFromConfig(config);

  // ── data_dir / connect（0.5；0.49 T4 删除 tenant 块）───────────
  const resolvedDataDir = options.dataDir ?? resolveDataDir(config);
  const dataDir = options.dataDirSubdir
    ? path.join(resolvedDataDir, options.dataDirSubdir)
    : resolvedDataDir;
  // issue-1（隔离缺口）：把本 node 解析后的 dataDir 桥接进进程 env，使工具输出落盘根
  // （core toolOutputRoot：ALS scope → VESSEL_TOOL_OUTPUT_DIR → VESSEL_DATA_DIR → ~/.vessel）
  // 用 node 自身 dataDir 而非硬编码生产根。data_dir 来自配置文件时 host env 原本没有
  // VESSEL_DATA_DIR，host in-process / 异步 bash 日志会落进 ~/.vessel；且下方 engine child
  // settings.toolOutputDir = toolOutputRoot() 会把 host 的错根传给 child。此处与 entry.ts
  // 对 child 的 `process.env.VESSEL_DATA_DIR = dataDir` 同源。默认根（config/env 均缺省）
  // 取值不变（零回归）。
  process.env.VESSEL_DATA_DIR = dataDir;
  // T2b（隔离击穿）：只桥接 VESSEL_DATA_DIR 不够 —— toolOutputRoot 让继承的
  // VESSEL_TOOL_OUTPUT_DIR 优先于 VESSEL_DATA_DIR，启动链（shell → gateway → node）
  // 带来的生产根会击穿舰队边界（金丝雀 T2b：node/engine environ 双变量并存，输出落
  // 生产根）。此处把落在本舰队 dataDir 之外的异根重写为 <dataDir>/tool-output，并同步
  // 重写 VESSEL_PLUGIN_CONFIG 的 dataDir/toolOutputDir 字段（解析失败 → 清除不猜）。
  // dataDir 之内的值（含生产舰队自身的正确根）保留 → 零回归；下方 engine child
  // settings.toolOutputDir = toolOutputRoot() 由此拿到本舰队根。
  sanitizeToolOutputEnv(process.env, dataDir);
  // 0.49 R1：单 id 以持久化 `<dataDir>/tenant.json` 为准（T4 删除 config tenant 块后
  // `loadConfig()` 恒为 `default`）；fresh 数据根没有该文件时仍回 `default`。
  const tenantId = resolveEffectiveTenantId(configTenantId, dataDir);
  const connectUrl = options.connect ?? process.env.VESSEL_CONNECT;
  const connectMode = typeof connectUrl === 'string' && connectUrl.trim() !== '';
  // connect 是唯一只读入口；其余入口（run / REPL / serve / feishu）都写本地
  // store / trace。tenant writer lock 已随单执行面收敛删除（T3 C2）。
  const localWrites = !connectMode;

  // 0.49 T5（C6）：只支持根布局；`<dataDir>/tenants/**` 非空 → fail-fast，
  // 不读、不迁、不移、不删、不写 marker/journal。写模式与 connect 同口径。
  let tenantPaths: TenantPaths;
  try {
    tenantPaths = resolveSingleTenantPaths(dataDir, tenantId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // 节点身份（0.25）：node_id 唯一来源（U3）：host.node_id > <dataDir>/node.json > 首次生成；
  // 展示名：host.node_name > 文件 name > hostname 派生。transport / PeerInfo 共用 nodeId。
  const nodeIdentity = await resolveNodeIdentity({
    ...(config.host?.nodeId !== undefined ? { configNodeId: config.host.nodeId } : {}),
    ...(config.host?.nodeName !== undefined ? { configNodeName: config.host.nodeName } : {}),
    dataDir,
    logger,
  });
  const nodeId = nodeIdentity.nodeId;
  const nodeName = nodeIdentity.name;
  markStartup('identity');

  // connect 模式：不获取写锁、不写本地 store/trace；配置仍加载用于 token 选择。
  if (connectMode) {
    return bootstrapConnect({
      config,
      nodeId,
      nodeName,
      tenantId,
      tenantPaths,
      url: connectUrl,
      headless,
      logger,
      ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.continueLatest === true ? { continueLatest: true } : {}),
      ...(options.resumeSessionId !== undefined
        ? { resumeSessionId: options.resumeSessionId }
        : {}),
      ...(options.connectRunTimeoutMs !== undefined
        ? { connectRunTimeoutMs: options.connectRunTimeoutMs }
        : {}),
      ...(options.connectRunPollMs !== undefined
        ? { connectRunPollMs: options.connectRunPollMs }
        : {}),
      ...(options.rpcClientFactory ? { rpcClientFactory: options.rpcClientFactory } : {}),
    });
  }

  // 启动闸两条腿：legacy provider.*/apiKey 链路（DECISION-020）或 registry 注册条目
  // 凭证已配置（纯 models.entries + credentials.json 形态，无 legacy 块）。
  if (
    !useMock &&
    !interactive &&
    !resolveEffectiveApiKey(config) &&
    !hasBootRegistryKey(config, dataDir)
  ) {
    console.error(t('common.noApiKey'));
    process.exit(configErrorExitCode);
  }

  // T3 C2：runtime/boot 不再获取 tenant writer lock。session/run 锁与
  // SessionLease 仍在执行面内部保证单写者；CLI 写意图锁保留到 T4/T5。
  const sessionBackend = config.session?.backend ?? 'file';

  // 启动 prune：best-effort，失败只 warn（无写意图时不触碰磁盘）。
  //
  // 0.57（**真实事故**：node 启动 16.3s，其中 10~27s 全在这一段）：
  // `trace.retention` 的缺省是 `max_runs: 1000`，而 `pruneTrace` 在「文件数 > max_runs」
  // 时走**全量解析**（每个 trace 文件都要 readFile + 逐帧 JSON.parse 才能知道 lastTs）。
  // 3000+ 个 run 的租户于是每次启动都要把整份 trace 目录重新读一遍 —— 这不是「启动需要
  // 的活」，是**留存清理**，跟能不能接请求毫无关系。
  //
  // 所以判据改成「谁需要它先做完」：
  // - headless（一次性进程）：`await`，否则进程退出时它可能还没跑（语义不变）；
  // - REPL / serve / node：**不阻塞启动**，交给 timer（REPL 早就是这么做的，
  //   S4 §2.2「首帧不能被 prune 阻塞」；这里只是把同一条政策推广到 serve/node）。
  //   它的产物是「删掉过期的 trace」，晚几秒与早几秒对任何人都没有区别。
  const pruneAfterFirstFrame = localWrites && options.headless !== true;
  const pruneTraceBestEffort = async (): Promise<void> => {
    const startedAt = performance.now();
    try {
      const result = await pruneTenantTrace({ config, tenantPaths });
      // 一行结果（第十四条）：干完活必须留账，否则「prune 到底跑了没」只能靠猜。
      if (result.deleted_runs > 0 || result.deleted_bytes > 0) {
        logger.info('trace.prune.done', {
          deleted_runs: result.deleted_runs,
          kept_runs: result.kept_runs,
          deleted_bytes: result.deleted_bytes,
          duration_ms: Math.round(performance.now() - startedAt),
        });
      }
    } catch (error) {
      console.warn(
        `⚠ Failed to prune trace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  if (localWrites && !pruneAfterFirstFrame) {
    await timeStartup('prune', pruneTraceBestEffort());
  }
  markStartup('prune');

  // ── 每 tenant 执行面（0.5 A-6）──────────────────
  // 本地模式复用同一工厂，只构建当前 tenant；provider / 插件 / trace /
  // metrics 全部由 bundle 持有。bootstrap 只负责入口、RPC 与生命周期。
  const loader = new PluginLoader();
  // 启动告警：默认集包含外部插件时提示信任边界（opt-out 见 VESSEL_NO_EXTERNAL_PLUGINS）。
  warnExternalPluginsOnce(
    resolvePluginSelection(
      loader,
      config.plugins,
      Boolean(process.env.VESSEL_DEBUG),
      declarativePluginEntries(config),
    ).external,
  );
  let currentSessionId = sessionId ?? newSessionId();
  // 0.15：REPL / headless 对显式会话持进程级写锁（`--continue` / `-r` / `--session`）。
  // serve-only 不持长锁：gateway 每次 run 取锁，避免空闲实例挡住其它前端。
  let processSessionLock: SessionLock | undefined;
  if (
    options.sessionId !== undefined &&
    sessionBackend !== 'memory' &&
    (interactive === true || headless === true)
  ) {
    try {
      processSessionLock = await acquireSessionLock({
        tenantDir: tenantPaths.root,
        kind: 'session',
        id: options.sessionId,
        ...(options.clock ? { now: options.clock } : {}),
      });
      process.once('exit', () => processSessionLock?.releaseSync());
    } catch (error) {
      if (error instanceof SessionLockedError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
  }
  // 0.17 A4：成员工具只走 AgentService；显式 `agent.enabled: true` 才启动。
  const agentPlan = resolveAgentWiring(config, { headless });
  const agentServiceEnabled = agentPlan.agentEnabled;
  /**
   * 父宿主是否注册 ask 工具（0.27 / 0.33）。
   *
   * 0.33：headless 也注册（请求落盘后挂起，人类稍后回答并 resume），
   * 所以「注册」不再等于「进程内有应答者」。
   *
   * 0.51：成员拿不拿 `ask` 已不由这里决定（不再传 `extraTools`）：判据是「父宿主注册了
   * + 这具身体能 bridge」，由执行内核在 `selectTools` 一处判定（不再对外解释原因）。
   * 这个标志只剩一个用途 —— `humanApproval`：没有进程内应答者时，模型发起的 rotate
   * 直接走 `rotate_not_needed`，不去等一个不会到来的确认。
   */
  const askUserAvailable = registerAskUser && config.ui?.askUser !== false;
  const interactiveHumanAvailable = askUserAvailable && !headless;

  // 0.28 F2：飞书渠道成员被 TTL 回收后，复活所需的 Team id 要等
  // `createAgentServiceWiring` 之后才存在；bundle（含渠道）先构造，所以用晚绑定
  // getter 回填（与 localHuman / localMember 同口径）。headless / 无默认 workspace
  // 时保持 undefined，渠道退回「回收后 member_closed」的旧行为。
  let feishuTeamId: string | undefined;
  // 0.28：渠道执行面所需的 AgentService 同样晚绑定 —— 渠道随 bundle 构造，
  // `createAgentServiceWiring` 之后才存在；插件在 `start()` 时求值。
  let feishuAgentService: AgentService | undefined;
  // ── tools-engine P2：engine child（装配层基础设施，与 gateway 同级；seams 契约 §3）──
  // 每 host 一个 engine child（B 形态）；合成 descriptor 不进 PluginLoader / catalog。
  // getTransport 晚绑定：supervisor 未 start / disabled ⇒ 转发 fail-closed（不静默回退）。
  const engineSupervisorRef: { current?: EngineSupervisor } = {};
  // 池 S20：mode=pool 时 ref 持 PoolTransport（getTransport 晚绑定形状不变，fail-closed 语义不变）。
  const poolTransportRef: { current?: PoolTransport } = {};
  // 批次 2：MCP host shell 晚绑定（factory 装配后才存在；engine 重启 onReady 对账用）。
  const mcpShellRef: { current?: McpEngineShell } = {};
  const engineClient = createEngineClient({
    getTransport: () => engineSupervisorRef.current?.transport ?? poolTransportRef.current,
    logger,
  });
  let engineSupervisor: EngineSupervisor | undefined;
  if (config.toolsEngine?.mode === 'pool') {
    // 池 S20：node 数据面 = PoolTransport 直连 gateway 监督的 engine 池（替代 child supervisor）。
    // poolDir = 用户全局配置目录 + engine-pool[-<instance>]（解释 (d)：--data-dir 不移动 poolDir，
    // 隔离实例必须设 gateway.engine_pool.instance）。双开关缺省关：本分支仅 mode=pool 显式 opt-in。
    const poolInstance = config.gateway?.enginePool?.instance;
    const poolDir = path.join(
      getUserConfigDir(),
      poolInstance !== undefined && poolInstance !== ''
        ? `engine-pool-${poolInstance}`
        : 'engine-pool',
    );
    poolTransportRef.current = createPoolTransport({
      poolDir,
      nodeId,
      incarnation: Date.now(),
      // 与 child settings 同源：dataDir = 本入口解析后的数据目录；toolOutputDir = host 生效根。
      dirs: { dataDir, toolOutputDir: toolOutputRoot() },
      // 解释 (e)：host 注册权威 = mcpShell.listServers()（与账本 route.source 喂入同源）；
      // 命中 → mcp:<server>，否则 undefined → 全候选。shell 未就绪 → undefined（晚绑定现态）。
      getSource: (toolName) => {
        const server = mcpShellRef.current
          ?.listServers?.()
          .find((item) => item.tools.includes(toolName));
        return server !== undefined ? `mcp:${server.name}` : undefined;
      },
      // 修正案 R1.1：callback 续上 oracle = EngineClient.pendingState（委托 pending.state()）。
      pendingState: (runId, toolCallId) => engineClient.pendingState(runId, toolCallId),
      logger,
      // 修正案 R1.2：连接转健康（含重连 / respawn 恢复）→ reconcile + pushRegistry，
      // 与 child onReady 同语义（两处调用点，宪法 10.7 复制不抽取，child 分支保持逐字）。
      onConnectionReady: () => {
        void (async () => {
          try {
            await mcpShellRef.current?.reconcile();
            await engineClient.pushRegistry();
          } catch (error) {
            logger.warn('tools-engine registry push failed', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      },
      onToolCallback: (params) => engineClient.handleToolCallback(params),
      onEngineNotification: (method, params) =>
        engineClient.handleEngineNotification(method, params),
    });
  } else {
    engineSupervisor = createEngineSupervisor({
      entryPath: path.join(import.meta.dir, '..', 'tools-engine', 'entry.ts'),
      rootDir: path.join(import.meta.dir, '..', '..'),
      dataDir: path.join(dataDir, 'tools-engine'),
      // 落盘 env 与 host 同源：dataDir = 本入口解析后的数据目录；toolOutputDir = host 生效根。
      settings: { dataDir, toolOutputDir: toolOutputRoot() },
      logger,
      onToolCallback: (params) => engineClient.handleToolCallback(params),
      onEngineNotification: (method, params) =>
        engineClient.handleEngineNotification(method, params),
      // 每次 start / 重启成功后对账（重启不改注册表身份；失败只记日志）。
      // 批次 2：MCP 重喂 configure 重建连接 + 注册对账（换连接不换定义，透明）。
      onReady: () => {
        void (async () => {
          try {
            await mcpShellRef.current?.reconcile();
            await engineClient.pushRegistry();
          } catch (error) {
            logger.warn('tools-engine registry push failed', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      },
    });
    engineSupervisorRef.current = engineSupervisor;
    // 预算内失败自动重试；预算尽 disabled（start 抛最后一次错误）→ 工具 fail-closed，
    // 启动不崩：用户可见稳定 engine_unavailable 错误（行为验证点：启动诊断）。
    await engineSupervisor.start().catch((error: unknown) => {
      logger.error('tools-engine start failed; whitelisted tools are fail-closed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // Stage 4：每 node 每进程一个 Runtime；tenant bundle 与成员 host 共用。
  const executionRuntime = new Runtime({ logger });
  const bundle = await buildTenantRuntime({
    tenantId,
    runtime: executionRuntime,
    config,
    // P2 热加载：EU envCadence / envChannel 读 live ref（cli 热应用时同步）。
    getEnvInjection: () => liveConfigRef.current.envInjection,
    tenantPaths,
    configSources: loaded.sources,
    configPaths: loaded.paths,
    useMock,
    ...(options.mockScenario !== undefined ? { mockScenario: options.mockScenario } : {}),
    headless,
    // 0.15：显式 ui.askUser=false 关闭；无客户端的入口不会传 true。
    registerAskUser: askUserAvailable,
    loader,
    nodeId,
    sessionId: currentSessionId,
    logger,
    writeTrace: localWrites,
    pruneTrace: false,
    ...(options.metricsFactory ? { metricsFactory: options.metricsFactory } : {}),
    ...(options.traceFactory ? { traceFactory: options.traceFactory } : {}),
    ...(options.redactor ? { redactor: options.redactor } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.loadMcpModule ? { loadMcpModule: options.loadMcpModule } : {}),
    ...(options.loadFeishuModule ? { loadFeishuModule: options.loadFeishuModule } : {}),
    ...(options.feishuTransport !== undefined ? { feishuTransport: options.feishuTransport } : {}),
    resolveFeishuTeamId: () => feishuTeamId,
    resolveFeishuService: () => feishuAgentService,
    engineClient,
  }).catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : error}`);
    process.exit(configErrorExitCode);
  });
  markStartup('runtime');
  // 批次 2：MCP host shell 回填（engine 重启 onReady 对账；初始 configure 已在 factory 完成）。
  mcpShellRef.current = bundle.mcpShell;

  const {
    providerName,
    providerModel,
    providerBaseUrl,
    session,
    sessionControl,
    plugins,
    pluginHost: finalPluginHost,
    runtimeEvents,
    trace,
    metrics,
    runStore,
    eventLog,
    timelineLog,
    feishu: feishuChannel,
  } = bundle;

  // MCP 控制面（bundle 内已安装；保留局部名以兼容后续注入）。
  const mcpControl = bundle.mcp;

  // Stage 4：WorkingContext 归 Run，tenant bundle 不再持有长期存活实例。
  // 外壳的 `ctx.context` 仍需要一个可读窗口：agent 启用时用 local-run-adapter 的
  // 会话镜像；否则（agent 关闭 / headless）用这个独立镜像，避免和执行内核共享实例。
  const context = new MemoryWorkingContext({
    maxTokens: config.context?.maxTokens,
    maxMessages: config.context?.maxMessages,
    autoCompact: config.context?.autoCompact,
    compactThreshold: config.context?.compactThreshold,
    // q-tool-result-whitelist：与执行内核同一口径（缺省 ⇒ core 内置默认）。
    ...(config.context?.toolResultWhitelist !== undefined
      ? { toolResultWhitelist: config.context.toolResultWhitelist }
      : {}),
  });

  // 成员 wiring 的构造参数（与 bundle 内保持一致）。
  const limits = config.limits ?? {};
  const termination = {
    maxIterations: config.termination?.maxIterations,
    maxRuntimeSeconds: config.termination?.maxRuntimeSeconds,
  };
  const permission = {
    default: headless ? ('allow' as const) : ('ask' as const),
    // E7：配置持久化的 always 规则 + 运行时始终免确认的 ask。
    // 老配置里可能仍写着旧工具名（表见 `src/legacy-tool-names.ts`，换算见
    // `normalizeLegacyToolName`），不换算就等于让用户当年选的「always」静默失效。
    autoApprove: [
      ...new Set([...(config.permission?.autoApprove ?? []).map(normalizeLegacyToolName), 'ask']),
    ],
    // 0.27：配置级保险；用户显式配置时以其值为准（与 autoApprove 语义一致，不合并默认）。
    // perm-F1：缺省名单单一真源 `DEFAULT_NEVER_AUTO_APPROVE`（含 pii_reveal）——
    // 与 resolveRuntimePermission / permission-store 同源，热应用整体替换不会抹掉它。
    neverAutoApprove: (config.permission?.neverAutoApprove ?? [...DEFAULT_NEVER_AUTO_APPROVE]).map(
      normalizeLegacyToolName,
    ),
  };

  // ── vessel 元工具（P1，单工具面）：结构化控制面桥 ─────────────────────
  // call_tool 经 vessel-bridge guardrail 改写成目标工具，鉴权落最终目标 + args（ADR-058 决策 2）；
  // rpc/set_config 由 vessel 自执行，方法级鉴权在 vessel.checkPermission（用户裁定 2026-11-18：
  // 不设第二执行器工具）。注册必须先于 wiring.startOwner()——main EU spawn 时快照父宿主
  // 工具列表（spawn 顺序不变式）。dispatcher 建在 agent 装配之后，晚绑定回填（与 feishuTeamId
  // 同口径）；local / serve 共用这一个 localDispatcher。
  let vesselRpcPort: VesselRpcPort | undefined;
  // O2：bridge_deny 活引用（缺省 [] = P1 行为零变化）；permission 热应用 applier 更新。
  const bridgeDenyRef = { current: normalizeBridgeDeny(config.permission?.bridgeDeny) };
  const vesselMeta = createVesselMetaSurface({
    getLocalRpc: () => vesselRpcPort,
    getBridgeDeny: () => bridgeDenyRef.current,
  });
  finalPluginHost.registerTool(vesselMeta.vessel);
  finalPluginHost.registerGuardrail(vesselMeta.bridgeGuardrail);

  // ── AgentService + REPL owner 端点（0.17 Phase A）──
  let agentControl: BootstrapResult['agent'];
  /**
   * 运行期通知总线（热应用 / 版本检查 / 成员停下共用）。
   *
   * 只有在 agent 装配（`finalPluginHost` 存在）时才建；CLI 的 serve 壳复用这个实例
   * （见 `BootstrapResult.notice`），不再自己建第二个总线。
   */
  let noticeBus: RuntimeNoticeBus | undefined;
  /** 成员停下通知的投递面（窗口合并 / 每轮一条 / 定向父 session）。 */
  let peerNotices: PeerNoticeRouter | undefined;
  /** node 健康订阅 watcher（q-health-subscription；需求驱动周期探测，快照供插件观察）。 */
  let nodeHealthWatch: NodeHealthWatch | undefined;
  /**
   * 图片 blob 池的 GC 定时器（0.56 P1）。缺省开：孤儿 blob 不清会一直占着 2 GiB 池，
   * 触顶之后新图不再内联（静默降级）。第一趟固定 dry-run（只报「将删 N / 共 M」）。
   */
  let imageBlobGc: ImageBlobGcRunner | undefined;
  /**
   * 附件暂存区 TTL GC（file-ref-ux A2）：drop/paste 上传的临时副本 60min + 1h 宽限。
   * 与 blob GC 同形态（第一趟 dry-run、unref、在飞不叠）。
   */
  let stagingGc: StagingGcRunner | undefined;
  /**
   * auto-gc P1：closed / 归档数据自动回收调度器。缺省开（用户裁定：系统应自清洁；
   * 保护不变量保安全）。第一趟固定 dry-run；配置经 live resolver 活生效。
   */
  let autoPrune: AutoPruneRunner | undefined;
  /** auto-gc P1 热应用入口（return 处透传给 CLI 的 applyAutoPrune）。 */
  let applyAutoPruneConfig: ((next: VesselConfig) => string[]) | undefined;
  /**
   * 0.53 notice-rotate：成员停下通知要按**投递那一刻**父成员当前的 session 定向，而
   * router 建在 `createAgentServiceWiring` 之前 —— 同样晚绑定（与 `feishuAgentService`
   * 同口径），闭包在 flush 时求值；装配前为 undefined 时通知退回报告时刻的 session。
   */
  let noticeAgentService: AgentService | undefined;
  /**
   * S7 热应用：出站 federation 端口的原地更新入口（agent 装配且 federation 启用时
   * 才有）。在函数级声明，return 处透传给 CLI 的 applyFederation。
   */
  let federationApply: ((next: FederationRuntimeOptions) => void) | undefined;
  // ── 自重启 Option A / gateway.restart 预约面（P1 批5 迁 node-restart.ts）──
  // 纯闭包工厂（构造期零副作用）；updateResumeMarker 供启动恢复段共用，
  // 先于 agent 装配创建（原为提升函数声明，时序语义不变）。
  const { updateResumeMarker, selfRestart, gatewayRestart } = createNodeRestartSurface({
    bundle,
    executionRuntime,
    config,
    dataDir,
    logger,
    resolveAgentControl: () => agentControl,
  });

  if (agentServiceEnabled) {
    const assembly = await assembleAgentWiring({
      config,
      liveConfigRef,
      bundle,
      executionRuntime,
      engineClient,
      currentSessionId,
      interactiveHumanAvailable,
      headless,
      logger,
      dataDir,
      nodeId,
      nodeName,
      tenantId,
      agentPlan,
      termination,
      limits,
      permission,
      updateResumeMarker,
      resolveNoticeAgentService: () => noticeAgentService,
    });
    // 晚绑定回填（语义不变：getter/活引用原地读，时序与拆分前一致，均先于 startOwner）。
    noticeBus = assembly.noticeBus;
    peerNotices = assembly.peerNotices;
    nodeHealthWatch = assembly.nodeHealthWatch;
    federationApply = assembly.federationApply;
    feishuTeamId = assembly.feishuTeamId;
    feishuAgentService = assembly.feishuAgentService;
    noticeAgentService = assembly.noticeAgentService;
    // 顺序契约：`main` 的 ExecutionUnit 在 spawn 时快照父宿主工具列表，
    // 必须等 `agent` 工具注册完再派生 owner，否则 main 永久缺 `agent`。
    const owner = await assembly.wiring.startOwner();
    markStartup('agent.owner');
    agentControl = await finishAgentAssembly(
      {
        config,
        liveConfigRef,
        bundle,
        executionRuntime,
        engineClient,
        currentSessionId,
        interactiveHumanAvailable,
        headless,
        logger,
        dataDir,
        nodeId,
        nodeName,
        tenantId,
        agentPlan,
        termination,
        limits,
        permission,
        updateResumeMarker,
        resolveNoticeAgentService: () => noticeAgentService,
      },
      assembly.wiring,
      owner,
    );
  }

  // ── Durable resume（0.3）─────────────────────────
  // 恢复只走 tenant runtime 的 `ExecutionUnit.resumeRun`（不注入合成消息）。
  const { runs, resumeRun } = createDurableResumeSurface({
    bundle,
    runStore,
    tenantPaths,
    clock: options.clock,
    dataDir,
    tenantId,
    logger,
    eventLog,
    resolveAgentControl: () => agentControl,
  });

  // ── Local RPC dispatcher（0.5 A-5）───────────────
  // 本地模式不监听端口；CLI/TUI 通过 ctx.rpc 走与 gateway 相同的方法表。
  const localAuth = resolveGatewayAuth(config, {
    hostname: '127.0.0.1',
    allowRemote: false,
    env: process.env,
  });
  // 0.18：本地模式只有一个 tenant 流；dispatcher 与 gateway 共用同一个 hub。
  const localEventHub = createGatewayEventHub({
    stream: runtimeEvents,
    // 0.18：live 与 trace 同源（bundle.redactor 已是 core+ext 组合实例）。
    redactor: bundle.redactor,
  });
  // 0.28 C3：本地 `runs.*` 控制面（与 dispatcher / TUI 适配器共用同一实例）。
  // agent 未启用时缺省 undefined，`runs.start` 保持既有 forbidden 语义。
  const localRunControl =
    agentControl !== undefined
      ? createRunControl(agentControl.service, bundle.scheduler, tenantId)
      : undefined;

  // 0.43：本地 REPL / local run 与 gateway 共用同一体验型 plugin 宿主
  //（懒激活 + onStartup 预激活；关闭时显式 stopAll）。
  const localPluginHostManager = createPluginHostManager({
    loader: bundle.pluginLoader,
    config,
    dataDir,
    logger,
  });
  await activateStartupPlugins(localPluginHostManager, {
    loader: bundle.pluginLoader,
    config,
    tenantId,
    logger,
  });
  // P1-w2d（D3）：install 后登记 in-process 能力插件的 RPC / 贡献面（w1a 接缝）；
  // 返回的基础行并入下方 plugins 数据源（provider 类不在 bundle.plugins 里）。
  const inProcessPluginRows = bundle.registerInProcessPlugins(localPluginHostManager, config);
  const reloadLocalPlugins = createPluginReloader({
    loader: bundle.pluginLoader,
    manager: localPluginHostManager,
    getConfig: () => config,
  });
  // 0.43 E3：本地模式同样监听项目/用户插件目录与 config，变更即 rescan + reload。
  const localPluginWatch = startPluginWatch({
    onChange: ({ paths }) => {
      void reloadLocalPlugins.reload().catch((error) => {
        logger.warn('plugin.reload.failed', {
          error: error instanceof Error ? error.message : String(error),
          paths,
        });
      });
    },
  });

  // R-6：kanban deps（可变对象，同一引用进 localDispatcher opts.kanban 与 result.kanbanDeps）。
  // 解析走共享 resolveKanbanBoardPath（cli 网络面同源）；热应用由 cli applyKanban 原地改。
  const kanbanDeps: { boardPath: string } = { boardPath: resolveKanbanBoardPath(config.kanban) };

  // bootstrap P0（设计稿 §5）：本地面与 cli 网络面共用同一插件读面工厂。
  // 修复两处缺口：①原手写 plugins() 跳过 child（mode==='child' → continue）但本地面
  // 没有补 statuses 行 → marketplace/usage 等体验插件整行不可见；②opts 未传
  // pluginCatalog → serve 兜底 () => [] → 本地 plugins.catalog 恒空。
  // getConfig 读 liveConfigRef.current：本地读面从启动 config 升级为活配置（与 cli 同源）；
  // child settings 启动钉死（plugin-host-assembly 本地语义）不在本批动，另议。
  const pluginSurface = createPluginSurface({
    loader: bundle.pluginLoader,
    loadedPlugins: plugins,
    inProcessRows: inProcessPluginRows,
    manager: localPluginHostManager,
    getConfig: () => liveConfigRef.current,
    startupConfig: bundle.config,
    surfaces: bundle.pluginSurfaces,
    pendingInProcessRestart: () => reloadLocalPlugins.pendingInProcessRestart(),
  });

  const localDispatcher: LocalRpcDispatcher = createLocalRpcDispatcher({
    hub: localEventHub,
    session,
    // 会话级上下文用量（additive `sessions.get.context_usage`）：从**时间线**尾窗派生
    // （历史会话 / rotate 后 / 重启后都可用）。`contextWindowTokens` 与 runtime 算百分比的
    // 分母同源（`config.context.maxTokens`，缺省走 DEFAULT_CONFIG）。
    //
    // 0.54 stop-write：读源是 `bundle.timelineLog`（只读口，没有 append）——
    // `events.ndjson` 已停写，装配层也不再拼那条路径去 `stat`。
    ...(timelineLog !== undefined
      ? {
          contextUsage: createContextUsageSource({
            tail: timelineLog,
            watermark: (sessionId: string) => timelineLog.watermark(sessionId),
            ...(config.context?.maxTokens !== undefined
              ? { contextWindowTokens: config.context.maxTokens }
              : {}),
          }),
          // 请求组成快照（additive `sessions.composition`，q-context-composition）：
          // 同一个读口，取 `context.composition` 事实事件（每请求一条成分明细）。
          composition: createContextCompositionSource({ tail: timelineLog }),
          // 「模型这一轮看到了什么系统消息」（additive `sessions.get.system_context`）：
          // 同一个读口，取的是另一类事件（`prompt.system_context`）。
          // 事件不是 message ⇒ 回放窗口淘汰 / 进程重启后只有重新派生才能把卡找回来。
          systemContext: createSystemContextSource({
            tail: timelineLog,
            watermark: (sessionId: string) => timelineLog.watermark(sessionId),
          }),
          // 每张图的投递状态（additive `sessions.get.session.messages[].image_delivery`，0.56）：
          // 同一个读口，取的是另一类事件（`image.sent` / `context.image_dropped`）。
          // 从事件派生而不是写进 refs —— 后者会改写历史前缀且被 messageSignature 无视。
          imageDelivery: createImageDeliverySource({
            log: timelineLog,
            watermark: (sessionId: string) => timelineLog.watermark(sessionId),
          }),
          // `sessions.events` 回填 + `sessions.get.event_cursor`：与上面两个同一个读口，
          // serve 只做游标/分页。
          sessionEvents: createSessionEventsSource({
            log: timelineLog,
            watermark: (sessionId: string) => timelineLog.watermark(sessionId),
          }),
        }
      : {}),
    // 0.54 A：timeline 四字段（additive `sessions.get.event_cursor` 的 `timeline_head` /
    // `wal_head` / `published_head` / `holes` / `tainted`）。双写开关关 / 该会话没有
    // timeline ⇒ 一起缺省。
    ...(bundle.timelineDualWrite !== undefined
      ? {
          timelineHeads: {
            lookup: (sessionId: string) =>
              bundle.timelineDualWrite?.heads(sessionId) ?? Promise.resolve(undefined),
          },
          // 0.54 B1：时间线 epoch 的两个端口。`readPage` 是历史页，`timelineTail` 是
          // 发布点实时尾随（`pub-i2` 的 `onPublish` 扇出；serve 按连接的 session_id 过滤）。
          timelineRead: {
            readPage: (
              sessionId: string,
              options: { afterSeq: number; untilSeq?: number; limit?: number },
            ) => bundle.timelineDualWrite?.readPage(sessionId, options) ?? Promise.resolve([]),
          },
          timelineTail: timelineTailPort(bundle.timelineDualWrite),
        }
      : {}),
    pluginHostManager: localPluginHostManager,
    pluginsReload: () => reloadLocalPlugins.reload(),
    // S4：本地 RPC 同样注入插件设置写面（与 gateway 模式同一 asm 函数）。
    pluginsConfigSet: (plugin: string, key: string, value: string | number | boolean) =>
      setPluginConfigValue(plugin, key, value),
    // 0.15: local RPC runs also take the session write lock.
    runtime: bundle.runtime,
    context,
    pluginHost: finalPluginHost,
    ...(localAuth.ok ? { auth: localAuth.auth } : {}),
    version: readPackageVersion(),
    nodeId,
    nodeName,
    defaultTenantId: tenantId,
    config: {
      snapshot: async (): Promise<ConfigSnapshotLike> =>
        buildConfigSnapshot({
          config: sanitizeConfigForSnapshot(config),
          sources: loaded.sources,
          paths: loaded.paths,
          tenantId,
        }) as unknown as ConfigSnapshotLike,
    },
    // bootstrap P0：与 cli 网络面同源（createPluginSurface）——child runtime 行 +
    // 显式 disabled 补行 + 活配置口径由工厂统一提供；catalog 首次注入本地面。
    plugins: pluginSurface.entries,
    pluginCatalog: pluginSurface.catalog,
    ...(metrics ? { metrics: () => metrics.snapshot() } : {}),
    metricsControl: {
      ...(typeof (metrics as unknown as { reset?: unknown })?.reset === 'function'
        ? { reset: () => (metrics as unknown as { reset: () => void }).reset() }
        : {}),
      rebuild: () => rebuildMetrics(tenantPaths.events_dir),
    },
    // 0.54 C：`events.list` 换源到时间线（`seq` = `timeline_seq`）。旧的
    // `readEvents: (filter) => readTraceEvents(events_dir, filter)` 已删除：那条路读
    // `data/events/<run_id>.jsonl` 的 per-run 序号，与登记在 CHANGELOG 的新语义同名不同义。
    // timeline 的 run 索引是**会话内**的，所以 run → session 的解析也在端口实现里。
    timelineRunEvents: createTimelineRunEventsPort({
      sessionsDir: tenantPaths.sessions_dir,
      logger,
      // 快路径：durable 打开的安装能从 RunRecord 一次读到 `session_id`。
      ...(bundle.runStore !== undefined
        ? {
            resolveSession: async (runId: string) => {
              const record = await bundle.runStore?.load(runId);
              return record?.session_id;
            },
          }
        : {}),
    }),
    trace: {
      prune: (params: Record<string, unknown>) => {
        const pruneOptions = {
          ...(typeof params.older_than_days === 'number'
            ? { retentionDays: params.older_than_days }
            : {}),
          ...(typeof params.max_runs === 'number' ? { maxRuns: params.max_runs } : {}),
          ...(typeof params.max_bytes === 'number' ? { maxBytes: params.max_bytes } : {}),
        };
        // 0.49 T5：data-dir 写意图锁（中性命名）；同进程重复加锁由 withDataLock 识别。
        return withDataLock({ dataDir: tenantPaths.root }, () =>
          pruneTrace(tenantPaths.events_dir, pruneOptions),
        );
      },
    },
    sessionData: {
      deleteSessionData: (sessionId: string) =>
        withDataLock({ dataDir: tenantPaths.root }, async () => {
          // 0.34 Stage 3：sessionControl.delete 内部先 detach；冲突（active run /
          // 活 SessionLease）直接抛 `conflict`，不做任何删除。
          return sessionControl.delete(sessionId);
        }),
    },
    redactor: bundle.redactor,
    ...(runStore
      ? {
          durable: {
            store: runStore,
            ...(runs
              ? {
                  resume: async (runId: string) => {
                    const handle = await runs.resume(runId);
                    void handle?.done;
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(mcpControl ? { mcp: { listServers: () => mcpControl.list() } } : {}),
    ...(feishuChannel ? { feishu: { status: () => feishuChannel.status() } } : {}),
    // 0.28 C3：本地裸跑与 `--serve` 共用同一套方法表——`agents.*` / `teams.*` /
    // `runs.*` 必须注入同一批控制面，否则 TUI 里 `agents.create` 返回 not_found、
    // `runs.start` 返回 forbidden。三者在 agent 未启用时保持缺省（方法进 manifest，
    // handler 按既有语义报错），不新增实体。
    ...(agentControl !== undefined
      ? { agent: agentControl.control, teams: agentControl.team, runControl: localRunControl }
      : {}),
    // 0.52：async ask 的答案投放（本地 REPL / 本地 dispatcher 也要能起那一次新 run）。
    // 与 `--serve` 同一份实现：答案作为 user 消息进成员 inbox 并起新 run。
    ...(agentControl !== undefined
      ? { askAnswerDelivery: createAskAnswerDelivery(agentControl.service) }
      : {}),
    // 0.52：attachments.list 的列举器（节点侧只读目录浏览）。与读文件工具同一份
    // basic-tools 配置（allowed_roots / deny_paths）—— 面板列出来的路径必须与读侧判定同源。
    listAttachments: createConfigAttachmentLister({ getConfig: () => config }),
    // R-1（q-restart-tool）：vessel op=rpc 走的是本 localDispatcher（vesselRpcPort），
    // gateway.restart 必须在这里同样注入，否则设计主入口 not_supported——
    // cli.ts 的网络 gatewayOptions 只是另一路。惰性包装：gatewayRestart 定义在
    // 装配后段，dispatch 发生时早已初始化（TDZ 无虞）。additive 只补 restart；
    // selfRestart/shutdown/reload 的本地面缺口另议，不在本批扩面。
    restart: async (input) => gatewayRestart(input),
    // R-6（q-tooling-cosmetic，同 R-1 模式）：vessel op=rpc 走的是本 localDispatcher
    // （vesselRpcPort），kanban.* 必须在这里同样注入 deps，否则设计主入口
    // not_found「board path is not configured」——cli.ts 的网络 gatewayOptions 只是另一路。
    // 可变对象：cli 的 applyKanban 热应用经 result.kanbanDeps 原地更新（handler 每次调用读）。
    kanban: kanbanDeps,
    // file-ref-ux（A2/A3/A4）：暂存上传 + 预览/过期探针。边界与入池同一份
    // basic-tools 配置；暂存根已由 buildPathBoundary 追加进允许根。
    stageAttachment: createConfigAttachmentStager({ getConfig: () => config }),
    previewAttachment: createConfigAttachmentPreviewer({ getConfig: () => config }),
  });
  // vessel 元工具的 RPC 端口回填：与 gateway 同一方法表 / 同一权限语义（本地 principal）。
  vesselRpcPort = localDispatcher;
  // A1：本地 RPC ← runtimeEvents 的只读桥接。TUI 的 `/runs resume`
  // 只靠 `rpc.subscribe` 等待终态；缺少 onEvent 时订阅是 no-op，命令会一直挂起。
  // 通知只再分发，不写回事件流。
  const localRpcClient = createLocalRpcClient({
    dispatch: localDispatcher.dispatch,
    onEvent: (handler) =>
      runtimeEvents.subscribe((event) => {
        handler({ method: 'events.event', params: event });
      }),
  });

  // ── 权限控制面（0.6.1 E7；tui 的 `ReplContext.permissions`）────
  // 用户 YAML 的 permission.auto_approve；TUI "always" 与 /permissions 共用。
  const permissionConfigPath = options.userConfigPath ?? getUserConfigPath();
  const permissionsControl = {
    list: async (): Promise<string[]> => listAutoApproveRules({ configPath: permissionConfigPath }),
    add: async (toolName: string): Promise<void> => {
      await addAutoApproveRule(toolName, { configPath: permissionConfigPath });
    },
    remove: async (toolName: string): Promise<void> => {
      await removeAutoApproveRule(toolName, { configPath: permissionConfigPath });
    },
    path: (): string => permissionConfigPath,
  };

  // ── 权限 "always" 持久化（0.6.1 E7）────────────────
  // 只在真正交互的本地 REPL 生效：remote/connect 的授权属于远端 gateway，
  // serve/headless 的 allow 不是用户显式选择。
  let unsubPermissionPersist: (() => void) | undefined;
  if (interactive) {
    const pendingTools = new Map<string, string>();
    unsubPermissionPersist = runtimeEvents.subscribe((event) => {
      const data = isRecordValue(event.data) ? event.data : undefined;
      if (!data) return;

      if (event.type === 'tool.permission.request') {
        const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
        const tool = typeof data.tool === 'string' ? data.tool : undefined;
        if (requestId === undefined || tool === undefined) return;
        pendingTools.set(requestId, tool);
        while (pendingTools.size > 1000) {
          const first = pendingTools.keys().next();
          if (first.done) break;
          pendingTools.delete(first.value);
        }
        return;
      }

      if (event.type !== 'tool.permission.response') return;
      const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
      const tool = requestId === undefined ? undefined : pendingTools.get(requestId);
      if (requestId !== undefined) pendingTools.delete(requestId);
      if (tool === undefined || data.remember !== true) return;

      // q-env-card-visibility-fix：写盘改走 withConfigLock（async）。事件回调是同步的，
      // 失败用 .catch 收口（原 try/catch 只能接同步抛错，async 化后会漏成 unhandled rejection）。
      addAutoApproveRule(tool, { configPath: permissionConfigPath }).catch((error) => {
        console.warn(
          `⚠ Failed to persist permission rule for "${tool}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  }

  // ── node 退出序列 + 关闭（P1 批6 迁 shutdown-sequence.ts）──
  // 步骤顺序在工厂内显式顺序书写；晚绑定 let 经 getter/setter 原地读写（语义不变）。
  const { beginDrain, shutdown } = createShutdownSequence({
    bundle,
    executionRuntime,
    engineClient,
    engineSupervisor,
    poolTransportRef,
    localPluginWatch,
    localPluginHostManager,
    localDispatcher,
    localEventHub,
    logger,
    tenantId,
    resolveProcessSessionLock: () => processSessionLock,
    resolveAgentControl: () => agentControl,
    resolveUnsubPermissionPersist: () => unsubPermissionPersist,
    clearUnsubPermissionPersist: () => {
      unsubPermissionPersist = undefined;
    },
    resolvePeerNotices: () => peerNotices,
    clearPeerNotices: () => {
      peerNotices = undefined;
    },
    resolveNodeHealthWatch: () => nodeHealthWatch,
    clearNodeHealthWatch: () => {
      nodeHealthWatch = undefined;
    },
    resolveImageBlobGc: () => imageBlobGc,
    clearImageBlobGc: () => {
      imageBlobGc = undefined;
    },
    resolveStagingGc: () => stagingGc,
    clearStagingGc: () => {
      stagingGc = undefined;
    },
    resolveAutoPrune: () => autoPrune,
    clearAutoPrune: () => {
      autoPrune = undefined;
    },
    clearNoticeAgentService: () => {
      noticeAgentService = undefined;
    },
  });
  // ── 本地 TUI 的执行适配器（0.28 C3 / D10 / D12）─────────
  // 本地裸跑不能直连 `bundle.runtime`：那条路径绕过 `admit`，每个会话都用到
  // tenant 共享的运行时，C4 的 role 感知策略对它无效（PLAN §12.3）。
  // 适配器把执行转成 `runs.start → admit`，并把 `ctx.context` 换成当前 body 的镜像。
  const localRun =
    agentControl !== undefined && localRunControl !== undefined
      ? createLocalRunAdapter({
          events: runtimeEvents,
          pluginHost: finalPluginHost,
          runControl: localRunControl,
          agentControl: agentControl.control,
          session,
          // 0.34 S2 / C5：TUI mirror 与 tenant 上下文同源（阈值 / 预算 / 自动压缩）。
          contextConfig: config.context,
          // C6：`/compact` 走 tenant 执行门面 → 已存在的 EU；RunnableAgent 类型
          // 不暴露该可选方法，按结构读取（门面 / 写锁包装都以结构透传）。
          compactContext: (sessionId) => {
            const runtime = bundle.runtime as RunnableAgent & {
              compactContext?(
                id: string,
              ): Promise<{ removed: number; remaining: number; messages?: Message[] }>;
            };
            if (typeof runtime.compactContext !== 'function') {
              return Promise.reject(new Error('compact_unavailable'));
            }
            return runtime.compactContext(sessionId);
          },
        })
      : undefined;

  // ── ReplContext ─────────────────────────────────
  // 工具/插件的唯一来源是同一个 PluginHost（插件在 install() 里注册）。
  const baseRuntime: RunnableAgent = localRun?.runtime ?? bundle.runtime;
  // Q5：显式 `-r/--resume <id>` 的首轮走 resumeSession；connect 模式不走这里。
  const resumableRuntime =
    options.resumeSessionId !== undefined
      ? withFirstRunResume(baseRuntime, options.resumeSessionId)
      : baseRuntime;
  const ctx: ReplContextWithPermissions = {
    runtime: resumableRuntime,
    pluginHost: finalPluginHost,
    session,
    events: runtimeEvents,
    context: localRun?.context ?? context,
    currentSessionId,
    onSessionChange: (id) => {
      currentSessionId = id;
      // D12：切会话（/new、/resume、/runs resume）后把镜像指向该会话。
      void localRun?.runtime.focusSession(id);
    },
    provider: { name: providerName, model: providerModel, baseUrl: providerBaseUrl },
    plugins: plugins.map((p) => p.name),
    rpc: localRpcClient,
    tenant: { data_dir: tenantPaths.root },
    config,
    version: readPackageVersion(),
    // 0.6.1：TUI "always" 与 /permissions 的用户 YAML 写回面。
    permissions: permissionsControl,
    // 0.18：resume 历史从会话事件日志重建；memory / 只读执行面没有日志时保持 undefined。
    ...(eventLog ? { eventLog } : {}),
    // 0.11：TUI /settings 的语言写回面（同一用户 YAML）；0.13 增加状态栏位置。
    settings: createReplSettings({
      configPath: permissionConfigPath,
      configLanguage: config.ui?.language,
      ...(config.ui?.statusBars !== undefined ? { configStatusBars: config.ui.statusBars } : {}),
      ...(config.ui?.errorLevel !== undefined ? { configErrorLevel: config.ui.errorLevel } : {}),
      ...(config.ui?.verbosity !== undefined ? { configVerbosity: config.ui.verbosity } : {}),
    }),
    // 0.3 注入面：未启用时保持 undefined，既有行为不变。
    ...(mcpControl ? { mcp: mcpControl } : {}),
    ...(runs ? { runs } : {}),
    // 0.4 注入面：未启用时保持 undefined。
    ...(metrics ? { metrics: () => metrics.snapshot() } : {}),
    ...(feishuChannel ? { feishu: { status: () => feishuChannel.status() } } : {}),
    newSessionId,
    onExit: () => {
      void shutdown().finally(() => process.exit(0));
    },
  };

  // REPL / serve / node：prune 在 bootstrap 返回后由 timer 执行，启动不等它（S4 D2）。
  // `unref()`：清理任务不该把进程挂住（headless 仍然走上面的 await，语义不变）。
  if (pruneAfterFirstFrame) {
    const timer = setTimeout(() => {
      void pruneTraceBestEffort();
    }, 0);
    (timer as { unref?: () => void }).unref?.();
  }

  // ── 0.56 P1：图片 blob 池 GC（第一趟 dry-run，之后定时真删）────────────────────
  // 三条纪律：① 引用集合扫「会话壳 + 事件日志」两处（漏一处 = 删在用图）；
  // ② 证明不了引用集合就整趟放弃（`aborted`，一个字节都不删）；
  // ③ 超上限**不静默**（warn + 事件 + 一张通知卡）。
  const blobGcEnabled = config.vision?.blobGcEnabled !== false;
  // 安全闸：blob 池必须落在**这个数据目录**里。`VESSEL_BLOB_DIR` 可以把池指到别处
  // （多节点 / 多租户共享一份池），而引用集合只能扫到本目录的会话 —— 那时删任何东西
  // 都是「删别人还在用的图」。宁可不做（漏水），也不猜。
  const blobPoolRoot = imageBlobRoot();
  const blobPoolInside = isBlobRootInsideDataDir(tenantPaths.root, blobPoolRoot);
  if (blobGcEnabled && localWrites && timelineLog !== undefined && !blobPoolInside) {
    logger.warn('image blob gc skipped: blob root outside data dir', {
      data_dir: tenantPaths.root,
      blob_root: blobPoolRoot,
    });
  }
  if (blobGcEnabled && localWrites && timelineLog !== undefined && blobPoolInside) {
    const gcLog = timelineLog;
    imageBlobGc = startImageBlobGc({
      sessionsDir: tenantPaths.sessions_dir,
      log: { read: (sessionId: string) => gcLog.read(sessionId) },
      root: blobPoolRoot,
      ...(config.vision?.orphanGraceHours !== undefined
        ? { orphanGraceHours: config.vision.orphanGraceHours }
        : {}),
      ...(config.vision?.imageBlobTtlDays !== undefined
        ? { ttlDays: config.vision.imageBlobTtlDays }
        : {}),
      ...(config.vision?.blobGcIntervalHours !== undefined
        ? { intervalHours: config.vision.blobGcIntervalHours }
        : {}),
      ...(config.vision?.blobGcDryRun === true ? { dryRun: true } : {}),
      onUnreadable: (sessionId: string, error: unknown) => {
        // 旧格式会话（0.54 之前）没有 blob 池，读不出来是可声明的；**不是静默**。
        logger.warn('image blob gc: session events unreadable', {
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      onReport: (report) => {
        const line = formatImageBlobGcReport(report);
        if (report.aborted !== undefined) {
          logger.warn('image blob gc aborted', {
            reason: report.aborted.reason,
            scanned: report.scanned,
          });
          return;
        }
        logger.info('image blob gc pass', { line, scanned: report.scanned });
        // 报告进事件流：人（Web/TUI）能看到「将删 / 已删」，不必翻日志。
        runtimeEvents.publish({
          type: 'gc.image_blobs',
          run_id: 'gc',
          data: { line, dry_run: report.dryRun, scanned: report.scanned, result: report.result },
          ts: Date.now(),
        });
        if (report.result?.overLimit === true) {
          const summary = `Image pool over limit (${report.result.totalBytes} bytes): new images will not be inlined`;
          console.warn(`⚠ ${summary}`);
          noticeBus?.publish({
            scope: 'config',
            summary,
            details: [line],
            ok: false,
          });
        }
      },
    });
  }

  // ── file-ref-ux A2：附件暂存区 TTL GC（60min + 1h 宽限，按 mtime）─────────────
  // 与 blob GC 同闸（localWrites）同形态（第一趟 dry-run、unref）。暂存副本是
  // 用户上传的临时字节，过期回收不需要引用集合扫描（TTL + 宽限即判据）。
  if (localWrites) {
    stagingGc = startStagingGc({
      onReport: (report) => {
        logger.info('attachment staging gc pass', {
          dry_run: report.dryRun,
          scanned: report.scanned,
          reclaimed: report.reclaimed,
          bytes: report.bytes,
        });
      },
    });
  }

  // ── auto-gc P1：closed / 归档 team 数据自动回收（环3）────────────────────────
  // 闸与 blob GC 同口径：connectMode（远程网关的本地进程）绝不跑本地 prune。
  // enabled 缺省 true（用户裁定：系统应自清洁），显式 false 只跳过趟、链不断
  // （live resolver 每趟求值，热重载再开即活）。headless 一次性进程天然不触发
  // （unref + 首趟 setTimeout 0），与 blob GC 同形态，不另设闸。
  if (localWrites) {
    // D3：有活 AgentService 就必须经 registry 摘除（直接改文件会被整份 flush 复活）；
    // 端口建不起来（旧内核缺方法）宁可不做。无 AgentService 时无活 registry，
    // 离线文件模式安全（与 CLI 同路）。
    const onlinePrune =
      agentControl !== undefined ? createOnlinePrunePort(agentControl.service) : undefined;
    if (agentControl !== undefined && onlinePrune === undefined) {
      logger.warn('auto prune skipped: agent service lacks online prune port', {
        data_dir: tenantPaths.root,
      });
    } else {
      // 活配置引用：调度器闭包每趟求值；applyAutoPruneConfig 热应用时原地替换。
      const autoPruneConfigRef: { current: VesselConfig } = { current: config };
      autoPrune = startAutoPrune({
        resolveConfig: () => autoPruneConfigRef.current,
        tenantPaths,
        tenantId,
        ...(onlinePrune !== undefined ? { online: onlinePrune } : {}),
        onReport: (report: AutoPrunePassReport) => {
          const line = formatAutoPruneReport(report);
          if (report.aborted !== undefined) {
            logger.warn('auto prune aborted', { reason: report.aborted.reason });
          } else if (report.skipped_pass !== undefined) {
            logger.info('auto prune pass skipped', { reason: report.skipped_pass });
          } else {
            logger.info('auto prune pass', {
              line,
              dry_run: report.dry_run,
              totals: report.totals,
            });
          }
          // 报告进事件流：人（Web/TUI）能看到「将删 / 已删」，不必翻日志。
          runtimeEvents.publish({
            type: 'gc.agents',
            run_id: 'gc',
            data: { line, ...report },
            ts: Date.now(),
          });
          // 异常 / 拒删（记录摘除失败）不静默：一张通知卡（同 blob GC overLimit 三路）。
          const refused = report.notes.includes('agents_snapshot_write_failed');
          if (report.aborted !== undefined || refused) {
            const summary =
              report.aborted !== undefined
                ? `Auto prune aborted: ${report.aborted.reason}`
                : 'Auto prune: agent snapshot write failed (records kept)';
            console.warn(`⚠ ${summary}`);
            noticeBus?.publish({ scope: 'config', summary, details: [line], ok: false });
          }
        },
      });
      applyAutoPruneConfig = (next) => {
        autoPruneConfigRef.current = next;
        // O4：热改即重排 —— 只换引用不重排的话，挂定的缺省 24h 定时器要明天才按新
        // interval 走。reschedule 清挂起 timer 按当前 interval 立即重排（在飞趟不动）。
        autoPrune?.reschedule();
        return [
          `autoPrune: hot-applied (live resolver; enabled=${next.autoPrune?.enabled !== false}, next pass rescheduled to new interval)`,
        ];
      };
    }
  }

  return {
    runtime: resumableRuntime,
    executionRuntime,
    ctx,
    config,
    liveConfigRef,
    tenantId,
    tenantPaths,
    bundle,
    toolsEngine: { client: engineClient, supervisor: engineSupervisor, bridgeDeny: bridgeDenyRef },
    ...(agentControl !== undefined ? { agent: agentControl } : {}),
    // 运行期通知总线：serve 壳复用它（配置热应用 / 版本检查 / 成员停下同一条通路）。
    ...(noticeBus !== undefined ? { notice: noticeBus } : {}),
    ...(trace ? { trace } : {}),
    sessionControl,
    // S7 热应用：出站端口存在时透传其原地更新入口（入站面由 cli 的 controlPlane 持有）。
    ...(federationApply !== undefined ? { federationApply } : {}),
    // auto-gc P1 热应用：调度器活配置引用的原地更新入口（cli 的 applyAutoPrune 用）。
    ...(applyAutoPruneConfig !== undefined ? { applyAutoPruneConfig } : {}),
    // R-6：localDispatcher 的 kanban deps 透传（cli applyKanban 热应用原地更新）。
    kanbanDeps,
    nodeId,
    nodeName,
    mcp: mcpControl,
    runStore,
    runs,
    feishu: feishuChannel,
    metrics,
    resumeRun,
    shutdown,
    beginDrain,
    selfRestart,
    gatewayRestart,
    cleanup: () => {
      void shutdown();
    },
  };
}
