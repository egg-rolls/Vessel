/**
 * 「RPC 被拒（401 / Origin）不许静默」+「pending 拉取失败不许冒充空列表」（0.59）。
 *
 * 这一单的由来是一次真 bug：浏览器在 `127.0.0.1:8644`（Vite relay）时 `POST /v1/rpc`
 * 全部 401，而客户端把 401 当普通失败吞掉 —— 界面上**没有任何表示**，于是 rotate 的
 * 权限卡永远拿不到、点不了，用户只能按停止。这里钉四条：
 *
 * 1. **传输层**：真实的 `GatewayClient#rpc` 收到 401 ⇒ 全局「被拒」状态变成
 *    `{kind:'session'}`，并且**恰好一次**走到既有的重新鉴权通道（`setSessionReauthHandler`）；
 *    403 `forbidden_origin` ⇒ `{kind:'origin'}`，且**不**触发重新登录（重登不会好）；
 * 2. **恢复即清**：下一次成功响应把状态清空（提示条自己消失，不需要用户点关闭）；
 * 3. **不许风暴**：同一条事实连续出现只抬一次，冷却后才再抬（401 会成串出现）；
 * 4. **pending 失败 ≠ 空**：`resolvePendingFetch` 把失败标成 `failed`（带原因分类），
 *    旧 gateway 的 `method_not_allowed` 标成 `unsupported`（界面不出提示），并且
 *    失败那一轮**不做** stale 收敛（不误删本地卡片）；恢复那一轮把卡片补回来；
 * 5. **连不通也算被拒**：真跨源被挡时浏览器只抛 `TypeError`（没有状态码可分类）⇒
 *    连续 N 次、窗口内、本 epoch 从未成功过才抬 `{kind:'connection'}`，成功一次即自愈、
 *    此后本 epoch 永不抬；它压掉网络类提示但绝不吞鉴权提示。
 *
 * 直接跑：`bun run src/gateway-rpc-blocked.test.ts`（看输出文本判定；本机 bun 是
 * Windows 版，退出码不可信）。
 */

import { shellNoticeItems } from '../apps/web/src/app/shellNoticeItems';
import {
  buildHydrationSnapshot,
  type InteractionState,
  interactionReducer,
  type ListedInteraction,
  type ListedInteractionPage,
  PENDING_FETCH_UNKNOWN,
  resolvePendingFetch,
  stalePendingIds,
} from '../apps/web/src/gateway/interaction-hydration';
import { GatewayClient } from '../apps/web/src/gateway/node/index';
import {
  beginRpcEpoch,
  classifyRpcFailure,
  createRpcBlockTracker,
  type GatewayRpcBlock,
  isUnsupportedMethodError,
  rpcBlockTracker,
  setSessionReauthHandler,
} from '../apps/web/src/gateway/session-invalid';
import { t } from '../apps/web/src/i18n';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${got}`);
}

/** `shellNoticeItems` 的入参缺省值：只有被测字段才覆盖。 */
function noticeInput(
  overrides: Partial<Parameters<typeof shellNoticeItems>[0]> = {},
): Parameters<typeof shellNoticeItems>[0] {
  return {
    lastError: null,
    tokenError: null,
    stale: false,
    connectionState: 'open',
    reconnectAttempt: 0,
    sessionInvalid: null,
    onRelogin: () => {},
    onDismissError: () => {},
    onRetry: () => {},
    onOpenConnection: () => {},
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 401 的两种真身：node 鉴权（`unauthorized`）与平台会话闸（`session_required`）。 */
const UNAUTHORIZED_BODY = { error: { code: 'unauthorized', message: 'Missing or invalid token' } };
const ORIGIN_BODY = { error: { code: 'forbidden_origin', message: 'Origin is not allowed' } };

interface FetchCall {
  url: string;
  method: string;
}

/** 让 `GatewayClient#rpc` 打到假 fetch：没有网络、没有真实 node。 */
async function withFetch(
  respond: (call: FetchCall) => Response,
  run: (calls: FetchCall[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = { url, method: init?.method ?? 'GET' };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

async function main(): Promise<void> {
  // ---- 1. 分类：谁能算「被拒」 ----
  check(
    '401 unauthorized → session',
    classifyRpcFailure({ code: 'unauthorized', status: 401, message: 'x' })?.kind === 'session',
  );
  check(
    'session_required（无状态码）→ session',
    classifyRpcFailure({ code: 'session_required', message: 'x' })?.kind === 'session',
  );
  check(
    'csrf_failed → session',
    classifyRpcFailure({ code: 'csrf_failed', status: 403, message: 'x' })?.kind === 'session',
  );
  check(
    'forbidden_origin → origin',
    classifyRpcFailure({ code: 'forbidden_origin', status: 403, message: 'x' })?.kind === 'origin',
  );
  check(
    'invalid_host → origin',
    classifyRpcFailure({ code: 'invalid_host', status: 403, message: 'x' })?.kind === 'origin',
  );
  check(
    '权限类 403 forbidden 不算被拒',
    classifyRpcFailure({ code: 'forbidden', status: 403, message: 'x' }) === null,
  );
  check(
    '本地缺 token（无 status）不算会话失效',
    classifyRpcFailure({ code: 'unauthorized', message: 'token required' }) === null,
  );
  check('网络错误不算被拒', classifyRpcFailure({ code: 'network', message: 'boom' }) === null);
  check(
    '旧 gateway 404/method_not_allowed = 不支持',
    isUnsupportedMethodError({ code: 'not_found', status: 404, message: 'x' }) &&
      isUnsupportedMethodError({ code: 'method_not_allowed', status: 405, message: 'x' }) &&
      !isUnsupportedMethodError({ code: 'unauthorized', status: 401, message: 'x' }),
  );

  // ---- 2. 真实传输层：401 → 全局状态 + 恰一次重新鉴权 ----
  let reauthCalls = 0;
  setSessionReauthHandler(() => {
    reauthCalls += 1;
  });
  rpcBlockTracker.clear();

  const client = new GatewayClient('http://127.0.0.1:8642', { proxy: true });
  let thrownCode = '';
  await withFetch(
    () => jsonResponse(401, UNAUTHORIZED_BODY),
    async (calls) => {
      try {
        await client.rpc('interactions.list', { status: 'pending' });
      } catch (error) {
        thrownCode = (error as { code?: string }).code ?? '';
      }
      check('401 打到 /v1/rpc', calls[0]?.url === 'http://127.0.0.1:8642/v1/rpc');
      check('401 仍然抛给调用方（不吞错误）', thrownCode === 'unauthorized', thrownCode);
    },
  );
  const block = rpcBlockTracker.snapshot().block;
  check('401 写进全局「被拒」状态', block?.kind === 'session', JSON.stringify(block));
  check(
    '被拒状态带方法名（顶部提示能说清是谁）',
    block?.method === 'interactions.list',
    block?.method,
  );
  check('401 走了一次既有重新鉴权通道', reauthCalls === 1, String(reauthCalls));

  // 同一条事实再来一次（页面上并发十几个 RPC）：不再抬。
  await withFetch(
    () => jsonResponse(401, UNAUTHORIZED_BODY),
    async () => {
      await client.rpc('sessions.list').catch(() => null);
      await client.rpc('sessions.list').catch(() => null);
    },
  );
  check('连续相同的 401 不重复抬（不打风暴）', reauthCalls === 1, String(reauthCalls));

  // 事实变了（会话失效 → Origin 被拒）：抬，且不再走重新登录。
  await withFetch(
    () => jsonResponse(403, ORIGIN_BODY),
    async () => {
      await client.rpc('sessions.list').catch(() => null);
    },
  );
  check(
    'Origin 被拒换成 origin 事实',
    rpcBlockTracker.snapshot().block?.kind === 'origin',
    JSON.stringify(rpcBlockTracker.snapshot().block),
  );
  check('Origin 被拒不触发重新登录', reauthCalls === 1, String(reauthCalls));

  // RPC 恢复（成功响应）⇒ 状态自己清掉。
  await withFetch(
    () => jsonResponse(200, { ok: true, result: { sessions: [] } }),
    async () => {
      await client.rpc('sessions.list');
    },
  );
  check('一次成功响应就清掉被拒状态', rpcBlockTracker.snapshot().block === null);
  setSessionReauthHandler(null);

  // ---- 3. 冷却：同一条事实过了重复间隔才再抬 ----
  {
    let clock = 1_000;
    const tracker = createRpcBlockTracker({ repeatMs: 30_000, now: () => clock });
    const first = tracker.observe({ code: 'unauthorized', status: 401, message: 'x' });
    clock += 1_000;
    const second = tracker.observe({ code: 'unauthorized', status: 401, message: 'x' });
    clock += 30_000;
    const third = tracker.observe({ code: 'unauthorized', status: 401, message: 'x' });
    check('首次抬', first !== null);
    check('冷却期内不抬', second === null);
    check('过冷却继续挂着 ⇒ 再抬一次', third !== null);
    check(
      '同一条事实不刷新起始时间',
      tracker.snapshot().block?.at === 1_000,
      String(tracker.snapshot().block?.at),
    );
    tracker.clear();
    check('clear 之后状态为空', tracker.snapshot().block === null);
  }

  // ---- 4. pending 拉取：失败 ≠ 空列表 ----
  const listedPermissions: ListedInteraction[] = [
    {
      kind: 'permission',
      request_id: 'req-1',
      run_id: 'run-1',
      session_id: 's1',
      tool: 'agent.rotate',
      status: 'pending',
      created_at: 10,
    },
    {
      kind: 'ask',
      request_id: 'req-2',
      run_id: 'run-2',
      session_id: 's2',
      status: 'pending',
      created_at: 20,
      questions: [{ question: '继续吗？' }],
    },
  ];
  const pendingPage: ListedInteractionPage = { interactions: listedPermissions, total: 2 };

  const failedRound = resolvePendingFetch(
    {
      status: 'rejected',
      reason: { code: 'session_required', status: 401, message: 'no session' },
    },
    {
      status: 'rejected',
      reason: { code: 'session_required', status: 401, message: 'no session' },
    },
    111,
  );
  check(
    '拉取失败 ⇒ status failed',
    failedRound.state.status === 'failed',
    failedRound.state.status,
  );
  check(
    '失败原因分类为 session',
    failedRound.state.kind === 'session',
    String(failedRound.state.kind),
  );
  check('失败原因带原文（给用户看）', failedRound.state.message === 'no session');
  check('失败时 pending 不可用（不能据此删卡片）', failedRound.pendingUsable === false);
  check('失败时不算全集', failedRound.pendingComplete === false);

  const unsupportedRound = resolvePendingFetch(
    { status: 'rejected', reason: { code: 'method_not_allowed', status: 405, message: 'nope' } },
    { status: 'fulfilled', value: [] },
  );
  check(
    '旧 gateway 不支持 ⇒ unsupported（界面不出提示）',
    unsupportedRound.state.status === 'unsupported',
  );

  const otherRound = resolvePendingFetch(
    { status: 'rejected', reason: new Error('boom') },
    { status: 'fulfilled', value: [] },
  );
  check(
    '其它失败 ⇒ failed/other',
    otherRound.state.status === 'failed' && otherRound.state.kind === 'other',
  );

  // 失败那一轮：本地卡片一张都不删（只增不减），重连成功后补回。
  const local: InteractionState = {
    permissions: [
      {
        requestId: 'req-local',
        tool: 'agent.rotate',
        input: {},
        runId: 'run-local',
        requestedAt: 5,
      },
    ],
    asks: [],
  };
  const failedSnapshot = {
    ...buildHydrationSnapshot({ pending: failedRound.pending, orphaned: failedRound.orphaned }),
    ...(failedRound.pendingComplete
      ? { staleIds: stalePendingIds(['req-local'], failedRound.pending, new Set()) }
      : {}),
  };
  const afterFailure = interactionReducer(local, { type: 'hydrate', snapshot: failedSnapshot });
  check(
    '失败那一轮不误删本地卡片',
    afterFailure.permissions.length === 1 && afterFailure.permissions[0]?.requestId === 'req-local',
  );

  const recovered = resolvePendingFetch(
    { status: 'fulfilled', value: pendingPage },
    { status: 'fulfilled', value: [] },
    222,
  );
  check('恢复 ⇒ status ok', recovered.state.status === 'ok');
  const recoveredSnapshot = {
    ...buildHydrationSnapshot({ pending: recovered.pending, orphaned: recovered.orphaned }),
    ...(recovered.pendingComplete
      ? { staleIds: stalePendingIds(['req-local'], recovered.pending, new Set()) }
      : {}),
  };
  const afterRecovery = interactionReducer(afterFailure, {
    type: 'hydrate',
    snapshot: recoveredSnapshot,
  });
  check(
    '恢复那一轮把权限卡补回来（rotate 卡能出现了）',
    afterRecovery.permissions.some((item) => item.requestId === 'req-1'),
    JSON.stringify(afterRecovery.permissions.map((item) => item.requestId)),
  );
  check(
    '恢复那一轮把 ask 卡补回来（待批页不空）',
    afterRecovery.asks.some((item) => item.requestId === 'req-2'),
  );
  check(
    '恢复那一轮的 stale 收敛生效（服务端已没有的本地卡片被移除）',
    !afterRecovery.permissions.some((item) => item.requestId === 'req-local'),
  );
  check('首帧状态是 unknown（还没拉过）', PENDING_FETCH_UNKNOWN.status === 'unknown');

  // ---- 5. 快照引用稳定：内容没变不产生新对象（避免 401 把 React 打成每请求一渲） ----
  {
    const tracker = createRpcBlockTracker({ repeatMs: 30_000, now: () => 5_000 });
    tracker.observe({ code: 'unauthorized', status: 401, message: 'x' }, { method: 'a' });
    const before = tracker.snapshot();
    tracker.observe({ code: 'unauthorized', status: 401, message: 'x' }, { method: 'a' });
    check('同一事实重复观察不换快照对象', tracker.snapshot() === before);
  }

  // ---- 6. connection 档：一次都没连通过 ⇒ 抬一次；成功过就永不抬；成功即自愈 ----
  {
    let clock = 1_000;
    const tracker = createRpcBlockTracker({ now: () => clock });

    // 两次不够阈值（单次抖动 / 短时抖动不报警）。
    check('network 失败 1 次不抬', tracker.observeNetworkFailure({ now: clock }) === null);
    clock += 1_000;
    check(
      'network 失败 2 次不抬（阈值 3）',
      tracker.observeNetworkFailure({ now: clock }) === null,
    );
    clock += 1_000;
    const raised = tracker.observeNetworkFailure({ now: clock, method: 'interactions.list' });
    check(
      '30s 内连续 3 次且从未成功 ⇒ 抬 connection 档',
      raised?.kind === 'connection',
      JSON.stringify(raised),
    );
    check('connection 档带失败次数', raised?.attempts === 3, String(raised?.attempts));
    check('connection 档不写 HTTP 状态', raised?.status === undefined);
    check(
      'connection 档进快照（顶栏/待批页都读它）',
      tracker.snapshot().block?.kind === 'connection',
    );
    // 抬过就不再刷（每 epoch 一次）。
    clock += 1_000;
    check('同 epoch 再失败不重复抬', tracker.observeNetworkFailure({ now: clock }) === null);

    // 自愈：一次成功 ⇒ 已经抬出来的那条自动消失。
    clock += 1_000;
    tracker.noteSuccess();
    check('抬升后 success ⇒ connection 提示自动消失', tracker.snapshot().block === null);

    // 成功过一次 ⇒ 本 epoch 内再失败多少次都不抬（否则断网会疯狂误报）。
    for (let i = 0; i < 10; i += 1) {
      clock += 100;
      tracker.observeNetworkFailure({ now: clock });
    }
    check(
      '成功过一次后不再抬（断网/抖动不误报）',
      tracker.snapshot().block === null,
      JSON.stringify(tracker.snapshot().block),
    );
  }

  // ---- 7. connection 档：窗口与 epoch 重置 ----
  {
    let clock = 10_000;
    const tracker = createRpcBlockTracker({ now: () => clock });
    // 每次间隔 > 30s ⇒ 每次都在新窗口里当第 1 次，永远攒不到 3。
    for (let i = 0; i < 3; i += 1) {
      tracker.observeNetworkFailure({ now: clock });
      clock += 31_000;
    }
    check('失败跨越 30s 窗口 ⇒ 不抬（只累计窗口内的连续失败）', tracker.snapshot().block === null);

    // 新连接 = 新 epoch：抬过的那条作废，计数归零，可以重新判定。
    clock += 1_000;
    const fresh = createRpcBlockTracker({ now: () => clock });
    fresh.observeNetworkFailure({ now: clock });
    fresh.observeNetworkFailure({ now: clock + 1 });
    fresh.observeNetworkFailure({ now: clock + 2 });
    check('新 tracker 三次即抬', fresh.snapshot().block?.kind === 'connection');
    fresh.beginEpoch();
    check('beginEpoch 清掉上 epoch 的 connection 提示', fresh.snapshot().block === null);
    const afterEpoch = [
      fresh.observeNetworkFailure({ now: clock + 10 }),
      fresh.observeNetworkFailure({ now: clock + 11 }),
      fresh.observeNetworkFailure({ now: clock + 12 }),
    ];
    check(
      '新 epoch 可以重新判定（第三次再抬）',
      afterEpoch[2]?.kind === 'connection',
      JSON.stringify(afterEpoch.map((block) => block?.kind ?? null)),
    );
  }

  // ---- 8. 真实传输层：三次 fetch 直接抛（CORS 挡死）⇒ connection 档，且不触发重登 ----
  {
    // 这一节要一个干净的 epoch：上面几节的成功响应已经置了「本 epoch 成功过」。
    beginRpcEpoch();
    let reauth = 0;
    setSessionReauthHandler(() => {
      reauth += 1;
    });
    const client = new GatewayClient('http://127.0.0.1:8643', { proxy: true });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    try {
      for (let i = 0; i < 3; i += 1) {
        await client.rpc('interactions.list', { status: 'pending' }).catch(() => null);
      }
    } finally {
      globalThis.fetch = original;
    }
    const block = rpcBlockTracker.snapshot().block;
    check(
      '三次 TypeError（真跨源被挡的形状）⇒ connection 档',
      block?.kind === 'connection',
      JSON.stringify(block),
    );
    check('connection 档带上次的浏览器原话', (block?.message ?? '').includes('Failed to fetch'));
    check('connection 档**不**触发重新登录', reauth === 0, String(reauth));
    check('connection 档不带方法名以外的假状态码', block?.status === undefined);

    // 之后一次成功 ⇒ 自动消失（自愈，走真实传输层）。
    await withFetch(
      () => jsonResponse(200, { ok: true, result: { interactions: [] } }),
      async () => {
        await client.rpc('interactions.list', { status: 'pending' });
      },
    );
    check('真实 RPC 成功一次 ⇒ connection 提示消失', rpcBlockTracker.snapshot().block === null);
    setSessionReauthHandler(null);
  }

  // ---- 9. 顶栏去重：connection 档压掉网络类提示，但绝不吞鉴权类 ----
  {
    const connectionBlock: GatewayRpcBlock = {
      kind: 'connection',
      code: 'unreachable',
      message: 'Failed to fetch',
      method: 'interactions.list',
      at: 1,
      attempts: 3,
    };
    const connectionOnly = shellNoticeItems(
      noticeInput({ sessionInvalid: connectionBlock, lastError: '连不上', stale: true }),
    );
    check(
      'connection 档存在 ⇒ 网络类条目只剩一条',
      connectionOnly.length === 1 && connectionOnly[0]?.id === 'shell-rpc-unreachable',
      JSON.stringify(connectionOnly.map((item) => item.id)),
    );
    check(
      'connection 档的动作指向连接设置',
      connectionOnly[0]?.actions?.[0]?.label === t('app.openConnection'),
    );
    const connectionText = `${connectionOnly[0]?.text ?? ''} ${connectionOnly[0]?.hint ?? ''}`;
    check(
      'connection 文案给的是人话，不含命令行操作',
      !/(npm|pnpm|yarn|sudo|\$ |`|重启|restart|vessel )/i.test(connectionText),
      connectionText,
    );

    const withAuth = shellNoticeItems(
      noticeInput({
        sessionInvalid: connectionBlock,
        tokenError: '鉴权失败',
        lastError: '连不上',
        stale: true,
      }),
    );
    check(
      '鉴权提示永不被吞（且 connection 档让位）',
      withAuth.some((item) => item.id === 'shell-token-error') &&
        !withAuth.some((item) => item.id === 'shell-rpc-unreachable'),
      JSON.stringify(withAuth.map((item) => item.id)),
    );

    const sessionBlock: GatewayRpcBlock = {
      kind: 'session',
      code: 'unauthorized',
      message: 'no token',
      at: 1,
    };
    const sessionAndAuth = shellNoticeItems(
      noticeInput({ sessionInvalid: sessionBlock, tokenError: '鉴权失败' }),
    );
    check(
      '会话档与鉴权提示同时在场时两条都在',
      sessionAndAuth.some((item) => item.id === 'shell-rpc-session') &&
        sessionAndAuth.some((item) => item.id === 'shell-token-error'),
      JSON.stringify(sessionAndAuth.map((item) => item.id)),
    );

    const plain = shellNoticeItems(noticeInput({ lastError: 'boom', stale: true }));
    check(
      '没有 connection 档时既有 lastError/stale 照旧（不误伤）',
      plain.map((item) => item.id).join(',') === 'shell-error,shell-stale',
      plain.map((item) => item.id).join(','),
    );
  }

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`OK gateway-rpc-blocked: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED gateway-rpc-blocked: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

/** `ListedInteraction` 的可选字段太宽，测试里直接按最小形状给。 */
await main();
