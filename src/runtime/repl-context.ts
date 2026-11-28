/**
 * 权限控制面 + 本地 TUI 执行适配器 + ReplContext 组装（P1 批8，自 bootstrap.ts 迁出）。
 * createPermissionsSurface：用户 YAML auto_approve 控制面 + always 持久化订阅；
 * createReplContext：localRun 适配器（runs.start → admit）+ ReplContext 组装。
 * 晚绑定语义不变：currentSessionId 经 setter 原地写 trunk let；agentControl 工厂内
 * 局部 const 快照（装配期求值）。接线改动 = 5 行；其余移动体逐字节（缩进 -2）。
 */

import { getUserConfigPath, type VesselConfig } from '../../packages/config/src/index';
import type {
  MemoryWorkingContext,
  Message,
  RunnableAgent,
  TenantPaths,
} from '../../packages/core/src/index';
import { createLocalRunAdapter } from '../agent/local-run-adapter';
import { createReplSettings } from '../config/ui-settings';
import {
  addAutoApproveRule,
  listAutoApproveRules,
  removeAutoApproveRule,
} from '../data/permission-store';
import type { createLocalRpcClient } from '../rpc/index';
import type { DurableRunsControlLike } from '../run/durable-wiring';
import type { createRunControl } from '../run/run-control';
import { readPackageVersion } from '../shared/version';
import { isRecordValue, withFirstRunResume } from './bootstrap-connect';
import type {
  BootstrapResult,
  PermissionsControlLike,
  ReplContextWithPermissions,
} from './bootstrap-types';
import { newSessionId } from './session-id';
import type { TenantRuntimeBundle } from './tenant-runtime-factory';

/** 权限面输入。 */
export interface PermissionsSurfaceContext {
  userConfigPath: string | undefined;
  interactive: boolean;
  runtimeEvents: TenantRuntimeBundle['runtimeEvents'];
}

export function createPermissionsSurface(ctx: PermissionsSurfaceContext) {
  const { userConfigPath, interactive, runtimeEvents } = ctx;
  // ── 权限控制面（0.6.1 E7；tui 的 `ReplContext.permissions`）────
  // 用户 YAML 的 permission.auto_approve；TUI "always" 与 /permissions 共用。
  const permissionConfigPath = userConfigPath ?? getUserConfigPath();
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
  return { permissionsControl, permissionConfigPath, unsubPermissionPersist };
}

/** ReplContext 组装输入：trunk 稳定引用 + currentSessionId setter + agentControl getter。 */
export interface ReplContextAssemblyContext {
  bundle: TenantRuntimeBundle;
  config: VesselConfig;
  context: MemoryWorkingContext;
  currentSessionId: string;
  setCurrentSessionId: (id: string) => void;
  resumeSessionId: string | undefined;
  providerName: TenantRuntimeBundle['providerName'];
  providerModel: TenantRuntimeBundle['providerModel'];
  providerBaseUrl: TenantRuntimeBundle['providerBaseUrl'];
  plugins: TenantRuntimeBundle['plugins'];
  localRpcClient: ReturnType<typeof createLocalRpcClient>;
  localRunControl: ReturnType<typeof createRunControl> | undefined;
  tenantPaths: TenantPaths;
  mcpControl: TenantRuntimeBundle['mcp'];
  runs: DurableRunsControlLike | undefined;
  metrics: TenantRuntimeBundle['metrics'];
  feishuChannel: TenantRuntimeBundle['feishu'];
  shutdown: (options?: { drain?: boolean }) => Promise<void>;
  permissionsControl: PermissionsControlLike;
  permissionConfigPath: string;
  resolveAgentControl: () => BootstrapResult['agent'];
}

export function createReplContext(rc: ReplContextAssemblyContext): {
  ctx: ReplContextWithPermissions;
  resumableRuntime: RunnableAgent;
} {
  const {
    bundle,
    config,
    context,
    currentSessionId,
    setCurrentSessionId,
    resumeSessionId,
    providerName,
    providerModel,
    providerBaseUrl,
    plugins,
    localRpcClient,
    localRunControl,
    tenantPaths,
    mcpControl,
    runs,
    metrics,
    feishuChannel,
    shutdown,
    permissionsControl,
    permissionConfigPath,
    resolveAgentControl,
  } = rc;
  const { session, pluginHost: finalPluginHost, runtimeEvents, eventLog } = bundle;
  // ── 本地 TUI 的执行适配器（0.28 C3 / D10 / D12）─────────
  // 本地裸跑不能直连 `bundle.runtime`：那条路径绕过 `admit`，每个会话都用到
  // tenant 共享的运行时，C4 的 role 感知策略对它无效（PLAN §12.3）。
  // 适配器把执行转成 `runs.start → admit`，并把 `ctx.context` 换成当前 body 的镜像。
  const agentControl = resolveAgentControl();
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
    resumeSessionId !== undefined ? withFirstRunResume(baseRuntime, resumeSessionId) : baseRuntime;
  const ctx: ReplContextWithPermissions = {
    runtime: resumableRuntime,
    pluginHost: finalPluginHost,
    session,
    events: runtimeEvents,
    context: localRun?.context ?? context,
    currentSessionId,
    onSessionChange: (id) => {
      setCurrentSessionId(id);
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
  return { ctx, resumableRuntime };
}
