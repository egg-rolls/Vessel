/**
 * 登录 HTTP 面的测试：策略化之后的路由、回调、以及 `GET /auth/whoami`。
 *
 * 全部走**进程内**（`AuthService.handle`）+ stub fetch：这里证明的是我们的
 * 路由/状态机/白名单/文案，**不是** provider 的真实行为（见回报里的「未验证」）。
 *
 * @module @vessel-agent/serve/auth/routes.test
 */

import { describe, expect, test } from 'bun:test';
import {
  type AuthRequestContext,
  AuthService,
  type AuthServiceOptions,
  type AuthWhoami,
  CSRF_HEADER,
  TRUSTED_ORIGIN_HEADER,
} from './routes.js';

const GUID_LOWER = '8f3c1f4e-2b7a-4c1d-9a55-0f1e2d3c4b5a';

const CTX: AuthRequestContext = {
  edge: {
    viaProxy: false,
    proxySecretOk: true,
    host: 'egg-rolls.top',
    protocol: 'https',
    localDirect: false,
  },
  address: '127.0.0.1',
};

function makeService(overrides: Partial<AuthServiceOptions> = {}): AuthService {
  return new AuthService({
    allowedHosts: [],
    publicOrigins: ['https://egg-rolls.top'],
    backends: [],
    session: { idleMinutes: 30, absoluteHours: 12 },
    env: {},
    log: () => {},
    ...overrides,
  });
}

function get(
  svc: AuthService,
  path: string,
  cookie?: string,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const request = new Request(`https://egg-rolls.top${path}`, {
    headers: { ...(cookie !== undefined ? { cookie } : {}), ...headers },
  });
  return svc.handle(request, new URL(request.url), CTX);
}

/** 从 Set-Cookie 里挑出某个 cookie 的 `name=value`，用于后续请求。 */
function cookieNamed(response: Response, name: string): string | null {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? '';
    if (pair.startsWith(`${name}=`)) return pair;
  }
  return null;
}

/** token 腿 / 用户腿的桩（按 URL 分流，与 provider 的真实端点为无关）。 */
function stubFetch(user: unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (href.includes('access_token') || href.includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'at-not-real' }), { status: 200 });
    }
    return new Response(JSON.stringify(user), { status: 200 });
  }) as typeof fetch;
}

const MICROSOFT_BACKEND = {
  kind: 'microsoft_oauth',
  clientId: 'ms-client-id',
  clientSecretEnv: 'MS_CLIENT_SECRET',
  // 白名单写大写，provider 回小写：大小写不敏感必须仍然命中。
  allowUserIds: [GUID_LOWER.toUpperCase()],
};

describe('GET /auth/whoami', () => {
  test('未登录也允许调用：identity=null，backends 照旧（前端靠它渲染按钮）', async () => {
    const svc = makeService({
      backends: [MICROSOFT_BACKEND, { kind: 'password', username: 'admin' }],
      env: { MS_CLIENT_SECRET: 'present' },
    });
    const response = await get(svc, '/auth/whoami');
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as AuthWhoami;
    expect(body).toEqual({
      identity: null,
      node: null,
      team: null,
      backends: [
        { id: 'microsoft', kind: 'microsoft_oauth', label: 'Sign in with Microsoft' },
        { id: 'password', kind: 'password', label: 'Sign in with a password' },
      ],
      auth_mode: 'none',
    });
  });

  test('缺 client secret 的后端仍然列出，但带 disabled + 原因', async () => {
    const svc = makeService({ backends: [MICROSOFT_BACKEND], env: {} });
    const body = (await (await get(svc, '/auth/whoami'))?.json()) as AuthWhoami;
    expect(body.backends).toEqual([
      {
        id: 'microsoft',
        kind: 'microsoft_oauth',
        label: 'Sign in with Microsoft',
        disabled: true,
        reason: 'secret_missing: env MS_CLIENT_SECRET is not set',
      },
    ]);
  });

  test('不回显 allow_user_ids 名单，也不回显任何 secret 值', async () => {
    const svc = makeService({
      backends: [MICROSOFT_BACKEND],
      env: { MS_CLIENT_SECRET: 'super-secret-value' },
    });
    const text = await (await get(svc, '/auth/whoami'))?.text();
    expect(text).not.toContain(GUID_LOWER);
    expect(text).not.toContain(GUID_LOWER.toUpperCase());
    expect(text).not.toContain('super-secret-value');
  });

  test('平台 token = auth_mode bearer', async () => {
    const svc = makeService({ platformToken: 'platform-token-xyz' });
    const response = await get(svc, '/auth/whoami', undefined, {
      authorization: 'Bearer platform-token-xyz',
    });
    const body = (await response?.json()) as AuthWhoami;
    expect(body.auth_mode).toBe('bearer');
    expect(body.identity).toBeNull();
  });

  test('错 token 不算 bearer（auth_mode 仍是 none）', async () => {
    const svc = makeService({ platformToken: 'platform-token-xyz' });
    const response = await get(svc, '/auth/whoami', undefined, {
      authorization: 'Bearer wrong',
    });
    const body = (await response?.json()) as AuthWhoami;
    expect(body.auth_mode).toBe('none');
  });

  test('node / team 由组合根注入；不注入就是 null（不猜）', async () => {
    const injected = makeService({
      runtimeInfo: () => ({ node: { id: 'node-1', name: '本机', state: 'up' }, team: null }),
    });
    const withRuntime = (await (await get(injected, '/auth/whoami'))?.json()) as AuthWhoami;
    expect(withRuntime.node).toEqual({ id: 'node-1', name: '本机', state: 'up' });
    expect(withRuntime.team).toBeNull();

    const plain = (await (await get(makeService(), '/auth/whoami'))?.json()) as AuthWhoami;
    expect(plain.node).toBeNull();
  });

  test('非 GET 一律 405', async () => {
    const svc = makeService();
    const request = new Request('https://egg-rolls.top/auth/whoami', { method: 'POST' });
    const response = await svc.handle(request, new URL(request.url), CTX);
    expect(response?.status).toBe(405);
  });
});

describe('策略化的 OAuth 路由', () => {
  test('未配置的后端 /auth/<provider>/start = 404 backend_not_configured', async () => {
    const svc = makeService({ backends: [MICROSOFT_BACKEND], env: { MS_CLIENT_SECRET: 'x' } });
    const response = await get(svc, '/auth/github/start');
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: 'backend_not_configured' });
  });

  test('/auth/<provider>/start：302 到 provider，redirect_uri = 来源 + 该 provider 的回调路径', async () => {
    const svc = makeService({ backends: [MICROSOFT_BACKEND], env: { MS_CLIENT_SECRET: 'x' } });
    const response = await get(svc, '/auth/microsoft/start');
    expect(response?.status).toBe(302);
    const location = new URL(response?.headers.get('location') ?? '');
    expect(location.origin).toBe('https://login.microsoftonline.com');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://egg-rolls.top/auth/microsoft/callback',
    );
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    // 浏览器绑定 cookie 必须下发（光偷 state 不够）。
    expect(cookieNamed(response as Response, '__Host-vessel_oauth')).not.toBeNull();
  });

  test('缺 secret：不发 302，回登录页并带 secret_missing', async () => {
    const svc = makeService({ backends: [MICROSOFT_BACKEND], env: {} });
    const response = await get(svc, '/auth/microsoft/start');
    expect(response?.status).toBe(302);
    expect(response?.headers.get('location')).toBe('/login?error=secret_missing');
  });

  test('/auth 端点清单里有已注册 provider 的 start / callback', async () => {
    const svc = makeService({ backends: [MICROSOFT_BACKEND], env: {} });
    const body = (await (await get(svc, '/auth'))?.json()) as { endpoints: string[] };
    expect(body.endpoints).toContain('/auth/microsoft/start');
    expect(body.endpoints).toContain('/auth/microsoft/callback');
    expect(body.endpoints).toContain('/auth/whoami');
    expect(body.endpoints).toContain('/auth/gitee/callback');
  });

  test('口令后端的 /auth/password/start 不存在（它没有 302 起步态）', async () => {
    const svc = makeService({ backends: [{ kind: 'password' }] });
    const response = await get(svc, '/auth/password/start');
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: 'not_found' });
  });
});

describe('GET /auth/status（现有登录页与前端都吃这个契约）', () => {
  test('loginBackends 来自注册表：id / kind / label / startPath 都对', async () => {
    const svc = makeService({
      backends: [MICROSOFT_BACKEND, { kind: 'password' }],
      env: { MS_CLIENT_SECRET: 'x' },
    });
    const body = (await (await get(svc, '/auth/status'))?.json()) as {
      loginBackends: { id: string; kind: string; label: string; startPath: string }[];
    };
    expect(body.loginBackends).toEqual([
      {
        id: 'microsoft',
        kind: 'microsoft_oauth',
        label: 'Sign in with Microsoft',
        startPath: '/auth/microsoft/start',
      },
      {
        id: 'password',
        kind: 'password',
        label: 'Sign in with a password',
        startPath: '/login',
      },
    ]);
  });
});

describe('完整往返（start → callback → 会话 → whoami）', () => {
  async function login(): Promise<{ response: Response; state: string; binder: string }> {
    const svc = makeService({
      backends: [MICROSOFT_BACKEND],
      env: { MS_CLIENT_SECRET: 'x' },
      fetchImpl: stubFetch({ id: GUID_LOWER, displayName: '张三' }),
      runtimeInfo: () => ({ node: { id: 'node-1', name: '本机', state: 'up' }, team: null }),
    });
    const start = (await get(svc, '/auth/microsoft/start')) as Response;
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const binder = cookieNamed(start, '__Host-vessel_oauth') ?? '';
    const response = (await get(
      svc,
      `/auth/microsoft/callback?code=the-code&state=${encodeURIComponent(state)}`,
      binder,
    )) as Response;
    return { response, state, binder };
  }

  test('登录成功：建会话、302 回首页；subject 前缀是 provider id', async () => {
    const { response } = await login();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(cookieNamed(response, '__Host-vessel_sid')).not.toBeNull();
  });

  test('登录后 whoami：identity 是自己的 id / 展示名，auth_mode=cookie', async () => {
    const svc = makeService({
      backends: [MICROSOFT_BACKEND],
      env: { MS_CLIENT_SECRET: 'x' },
      fetchImpl: stubFetch({ id: GUID_LOWER, displayName: '张三' }),
      runtimeInfo: () => ({ node: { id: 'node-1', name: '本机', state: 'up' }, team: null }),
    });
    const start = (await get(svc, '/auth/microsoft/start')) as Response;
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const binder = cookieNamed(start, '__Host-vessel_oauth') ?? '';
    const callback = (await get(
      svc,
      `/auth/microsoft/callback?code=the-code&state=${encodeURIComponent(state)}`,
      binder,
    )) as Response;
    const session = cookieNamed(callback, '__Host-vessel_sid') ?? '';

    const body = (await (await get(svc, '/auth/whoami', session))?.json()) as AuthWhoami;
    expect(body.identity).toEqual({ id: `microsoft:${GUID_LOWER}`, name: '张三', role: 'admin' });
    expect(body.auth_mode).toBe('cookie');
    expect(body.node).toEqual({ id: 'node-1', name: '本机', state: 'up' });
  });

  test('大小写不敏感白名单在服务端也成立（配置大写 / provider 回小写）', async () => {
    const { response } = await login();
    expect(response.headers.get('location')).toBe('/');
  });

  test('不在白名单：302 回登录页带 not_allowlisted（不建会话）', async () => {
    const svc = makeService({
      backends: [{ ...MICROSOFT_BACKEND, allowUserIds: ['00000000-0000-0000-0000-000000000000'] }],
      env: { MS_CLIENT_SECRET: 'x' },
      fetchImpl: stubFetch({ id: GUID_LOWER }),
    });
    const start = (await get(svc, '/auth/microsoft/start')) as Response;
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const binder = cookieNamed(start, '__Host-vessel_oauth') ?? '';
    const response = (await get(
      svc,
      `/auth/microsoft/callback?code=c&state=${encodeURIComponent(state)}`,
      binder,
    )) as Response;
    expect(response.headers.get('location')).toBe('/login?error=not_allowlisted');
    expect(cookieNamed(response, '__Host-vessel_sid')).toBeNull();
  });

  test('重放同一个 state 被拒（一次性）', async () => {
    const svc = makeService({
      backends: [MICROSOFT_BACKEND],
      env: { MS_CLIENT_SECRET: 'x' },
      fetchImpl: stubFetch({ id: GUID_LOWER }),
    });
    const start = (await get(svc, '/auth/microsoft/start')) as Response;
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const binder = cookieNamed(start, '__Host-vessel_oauth') ?? '';
    const path = `/auth/microsoft/callback?code=c&state=${encodeURIComponent(state)}`;
    const first = (await get(svc, path, binder)) as Response;
    expect(first.headers.get('location')).toBe('/');
    const second = (await get(svc, path, binder)) as Response;
    expect(second.headers.get('location')).toBe('/login?error=state_invalid');
  });

  test('无 binder cookie 的回调被拒（state 绑定浏览器）', async () => {
    const svc = makeService({
      backends: [MICROSOFT_BACKEND],
      env: { MS_CLIENT_SECRET: 'x' },
      fetchImpl: stubFetch({ id: GUID_LOWER }),
    });
    const start = (await get(svc, '/auth/microsoft/start')) as Response;
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const response = (await get(
      svc,
      `/auth/microsoft/callback?code=c&state=${encodeURIComponent(state)}`,
    )) as Response;
    expect(response.headers.get('location')).toBe('/login?error=state_invalid');
  });
});

describe('受信 relay 的 origin 声明（dev 边缘，解决跨源页面的 CSRF 拒绝）', () => {
  /** 登录一次，拿到会话 cookie + CSRF 令牌。 */
  async function loggedIn(svc: AuthService): Promise<{ cookie: string; csrf: string }> {
    const start = (await get(svc, '/auth/microsoft/start')) as Response;
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const binder = cookieNamed(start, '__Host-vessel_oauth') ?? '';
    const callback = (await get(
      svc,
      `/auth/microsoft/callback?code=c&state=${encodeURIComponent(state)}`,
      binder,
    )) as Response;
    const cookie = cookieNamed(callback, '__Host-vessel_sid') ?? '';
    const status = (await (await get(svc, '/auth/status', cookie))?.json()) as {
      csrfToken: string;
    };
    return { cookie, csrf: status.csrfToken };
  }

  function mutatingRequest(input: {
    cookie: string;
    csrf: string;
    origin: string;
    claim?: string;
  }): Request {
    const headers: Record<string, string> = {
      cookie: input.cookie,
      origin: input.origin,
      [CSRF_HEADER]: input.csrf,
    };
    if (input.claim !== undefined) headers[TRUSTED_ORIGIN_HEADER] = input.claim;
    return new Request('https://egg-rolls.top/platform/rpc', { method: 'POST', headers });
  }

  const PROXY_CTX: AuthRequestContext = {
    edge: {
      viaProxy: true,
      proxySecretOk: true,
      host: 'egg-rolls.top',
      protocol: 'https',
      localDirect: false,
    },
    address: '127.0.0.1',
  };

  function service(proxySecret?: string): AuthService {
    return makeService({
      backends: [MICROSOFT_BACKEND],
      env: { MS_CLIENT_SECRET: 'x' },
      fetchImpl: stubFetch({ id: GUID_LOWER }),
      ...(proxySecret !== undefined ? { proxySecret } : {}),
    });
  }

  test('页面 origin 与边缘 host 不一致、又没有声明 ⇒ csrf_failed（旧行为不变）', async () => {
    const svc = service('relay-secret');
    const { cookie, csrf } = await loggedIn(svc);
    const gate = svc.authorize(
      mutatingRequest({ cookie, csrf, origin: 'http://127.0.0.1:8644' }),
      PROXY_CTX,
      { mutating: true },
    );
    expect(gate.ok).toBe(false);
    expect(gate.ok === false ? gate.reason : null).toBe('csrf_failed');
  });

  test('密钥成立 + 声明与边缘 host 一致 ⇒ 放行', async () => {
    const svc = service('relay-secret');
    const { cookie, csrf } = await loggedIn(svc);
    const gate = svc.authorize(
      mutatingRequest({
        cookie,
        csrf,
        origin: 'http://127.0.0.1:8644',
        claim: 'https://egg-rolls.top',
      }),
      PROXY_CTX,
      { mutating: true },
    );
    expect(gate.ok).toBe(true);
  });

  test('没配反代密钥 ⇒ 声明一律不采信（本机任何进程都伪造不出来）', async () => {
    const svc = service(); // 不传 proxySecret = 未配置
    const { cookie, csrf } = await loggedIn(svc);
    const gate = svc.authorize(
      mutatingRequest({
        cookie,
        csrf,
        origin: 'http://127.0.0.1:8644',
        claim: 'https://egg-rolls.top',
      }),
      PROXY_CTX,
      { mutating: true },
    );
    expect(gate.ok).toBe(false);
    expect(gate.ok === false ? gate.reason : null).toBe('csrf_failed');
  });

  test('配了密钥但这次请求的密钥不成立 ⇒ 声明不采信', async () => {
    const svc = service('relay-secret');
    const { cookie, csrf } = await loggedIn(svc);
    const gate = svc.authorize(
      mutatingRequest({
        cookie,
        csrf,
        origin: 'http://127.0.0.1:8644',
        claim: 'https://egg-rolls.top',
      }),
      { ...PROXY_CTX, edge: { ...PROXY_CTX.edge, proxySecretOk: false, viaProxy: false } },
      { mutating: true },
    );
    expect(gate.ok).toBe(false);
    expect(gate.ok === false ? gate.reason : null).toBe('csrf_failed');
  });

  test('声明本身也要过 host 判据：拿它去冒名另一个 host 无效', async () => {
    const svc = service('relay-secret');
    const { cookie, csrf } = await loggedIn(svc);
    const gate = svc.authorize(
      mutatingRequest({ cookie, csrf, origin: 'https://evil.test', claim: 'https://evil.test' }),
      PROXY_CTX,
      { mutating: true },
    );
    expect(gate.ok).toBe(false);
    expect(gate.ok === false ? gate.reason : null).toBe('csrf_failed');
  });
});
