/**
 * gateway.* 管理方法（`gateway.reload`，DECISION-023 §2.3；CONTRACT-hot-apply §1；
 * `gateway.shutdown`，P0-run-stops P1：Windows 强杀前的优雅关闭入口）。
 *
 * serve 只负责协议形状、权限与参数校验（scope 枚举 + 去重）；真实 applier 由 asm
 * 通过 `GatewayOptions.reload` / `GatewayOptions.shutdown` 注入。未注入时明确返回
 * `not_supported`。结果形状保持 `{ reloaded, requires_restart }`，不因 scope 扩展而变。
 *
 * @module @vessel-agent/serve
 */

import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import { stringListSchema } from './schemas.js';

/**
 * 可热重载的范围（DECISION-023 §2.3；CONTRACT-hot-apply §1）。
 *
 * serve 只做枚举校验，不实现任何 applier：`scope -> applier` 的映射在 asm 侧
 * （`src/gateway-reload-wiring.ts`）。新增 applier 不需要改这里以外的协议形状。
 */
export const RELOAD_SCOPES = ['config', 'plugins', 'permission', 'tools', 'mcp'] as const;

/** 热重载范围。 */
export type ReloadScope = (typeof RELOAD_SCOPES)[number];

/** `gateway.reload` 结果；`requires_restart` 不得伪装成已生效。 */
export interface GatewayReloadResult {
  reloaded: string[];
  requires_restart: string[];
}

/** `gateway.shutdown` 结果：只表示「退出序列已受理」，不表示进程已退出。 */
export interface GatewayShutdownResult {
  stopping: boolean;
}

/**
 * `node.restart.self` 入参（自重启 Option A，runlost-graceful-restart-audit §4.2）。
 * cancel=true 时只需 session_id（编排者等待超时后撤销 continuation 标记）。
 */
export interface SelfRestartInput {
  session_id: string;
  run_id?: string;
  prompt?: string;
  cancel?: boolean;
}

/** `node.restart.self` 结果：只表示「预约已受理 / 已撤销」，重启由 detached 编排者执行。 */
export interface SelfRestartResult {
  accepted?: boolean;
  cancelled?: boolean;
  run_id?: string;
  session_id?: string;
}

/**
 * `gateway.restart` 入参（q-restart-tool：self-restart 的 vessel 工具面入口）。
 *
 * 与 node.restart.self（admin，CLI 专用）的差别：
 * - permission 'write' ⇒ 可经 vessel 工具 op=rpc 触达（admin 被桥硬 deny）；
 * - **prompt 可选**：缺省 = 请求级重启——装配层以系统固定的请求级恢复指令替代
 *   续作点火（模型无需给自己写启动提示词），走既有 continuation 投递通道；
 * - 预约受理后由装配层复用 CLI 的 selfRestartReserveCommand 完成
 *   handoff + detached 编排者 spawn（编排者机制与 CLI 完全一致）。
 * session_id / run_id 经 vessel 桥调用时由 ToolContext 自动补注（可显式覆盖）。
 */
export interface GatewayRestartInput {
  session_id: string;
  run_id?: string;
  prompt?: string;
  wait_timeout_ms?: number;
}

/** `gateway.restart` 结果：预约已受理 + 编排者已 spawn；重启在触发者 run 终态后执行。 */
export interface GatewayRestartResult {
  accepted: boolean;
  session_id: string;
  run_id: string;
  orchestrator_pid: number;
  wait_timeout_ms: number;
}

export interface AdminMethodsDeps {
  /** asm 注入的实际热重载实现；缺省 → `not_supported`。 */
  reload?: (scopes: string[]) => Promise<GatewayReloadResult>;
  /**
   * asm 注入的优雅退出序列（P0-run-stops P1）：跑现成的 shutdownServeStack
   * （beginDrain drain-to-quiesce → gateway.stop → … → exit）。缺省 → `not_supported`。
   * **调用方（停止侧 CLI）在超时后仍会强杀**——这里不保证进程一定退出。
   */
  shutdown?: () => Promise<void>;
  /**
   * asm 注入的自重启预约（Option A）：写 continuation 标记（RunJournal 单写口）
   * 并立即返回——触发者 run 自然完成后由 detached 编排者执行 stop/start。
   * 缺省 → `not_supported`。
   */
  selfRestart?: (input: SelfRestartInput) => Promise<SelfRestartResult>;
  /**
   * asm 注入的完整自重启预约（q-restart-tool）：写 continuation 标记 + handoff +
   * spawn detached 编排者后立即返回。缺省 → `not_supported`。
   */
  restart?: (input: GatewayRestartInput) => Promise<GatewayRestartResult>;
}

/**
 * 解析 `scopes`：缺省（undefined）→ 空数组，默认集由装配层决定
 * （`src/gateway-reload-wiring.ts` 的 `DEFAULT_SCOPES`，ADR-075：`config,plugins`）。
 * 显式传入且未注册的 scope 仍由装配层拒绝，不静默忽略。
 * 去重并保持调用方顺序；schema 已先校验类型与 enum，这里兜底非数组输入。
 */
export function parseReloadScopes(value: unknown): ReloadScope[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new RpcError('invalid_params', 'scopes must be an array');
  }
  const scopes: ReloadScope[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !(RELOAD_SCOPES as readonly string[]).includes(item)) {
      throw new RpcError('invalid_params', `scopes must only contain: ${RELOAD_SCOPES.join(', ')}`);
    }
    if (!scopes.includes(item as ReloadScope)) scopes.push(item as ReloadScope);
  }
  return scopes;
}

export function createAdminMethods(deps: AdminMethodsDeps): RpcMethodDefinition[] {
  return [
    {
      name: 'gateway.reload',
      permission: 'admin',
      params_schema: {
        type: 'object',
        properties: {
          scopes: {
            type: 'array',
            // 枚举是唯一真相源：新增 applier 只改 RELOAD_SCOPES，不改这里。
            items: { type: 'string', enum: [...RELOAD_SCOPES] },
          },
        },
      },
      result_schema: {
        type: 'object',
        required: ['reloaded', 'requires_restart'],
        properties: {
          reloaded: stringListSchema,
          requires_restart: stringListSchema,
        },
      },
      handler: async (params) => {
        const reload = deps.reload;
        if (!reload) {
          throw new RpcError('not_supported', 'gateway.reload is not supported by this gateway');
        }
        return reload(parseReloadScopes(params.scopes));
      },
    },
    {
      // P0-run-stops P1：优雅关闭。Windows 上外部 `process.kill` 是无条件终止，
      // 进程内信号处理器永远跑不到 ⇒ 停止侧先经本方法触发进程内 drain，再等退出；
      // 超时仍回退强杀。响应必须先于退出序列发出：handler 只**受理**（defer 一拍），
      // 真正的 shutdownServeStack + process.exit 由 asm 注入的闭包在下一拍执行。
      name: 'gateway.shutdown',
      permission: 'admin',
      params_schema: { type: 'object', properties: {} },
      result_schema: {
        type: 'object',
        required: ['stopping'],
        properties: { stopping: { type: 'boolean' } },
      },
      handler: async () => {
        const shutdown = deps.shutdown;
        if (!shutdown) {
          throw new RpcError('not_supported', 'gateway.shutdown is not supported by this gateway');
        }
        setTimeout(() => {
          // 退出序列自身的失败由 asm 闭包记录；这里不吞进程退出（停止侧有强杀兜底）。
          void shutdown().catch(() => undefined);
        }, 0);
        return { stopping: true };
      },
    },
    {
      // 自重启 Option A（用户裁定）：预约即返回「调用成功，正在重启」——工具调用
      // 不跨进程死亡（避 run lost）。触发者 run 自然完成 → detached 编排者等 quiesce
      // → 优雅 stop/start → 新进程按 continuation 标记续作。与 gateway.shutdown 同级
      // （admin）；模型面经 bash CLI `vessel restart --self` 触达。
      name: 'node.restart.self',
      permission: 'admin',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: {
          session_id: { type: 'string' },
          run_id: { type: 'string' },
          prompt: { type: 'string' },
          cancel: { type: 'boolean' },
        },
      },
      result_schema: {
        type: 'object',
        properties: {
          accepted: { type: 'boolean' },
          cancelled: { type: 'boolean' },
          run_id: { type: 'string' },
          session_id: { type: 'string' },
        },
      },
      handler: async (params) => {
        const selfRestart = deps.selfRestart;
        if (!selfRestart) {
          throw new RpcError('not_supported', 'node.restart.self is not supported by this gateway');
        }
        const sessionId = typeof params.session_id === 'string' ? params.session_id.trim() : '';
        if (sessionId === '') {
          throw new RpcError('invalid_params', 'session_id must be a non-empty string');
        }
        const cancel = params.cancel === true;
        const prompt = typeof params.prompt === 'string' ? params.prompt : '';
        if (!cancel && prompt.trim() === '') {
          throw new RpcError('invalid_params', 'prompt must be a non-empty string (continuation)');
        }
        const runId =
          typeof params.run_id === 'string' && params.run_id !== '' ? params.run_id : undefined;
        return selfRestart({
          session_id: sessionId,
          ...(runId !== undefined ? { run_id: runId } : {}),
          ...(cancel ? { cancel: true } : { prompt }),
        });
      },
    },
    {
      // q-restart-tool（用户裁定）：self-restart 的 vessel 工具面入口。平台级操作
      // 影响整个 gateway+node，故放 vessel RPC 层而非 agent 工具；permission 'write'
      // ⇒ vessel op=rpc 可达（write→ask 确认卡，与 bash 危险操作同口径；admin 被桥
      // 硬 deny，所以 node.restart.self 保持 CLI 专用）。prompt 可选：缺省 = 请求级
      // 重启（装配层以系统恢复指令点火续作）；编排者 / fail-safe / 续作投递与 CLI
      // `vessel restart --self` 完全同一份实现（selfRestartReserveCommand）。
      name: 'gateway.restart',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: {
          session_id: { type: 'string' },
          run_id: { type: 'string' },
          prompt: { type: 'string' },
          wait_timeout_ms: { type: 'integer', minimum: 1 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['accepted', 'session_id', 'run_id', 'orchestrator_pid', 'wait_timeout_ms'],
        properties: {
          accepted: { type: 'boolean' },
          session_id: { type: 'string' },
          run_id: { type: 'string' },
          orchestrator_pid: { type: 'integer' },
          wait_timeout_ms: { type: 'integer' },
        },
      },
      handler: async (params) => {
        const restart = deps.restart;
        if (!restart) {
          throw new RpcError('not_supported', 'gateway.restart is not supported by this gateway');
        }
        const sessionId = typeof params.session_id === 'string' ? params.session_id.trim() : '';
        if (sessionId === '') {
          throw new RpcError('invalid_params', 'session_id must be a non-empty string');
        }
        // prompt 可选（请求级重启）；显式传入则必须非空（空串歧义拒绝）。
        let prompt: string | undefined;
        if (params.prompt !== undefined) {
          if (typeof params.prompt !== 'string' || params.prompt.trim() === '') {
            throw new RpcError(
              'invalid_params',
              'prompt must be a non-empty string when provided (omit it for request-level resume)',
            );
          }
          prompt = params.prompt;
        }
        let waitTimeoutMs: number | undefined;
        if (params.wait_timeout_ms !== undefined) {
          const value = params.wait_timeout_ms;
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
            throw new RpcError('invalid_params', 'wait_timeout_ms must be a positive integer');
          }
          waitTimeoutMs = value;
        }
        const runId =
          typeof params.run_id === 'string' && params.run_id !== '' ? params.run_id : undefined;
        return restart({
          session_id: sessionId,
          ...(runId !== undefined ? { run_id: runId } : {}),
          ...(prompt !== undefined ? { prompt } : {}),
          ...(waitTimeoutMs !== undefined ? { wait_timeout_ms: waitTimeoutMs } : {}),
        });
      },
    },
  ];
}
