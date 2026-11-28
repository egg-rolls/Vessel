/**
 * 本地 RPC 表面装配（P1 批9 strangler 纯移动，自 bootstrap.ts 迁出；P2 落地）。
 *
 * `createLocalRpcDispatcher` = `startGateway({localOnly:true})`（packages/serve/
 * src/local.ts）——本地面与 cli 网络面共用同一方法表。本模块只构造本地面 opts：
 * **共享底座 + feature 收集结果展开**（ADR-107 P2：collectedDispatcher 由
 * src/assembly 收集器合并，两表面共消费同一份——「忘接一路」结构上不可能）。
 *
 * 零行为变更：opts 字面量逐字自 bootstrap.ts 移动；脊柱（config/engine/bundle/
 * vessel/agent 注册与 startOwner 先后）仍在主干显式书写。
 */

import type { VesselConfig } from '../../packages/config/src/index';
import { buildConfigSnapshot, type loadConfig } from '../../packages/config/src/index';
import type { Logger, TenantPaths } from '../../packages/core/src/index';
import { pruneTrace, rebuildMetrics } from '../../packages/core/src/index';
import type {
  ConfigSnapshotLike,
  LocalRpcDispatcher,
  LocalRpcOptions,
  PluginHostManager,
} from '../../packages/serve/src/index';
import { createLocalRpcDispatcher } from '../../packages/serve/src/index';
import { createAskAnswerDelivery } from '../agent/ask-answer-delivery';
import { sanitizeConfigForSnapshot } from '../config/config-snapshot';
import { withDataLock } from '../data/data-lock';
import { createGatewayConfigSet } from '../gateway/gateway-config-control';
import type { resolveGatewayAuth } from '../gateway/serve-auth';
import { setPluginConfigValue } from '../plugin/plugin-config';
import type { createPluginReloader } from '../plugin/plugin-host-assembly';
import type { createPluginSurface } from '../plugin/plugin-surface';
import type { createRunControl } from '../run/run-control';
import { createContextCompositionSource } from '../session/context-composition';
import { createContextUsageSource } from '../session/context-usage';
import { createImageDeliverySource } from '../session/image-delivery';
import type { SessionControl } from '../session/session-control';
import { createSessionEventsSource } from '../session/session-events';
import { createSystemContextSource } from '../session/system-context';
import { createTimelineRunEventsPort, timelineTailPort } from '../session/timeline-dual-write';
import { readPackageVersion } from '../shared/version';
import type { BootstrapResult } from './bootstrap-types';
import type { createDurableResumeSurface } from './node-restart';
import type { TenantRuntimeBundle } from './tenant-runtime-factory';

/** 本地面装配输入（主干装配序的既成品；类型多取既有接口/工厂返回，不新造形状）。 */
export interface LocalRpcSurfaceInput {
  localEventHub: Parameters<typeof createLocalRpcDispatcher>[0]['hub'];
  session: LocalRpcOptions['session'];
  timelineLog: TenantRuntimeBundle['timelineLog'];
  config: VesselConfig;
  bundle: TenantRuntimeBundle;
  localPluginHostManager: PluginHostManager;
  reloadLocalPlugins: ReturnType<typeof createPluginReloader>;
  context: LocalRpcOptions['context'];
  finalPluginHost: LocalRpcOptions['pluginHost'];
  localAuth: ReturnType<typeof resolveGatewayAuth>;
  nodeId: string;
  nodeName: string;
  tenantId: string;
  loaded: Awaited<ReturnType<typeof loadConfig>>;
  pluginSurface: ReturnType<typeof createPluginSurface>;
  metrics: TenantRuntimeBundle['metrics'];
  tenantPaths: TenantPaths;
  logger: Logger;
  sessionControl: SessionControl;
  runStore: TenantRuntimeBundle['runStore'];
  runs: ReturnType<typeof createDurableResumeSurface>['runs'];
  mcpControl: TenantRuntimeBundle['mcp'];
  feishuChannel: TenantRuntimeBundle['feishu'];
  agentControl: BootstrapResult['agent'];
  localRunControl: ReturnType<typeof createRunControl> | undefined;
  /** P2 收集器合并结果（第一批：attachments/jobs/kanban/restart） */
  collectedDispatcher: Partial<LocalRpcOptions>;
}

/** 构造本地 dispatcher：opts = 共享底座 + feature 收集结果展开。 */
export function buildLocalRpcSurface(input: LocalRpcSurfaceInput): LocalRpcDispatcher {
  const {
    localEventHub,
    session,
    timelineLog,
    config,
    bundle,
    localPluginHostManager,
    reloadLocalPlugins,
    context,
    finalPluginHost,
    localAuth,
    nodeId,
    nodeName,
    tenantId,
    loaded,
    pluginSurface,
    metrics,
    tenantPaths,
    logger,
    sessionControl,
    runStore,
    runs,
    mcpControl,
    feishuChannel,
    agentControl,
    localRunControl,
    collectedDispatcher,
  } = input;
  return createLocalRpcDispatcher({
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
      // batch8 残留（R-1 同族）：本地面 config.set 写面注入——与 cli 网络面同一 asm
      // 写函数（白名单 isSettableConfigKey + default tenant 防御 + 原子 0600 写）。
      // 此前只注入 snapshot ⇒ 本地 dispatcher（vessel 元工具 op=set_config / TUI）
      // config.set 恒 not_found。写后热应用：serve 模式由 cli configWatch 的 fs 回声
      // 承载；纯本地 REPL 无热应用（liveConfigRef 启动快照语义，与插件读面一致）。
      set: createGatewayConfigSet({
        defaultTenantId: tenantId,
        projectConfigPath: loaded.paths.project,
      }),
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
    // P2 收集器（ADR-107）：feature 贡献的 RPC deps 统一展开（第一批四 feature：
    // attachments 三键 / jobs / kanban / restart）。键冲突 fail-closed 在收集器内。
    // R-1 的 restart 与 R-6 的 kanban 由各自 feature 单点声明，两表面共消费——
    // 「忘接一路」结构上不可能。selfRestart/shutdown/reload 的本地面缺口另议。
    ...collectedDispatcher,
  });
}
