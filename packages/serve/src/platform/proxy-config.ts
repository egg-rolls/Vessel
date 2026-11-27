/**
 * 0.58：平台代理 node 的**策略表**（路由形状、路径/方法白名单、各项上限）。
 *
 * 为什么单独一个文件：这些是「代理能不能成为新的穿通面」的全部判据，必须能被一眼读完、
 * 也只能有一处。转发实现（`proxy.ts` / `proxy-ws.ts`）只消费这里的结果，不许自己
 * 再加一条「顺手放行」。
 *
 * 三条硬约束（对应 docs/architecture/0.55-gateway-proxies-node.md）：
 * 1. 目标地址**只能**来自注册表：客户端只提供 `node_id`，永远不提供 host/port/scheme；
 * 2. 路径与 RPC 方法**白名单**（fail-closed）：不在表里的一律拒绝，不做「不认识就透传」；
 * 3. 每一项都要有上限：请求体、并发、超时、WS 背压水位与硬阈值。
 *
 * @module @vessel-agent/serve/platform/proxy-config
 */

/** 代理前缀：`/nodes/:nodeId/<node 路径>`。 */
export const PROXY_BASE_PATH = '/nodes';

/** node 侧路径的**永远拒绝**列表（会吐凭据 / 走另一套账号语义）。 */
const DENIED_PATH_PREFIXES: readonly string[] = [
  // 0.55：回环 + 同源时把 legacy gateway token 原样吐出来——经代理转一手就是
  // 「node token 出网关」，正是本设计的红线。
  '/v1/local/',
  // federation 入站走 peer bearer，不属于浏览器会话语义。
  '/v1/federation/',
];

/**
 * 允许代理的精确路径（比前缀更精确的都用前缀覆盖）。
 * 只列**数据面**：`/health` 用于浏览器区分「平台活着但 node 挂了」。
 */
const ALLOWED_EXACT_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/v1/health',
  '/v1/rpc',
  '/v1/events',
  '/v1/sessions',
  '/v1/tools',
  '/v1/runs',
]);

/** 允许代理的路径前缀（`/v1/**` 覆盖 durable / mcp / runs 子资源）。 */
const ALLOWED_PATH_PREFIXES: readonly string[] = ['/v1/'];

/**
 * 允许 WS 升级的精确路径。node 侧 `/ws` 是 0.1.0 兼容别名，一起放行；
 * 其它路径的 `Upgrade: websocket` 一律 400（WS 只走这条有记账的通道）。
 */
const ALLOWED_WS_PATHS: ReadonlySet<string> = new Set(['/v1/events', '/ws']);

/** 允许的 HTTP 方法。node 侧只有 GET/HEAD/POST 三种（无 PUT/DELETE 路由）。 */
const ALLOWED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST']);

/** node `node_id` 形状：注册表里的 id 由 CLI 生成，只可能是这套字符。 */
const NODE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * plugin-embed 契约 §4：embed 静态命名空间 `/plugins/<id>/ui/<...>`。
 * id 规则与 manifest 一致（`[a-z0-9][a-z0-9-]{1,63}`）；`ui` 段对
 * contributes.http 保留（manifest 校验），所以这里只会命中静态资源，
 * 动态路由不在该命名空间内。traversal 防护由 safeRestPath 负责。
 */
const PLUGIN_EMBED_STATIC_RE = /^\/plugins\/[a-z0-9][a-z0-9-]{1,63}\/ui\/(.+)$/;

/**
 * RPC 方法白名单的**命名空间**（0.55 方法表的全部前缀）。
 *
 * 为什么按命名空间而不是逐条列方法：逐条列会随 node 加方法而静默失效（新方法一律被拒
 * ⇒「面板某个按钮点了没反应」），维护成本高的白名单最终会被人改成黑名单。命名空间是
 * 稳定集合，未知命名空间（= 平台不认识的扩展）仍然 fail-closed。
 */
const ALLOWED_RPC_NAMESPACES: ReadonlySet<string> = new Set([
  'agents',
  'ask',
  'attachments',
  'capabilities',
  'config',
  'evals',
  'events',
  'feishu',
  'gateway',
  'health',
  'interactions',
  // q-inbox-ux-fix（jobs proxy 白名单缺口，lead 双员发现 / 用户裁示 approve）：
  // 异步 bash 作业可视化（jobs.log 读 log tail / jobs.list badge 初始读）经平台代理
  // 时缺命名空间 ⇒ proxy_method_not_allowed（fail-closed；直连 node 正常）。
  // jobs.* 只读作业产物，不涉及进程生死 / 服务安装，无需进 DENIED_RPC_METHODS；
  // 与 kanban 先例同口径，后续 jobs.* 新方法同命名空间自动覆盖。
  'jobs',
  // q-kanban-proxy：任务看板（kanban.get 读板 / kanban.archive 用户验收归档）。
  // node 侧方法已就位（gateway/methods/kanban.ts），平台侧缺命名空间导致
  // proxy_method_not_allowed（fail-closed）。两者都不涉及进程生死 / 服务安装，
  // 无需进 DENIED_RPC_METHODS；后续 kanban.* 新方法同命名空间自动覆盖。
  'kanban',
  'mcp',
  'metrics',
  'permission',
  'permissions',
  // 插件数据面 RPC（plugin.<id>.<method>）：embed 契约 §11 承诺代理模式可用，
  // picker / embed 数据 / iframe 桥都走它（2026-11-23 用户裁决加入）。只加这一个
  // 命名空间；DENIED_RPC_METHODS 与插件自身的方法白名单仍然生效。
  'plugin',
  'plugins',
  'runs',
  'sessions',
  'teams',
  'tools',
  'trace',
]);

/**
 * 显式拒绝的方法（即使命名空间在白名单里）。
 *
 * 判据：会改变**进程生死**或**服务安装**的方法——它们没有「浏览器会话」这个语义，
 * 只能由本机 CLI 做。0.55 方法表里目前没有 shutdown/update，这里是**预留的闸门**：
 * 将来 node 加了这类方法，默认也不会因为命名空间命中而被放行。
 */
const DENIED_RPC_METHODS: ReadonlySet<string> = new Set([
  'gateway.install-service',
  'gateway.install.service',
  'gateway.shutdown',
  'gateway.restart',
  'node.shutdown',
  'node.restart',
  'node.update',
]);

/** 代理的全部上限；组合根可以按部署覆盖（`PlatformProxyLimits` 是唯一真相）。 */
export interface PlatformProxyLimits {
  /** 单请求体上限（字节）。超出 → 413。 */
  maxBodyBytes: number;
  /** 同时在途的 HTTP 代理请求上限。超出 → 503（不排队：排队就是无界）。 */
  maxConcurrentRequests: number;
  /** 上游响应头超时（毫秒）。流式响应在头到达后**不受**这个上限约束。 */
  requestTimeoutMs: number;
  /**
   * **健康探测类路径**的响应头超时（毫秒）。
   *
   * 为什么必须单独一条（0.57 真实事故）：`/health` 走的是 30s 的 RPC 超时，node 未就绪
   * 时每个请求都白等 30s 才报 `node_unreachable`——用户看到的现象是「页面卡 30 秒，然后
   * 说 node 连不上」。探活是**快失败 + 快重试**的语义，跟 RPC 的「慢但可能要跑很久」不是
   * 一回事：健康探测 1.5s 拿不到响应头，结论就已经是「它还没起来」。
   */
  probeTimeoutMs: number;
  /** WS 上游握手超时（毫秒）：浏览器已连上但 node 迟迟不 open → 1011。 */
  wsHandshakeTimeoutMs: number;
  /** WS 心跳间隔（毫秒）：平台自己向浏览器发 ping，不借用 node 的心跳。 */
  wsHeartbeatIntervalMs: number;
  /** WS 判死阈值（毫秒）：这么久没有任何来自对端的证据 → 双向关闭并记账。 */
  wsHeartbeatTimeoutMs: number;
  /** 同时存在的代理 WS 连接上限。超出 → 503。 */
  wsMaxConnections: number;
  /** 背压高水位（字节）：超过后暂停向该端写入，转入有界队列。 */
  wsHighWaterBytes: number;
  /** 背压低水位（字节）：降到这里以下恢复写入。 */
  wsLowWaterBytes: number;
  /** 单向待发队列的硬阈值（字节）：超过 → 1013 关闭并记 `backpressure_overflow`。 */
  wsHardLimitBytes: number;
  /** 全平台所有 WS 待发字节的硬预算（字节）：防止「每条连接都刚好没超」把内存吃光。 */
  wsPendingBudgetBytes: number;
}

/** 缺省值。数字都带注释：它们是判据，不是魔法数。 */
export const DEFAULT_PLATFORM_PROXY_LIMITS: PlatformProxyLimits = {
  // 8 MiB：node 没有上传端点，RPC 体最大的是多模态内联（几 MiB base64）。
  maxBodyBytes: 8 * 1024 * 1024,
  // 64：与 platform `/platform/rpc` 的量级匹配；超出直接 503 让浏览器重试。
  maxConcurrentRequests: 64,
  // 30s：与 node 客户端自己的请求超时同量级（`REQUEST_TIMEOUT_MS`）。
  requestTimeoutMs: 30_000,
  // 1.5s：探活只回答「node 在不在」，不该借 RPC 的 30s。1.5s 足够同机 / 同网段一次
  // 三次握手 + 一次 `{"status":"ok"}`，慢于此的 node 在人类感知里就是「没起来」。
  probeTimeoutMs: 1_500,
  // 10s：跨机 WS 握手给足时间，又不至于让半开连接长期占槽。
  wsHandshakeTimeoutMs: 10_000,
  // 25s / 60s：与 node 侧心跳同口径（设计 §3.2 的延迟预算表）。
  wsHeartbeatIntervalMs: 25_000,
  wsHeartbeatTimeoutMs: 60_000,
  // 32：一条 WS ≈ 一个标签页；32 张标签页已经远超真实用量。
  wsMaxConnections: 32,
  // 1 MiB / 256 KiB：设计 §2.2 的水位；1/2 关系保证一次停顿不会立刻再次触发。
  wsHighWaterBytes: 1024 * 1024,
  wsLowWaterBytes: 256 * 1024,
  // 8 MiB：与 node 侧 `MAX_BUFFERED_BYTES` 同值——再大就是「慢客户端吃掉进程内存」。
  wsHardLimitBytes: 8 * 1024 * 1024,
  // 64 MiB：32 条连接 × 8 MiB 的理论上界太高，用全局预算兜住实际峰值。
  wsPendingBudgetBytes: 64 * 1024 * 1024,
};

/** 合并用户覆盖值（负值 / 非整数忽略，保持缺省，不允许把上限调成无穷）。 */
export function resolveProxyLimits(
  overrides?: Partial<PlatformProxyLimits> | undefined,
): PlatformProxyLimits {
  const resolved: PlatformProxyLimits = { ...DEFAULT_PLATFORM_PROXY_LIMITS };
  if (overrides === undefined) return resolved;
  for (const key of Object.keys(DEFAULT_PLATFORM_PROXY_LIMITS) as Array<
    keyof PlatformProxyLimits
  >) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) resolved[key] = value;
  }
  // 水位必须有序：高水位 < 硬阈值，低水位 < 高水位。配错不是「更宽松」，是「永远触发」。
  if (resolved.wsLowWaterBytes >= resolved.wsHighWaterBytes) {
    resolved.wsLowWaterBytes = Math.floor(resolved.wsHighWaterBytes / 4);
  }
  if (resolved.wsHighWaterBytes >= resolved.wsHardLimitBytes) {
    resolved.wsHardLimitBytes = resolved.wsHighWaterBytes * 8;
  }
  return resolved;
}

/** 解析后的代理路由：`/nodes/<id><rest>`。 */
export interface ProxyRoute {
  nodeId: string;
  /** 以 `/` 开头的 node 侧路径（含前导斜杠，**不含** node_id）。 */
  rest: string;
}

/**
 * 解析代理路径。不匹配 / 形状可疑一律返回 null（调用方 404，不回显解析细节）。
 *
 * 拒绝的输入（每一条都对应一种绕过）：
 * - `//host/x`、`/\host/x`：URL 解析会把它们当成新 authority（SSRF 的经典写法）；
 * - 含 `..` 段、`%2e%2e` 段：路径穿越；
 * - 含 `:`（第一个 `/` 之前的 id 之外）：`http://127.0.0.1:8644` 这种绝对地址不会被当成路径。
 */
export function parseProxyRoute(pathname: string): ProxyRoute | null {
  const prefix = `${PROXY_BASE_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const tail = pathname.slice(prefix.length);
  const slash = tail.indexOf('/');
  if (slash <= 0) return null;
  let nodeId: string;
  try {
    nodeId = decodeURIComponent(tail.slice(0, slash));
  } catch {
    return null;
  }
  if (!NODE_ID_PATTERN.test(nodeId)) return null;
  const rest = tail.slice(slash);
  if (!safeRestPath(rest)) return null;
  return { nodeId, rest };
}

/** `rest` 自身的形状校验；通过才能拼到注册表给出的 origin 上。 */
export function safeRestPath(rest: string): boolean {
  if (!rest.startsWith('/')) return false;
  if (rest.startsWith('//')) return false;
  if (rest.includes('\\')) return false;
  if (rest.includes('://')) return false;
  // 逐段解码后再查 `..`：编码过的 `%2e%2e` 与 `..` 等价。
  for (const raw of rest.split('/')) {
    if (raw === '') continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return false;
    }
    if (segment === '.' || segment === '..') return false;
  }
  return true;
}

/** 代理拒绝的原因；调用方按 `status` / `code` 直接回 JSON。 */
export interface ProxyRejection {
  status: number;
  code: string;
  message: string;
}

/**
 * 路径是不是**健康探测**：这类请求要快失败（{@link PlatformProxyLimits.probeTimeoutMs}），
 * 不能借用 RPC 的 30s 响应头超时。
 *
 * 判据只认「探活」本身：`/health`、`/healthz`、`/readyz`、`/livez`（含 `/v1/` 前缀与尾斜杠）。
 * 任何要读会话 / 跑 run 的路径都不在此列表——它们本来就可能要几十秒。
 */
export function isHealthProbePath(rest: string): boolean {
  const path = rest.length > 1 && rest.endsWith('/') ? rest.slice(0, -1) : rest;
  // `/v1/health` 与 `/health` 是同一个探活（strip 前缀时保留前导斜杠）。
  const bare = path.startsWith('/v1/') ? path.slice(3) : path;
  return bare === '/health' || bare === '/healthz' || bare === '/readyz' || bare === '/livez';
}

/**
 * 路径是否允许代理（HTTP）。plugin-embed 契约 §4：`/plugins/<id>/ui/<...>`
 * 的 embed 静态资源**仅 GET / HEAD** 放行（其他方法 405）；其余形状不变。
 */
export function checkProxyHttpPath(rest: string, method: string): ProxyRejection | null {
  for (const denied of DENIED_PATH_PREFIXES) {
    if (rest.startsWith(denied)) {
      return {
        status: 403,
        code: 'proxy_path_denied',
        message:
          `proxy_path_denied: ${denied}* 永远不经代理（这个端点会把 node 凭据写在响应体里）。` +
          '需要它请走本机 CLI。',
      };
    }
  }
  if (ALLOWED_EXACT_PATHS.has(rest)) return null;
  for (const allowed of ALLOWED_PATH_PREFIXES) {
    if (rest.startsWith(allowed)) return null;
  }
  const embedStatic = PLUGIN_EMBED_STATIC_RE.exec(rest);
  if (embedStatic !== null) {
    // 后续段至少一个非空（`/plugins/<id>/ui/` 本身不算资源路径）。
    const hasSegment = (embedStatic[1] ?? '').split('/').some((segment) => segment.length > 0);
    if (hasSegment) {
      const upper = method.toUpperCase();
      if (upper === 'GET' || upper === 'HEAD') return null;
      return {
        status: 405,
        code: 'proxy_method_not_allowed',
        message:
          `proxy_method_not_allowed: embed 静态资源（/plugins/<id>/ui/**）只代理 GET / HEAD` +
          `（收到 ${upper}）。`,
      };
    }
  }
  return {
    status: 404,
    code: 'proxy_path_not_allowed',
    message:
      `proxy_path_not_allowed: 平台只代理 node 的数据面路径（/health、/v1/**）与 embed 静态资源` +
      `（/plugins/<id>/ui/**，仅 GET / HEAD）；"${rest}" 不在白名单内。` +
      '插件 iframe 页仍请直连 node 或走 node 自己的入口。',
  };
}

/** WS 升级路径是否允许（只有事件流两条）。 */
export function checkProxyWsPath(rest: string): ProxyRejection | null {
  if (ALLOWED_WS_PATHS.has(rest)) return null;
  return {
    status: 400,
    code: 'proxy_ws_path_not_allowed',
    message:
      `proxy_ws_path_not_allowed: 代理只转发事件流 WS（/v1/events、/ws）；` +
      `"${rest}" 不接受 Upgrade。`,
  };
}

/** HTTP 方法是否允许代理。 */
export function checkProxyMethod(method: string): ProxyRejection | null {
  const upper = method.toUpperCase();
  if (ALLOWED_METHODS.has(upper)) return null;
  return {
    status: 405,
    code: 'proxy_method_not_allowed',
    message: `proxy_method_not_allowed: 代理只转发 GET / HEAD / POST（收到 ${upper}）。`,
  };
}

/**
 * WS 帧里的 RPC 方法裁决。`frame` 是已解析的客户端帧；只有 `kind:'req'` 参与判定。
 *
 * 返回 null = 放行。拒绝时调用方回一帧 `res`（形状与 node 一致），**不转发**。
 */
export function checkRpcMethod(method: unknown): ProxyRejection | null {
  if (typeof method !== 'string' || method === '') {
    return {
      status: 403,
      code: 'proxy_method_denied',
      message: 'proxy_method_denied: RPC 帧没有方法名。',
    };
  }
  if (DENIED_RPC_METHODS.has(method)) {
    return {
      status: 403,
      code: 'proxy_method_denied',
      message:
        `proxy_method_denied: ${method} 会改变进程生死 / 安装服务，不经代理放行` +
        '（请在本机用 CLI 执行）。',
    };
  }
  const namespace = method.slice(0, method.indexOf('.'));
  if (!ALLOWED_RPC_NAMESPACES.has(namespace)) {
    return {
      status: 403,
      code: 'proxy_method_not_allowed',
      message:
        `proxy_method_not_allowed: 代理只转发已知命名空间的 node 方法，` +
        `"${method}" 的平台侧白名单缺失（fail-closed，不是透传）。`,
    };
  }
  return null;
}
