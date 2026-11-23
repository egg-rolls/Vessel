/**
 * 0.49 G1：Platform RPC（`POST /platform/rpc`）。
 *
 * 独立 allowlist + 显式 switch；复用 RPC 信封类型，但**不** import node dispatcher /
 * node principal / `gateway/methods/**`。未知方法一律 `not_found`，绝不透传到 node。
 *
 * @module @vessel-agent/serve/platform/rpc
 */

import { logEvent } from '../log-event.js';
import { RPC_VERSION, type RpcRequest } from '../rpc.js';
import type { PlatformAuthResult } from './auth.js';
import { PlatformNodeNotFoundError, type PlatformRegistry } from './registry.js';
import type { PlatformNodeCredential } from './types.js';

/** 平台方法 allowlist（契约 §2.3 冻结；Q4-C 表尾 additive `gateway.shutdown`，唯一非只读项）。 */
export type PlatformRpcMethod =
  | 'platform.nodes.list'
  | 'platform.nodes.get'
  | 'platform.nodes.credentials'
  | 'platform.whoami'
  | 'platform.health.get'
  | 'gateway.shutdown';

export const PLATFORM_RPC_METHODS: readonly PlatformRpcMethod[] = [
  'platform.nodes.list',
  'platform.nodes.get',
  'platform.nodes.credentials',
  'platform.whoami',
  'platform.health.get',
  'gateway.shutdown',
];

/** 平台侧错误码；只新增平台码，不改 node 冻结错误码。 */
export type PlatformRpcErrorCode =
  | 'invalid_params'
  | 'not_found'
  | 'platform_unauthorized'
  | 'platform_credentials_unavailable'
  | 'node_not_found'
  | 'node_unreachable';

export interface PlatformRpcContext {
  auth: PlatformAuthResult;
  registry: PlatformRegistry;
  /** 组合根注入：按 node_id 读取该 node 生效凭据；只读取/透传。 */
  resolveNodeCredential: (nodeId?: string) => PlatformNodeCredential;
  /** 平台版本（`gateway.health.get` / `/health` 共用）。 */
  version: string;
  /**
   * 0.58：代理能力（`/nodes/:nodeId/**`）。打开时代理成为浏览器的唯一数据面，
   * `platform.nodes.credentials` 因此**降级为 CLI 专用**（见该方法内的注释）。
   */
  proxy?: { enabled: boolean; basePath: string } | undefined;
  /**
   * Q4-C：组合根注入的进程内优雅退出序列（含 lock.release + exit）；受理 defer 由 rpc 层保证。
   * 省略 = `gateway.shutdown` 回 not_found（与未知方法同，零表面）。
   */
  shutdown?: {
    handle: () => Promise<void>;
    /** config gateway.remote_shutdown === true；缺省 false。 */
    remoteAllowed: boolean;
  };
  /**
   * Q4-C additive：反代密钥是否**已配置**（auth.proxySecretOk 未配置时恒 true，
   * 不足以作远程闸；远程 shutdown 必须 fail-closed 地要求已配置密钥的反代）。
   */
  proxySecretConfigured?: boolean;
  /**
   * R1.2 additive：**原始 socket 回环**（resolvePlatformAuth 同源 address 经
   * isLoopbackAddress 判定，先于 proxySecretOk 合取）。auth.loopback 是合取，
   * 不能直接当「非回环」谓词：经已配置反代的远程请求（socket 回环 + 密钥头）
   * 必须分类为 remote 过闸 3/4（K3）；反代部署的本机直连（无头）仍是 loopback。
   */
  socketLoopback: boolean;
}

function json(data: unknown, status: number, extra: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

function success(
  id: string,
  result: unknown,
  extra: Record<string, string>,
  status = 200,
): Response {
  return json({ v: RPC_VERSION, id, ok: true, result }, status, extra);
}

function failure(
  id: string,
  code: PlatformRpcErrorCode,
  message: string,
  status: number,
  extra: Record<string, string>,
): Response {
  return json({ v: RPC_VERSION, id, ok: false, error: { code, message } }, status, extra);
}

function paramsRecord(params: unknown): Record<string, unknown> | null {
  if (params === undefined) return {};
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  return params as Record<string, unknown>;
}

/**
 * 校验信封并分发。HTTP 语义：
 * - 信封错误 → 400；方法不存在 → 200 + `not_found`；
 * - `node_not_found` → 404；凭据来源不可读 → 503。
 */
export async function handlePlatformRpc(
  req: Request,
  ctx: PlatformRpcContext,
  extra: Record<string, string> = {},
): Promise<Response> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return failure('', 'invalid_params', 'Failed to read request body', 400, extra);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failure('', 'invalid_params', 'Invalid JSON', 400, extra);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return failure('', 'invalid_params', 'Request body must be an object', 400, extra);
  }
  const record = body as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  if (record.v !== RPC_VERSION) {
    return failure(id, 'invalid_params', 'v must be 1', 400, extra);
  }
  if (id === '') {
    return failure('', 'invalid_params', 'id is required', 400, extra);
  }
  if (typeof record.method !== 'string' || record.method === '') {
    return failure(id, 'invalid_params', 'method is required', 400, extra);
  }

  const request: RpcRequest = {
    v: RPC_VERSION,
    id,
    method: record.method,
    ...(record.params !== undefined ? { params: record.params } : {}),
  };

  switch (request.method) {
    case 'platform.nodes.list': {
      const nodes = await ctx.registry.list();
      return success(id, { nodes }, extra);
    }
    case 'platform.nodes.get': {
      const params = paramsRecord(request.params);
      if (params === null) {
        return failure(id, 'invalid_params', 'params must be an object', 400, extra);
      }
      const nodeId = params.node_id;
      if (nodeId !== undefined && typeof nodeId !== 'string') {
        return failure(id, 'invalid_params', 'node_id must be a string', 400, extra);
      }
      try {
        const node = await ctx.registry.get(nodeId);
        return success(id, { node }, extra);
      } catch (error) {
        if (error instanceof PlatformNodeNotFoundError) {
          return failure(id, 'node_not_found', 'Node not found', 404, extra);
        }
        return failure(id, 'node_unreachable', 'Node registry probe failed', 503, extra);
      }
    }
    case 'platform.nodes.credentials': {
      // 0.58：代理接管 browser→node 之后，下发 node token 只剩一个后果 —— 把长期凭据
      // 交给最不可信的执行环境。所以**代理开启时这个端点降级为 CLI/本地自动化专用**：
      // 必须出示平台 token（`mode === 'token'`），回环 socket 不再构成理由。
      //
      // 没有代理的部署保持逐字旧行为（含 0.55.1 的「未配置 token ⇒ 回环放行」迁移安全），
      // 因为关掉代理就是一个应当完整可用的老形态（`gateway.proxy_nodes: false`）。
      const proxyEnabled = ctx.proxy?.enabled === true;
      const unconfiguredLoopback = ctx.auth.loopback && !ctx.auth.tokenConfigured;
      if (ctx.auth.mode !== 'token' && (proxyEnabled || !unconfiguredLoopback)) {
        return failure(
          id,
          'platform_unauthorized',
          'platform_token_required: platform.nodes.credentials 只发给带平台 token 的客户端。' +
            (proxyEnabled
              ? '代理已开启（gateway.proxy_nodes），浏览器不需要也不应该拿 node token —— ' +
                '数据面请走 /nodes/<node_id>/ 前缀；这个端点现在只服务 CLI / 本地自动化。'
              : '浏览器请在连接设置里粘贴平台 token，脚本用 Authorization: Bearer <平台 token>；' +
                '令牌来自 gateway.token 或 gateway.token_env 指向的环境变量（不是 node token）。'),
          401,
          extra,
        );
      }
      const params = paramsRecord(request.params);
      if (params === null) {
        return failure(id, 'invalid_params', 'params must be an object', 400, extra);
      }
      const requestedNodeId = params.node_id;
      if (requestedNodeId !== undefined && typeof requestedNodeId !== 'string') {
        return failure(id, 'invalid_params', 'node_id must be a string', 400, extra);
      }
      // 省略 node_id：恰好一个节点 → 该节点（G1 兼容）；多节点 → 必须指定。
      if (requestedNodeId === undefined && ctx.registry.count() !== 1) {
        return failure(
          id,
          'invalid_params',
          'node_id is required when more than one node is registered',
          400,
          extra,
        );
      }
      let resolved: PlatformNodeCredential;
      try {
        resolved = ctx.resolveNodeCredential(requestedNodeId);
      } catch {
        // 不回显底层错误（可能含配置细节）；不缓存、不落盘。
        return failure(
          id,
          'platform_credentials_unavailable',
          'Node credentials are unavailable',
          503,
          extra,
        );
      }
      if (!resolved.found) {
        return failure(id, 'node_not_found', 'Node not found', 404, extra);
      }
      const token = resolved.token;
      const result =
        typeof token === 'string' && token !== ''
          ? { token, mode: 'token' as const }
          : { token: null, mode: 'none' as const };
      return success(id, result, extra);
    }
    case 'platform.whoami': {
      // 0.58：`proxy` 是**能力位**：前端据此决定「数据面走平台代理」还是「直连 node」。
      // 老前端忽略这个键，行为不变。
      return success(
        id,
        {
          authenticated: ctx.auth.mode === 'token',
          mode: ctx.auth.mode,
          proxy: {
            enabled: ctx.proxy?.enabled === true,
            base_path: ctx.proxy?.basePath ?? '/nodes',
          },
        },
        extra,
      );
    }
    case 'platform.health.get': {
      return success(
        id,
        {
          status: 'ok',
          version: ctx.version,
          node_count: ctx.registry.count(),
          proxy: {
            enabled: ctx.proxy?.enabled === true,
            base_path: ctx.proxy?.basePath ?? '/nodes',
          },
        },
        extra,
      );
    }
    case 'gateway.shutdown': {
      // Q4-C：平台优雅关闭（只受理，镜像 node admin.ts 的 gateway.shutdown 形状）。
      // Windows 上外部 process.kill 是无条件终止（进程内信号处理器跑不到）⇒ 停止方
      // 先经本方法触发进程内退出序列（跑到 owned 池 stop），再等死；超时回退强杀。
      // 响应必须先于退出序列发出：handler 只**受理**（defer 一拍），真正的退出由
      // 组合根注入的闭包在下一拍执行。重复调用幂等（退出序列各 stop 均幂等）。
      const shutdown = ctx.shutdown;
      // R1.2：「非回环」谓词与 source 分类统一 isRemote —— 原始 socket 非回环，
      // 或经已配置反代（密钥头成立）。不用 auth.loopback（合取会把经反代的远程判成回环）。
      const isRemote =
        !ctx.socketLoopback || (ctx.proxySecretConfigured === true && ctx.auth.proxySecretOk);
      const source = isRemote ? 'remote' : 'loopback';
      // 闸 1：未注入 = 与未知方法完全相同（not_found 200，零表面，不打日志）。
      if (shutdown === undefined) {
        return failure(id, 'not_found', 'Unknown platform method', 200, extra);
      }
      // 闸 2：params 省略或空对象通过；非对象 → invalid_params（与 node params_schema 空对象同形）。
      if (paramsRecord(request.params) === null) {
        logEvent('warn', 'platform.shutdown.rejected', { code: 'invalid_params', source });
        return failure(id, 'invalid_params', 'params must be an object', 400, extra);
      }
      // 闸 3/4 先于闸 5：不向未授权远程调用者泄露 token 是否有效。
      // 闸 3：非回环必须显式 opt-in（gateway.remote_shutdown；缺省 false）。
      if (isRemote && !shutdown.remoteAllowed) {
        logEvent('warn', 'platform.shutdown.rejected', {
          code: 'remote_shutdown_disabled',
          source,
        });
        return failure(
          id,
          'platform_unauthorized',
          'remote_shutdown_disabled: 非回环 gateway.shutdown 未开启。配置 gateway.remote_shutdown: true ' +
            '并经已配置共享密钥的 TLS 反代访问；或 SSH 到主机跑 `vessel stop`（本机兜底）。',
          401,
          extra,
        );
      }
      // 闸 4：非回环必须经已配置密钥的 TLS 反代（fail-closed：proxySecretOk 未配置恒 true，不足以作闸）。
      if (isRemote && (ctx.proxySecretConfigured !== true || !ctx.auth.proxySecretOk)) {
        logEvent('warn', 'platform.shutdown.rejected', {
          code: 'remote_shutdown_requires_proxy',
          source,
        });
        return failure(
          id,
          'platform_unauthorized',
          'remote_shutdown_requires_proxy: 非回环 gateway.shutdown 必须经已配置共享密钥的 TLS 反代' +
            '（gateway.proxy_secret_env + 反代注入 X-Vessel-Proxy-Secret 头）；裸公网直连一律拒绝。',
          401,
          extra,
        );
      }
      // 闸 5：token 恒要求 —— 回环匿名 / 浏览器会话 cookie 一律拒，无迁移豁免。
      if (ctx.auth.mode !== 'token') {
        logEvent('warn', 'platform.shutdown.rejected', { code: 'shutdown_token_required', source });
        return failure(
          id,
          'platform_unauthorized',
          'shutdown_token_required: gateway.shutdown 需要 Authorization: Bearer <平台 token>' +
            '（gateway.token 或 gateway.token_env 的值；浏览器会话 cookie 不构成停止能力）。',
          401,
          extra,
        );
      }
      // 闸 6：受理日志（无 token）→ defer 一拍执行退出序列 → 响应先发出。
      logEvent('info', 'platform.shutdown.accepted', { source });
      setTimeout(() => {
        // 退出序列自身的失败由组合根闭包记录；这里不吞进程退出（停止侧有强杀兜底）。
        void shutdown.handle().catch(() => undefined);
      }, 0);
      return success(id, { stopping: true }, extra);
    }
    default:
      // 未列出的方法（含任意 node 方法名）一律 not_found，不触达 node dispatcher。
      return failure(id, 'not_found', 'Unknown platform method', 200, extra);
  }
}
