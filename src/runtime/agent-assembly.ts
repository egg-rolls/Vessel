/**
 * AgentService / REPL owner 装配（P1 批 4，自 bootstrap.ts 迁出；ADR-107 strangler）。
 *
 * 顺序承重契约不变：assembleAgentWiring（含 agent 工具注册 + 工具名闸）→
 * 主干显式调用 wiring.startOwner()（顺序可见）→ finishAgentAssembly（恢复/hub/owner 端点）。
 * 晚绑定回填语义不变：trunk 的 let 由返回值原地回填（均先于 startOwner）；
 * notice router 的父 session 重解析经 ctx.resolveNoticeAgentService getter 读 trunk 活引用。
 * 唯一接线改动 = resolveParentSession 一行改读 getter；其余移动体逐字节（整体缩进 -2）。
 */

import type { AgentService, MemberStatus, TeamDeclaration } from '@vessel-agent/agent';
import type { EngineClient } from '@vessel-agent/engine-client';
import { resolveEnvCadence, type VesselConfig } from '../../packages/config/src/index';
import {
  assertToolNameLegality,
  type Logger,
  type Runtime,
  sameRestartMarker,
} from '../../packages/core/src/index';
import type { ResumeAfterRestart } from '../../packages/core/src/types/session';
import { createAgentControl } from '../agent/agent-control';
import { type AgentOwnerServer, startAgentOwnerServer } from '../agent/agent-owner-server';
import { createAgentServiceWiring } from '../agent/agent-service-wiring';
import type { MemberPermissionMode, resolveAgentWiring } from '../agent/agent-wiring';
import { createPeerNoticeRouter, type PeerNoticeRouter } from '../agent/peer-notices';
import {
  createTeamHumanDelivery,
  createTeamLocalMemberDelivery,
  type LocalHumanTarget,
  type LocalMemberTarget,
} from '../agent/team-human-delivery';
import { registerRefsNoticeHook, registerRuntimeNoticeHook } from '../config/hot-apply-assembly';
import { visionSurfaceOf } from '../config/vision-settings';
import { createConfigAttachmentIngest } from '../data/attachment-ingest';
import { resolveAgentCwd } from '../data/path-resolution';
import type { FederationRuntimeOptions } from '../federation/federation-config';
import { loadFederationPeerSecrets } from '../federation/federation-secrets';
import { createFederationSendPort } from '../federation/federation-send-port';
import { createHubRuntime } from '../hub/hub-wiring';
import { resumeContinuations } from '../node/node-continuation';
import { createNodeResumer } from '../node/node-resume';
import { markStartup } from '../observability/startup-timing';
import { callbackRoute } from '../tools-engine/wiring';
import { registerBashJobDelivery } from './bash-job-delivery';
import { resolveDefaultTeamAnchor, resolveDefaultTeamWorkspace } from './bootstrap-connect';
import type { BootstrapResult } from './bootstrap-types';
import { createNodeHealthWatch, type NodeHealthWatch } from './node-health-watch';
import { createRuntimeNoticeBus, type RuntimeNoticeBus } from './runtime-notice';
import type { TenantRuntimeBundle } from './tenant-runtime-factory';

/** 装配输入：全部为 trunk 的稳定 const 引用（destructure 后移动体逐字节不变）。 */
export interface AgentAssemblyContext {
  config: VesselConfig;
  liveConfigRef: { current: VesselConfig };
  bundle: TenantRuntimeBundle;
  executionRuntime: Runtime;
  engineClient: EngineClient;
  currentSessionId: string;
  interactiveHumanAvailable: boolean;
  headless: boolean;
  logger: Logger;
  dataDir: string;
  nodeId: string;
  nodeName: string;
  tenantId: string;
  agentPlan: ReturnType<typeof resolveAgentWiring>;
  termination: { maxIterations: number | undefined; maxRuntimeSeconds: number | undefined };
  limits: NonNullable<VesselConfig['limits']>;
  permission: { default: 'allow' | 'ask'; autoApprove: string[]; neverAutoApprove: string[] };
  /** trunk 的标记单写口（函数声明提升；finishAgentAssembly 用）。 */
  updateResumeMarker: (
    sessionId: string,
    key: { run_id: string; interrupted_at: number },
    transform: (marker: ResumeAfterRestart) => ResumeAfterRestart | undefined,
  ) => Promise<boolean>;
  /** notice router flush 时读 trunk 的 noticeAgentService 活引用（shutdown 会清它）。 */
  resolveNoticeAgentService: () => AgentService | undefined;
}

type AgentServiceWiring = Awaited<ReturnType<typeof createAgentServiceWiring>>;

/** assembleAgentWiring 的产出：wiring + 需回填 trunk let 的晚绑定面。 */
export interface AgentWiringAssembly {
  wiring: AgentServiceWiring;
  noticeBus: RuntimeNoticeBus | undefined;
  peerNotices: PeerNoticeRouter | undefined;
  nodeHealthWatch: NodeHealthWatch | undefined;
  federationApply: ((next: FederationRuntimeOptions) => void) | undefined;
  feishuTeamId: string | undefined;
  feishuAgentService: AgentService | undefined;
  noticeAgentService: AgentService | undefined;
}

/**
 * agent 装配前半（原 bootstrap `if (agentServiceEnabled)` 块自 A3c 至工具名闸）：
 * federation/通知总线/peer router → createAgentServiceWiring → 回填 → agent 工具注册。
 * startOwner 调用点留主干（顺序可见），不在本函数内。
 */
export async function assembleAgentWiring(ctx: AgentAssemblyContext): Promise<AgentWiringAssembly> {
  const {
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
    resolveNoticeAgentService,
  } = ctx;
  const {
    providerModel,
    providerModelRef,
    session,
    sessionControl,
    pluginHost: finalPluginHost,
    runtimeEvents,
    runStore,
    eventLog,
  } = bundle;
  // 晚绑定面（原 trunk 函数级 let；装配后经返回值回填 trunk，时序不变）。
  // federationApply 条件赋值保持 let；其余单赋值用 const（biome useConst，语义等价）。
  let federationApply: ((next: FederationRuntimeOptions) => void) | undefined;
  // A3c：交互入口成员 ask 经父事件流弹现有权限卡片；headless 直接 allow。
  const memberPermissionMode: MemberPermissionMode = agentPlan.permissionMode;
  const memberTermination =
    agentPlan.termination !== undefined
      ? {
          maxIterations: agentPlan.termination.maxIterations ?? termination.maxIterations,
          maxRuntimeSeconds:
            agentPlan.termination.maxRuntimeSeconds ?? termination.maxRuntimeSeconds,
        }
      : termination;
  // 0.19 S3：配置声明（camelCase → TeamDeclaration 的 snake_case）+ 默认 workspace。
  const teamDeclarations: TeamDeclaration[] = (config.teams ?? []).map((team) => ({
    ...(team.name !== undefined ? { name: team.name } : {}),
    workspace: team.workspace,
    ...(team.policy !== undefined ? { policy: team.policy } : {}),
  }));
  // 0.28 C3：打开目录即建 Team。声明命中优先；否则交互 / serve 入口用 agent.cwd，
  // 未配置时用 dataDir 派生的稳定锚点（不是各进程 cwd，TUI 与 gateway 的 node 子进程
  // 因此共用同一个默认 Team）。headless（`--run` / 管道）保持 undefined：
  // 一次性进程不该在数据目录里留空 Team。
  const defaultWorkspace =
    resolveDefaultTeamWorkspace(config, teamDeclarations, logger) ??
    (headless ? undefined : (resolveAgentCwd(config) ?? resolveDefaultTeamAnchor(dataDir)));
  // 0.27：发给人类的 send 直接写本机 Team 日志（异步委派，不阻塞 agent）。
  // Team 服务在 createAgentServiceWiring 之后才存在，这里用晚绑定 getter 回填。
  let localHuman: LocalHumanTarget | undefined;
  let localMember: LocalMemberTarget | undefined;
  // 0.21 S8.2：federation 缺省启用；显式 `federation.enabled: false` 才不注入。
  // 语义不只是「跨节点所以关掉就没」：本机人类投递也挂在这个端口上，关掉 federation
  // 等于连「agent 找本机人类」一起关掉。见下方 localHuman 的构造。
  // q-fed-simple：`tokenSecret` peer 的 token 先从 SecretStore 预加载进内存。
  const federationSecrets = await loadFederationPeerSecrets({
    dataDir,
    federation: config.federation,
    logger,
  });
  // q-health-subscription：node 健康订阅 watcher（doc-subscription health 源的宿主侧）。
  // 需求驱动：扫到 health 订阅才探测；快照落插件 stateDir，插件 run 边界读快照发通知
  //（与文件订阅同一投递路径）。federation 关掉也建：本机 node 订阅不依赖 federation。
  const nodeHealthWatch = createNodeHealthWatch({
    getConfig: () => liveConfigRef.current,
    dataDir,
    nodeId,
    secrets: federationSecrets,
    logger,
  });
  nodeHealthWatch.start();
  const federation =
    config.federation?.enabled !== false
      ? createFederationSendPort({
          federation: config.federation ?? {},
          nodeId,
          secrets: federationSecrets,
          // 展示名只用于把指向本机的 `to` 归一化，不参与向外的 from。
          nodeName,
          localHuman: () => localHuman,
          localMember: () => localMember,
          // 4.1：durable outbox —— peer down 的出站消息持久化待投递（bounded
          // retry + 重连补投 + 幂等），进程重启续投；事件进结构日志（不含 token）。
          outboxDir: dataDir,
          onOutboxEvent: (event) => {
            if (
              event.kind === 'exhausted' ||
              event.kind === 'full' ||
              event.kind === 'load_failed'
            ) {
              logger.warn(`federation.outbox.${event.kind}`, { ...event });
            } else {
              logger.info(`federation.outbox.${event.kind}`, { ...event });
            }
          },
        })
      : undefined;
  if (federation !== undefined) {
    federationApply = (next) => federation.applyFederationOptions(next);
  }
  // 运行期通知总线（CONTRACT-hot-apply §3）：热应用 / 版本检查 / 成员停下共用同一条
  // 总线与同一个 BeforeLlm hook —— 两个总线会让两个 hook 争同一个注册名（后者被跳过）。
  // 建在这里而不是 serve 壳里：TUI 入口同样要看到成员停下通知，serve 复用这一个实例。
  const noticeBus = createRuntimeNoticeBus({
    events: runtimeEvents,
    tenantId,
    // P2：off 在 publish 入口丢（live getter）；诊断日志走中枢。
    envInjection: () => liveConfigRef.current.envInjection,
    logger,
  });
  registerRuntimeNoticeHook(
    finalPluginHost,
    noticeBus,
    eventLog,
    () => liveConfigRef.current.envInjection,
  );
  // 0.52：附件引用的环境信息行（模型据此知道有附件、该用 media 工具读）。
  // 0.56 P1：带上视觉面探针——有 `provider.vision` 且没被 kill switch 关时，尾注改说
  // 「图已随本条消息附上，不要再读」（避免模型把图再 media: read 一遍 = 双倍花费）。
  registerRefsNoticeHook(finalPluginHost, {
    vision: () => visionSurfaceOf({ config, backend: bundle.provider.vision }),
  });
  const peerNotices = createPeerNoticeRouter({
    bus: noticeBus,
    events: runtimeEvents,
    logger,
    // 0.53 notice-rotate：变更上的 `parent_session_id` 是报告时刻父 body 的 session；
    // 合并窗口内父若 rotate，新 body 换了 session，这条 notice 就只落到旧 body 上。
    // 真正投递那一刻用这条链接重解析父成员**当前** primary body 的 session
    // （`AgentService.peerParentSessionOf` 内部即 `currentBindingSession`）。
    // 注意入参是**上报变更的成员（子）id**（`PeerStopChange.agent_id`），不是父 id。
    // 晚绑定：router 建在 wiring 之前，闭包在 flush 时才读。
    resolveParentSession: (memberId) => resolveNoticeAgentService()?.peerParentSessionOf(memberId),
    // q-peer-notice-cadence：发射 gating 的唯一真相源 = envGranularity 的 peer cadence。
    // live resolver：report / schedule / flush 实时求值 ⇒ 热改即时生效。
    // request（内置缺省）= mid-run 可发；run = hold 到父 run 收口 + 一轮一条；off = 静默。
    cadence: () => resolveEnvCadence('peer', liveConfigRef.current.envInjection),
  });
  const wiring = await createAgentServiceWiring({
    // 来源行的 node 段与 federation 端口共用 nodeIdentity：federation 关掉时
    // 来源行仍要本机 node 段，不能只挂在 send port 上。
    nodeId,
    // q-addr-display：node 名同源传入（name 档来源行）；显示风格读 ui.addressStyle，
    // 装配期取值（重启生效；hot-apply 留扩展位）。缺省由执行内核兜底 name。
    nodeName,
    ...(config.ui?.addressStyle !== undefined ? { addressStyle: config.ui.addressStyle } : {}),
    tenantId,
    dataDir,
    sessionId: currentSessionId,
    pluginHost: finalPluginHost,
    // Stage 4：成员 EU 经同一 Runtime 的 getOrCreateExecutionUnit 取得；
    // agentId 绑定保证同 session 不会被 tenant / 成员两条路径静默复用。
    runtime: executionRuntime,
    // 成员 run durable：RunRecord 与 tenant run 同一条 journal 写路径。
    ...(runStore !== undefined ? { runStore } : {}),
    // 第 6 修（SPAWN-02）：宿主缺省存**ref**（条目键 / legacy 透传 ref）而非 wire——
    // spawn 继承 member.model ?? this.model 经 resolveModelRef 解析，裸 wire 名在
    // legacyPresent=false（纯 registry / provider 块已删）时无命中 → spawn_failed，
    // 全新 dataDir 的 main 创建（createOrRestoreOwner 不带 model）即 boot 死。
    // 展示面（selfCard / REPL / summary）仍用 wire：modelWire 与缺省 ref 分离。
    // config.agent.model 是用户显式值，原样作 ref（与旧语义字节等价）。
    model: agentPlan.model ?? providerModelRef,
    modelWire: agentPlan.model ?? providerModel,
    // 第 6 修（CHAIN-11/SPAWN-05）：tool 层 create/hire 显式 pin 与 RPC 同闸。
    ...(bundle.validateModelRef !== undefined ? { modelRefError: bundle.validateModelRef } : {}),
    limits: agentPlan.limits ?? limits,
    termination: memberTermination,
    ...(agentPlan.readOnlyTools !== undefined ? { readOnlyTools: agentPlan.readOnlyTools } : {}),
    // 0.51：成员工具面 = 节点全量（只剩 deny 只读档与 bridge 两条闸），`ask` 不再由
    // 装配层点名放行。它的可用性现在完全由两条真实事实决定：父宿主真的注册了 `ask`
    // （按入口 + `ui.askUser` 决定），且这具身体能 bridge（`permissionMode: 'bridge'`
    // + 父事件流）；缺任何一条就不进工具面，而不是靠这里传一个名字。详见
    // `packages/agent/src/runtime.ts` 的 `toolBlocked`。
    ...(config.context?.maxTokens !== undefined
      ? { contextMaxTokens: config.context.maxTokens }
      : {}),
    ...(config.context?.compactThreshold !== undefined
      ? { contextCompactThreshold: config.context.compactThreshold }
      : {}),
    // q-tool-result-whitelist：成员窗口与 owner 同一口径（缺省 ⇒ core 内置默认）。
    ...(config.context?.toolResultWhitelist !== undefined
      ? { contextToolResultWhitelist: config.context.toolResultWhitelist }
      : {}),
    // 注入粒度框架：self-card hook 的检测节奏（缺省不传 ⇒ 内置默认表，零回归）。
    // P2：读 live ref ⇒ 热应用后新 spawn 的 body 用新配置（live body 的 hook 走 resolver）。
    ...(liveConfigRef.current.envInjection !== undefined
      ? { envInjection: liveConfigRef.current.envInjection }
      : {}),
    // P2 热加载：self-card hook 的 cadence/channel/off resolver 读 live ref（live body 同步）。
    getEnvInjection: () => liveConfigRef.current.envInjection,
    permission,
    permissionMode: memberPermissionMode,
    // 0.31：按**入口是否真有进程内应答者**判定，而不是 `!headless`：feishu 非 TTY
    // （headless=false）既没有 TUI 也没有 gateway 权限卡片，用 !headless 会让
    // rotate 请求永远等不到人。0.33 起 headless 注册 ask 但不等于有应答者，
    // 所以这里用 interactiveHumanAvailable（排除 headless）。
    humanApproval: interactiveHumanAvailable,
    // 成员 bridge 请求 / 应答与 TUI 订阅的是同一条父事件流。
    parentEvents: runtimeEvents,
    // 0.27（spec §5.1）：每 tenant 唯一 scheduler，由 tenant bundle 构造。
    scheduler: bundle.scheduler,
    ...(config.agent?.ownerId !== undefined ? { ownerId: config.agent.ownerId } : {}),
    // 成员停下 / 被关闭 → 定向到父 session 的一条 runtime.notice（scope peer）。
    ...(peerNotices !== undefined ? { peerStops: peerNotices.report } : {}),
    // tools-engine P2 批次 3：inbox 逐 body 接线（原闭包含 agentId，callback 经 pending
    // 关联执行，成员身份不由 engine 提供）。spawn / 热刷新都经 inboxTool() 触发；喂账本
    // 幂等全量（指纹不变 engine 侧 no-op），失败只记日志。
    wireInboxTool: (tool) => {
      engineClient.wireTool(tool, callbackRoute('inbox'));
      void engineClient.pushRegistry().catch((error: unknown) => {
        logger.warn('tools-engine registry push failed (inbox)', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    logger,
    // 成员 ExecutionUnit 与父级共用 tenant 存储：同 session_id 可在新进程恢复历史。
    session,
    ...(eventLog !== undefined ? { eventLog } : {}),
    ...(bundle.leaseService !== undefined ? { leaseService: bundle.leaseService } : {}),
    // 0.56（决策 2：上传即落）：引用到达节点的第一刻就算 sha256 + 落 blob。
    // 边界从活的 basic-tools 配置来（与 `attachments.list` 同一份判定）。
    attachIngest: createConfigAttachmentIngest({ getConfig: () => config }),
    ...(bundle.summarizer !== undefined ? { summarizer: bundle.summarizer } : {}),
    ...(bundle.summarizerForSession !== undefined
      ? { summarizerForSession: bundle.summarizerForSession }
      : {}),
    teamDeclarations,
    ...(defaultWorkspace !== undefined ? { defaultWorkspace } : {}),
    ...(federation !== undefined ? { federation } : {}),
    ...(config.agent?.temporaryTtlHours !== undefined
      ? { temporaryTtlHours: config.agent.temporaryTtlHours }
      : {}),
    ...(config.agent?.inboxMaxMessages !== undefined
      ? { inboxMaxMessages: config.agent.inboxMaxMessages }
      : {}),
    ...(config.agent?.teamMemberLimit !== undefined
      ? { teamMemberLimit: config.agent.teamMemberLimit }
      : {}),
    // CREATE-0.39 §2.5：seeded create 的失败清理走 core 的 session-data 删除路径
    // （先 detach 再删 event log / SessionState / RunRecord）。
    deleteSessionData: async (sessionId: string) => {
      await sessionControl.delete(sessionId);
    },
  });
  // 0.27：回填本机投递端口（federation 端口的 getter 在此之后才读得到）。
  // 0.57：`agent` 段（1s 级）拆开记账：装配（TeamStore / AgentService）与派生 `main`
  // 是两件不同的事，谁的代价大要能直接读出来。
  markStartup('agent.wiring');
  localHuman = createTeamHumanDelivery(wiring.team);
  localMember = createTeamLocalMemberDelivery(wiring.team);
  // 0.28 F2：回填飞书成员复活用的 Team（默认 workspace 的 Team；缺省不复活）。
  const feishuTeamId = wiring.defaultTeam?.team_id;
  // 0.28：回填渠道执行面（渠道 `start()` 时才读取；此处不提前构造 / 不改变次序）。
  const feishuAgentService = wiring.service;
  // 0.53 notice-rotate：回填通知的重解析口（router 早在上面就建好了，flush 时才读）。
  const noticeAgentService = wiring.service;
  registerBashJobDelivery({ service: wiring.service, logger });
  logger.debug('agent.bash_job.delivery_ready', {});
  finalPluginHost.registerTool(wiring.tool);
  // tools-engine P2 批次 3：agent 恒 callback（Team 注册表 / body spawn / SessionStore
  // 状态留 host；内部端点 = 原 handler 闭包）。注册后立即接线，先于 startOwner（spawn
  // 顺序不变式）；喂账本失败只记日志（engine disabled → fail-closed）。
  engineClient.wireTool(wiring.tool, callbackRoute('agent'));
  try {
    await engineClient.pushRegistry();
  } catch (error) {
    logger.warn('tools-engine registry push failed (agent)', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  // 0.55：装配收尾的工具名闸（`agent` 工具是插件装完之后才注册的，所以要在这一句之后）。
  // 内置 / 插件工具名不合规 ⇒ 启动失败并列出全部违规项；外部（MCP）工具名只记 warning。
  for (const warning of assertToolNameLegality(finalPluginHost, 'bootstrap.final').warnings) {
    logger.warn('external tool name is not snake_case; passed through as-is', {
      tool_name: warning.name,
      suggestion: warning.suggestion,
    });
  }
  return {
    wiring,
    noticeBus,
    peerNotices,
    nodeHealthWatch,
    federationApply,
    feishuTeamId,
    feishuAgentService,
    noticeAgentService,
  };
}

/**
 * agent 装配后半（原 startOwner 之后至 agentControl 组装）：启动即扫恢复 →
 * hub 投影 → canonical 控制面 → owner 端点（headless 不监听）→ agentControl。
 */
export async function finishAgentAssembly(
  ctx: AgentAssemblyContext,
  wiring: AgentServiceWiring,
  owner: MemberStatus,
): Promise<BootstrapResult['agent']> {
  const { headless, logger, dataDir, nodeName, tenantId, updateResumeMarker } = ctx;
  const { session, sessionControl, runtimeEvents, runStore, eventLog, journalFactory } = ctx.bundle;
  // 0.53：**启动即扫**。gateway / 本地 dispatcher 开始收 RPC 之前，把「进程死亡时还没
  // 变成 run input 的 human 输入」重新投递一次（判据、幂等、上限 8 会话见
  // `AgentService.recoverPendingInputs`：unread + 未 held + 有 session_id + human 源）。
  // 放在 `startOwner()` 之后：成员 EU spawn 时快照父宿主工具列表，恢复出来的 run 要用同一批。
  // headless（`--run` / 管道）是一次性进程：不替别的会话恢复队列，退出时会留半截 run。
  //
  // 0.52 S1c：顺序改成「先发卡、再重放、准入后清标记」——
  // 1) 读 `resume_after_restart` 标记（落盘 SessionState 是唯一权威）；
  // 2) 每个带标记的会话发一张「重启恢复」环境信息卡：一次 `runtime.notice`，
  //    由环境信息通道在下一次请求的用户输入之前注入 ⇒ 同一份文本既进模型上下文，
  //    也在聊天流里渲染成 EnvCard（用户裁定：不是隐藏输入，两边可见一致）；
  // 3) 卡之后才调既有的 `recoverPendingInputs()` 重放**已接受**的输入（最早 ts FIFO）；
  // 4) 卡片落成消息且随请求进了模型上下文之后才清标记（清标记走 RunJournal 单写口）。
  // 任何一步失败都不阻断启动：标记与 unread 条目都还在，下次启动再判（幂等）。
  //
  // 自重启 Option A：continuation 标记的无感续作在发卡**之前**投递（node-continuation）；
  // 降级出来的普通标记恰好被随后的 node-resume 发卡。node-resume 跳过 continuation 标记。
  // （标记单写口更新 updateResumeMarker 是函数声明，提升在本函数作用域，见 selfRestart 旁。）
  if (!headless) {
    // q-async-job-reconcile：先对账孤儿异步作业占位卡，再走队列恢复。作业注册表是
    // 进程内存、占位卡随 inbox 落盘 ⇒ 启动时盘上的 running 卡必属上一进程（子进程已
    // 被 exit sweep 停掉），原位回写 failed；quiet 留档不起 run，与恢复链互不干扰。
    // 失败不阻断启动（卡保持 running，下次启动再试）。
    try {
      const reconciled = await wiring.service.reconcileAsyncJobs();
      if (reconciled.reconciled > 0 || reconciled.failed > 0) {
        logger.info('agent.async_job.reconcile_done', { ...reconciled });
      }
    } catch (error) {
      logger.warn('agent.async_job.reconcile_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      if (eventLog === undefined) {
        // memory 后端 / 只读执行面没有事件日志：拿不到「卡发过没、准入没」的证据，
        // 不另造一套状态 —— 退回 0.53 的队列重放（不发卡）。
        const recovered = await wiring.service.recoverPendingInputs();
        if (recovered.recovered > 0 || recovered.deferred > 0 || recovered.failed > 0) {
          logger.info('agent.inbox.recover_done', { ...recovered });
        }
      } else {
        // 自重启 Option A（件 3）：无感续作先行——触发者 run 已 completed 的
        // continuation 标记经 startup:true 通道投递（新 run 起跑），成功即清标记；
        // 非 completed / attempts 超限降级普通标记，由下面 node-resume 发卡。
        if (runStore !== undefined) {
          try {
            const continuation = await resumeContinuations({
              session,
              runStatus: async (runId) => (await runStore.load(runId))?.status,
              deliver: (sid, prompt) => wiring.service.deliverContinuationPrompt(sid, prompt),
              updateMarker: updateResumeMarker,
              warn: (event, meta) => logger.warn(event, meta),
              info: (event, meta) => logger.info(event, meta),
            });
            if (continuation.found > 0) {
              logger.info('node.continuation.done', { ...continuation });
            }
          } catch (error) {
            // 续作扫描失败不阻断启动：标记仍在盘上，下次启动再试。
            logger.warn('node.continuation.failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const restarted = createNodeResumer({
          session,
          eventLog,
          announce: (sessionId, text) => wiring.service.announceEnvironmentCard(sessionId, text),
          // 清标记：只清「还是同一份标记」的那一个；拷贝里去掉该字段，
          // 落盘仍走 RunJournal（`saveSessionState` 是 SessionState 的唯一写口）。
          clearMarker: async (sessionId, marker) => {
            const state = await session.load(sessionId);
            if (state === null) return false;
            if (!sameRestartMarker(state.resume_after_restart, marker)) return false;
            const { resume_after_restart: _cleared, ...rest } = state;
            const journal = journalFactory.transient({
              runId: 'manual',
              events: runtimeEvents,
              sessionId,
            });
            await journal.saveSessionState(rest);
            return true;
          },
          replay: async () => {
            const recovered = await wiring.service.recoverPendingInputs();
            return { recovered: recovered.recovered, sessions: recovered.sessions };
          },
          // P0-run-stops P3 僵尸标记判据的另一半：会话已完成。与 announce 的
          // `no_member` 原因联合成立时，node-resume 经 clearMarker（单写口）清掉
          // 永远不可能准入的标记（headless CLI 会话遗留），不再只增不减。
          unrecoverable: async (sessionId) => {
            const state = await session.load(sessionId);
            return state !== null && state.status === 'completed';
          },
          warn: (event, meta) => logger.warn(event, meta),
        });
        const report = await restarted.beginResume();
        markStartup('agent.resume');
        if (report.marked > 0 || report.replayed_inputs > 0) {
          logger.info('agent.resume.recover_done', {
            marked: report.marked,
            announced: report.announced,
            deduped: report.deduped,
            skipped: report.skipped,
            replayed_inputs: report.replayed_inputs,
            replayed_sessions: report.replayed_sessions,
            // P0-run-stops P4：per-session skip 原因聚合（只扩日志内容）——
            // skipped=9 这种读数必须能直接看出「为什么」，不用回去翻代码。
            ...(report.skipped > 0
              ? {
                  skipped_sessions: report.marks
                    .filter((mark) => mark.card === 'skipped')
                    .map((mark) => ({
                      session_id: mark.session_id,
                      reason: mark.skip_reason ?? 'unknown',
                    })),
                }
              : {}),
          });
        }
        // 准入是异步的（要等下一轮请求真的发出）：不阻塞启动，只在后台收尾清标记。
        void restarted.whenSettled().then((final) => {
          if (final.cleared.length > 0 || final.settle === 'timeout') {
            logger.info('agent.resume.settle_done', {
              cleared: final.cleared,
              settle: final.settle,
              marked: final.marked,
            });
          }
        });
      }
    } catch (error) {
      // 恢复失败不阻断启动：条目仍是 unread，标记仍落盘，下次启动再试。
      logger.warn('agent.inbox.recover_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // S5：hub 目录投影（node → hub 出站快照）。
  const hubRuntime = await createHubRuntime({
    service: wiring.service,
    // S6：真实 TeamService 作为 hub 指针源（只带 team_id / kind / message_id）。
    teamSource: wiring.team,
    nodeName,
    logger,
  });

  // owner 端点与 gateway 共用同一 canonical 控制面适配器。
  // CREATE-0.39 §2.1：mode=both 的 git restore 需要 agent 所属 Team 的 workspace。
  const agentControlLike = createAgentControl(wiring.service, tenantId, {
    resolveWorkspace: async (agentId: string) => {
      const status = await wiring.service.identify(agentId);
      const teamId = status?.team_id;
      return teamId === undefined ? undefined : wiring.teamStore.get(teamId)?.workspace;
    },
  });
  // 0.34 Stage 3：CLI / TUI / gateway 的所有 delete 入口共用同一个前置钩子。
  sessionControl.setDetachSession((sessionId) => wiring.service.detachSession(sessionId));
  let ownerServer: AgentOwnerServer | undefined;
  // owner 端点只服务交互 REPL / serve 的 CLI attach；headless（`--run` / 管道）
  // 是一次性进程，不监听端口。AgentService / Team 仍在进程内可用。
  if (!headless) {
    try {
      ownerServer = await startAgentOwnerServer({
        control: agentControlLike,
        sessionFor: () => session,
        teams: wiring.team,
        ownerId: wiring.ownerId,
        dataDir,
        tenantId,
        logger,
      });
    } catch (error) {
      // 同一 dataDir 已有 owner 时第二个 REPL 仍可用进程内工具；
      // CLI attach 保持在原 owner 上。
      console.warn(
        `⚠ agent owner endpoint unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const agentControl: BootstrapResult['agent'] = {
    service: wiring.service,
    team: wiring.team,
    owner,
    ownerId: wiring.ownerId,
    ...(ownerServer !== undefined ? { ownerServer } : {}),
    hubControl: hubRuntime.hubControl,
    control: agentControlLike,
    applyDefaultModel: wiring.applyDefaultModel,
    dispose: async () => {
      await ownerServer?.stop();
      // 回收定时器必须先停：否则 drain 期间 sweep 仍可能回收正要收口的 agent。
      wiring.stopSweep();
      // 成员轮必须在 tenant eventLog 关闭前收口：否则尾部事件 append 会被
      // `session_event_log_closed` 拒绝，子会话审计缺尾。
      await wiring.service.drain({ timeoutMs: 5000 });
      // Team 退订后再 flush 日志写链，避免关闭期间又追加系统消息。
      wiring.team.dispose();
      await wiring.teamStore.flush();
      await wiring.conversationStore?.flush();
      await wiring.service.flushSnapshot();
    },
  };
  return agentControl;
}
