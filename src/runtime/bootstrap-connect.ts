/**
 * connect 模式引导（P1 批 2 纯移动，自 bootstrap.ts 迁出；零行为变更）。
 * bootstrapConnect + connect helpers + 默认 Team workspace/anchor 与 kanban 路径解析；
 * bootstrap.ts 保留三个 resolve 函数的 re-export，外部消费点不变。
 */

import * as path from 'node:path';
import { normalizeWorkspace, type TeamDeclaration, workspaceKey } from '@vessel-agent/agent';
import { getUserConfigPath, type VesselConfig } from '../../packages/config/src/index';
import {
  type Logger,
  MemoryPluginHost,
  MemorySessionStore,
  MemoryWorkingContext,
  type RunEvent,
  type RunnableAgent,
  Runtime,
  type TenantPaths,
} from '../../packages/core/src/index';
import { createReplSettings } from '../config/ui-settings';
import { expandHome } from '../data/data-paths';
import { resolveAgentCwd } from '../data/path-resolution';
import { reportShutdownFailure } from '../gateway/shutdown-report';
import { resolveConnectToken } from '../gateway/transport-factory';
import { t } from '../i18n';
import { createEventStream } from '../observability/observability-wiring';
import { createHttpRpcClient, normalizeConnectUrl, type RpcClient } from '../rpc/index';
import {
  type ConnectResumeStart,
  type ConnectRunStart,
  waitForConnectedResumeTerminal,
  waitForConnectedRun,
} from '../run/connect-run-wait';
import { readPackageVersion } from '../shared/version';
import type { BootstrapResult, ReplContextWithPermissions } from './bootstrap-types';
import { newSessionId } from './session-id';

/** `--connect --run` 缺省终态等待上限（10 分钟）；测试可覆盖。 */
const DEFAULT_CONNECT_RUN_TIMEOUT_MS = 10 * 60_000;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 把旧式 `connectToken` / `caFile` 选项折入 CLI 覆盖层。
 * 生产路径直接传 `cliOverrides`；这里仅为兼容既有调用方，保证只有一个合并点。
 */
export function withConnectCliOverrides(
  cliOverrides: Partial<VesselConfig> | undefined,
  connectToken: string | undefined,
  caFile: string | undefined,
): Partial<VesselConfig> | undefined {
  const token = nonEmptyString(connectToken);
  const ca = nonEmptyString(caFile);
  if (token === undefined && ca === undefined) return cliOverrides;

  const legacy: NonNullable<VesselConfig['connect']> = {
    ...(token !== undefined ? { token } : {}),
    ...(ca !== undefined ? { caFile: ca } : {}),
  };
  return {
    ...cliOverrides,
    connect: { ...legacy, ...(cliOverrides?.connect ?? {}) },
  };
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunEventValue(value: unknown): value is RunEvent {
  return (
    isRecordValue(value) &&
    typeof value.type === 'string' &&
    typeof value.run_id === 'string' &&
    typeof value.ts === 'number'
  );
}

/**
 * Q5：`-r/--resume <id>` 的首轮显式走 `resumeSession(sessionId, input)`，
 * 之后恢复普通 `run`。只用于本地进程内路径；connect 模式没有新 RPC，
 * 保持 `runs.start` 到远端 AgentService 的既有语义。
 */
export function withFirstRunResume(runtime: RunnableAgent, sessionId: string): RunnableAgent {
  let pending = true;
  return {
    events: runtime.events,
    pluginHost: runtime.pluginHost,
    async run(input, sid, opts) {
      if (pending) {
        pending = false;
        const resume = runtime.resumeSession;
        if (typeof resume === 'function') {
          const target = sid !== undefined && sid !== '' ? sid : sessionId;
          return resume.call(runtime, target, input, opts);
        }
      }
      return runtime.run(input, sid, opts);
    },
    dispose: () => runtime.dispose(),
    ...(runtime.resumeRun !== undefined ? { resumeRun: runtime.resumeRun.bind(runtime) } : {}),
    ...(runtime.resumeSession !== undefined
      ? { resumeSession: runtime.resumeSession.bind(runtime) }
      : {}),
  };
}

/**
 * `runs.resume` 的 RPC 错误 → resume 稳定码（DECISION-033）。
 * 未列出的错误归 `resume_failed`；错误消息不含 token。
 */
function resumeRpcError(error: unknown, runId: string): Error {
  const code = (error as { code?: unknown } | null)?.code;
  const details = (error as { details?: unknown } | null)?.details;
  const legacy =
    isRecordValue(details) && typeof details.legacy_code === 'string'
      ? details.legacy_code
      : undefined;
  const mapped =
    code === 'not_found'
      ? 'run_not_found'
      : code === 'forbidden'
        ? 'forbidden'
        : code === 'not_supported'
          ? 'resume_unavailable'
          : code === 'conflict' && legacy === 'run_not_resumable'
            ? 'run_not_resumable'
            : code === 'conflict' && legacy === 'run_already_running'
              ? 'run_already_running'
              : 'resume_failed';
  const message = (error instanceof Error ? error.message : String(error)) || runId;
  return Object.assign(new Error(message), { code: mapped });
}

/**
 * connect 模式（A-4 §11.6）：不获取 tenant 写锁、不写本地 store/trace。
 * 本地 session 使用内存后端；run 走 canonical `runs.start`。
 */
export async function bootstrapConnect(input: {
  config: VesselConfig;
  nodeId: string;
  nodeName: string;
  tenantId: string;
  tenantPaths: TenantPaths;
  url: string;
  /** headless 不显示 provider banner，无需额外查询 gateway。 */
  headless: boolean;
  /** 0.10 R2-14：诊断 logger（与 bootstrap 共用） */
  logger: Logger;
  /** 0.11：本地用户配置路径（ui.language 写回；缺省 getUserConfigPath()） */
  userConfigPath?: string;
  /** 0.6.1：显式 session id（`--session` / `-r <id>`） */
  sessionId?: string;
  /** 0.6.1：`-c/--continue`；经 sessions.list 选择最近的非空会话 */
  continueLatest?: boolean;
  /** 0.6.1：`-r <id>`；先用 sessions.get 校验存在 */
  resumeSessionId?: string;
  /** 0.18：run 终态等待上限 / 轮询间隔（测试注入） */
  connectRunTimeoutMs?: number;
  connectRunPollMs?: number;
  rpcClientFactory?: (opts: {
    baseUrl: string;
    token: string;
    ca?: string;
  }) => RpcClient & { close(): Promise<void> };
}): Promise<BootstrapResult> {
  // P2：--connect 接受 ws:// / wss://（归一化为 http/https）。
  const connectUrl = normalizeConnectUrl(input.url);

  // 连接 token 与远程控制面共用 `resolveConnectToken`（DECISION-033）：
  // connect 专用凭据 → gateway 凭据（serve.token / token_env / admin_token(_env) /
  // VESSEL_GATEWAY_TOKEN / transport.token）。config loader 已合并 CLI / env / 文件层，
  // 因此显式 token 取合并后的 config.connect.token——不能让裸 env 覆盖 `--connect-token`。
  // 永不打印。
  const token =
    resolveConnectToken(input.config, { connectToken: input.config.connect?.token }) ?? '';

  // CA：只读文件，错误信息不带 token。
  const caPath = nonEmptyString(input.config.connect?.caFile);
  let ca: string | undefined;
  if (caPath !== undefined) {
    try {
      ca = await Bun.file(caPath).text();
    } catch {
      console.error(t('connect.caUnreadable', { path: caPath }));
      process.exit(1);
    }
    if (ca.trim() === '') {
      console.error(t('connect.caEmpty', { path: caPath }));
      process.exit(1);
    }
  }

  let client: RpcClient & { close(): Promise<void> };
  try {
    client = input.rpcClientFactory
      ? input.rpcClientFactory({
          baseUrl: connectUrl,
          token,
          ...(ca !== undefined ? { ca } : {}),
        })
      : createHttpRpcClient({
          baseUrl: connectUrl,
          token,
          ...(ca !== undefined ? { ca } : {}),
        });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const rpc: RpcClient & { close(): Promise<void> } = {
    request: <T = unknown>(method: string, params?: unknown) => client.request<T>(method, params),
    subscribe: (handler) => client.subscribe(handler),
    close: () => client.close(),
  };

  // A4：远端 node 以 health.get 为准；单 id 使用本地解析结果（token principal）。
  let remote: BootstrapResult['remote'];
  const effectiveTenantId = input.tenantId;
  try {
    const health = await rpc.request<unknown>('health.get');
    if (isRecordValue(health)) {
      const node = isRecordValue(health.node) ? health.node : undefined;
      const remoteNodeId =
        node && typeof node.node_id === 'string' && node.node_id !== '' ? node.node_id : undefined;
      remote = {
        tenantId: effectiveTenantId,
        ...(remoteNodeId !== undefined ? { nodeId: remoteNodeId } : {}),
        endpoint: connectUrl,
      };
    }
  } catch {
    // 旧 gateway / 权限不足：保留本地 tenant，仅少展示 node。
  }

  // connect 模式下 agent 实际跑在 gateway 上：状态栏应显示 gateway 的 provider，
  // 而不是本地 config 的 provider（否则 mock/远端 gateway 会显示成误导性的本地模型）。
  let gatewayProvider = input.config.provider;
  if (!input.headless) {
    try {
      const snapshot = await rpc.request<unknown>('config.get');
      if (isRecordValue(snapshot)) {
        const configValue = isRecordValue(snapshot.config) ? snapshot.config : undefined;
        const provider =
          configValue && isRecordValue(configValue.provider) ? configValue.provider : undefined;
        if (provider) {
          const name =
            typeof provider.name === 'string' && provider.name
              ? provider.name
              : gatewayProvider?.name;
          if (name) {
            gatewayProvider = {
              ...gatewayProvider,
              name,
              ...(typeof provider.model === 'string' ? { model: provider.model } : {}),
              ...(typeof provider.baseUrl === 'string' ? { baseUrl: provider.baseUrl } : {}),
            };
          }
        }
      }
    } catch {
      // 旧 gateway / 受限权限没有 config.get：退回本地配置。
    }
  }

  // Stage 4：connect 模式不执行本地 tenant run（远端才是执行面），但 BootstrapResult
  // 需要同一形状；这里给一个未注册 profile 的空 Runtime（`--connect` 与 `--serve` 互斥）。
  const executionRuntime = new Runtime({
    ...(input.logger !== undefined ? { logger: input.logger } : {}),
  });
  const events = createEventStream(input.config);
  const pluginHost = new MemoryPluginHost();
  const session = new MemorySessionStore();
  const context = new MemoryWorkingContext({
    maxTokens: input.config.context?.maxTokens,
    maxMessages: input.config.context?.maxMessages,
    autoCompact: input.config.context?.autoCompact,
    compactThreshold: input.config.context?.compactThreshold,
    // q-tool-result-whitelist：与执行内核同一口径（缺省 ⇒ core 内置默认）。
    ...(input.config.context?.toolResultWhitelist !== undefined
      ? { toolResultWhitelist: input.config.context.toolResultWhitelist }
      : {}),
  });

  // ── 会话续接（0.6.1 E8）：remote 端是唯一数据源 ──
  let resolvedSessionId = input.sessionId;
  if (input.resumeSessionId !== undefined) {
    try {
      await rpc.request('sessions.get', { session_id: input.resumeSessionId });
    } catch (error) {
      console.error(
        t('connect.resumeFailed', {
          id: input.resumeSessionId,
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exit(1);
    }
    resolvedSessionId = input.resumeSessionId;
  } else if (input.continueLatest === true) {
    try {
      const raw = await rpc.request<unknown>('sessions.list');
      const list = Array.isArray(raw)
        ? raw
        : isRecordValue(raw) && Array.isArray(raw.sessions)
          ? raw.sessions
          : [];
      const sessions = list
        .filter(isRecordValue)
        .filter((entry) => typeof entry.session_id === 'string')
        .map((entry) => ({
          session_id: entry.session_id as string,
          updated_at: typeof entry.updated_at === 'number' ? entry.updated_at : 0,
          message_count: typeof entry.message_count === 'number' ? entry.message_count : 0,
        }))
        .filter((entry) => entry.message_count > 0)
        .sort((a, b) =>
          b.updated_at !== a.updated_at
            ? b.updated_at - a.updated_at
            : a.session_id.localeCompare(b.session_id),
        );
      const latest = sessions[0];
      if (!latest) {
        console.error(t('common.noSessions'));
        process.exit(1);
      }
      resolvedSessionId = latest.session_id;
    } catch (error) {
      console.error(
        t('connect.listFailed', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exit(1);
    }
  }

  let currentSessionId = resolvedSessionId ?? newSessionId();
  let shuttingDown = false;

  const unsubscribe = client.subscribe((notification) => {
    if (!isRunEventValue(notification.params)) return;
    try {
      events.publish(notification.params);
    } catch {
      // 订阅者异常不影响连接
    }
  });

  /**
   * A3：TUI / headless 只会在本地 events 上发布 response；
   * connect 模式下必须经 canonical RPC 回远端。失败只写 stderr。
   */
  /**
   * gateway 会把 `permission.respond` / `ask.respond` 的结果再作为事件推回来。
   * 记录已转发的 requestId，回声到达时只消费一次，避免二次 RPC。
   */
  const forwardedInteractions = new Set<string>();
  const rememberForwarded = (key: string): void => {
    forwardedInteractions.add(key);
    while (forwardedInteractions.size > 1000) {
      const first = forwardedInteractions.values().next();
      if (first.done) break;
      forwardedInteractions.delete(first.value);
    }
  };

  const unsubscribeInteractions = events.subscribe((event) => {
    const data = isRecordValue(event.data) ? event.data : undefined;
    if (!data) return;
    if (event.type === 'tool.permission.response') {
      const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
      const decision =
        data.decision === 'allow' || data.decision === 'deny' ? data.decision : undefined;
      if (requestId === undefined || decision === undefined) return;
      const key = `permission:${requestId}`;
      if (forwardedInteractions.delete(key)) return;
      rememberForwarded(key);
      void rpc
        .request('permission.respond', {
          request_id: requestId,
          decision,
          ...(data.remember === true ? { remember: true } : {}),
        })
        .catch((error: unknown) => {
          console.error(
            `Remote permission response failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      return;
    }
    if (event.type === 'ask.user.answered') {
      const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
      if (requestId === undefined || !Array.isArray(data.answers)) return;
      const key = `ask:${requestId}`;
      if (forwardedInteractions.delete(key)) return;
      rememberForwarded(key);
      void rpc
        .request('ask.respond', { request_id: requestId, answers: data.answers })
        .catch((error: unknown) => {
          console.error(
            `Remote ask response failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  });

  /**
   * 0.17 P0：`runs.start` 只返回排队信封（`{run_id,status}`），不是最终输出。
   * 终态等待逻辑（事件匹配 + runs.get 确认 + 轮询 + 超时）在
   * `connect-run-wait.ts`，便于单测“终态事件不投递”场景。
   */
  // CONTRACT-0.34-context C6/C7：connect 模式的手动压缩经 canonical RPC。
  // 不改核心 `RunnableAgent`；只在本字面量上做结构化扩展。
  const runtime: RunnableAgent & {
    compactContext?(sessionId?: string): Promise<{ removed: number; remaining: number }>;
  } = {
    events,
    pluginHost,
    async run(inputValue, sessionId, opts) {
      // Message 原样使用（content 已是 string）；不做 String(content) 降级。
      const prompt = typeof inputValue === 'string' ? inputValue : inputValue.content;
      const targetSession = sessionId ?? currentSessionId;
      return await waitForConnectedRun({
        events,
        prompt,
        sessionId: targetSession,
        timeoutMs: input.connectRunTimeoutMs ?? DEFAULT_CONNECT_RUN_TIMEOUT_MS,
        ...(input.connectRunPollMs !== undefined ? { pollIntervalMs: input.connectRunPollMs } : {}),
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        start: async (): Promise<ConnectRunStart> => {
          const result = await rpc.request<unknown>('runs.start', {
            input: prompt,
            session_id: targetSession,
            ...(opts?.messages ? { messages: opts.messages } : {}),
          });
          // 旧 gateway 兼容：直接返回文本 / `{result}` 时原样返回。
          if (typeof result === 'string') return { kind: 'legacy', text: result };
          if (!isRecordValue(result) || typeof result.run_id !== 'string') {
            if (isRecordValue(result) && typeof result.result === 'string') {
              return { kind: 'legacy', text: result.result };
            }
            throw new Error('runs.start returned no run_id');
          }
          return { kind: 'job', jobId: result.run_id };
        },
        getRun: (jobId) => rpc.request<unknown>('runs.get', { run_id: jobId }),
      });
    },
    async compactContext(sessionId?: string) {
      const target = sessionId ?? currentSessionId;
      return await rpc.request<{ removed: number; remaining: number }>('sessions.compact', {
        session_id: target,
      });
    },
    dispose() {
      unsubscribe();
      unsubscribeInteractions();
      void client.close();
    },
  };

  const shutdown = async (_options?: { drain?: boolean }): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    unsubscribe();
    unsubscribeInteractions();
    try {
      await client.close();
    } catch (error) {
      reportShutdownFailure({
        events,
        logger: input.logger,
        step: 'client.close',
        error,
        tenantId: effectiveTenantId,
      });
    }
  };

  const ctx: ReplContextWithPermissions = {
    runtime,
    pluginHost,
    session,
    events,
    context,
    currentSessionId,
    onSessionChange: (id) => {
      currentSessionId = id;
    },
    provider: {
      name: gatewayProvider?.name ?? 'openai',
      model: gatewayProvider?.model ?? '',
      baseUrl: gatewayProvider?.baseUrl ?? '',
    },
    plugins: [],
    rpc,
    tenant: { data_dir: input.tenantPaths.root },
    config: input.config,
    // 0.11：connect 模式同样允许写本地用户配置（远端不受影响）。
    settings: createReplSettings({
      configPath: input.userConfigPath ?? getUserConfigPath(),
      configLanguage: input.config.ui?.language,
      ...(input.config.ui?.statusBars !== undefined
        ? { configStatusBars: input.config.ui.statusBars }
        : {}),
      ...(input.config.ui?.errorLevel !== undefined
        ? { configErrorLevel: input.config.ui.errorLevel }
        : {}),
      ...(input.config.ui?.verbosity !== undefined
        ? { configVerbosity: input.config.ui.verbosity }
        : {}),
    }),
    version: readPackageVersion(),
    newSessionId,
    onExit: () => {
      void shutdown().finally(() => process.exit(0));
    },
  };

  return {
    runtime,
    executionRuntime,
    ctx,
    config: input.config,
    liveConfigRef: { current: input.config },
    tenantId: effectiveTenantId,
    ...(remote !== undefined ? { remote } : {}),
    tenantPaths: input.tenantPaths,
    nodeId: input.nodeId,
    nodeName: input.nodeName,
    resumeRun: async (runId, opts) => {
      const outcome = await waitForConnectedResumeTerminal({
        events,
        runId,
        sessionId: currentSessionId,
        timeoutMs: input.connectRunTimeoutMs ?? DEFAULT_CONNECT_RUN_TIMEOUT_MS,
        ...(input.connectRunPollMs !== undefined ? { pollIntervalMs: input.connectRunPollMs } : {}),
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        resume: async (): Promise<ConnectResumeStart> => {
          let result: unknown;
          try {
            result = await rpc.request<unknown>('runs.resume', { run_id: runId });
          } catch (error) {
            throw resumeRpcError(error, runId);
          }
          if (typeof result === 'string') return { kind: 'legacy', text: result };
          if (!isRecordValue(result)) {
            throw Object.assign(new Error('runs.resume returned no result'), {
              code: 'resume_failed',
            });
          }
          if (typeof result.result === 'string') return { kind: 'legacy', text: result.result };
          const returnedRunId = result.run_id;
          if (typeof returnedRunId !== 'string' || returnedRunId === '') {
            throw Object.assign(new Error('runs.resume returned no run_id'), {
              code: 'resume_failed',
            });
          }
          return {
            kind: 'queued',
            runId: returnedRunId,
            ...(typeof result.session_id === 'string' && result.session_id !== ''
              ? { sessionId: result.session_id }
              : {}),
          };
        },
        getRun: (targetRunId) => rpc.request<unknown>('runs.get', { run_id: targetRunId }),
      });
      return {
        sessionId: outcome.sessionId !== '' ? outcome.sessionId : currentSessionId,
        result: outcome.output,
        mode: 'single-agent' as const,
      };
    },
    shutdown,
    cleanup: () => {
      void shutdown();
    },
  };
}

/**
 * 0.19 S3：配置声明 → `new` 的默认 Team workspace。
 *
 * 只做**归一化后的精确相等**匹配（不是前缀 / 祖先）；没有 `agent.cwd` 时用进程 cwd
 * 作声明匹配键（只是匹配键，不是建 Team 的锚点；锚点见 `resolveDefaultTeamAnchor`）。
 * 0 个命中 → undefined；多个命中 → warning + undefined；恰好 1 个 → 归一化 workspace。
 */
export function resolveDefaultTeamWorkspace(
  config: VesselConfig,
  declarations: readonly TeamDeclaration[],
  logger?: Logger,
): string | undefined {
  let cwdKey: string;
  try {
    cwdKey = workspaceKey(normalizeWorkspace(resolveAgentCwd(config) ?? process.cwd()));
  } catch (error) {
    logger?.warn('team.declaration.invalid', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  const matches = declarations.filter((declaration) => {
    try {
      return workspaceKey(normalizeWorkspace(declaration.workspace)) === cwdKey;
    } catch {
      return false;
    }
  });
  if (matches.length > 1) {
    logger?.warn('team.declaration.ambiguous_default', { count: matches.length });
    return undefined;
  }
  const match = matches[0];
  return match === undefined ? undefined : normalizeWorkspace(match.workspace);
}

/**
 * 0.50：交互 / serve 入口在没有显式 `agent.cwd`、也没有声明命中时的默认 Team 锚点。
 *
 * 不能用 `process.cwd()`：TUI 与 gateway 的 node 子进程从不同目录启动（daemon / node
 * spawn 都不设 cwd，子进程继承父进程 cwd），同一 data root 会因此留下多个默认 Team。
 * 从 dataDir 派生后，两个入口归一化到同一个 workspace，`ensureForWorkspace` 幂等收敛到
 * 一个 Team。锚点不需要目录存在（`ensureForWorkspace` 只按路径算身份，不建目录）。
 */
export function resolveDefaultTeamAnchor(dataDir: string): string {
  return path.resolve(dataDir, 'default');
}

/**
 * kanban boardPath 解析（R-6 提为共享唯一真相；原 q-kanban-proxy 在 cli.ts 本地定义）：
 * ~ 展开、相对进程 cwd → 缺省 <cwd>/docs/dev/kanban/board.json。
 * 启动装配（cli 网络面 + bootstrap localDispatcher 面）与热应用共用同一表达式。
 */
export function resolveKanbanBoardPath(kanban: VesselConfig['kanban']): string {
  return path.resolve(expandHome(kanban?.boardPath?.trim() || 'docs/dev/kanban/board.json'));
}
