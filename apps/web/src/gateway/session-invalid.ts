/**
 * 「RPC 被拒」的显式状态（0.59）。
 *
 * 起因是一次真 bug：浏览器在 `127.0.0.1:8644`（Vite relay）时 `POST /v1/rpc` 恒 401，
 * 而客户端把 401 当成普通 RPC 失败吞掉 —— 界面上**没有任何表示**。于是 rotate 的权限卡
 * 永远拿不到（`interactions.list` 也 401），用户唯一能做的动作是「停止」。
 *
 * 这里只做三件事，都很小：
 * 1. {@link classifyRpcFailure} 把「鉴权 / Origin 被拒」与业务错误分开（纯函数，可测）；
 * 2. {@link createRpcBlockTracker} 记下最近一次被拒事实，并按「变化 / 冷却」决定
 *    该不该再抬一次（避免错误轮询把 `notifyAuthRequired` 打成风暴）；
 * 3. {@link setSessionReauthHandler} 是唯一的对外动作出口 —— 浏览器层把它接到既有的
 *    `notifyAuthRequired()`（`auth/auth-client`），**不新造通道**。
 *
 * 为什么这个文件零依赖、不碰 DOM / 不 import 浏览器模块：根 tsconfig（lib 只有 ES2022、
 * 没有 DOM）会把 `src/*.test.ts` 引到的文件一起编译，`window` 那类全局在那里是残缺的。
 * 于是「谁去通知 React」这件事交给 `use-session-invalid.ts`，本文件保持纯逻辑。
 */

/**
 * 被拒的三类：
 * - `session`：会话失效（要重新登录）；
 * - `origin`：Origin / Host 被拒（要改配置，重登不会好）；
 * - `connection`：**一次都没连通过**（CORS 直接挡死 / node 没起，浏览器只给 TypeError）。
 */
export type GatewayRpcBlockKind = 'session' | 'origin' | 'connection';

export interface GatewayRpcBlock {
  kind: GatewayRpcBlockKind;
  /** gateway 稳定错误码（`unauthorized` / `session_required` / `forbidden_origin`…）。 */
  code: string;
  /** HTTP 状态；WS 侧错误与 connection 档没有状态。 */
  status?: number;
  /** 服务端原话（可能含诊断细节；不含 token / cookie）。 */
  message: string;
  /** 产生这次判定的请求路径或方法名（`/v1/rpc`、`interactions.list`）。 */
  method?: string;
  /** 首次观察到这条事实的时间（ms epoch）。 */
  at: number;
  /** 仅 connection 档：计数窗口内连续失败的次数（用于「最近 N 次全部失败」的说明）。 */
  attempts?: number;
}

/**
 * 直接表示「这个会话不能用了」的错误码。
 *
 * 只收**只有 HTTP 响应才可能产生**的码（它们天然带 401/403），不收 `unauthorized` 的
 * 「本地没 token」分支 —— 那条是 `httpJson` 在发请求之前自己抛的（`status` 为空），
 * 属于「还没输入 token」的界面状态，不是会话失效，报成「会话失效」会误导。
 */
const SESSION_CODES: ReadonlySet<string> = new Set([
  'session_required',
  'platform_unauthorized',
  'csrf_failed',
]);

/** Origin / Host 白名单拒绝（部署配置问题；重新登录不会好）。 */
const ORIGIN_CODES: ReadonlySet<string> = new Set(['forbidden_origin', 'invalid_host']);

/** 旧 gateway 根本没有这个方法（404 / 405 / method_not_allowed）：不是失败，是「不支持」。 */
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set(['method_not_allowed', 'not_found']);

interface ErrorShape {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

function shapeOf(error: unknown): ErrorShape | null {
  return typeof error === 'object' && error !== null ? (error as ErrorShape) : null;
}

function codeOf(error: unknown): string {
  const code = shapeOf(error)?.code;
  return typeof code === 'string' ? code : '';
}

function statusOf(error: unknown): number | undefined {
  const status = shapeOf(error)?.status;
  return typeof status === 'number' ? status : undefined;
}

function messageOf(error: unknown): string {
  const shape = shapeOf(error);
  if (typeof shape?.message === 'string' && shape.message.length > 0) return shape.message;
  return error instanceof Error && error.message.length > 0 ? error.message : '';
}

/**
 * 这个错误是不是「被拒绝访问」（会话失效 / Origin 被拒）。
 *
 * 判据刻意窄：只有 401、`session_required` / `platform_unauthorized` / `csrf_failed`、
 * `forbidden_origin` / `invalid_host`。权限类 403（`forbidden`）与业务错误一律返回 null，
 * 它们有自己的提示路径，不能被冒充成「重新登录」。
 */
export function classifyRpcFailure(error: unknown): Omit<GatewayRpcBlock, 'at' | 'method'> | null {
  const code = codeOf(error);
  const status = statusOf(error);
  const message = messageOf(error);

  if (ORIGIN_CODES.has(code)) {
    return { kind: 'origin', code, ...(status !== undefined ? { status } : {}), message };
  }
  if (status === 401 || SESSION_CODES.has(code)) {
    return {
      kind: 'session',
      code: code === '' ? 'unauthorized' : code,
      ...(status !== undefined ? { status } : {}),
      message,
    };
  }
  return null;
}

/** 旧 gateway 没有这个方法（调用方应「当作空结果」而不是报错）。 */
export function isUnsupportedMethodError(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 404 || status === 405) return true;
  return UNSUPPORTED_CODES.has(codeOf(error));
}

export interface RpcBlockSnapshot {
  /** 最近一次被拒事实；null = 当前没有。 */
  block: GatewayRpcBlock | null;
  /** 每产生一个新的 `block` 对象就 +1（UI 用它做 aria 播报 / 重渲判定）。 */
  revision: number;
}

export interface RpcBlockTracker {
  snapshot(): RpcBlockSnapshot;
  /**
   * 记录一次 RPC 失败。
   *
   * 返回**非 null** 时表示「这一次要抬出去」（触发重新鉴权），规则：
   * - 第一次观察到被拒：抬；
   * - 事实变了（kind / code 不同）：抬；
   * - 同一条事实但已过 `repeatMs`：再抬一次（长挂着的失效会话也要有人管）；
   * - 其余（连续相同失败、冷却期内）：不抬 —— 401 会成串出现，不能每来一条就通知。
   */
  observe(error: unknown, options?: { method?: string; now?: number }): GatewayRpcBlock | null;
  /**
   * 记录一次 **network 类失败**（fetch 连响应都没拿到：CORS 被拒 / node 没起 / 断网）。
   *
   * 这条通路只处理「这个问题连 HTTP 状态码都没有」的情形 —— 真跨源被拒时浏览器只抛
   * `TypeError`，没有任何 401/403 可分类，于是它既不会进 `observe`、也就永远不上报。
   *
   * 抬升规则（全部是**为了不误报**）：
   * - 本 epoch **从未成功过**才可能抬；成功过一次就永不抬（否则断网会疯狂误报）；
   * - 计数窗口内（缺省 30s）连续失败达到阈值（缺省 3）才抬，单次抖动不报；
   * - 每个 epoch 最多抬一次（抬过就不再刷）；
   * - `kind: 'connection'`：**不**触发重新登录（不是会话问题），动作指向连接设置。
   */
  observeNetworkFailure(options?: {
    method?: string;
    message?: string;
    now?: number;
  }): GatewayRpcBlock | null;
  /** 一次成功的 RPC：清掉计数、标记「本 epoch 成功过」，并让 connection 提示**自愈**消失。 */
  noteSuccess(): void;
  /** 新连接建立（连接级 hello，含重连成功）：唯一的 epoch 重置点。 */
  beginEpoch(): void;
  /** 清掉当前事实（任何 kind）并通知订阅者。 */
  clear(): void;
  subscribe(listener: () => void): () => void;
}

export interface RpcBlockTrackerOptions {
  /** 同一条事实的重报间隔（缺省 30s）。 */
  repeatMs?: number;
  now?: () => number;
  /** connection 档：窗口内连续 network 失败达到这个数才抬（缺省 3）。 */
  networkFailureThreshold?: number;
  /** connection 档：计数窗口（缺省 30s）。 */
  networkFailureWindowMs?: number;
}

const DEFAULT_REPEAT_MS = 30_000;
/** connection 档：连续失败阈值（单次抖动不值得报警）。 */
const DEFAULT_NETWORK_FAILURE_THRESHOLD = 3;
/** connection 档：计数窗口 —— 只有窗口内的连续失败才累计。 */
const DEFAULT_NETWORK_FAILURE_WINDOW_MS = 30_000;

const EMPTY_SNAPSHOT: RpcBlockSnapshot = { block: null, revision: 0 };

/** 两条被拒事实是否「内容等价」（用来避免无意义的重渲）。 */
function sameBlock(left: GatewayRpcBlock | null, right: GatewayRpcBlock | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.code === right.code &&
    left.status === right.status &&
    left.message === right.message &&
    left.method === right.method &&
    left.at === right.at
  );
}

export function createRpcBlockTracker(options: RpcBlockTrackerOptions = {}): RpcBlockTracker {
  const repeatMs = options.repeatMs ?? DEFAULT_REPEAT_MS;
  const now = options.now ?? (() => Date.now());
  const networkThreshold = options.networkFailureThreshold ?? DEFAULT_NETWORK_FAILURE_THRESHOLD;
  const networkWindowMs = options.networkFailureWindowMs ?? DEFAULT_NETWORK_FAILURE_WINDOW_MS;

  let snapshot: RpcBlockSnapshot = EMPTY_SNAPSHOT;
  /** 上一次「抬出去」的时刻（不是上一次观察到的时刻）。 */
  let lastRaisedAt = 0;
  const listeners = new Set<() => void>();

  // connection 档的按-epoch 计数（见 observeNetworkFailure 的抬升规则）。
  let networkFailures = 0;
  let networkWindowStart: number | undefined;
  let raisedConnectionThisEpoch = false;
  let succeededThisEpoch = false;

  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const commit = (block: GatewayRpcBlock, revision: number): void => {
    snapshot = { block, revision };
    emit();
  };

  const clearBlock = (): void => {
    if (snapshot.block === null) return;
    lastRaisedAt = 0;
    snapshot = { block: null, revision: snapshot.revision + 1 };
    emit();
  };

  return {
    snapshot: () => snapshot,

    observe(error, observeOptions = {}) {
      const classified = classifyRpcFailure(error);
      if (classified === null) return null;
      const at = observeOptions.now ?? now();
      const previous = snapshot.block;
      const same =
        previous !== null && previous.kind === classified.kind && previous.code === classified.code;
      const elapsed = at - lastRaisedAt;
      const raise = !same || elapsed >= repeatMs || elapsed < 0;

      const block: GatewayRpcBlock = {
        ...classified,
        ...(observeOptions.method !== undefined ? { method: observeOptions.method } : {}),
        // `at` 保持「这轮事实开始的时间」：同一条事实反复出现时不刷新它，
        // 否则界面上的「已经无效 N 秒」会永远归零。
        at: same && previous !== null ? previous.at : at,
      };
      // 只在**内容真的变了**时通知订阅者：401 会成串出现（一次页面加载十几次 RPC），
      // 每条都 commit 会把 React 侧打成每请求一次重渲。
      if (!sameBlock(previous, block)) {
        // revision 只在「换了一条事实」时 +1；同一条事实的细节变化（method / message）不 +1。
        commit(block, same ? snapshot.revision : snapshot.revision + 1);
      }
      if (!raise) return null;
      lastRaisedAt = at;
      return block;
    },

    observeNetworkFailure(failureOptions = {}) {
      // ① 本 epoch 成功过 ⇒ 永不抬。这一条是防误报的关键：断网、node 重启这些
      //    「本来就连得上」的场景由既有 network 提示（lastError / stale）负责，
      //    这里再多说一遍就是重复报警。
      if (succeededThisEpoch) return null;
      // ② 抬过就不再刷（每 epoch 一次）。
      if (raisedConnectionThisEpoch) return null;

      const at = failureOptions.now ?? now();
      // ③ 窗口：首次失败或已经超出窗口 ⇒ 重开一个窗口，计数从 1 开始。
      if (
        networkWindowStart === undefined ||
        at - networkWindowStart > networkWindowMs ||
        at < networkWindowStart
      ) {
        networkWindowStart = at;
        networkFailures = 0;
      }
      networkFailures += 1;
      if (networkFailures < networkThreshold) return null;

      raisedConnectionThisEpoch = true;
      const block: GatewayRpcBlock = {
        kind: 'connection',
        code: 'unreachable',
        ...(failureOptions.method !== undefined ? { method: failureOptions.method } : {}),
        message: failureOptions.message ?? '',
        at: networkWindowStart,
        attempts: networkFailures,
      };
      commit(block, snapshot.revision + 1);
      return block;
    },

    noteSuccess() {
      // 成功一次 ⇒ 本 epoch 之后永不再抬 connection 提示，并且**已经抬出来的那条
      // 必须自动消失**（否则会挂着一个已经不对的警告）。
      succeededThisEpoch = true;
      networkFailures = 0;
      networkWindowStart = undefined;
      clearBlock();
    },

    beginEpoch() {
      // 唯一的 epoch 重置点（ConnectionProvider/连接级 hello 处调用）。**不要在请求里
      // 重置** —— 那样计数永远攒不到阈值。新连接意味着上个 epoch 的「连不上」结论作废。
      networkFailures = 0;
      networkWindowStart = undefined;
      raisedConnectionThisEpoch = false;
      succeededThisEpoch = false;
      if (snapshot.block?.kind === 'connection') clearBlock();
    },

    clear() {
      clearBlock();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * 全局单例：`httpJson`（传输层）写，界面读。
 *
 * 为什么用模块单例而不是 context：401 可能发生在**任何** RPC 上，包括引擎之外的
 * 工具调用；把它挂在 context 里意味着每个调用点都要拿到 provider 的引用。
 */
export const rpcBlockTracker = createRpcBlockTracker();

let reauthHandler: (() => void) | null = null;

/**
 * 注册「需要重新鉴权」的动作（浏览器层接既有的 `notifyAuthRequired()`）。
 *
 * 一个出口、可替换（测试注入假实现），传输层因此不需要知道 auth 模块的任何东西。
 */
export function setSessionReauthHandler(handler: (() => void) | null): void {
  reauthHandler = handler;
}

/**
 * 记录一次 RPC 失败；该抬的时候调到 {@link setSessionReauthHandler} 那条既有通道。
 *
 * 只有 `kind === 'session'` 才触发重新鉴权：Origin / Host 被拒是**部署配置**问题
 * （白名单里没有这个来源），重新登录一百次也一样 —— 那时该做的是打开连接设置，
 * 所以 origin 只会写进状态给界面看。
 *
 * 返回被拒事实（供调用方把它带进自己的错误消息），没被拒就是 null。
 */
export function noteRpcFailure(error: unknown, method?: string): GatewayRpcBlock | null {
  const block = rpcBlockTracker.observe(error, method === undefined ? {} : { method });
  if (block !== null && block.kind === 'session') reauthHandler?.();
  return block;
}

/** RPC 成功：会话 / Origin / 连接都通了，清掉失效状态并让 connection 提示自愈（幂等）。 */
export function noteRpcSuccess(): void {
  rpcBlockTracker.noteSuccess();
}

/**
 * 一次 network 类失败（fetch 连响应都没拿到）。
 *
 * `kind: 'connection'` **不**触发重新鉴权：CORS 被拒 / node 没起，重登一百次也一样；
 * 该做的是打开连接设置。返回被抬出来的事实（没到阈值 / 不在窗口 / 本 epoch 成功过 ⇒ null）。
 */
export function noteRpcNetworkFailure(error: unknown, method?: string): GatewayRpcBlock | null {
  return rpcBlockTracker.observeNetworkFailure({
    ...(method !== undefined ? { method } : {}),
    message: messageOf(error),
  });
}

/**
 * 新连接建立（连接级 hello，含重连成功）—— **唯一的 epoch 重置点**。
 *
 * 由 `connection-handlers.ts` 在 `setEpoch` 处调用（同一行旁边），不要在任何请求路径里调：
 * 每个请求都重置的话连续失败计数永远攒不到阈值。
 */
export function beginRpcEpoch(): void {
  rpcBlockTracker.beginEpoch();
}
