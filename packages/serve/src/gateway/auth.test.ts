/**
 * `gateway/auth.ts` 的 Origin 闸窄属性测试（0.61：回环端口通配 + 显式凭据绕过）。
 *
 * 为什么长成这样：仓库没有 test gate（见 AGENTS.md「验证纪律」），纯函数探针是被允许的
 * 例外；写法沿用 `src/member-cwd.test.ts`（`check()` + 计数 + 汇总）。直接跑：
 *
 *   bun run packages/serve/src/gateway/auth.test.ts
 *
 * 判定看**输出文本**（`OK gateway-auth: passed N / N` 或 `FAIL ...`）：本机 bun 是
 * Windows 版，退出码不可信。
 *
 * 断言的是**行为不变量**：
 * - `normalizeAllowedOrigins`：回环端口通配保留；非回环通配 / 裸 `*` 报错；
 * - `originMatchesAllowlist` / `originAllowed`：通配只匹配自己的 hostname + 协议（含默认端口）；
 * - **显式凭据（`credentialVerified`）跳过白名单，cookie 路径（不传事实）不过就是拒**；
 * - `resolveHttpAllowedOrigins`：未配置 ⇒ `public_origins` + 三条回环通配；
 *   显式配置 ⇒ 就是它（不再自动补通配）；非法条目丢弃。
 */

import {
  corsHeaders,
  LOOPBACK_WILDCARD_ORIGINS,
  normalizeAllowedOrigins,
  originAllowed,
  originMatchesAllowlist,
  originMatchesEdgeHost,
  resolveHttpAllowedOrigins,
  resolveRequestEdge,
} from './auth';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name}: got ${got}`);
}

function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(name, ok, ok ? undefined : `${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
}

function throws(name: string, run: () => unknown): void {
  try {
    run();
    check(name, false, 'did not throw');
  } catch {
    check(name, true);
  }
}

function request(headers: Record<string, string>): Request {
  return new Request('http://127.0.0.1:8642/v1/rpc', { headers });
}

// ---- normalizeAllowedOrigins ----------------------------------------------

eq(
  'normalize: plain origins kept',
  normalizeAllowedOrigins(['https://egg-rolls.top', 'http://127.0.0.1:8642']),
  ['https://egg-rolls.top', 'http://127.0.0.1:8642'],
);
eq(
  'normalize: loopback port wildcards kept',
  normalizeAllowedOrigins(['http://127.0.0.1:*', 'http://localhost:*', 'http://[::1]:*']),
  ['http://127.0.0.1:*', 'http://localhost:*', 'http://[::1]:*'],
);
eq(
  'normalize: default port dropped, duplicates deduped',
  normalizeAllowedOrigins(['https://egg-rolls.top:443', 'https://egg-rolls.top']),
  ['https://egg-rolls.top'],
);
throws('normalize: bare "*" rejected', () => normalizeAllowedOrigins(['*']));
throws('normalize: empty string rejected', () => normalizeAllowedOrigins(['']));
throws('normalize: public host wildcard rejected', () =>
  normalizeAllowedOrigins(['https://egg-rolls.top:*']),
);
throws('normalize: private host wildcard rejected', () =>
  normalizeAllowedOrigins(['http://192.168.0.5:*']),
);
throws('normalize: wildcard with explicit port rejected', () =>
  normalizeAllowedOrigins(['http://127.0.0.1:8642:*']),
);
throws('normalize: path rejected', () => normalizeAllowedOrigins(['https://egg-rolls.top/api']));
throws('normalize: credentials rejected', () =>
  normalizeAllowedOrigins(['https://u:p@egg-rolls.top']),
);

// ---- originMatchesAllowlist ----------------------------------------------

check(
  'match: any loopback port hits the wildcard',
  originMatchesAllowlist('http://127.0.0.1:8644', ['http://127.0.0.1:*']),
);
check(
  'match: default port hits the wildcard',
  originMatchesAllowlist('http://127.0.0.1', ['http://127.0.0.1:*']),
);
check(
  'match: localhost alias needs its own entry',
  !originMatchesAllowlist('http://localhost:8644', ['http://127.0.0.1:*']),
);
check(
  'match: localhost wildcard hits',
  originMatchesAllowlist('http://localhost:8644', ['http://localhost:*']),
);
check(
  'match: ipv6 loopback wildcard hits',
  originMatchesAllowlist('http://[::1]:8644', ['http://[::1]:*']),
);
check(
  'match: scheme must agree',
  !originMatchesAllowlist('https://127.0.0.1:8644', ['http://127.0.0.1:*']),
);
check(
  'match: wildcard never covers another host',
  !originMatchesAllowlist('http://127.0.0.9:8644', ['http://127.0.0.1:*']),
);
check(
  'match: public wildcard cannot be smuggled in',
  !originMatchesAllowlist('https://egg-rolls.top', ['https://egg-rolls.top:*']),
);
check(
  'match: exact entry',
  originMatchesAllowlist('https://egg-rolls.top', ['https://egg-rolls.top']),
);
check(
  'match: non-http(s) origin never matches',
  !originMatchesAllowlist('file:///etc/passwd', ['http://127.0.0.1:*']),
);

// ---- originAllowed（鉴权/CSRF 边界）--------------------------------------

const allowlist = ['https://egg-rolls.top', 'http://127.0.0.1:*'];

check(
  'gate: no Origin header passes (curl / peer)',
  originAllowed(request({ host: '127.0.0.1:8642' }), allowlist),
);
check(
  'gate: cookie path with a non-whitelisted browser origin is rejected',
  !originAllowed(request({ host: '127.0.0.1:8642', origin: 'http://127.0.0.1:8644' }), [
    'https://egg-rolls.top',
  ]),
);
check(
  'gate: cookie path with a whitelisted origin passes',
  originAllowed(request({ host: '127.0.0.1:8642', origin: 'https://egg-rolls.top' }), allowlist),
);
check(
  'gate: loopback wildcard covers the Vite relay port',
  originAllowed(request({ host: '127.0.0.1:8642', origin: 'http://127.0.0.1:8644' }), allowlist),
);
check(
  'gate: same-origin still passes without a whitelist entry',
  originAllowed(request({ host: '127.0.0.1:8642', origin: 'http://127.0.0.1:8642' }), []),
);
check(
  'gate: cookie path with file:// origin rejected',
  !originAllowed(request({ origin: 'file:///tmp/x.html' }), allowlist),
);
check(
  'gate: explicit credential bypasses the whitelist',
  originAllowed(
    request({ host: '127.0.0.1:8642', origin: 'http://attacker.example' }),
    ['https://egg-rolls.top'],
    { credentialVerified: true },
  ),
);
check(
  'gate: explicit credential bypasses even an empty whitelist',
  originAllowed(request({ origin: 'http://attacker.example' }), [], { credentialVerified: true }),
);
check(
  'gate: unverified credential does NOT bypass (cookie path!)',
  !originAllowed(
    request({ host: '127.0.0.1:8642', origin: 'http://attacker.example' }),
    ['https://egg-rolls.top'],
    { credentialVerified: false },
  ),
);
check(
  'gate: trusted proxy bypass',
  originAllowed(request({ origin: 'http://attacker.example' }), [], { viaProxy: true }),
);
check(
  'gate: no facts at all keeps the old strict behaviour',
  !originAllowed(request({ host: '127.0.0.1:8642', origin: 'http://attacker.example' }), [
    'https://egg-rolls.top',
  ]),
);

// ---- resolveHttpAllowedOrigins -------------------------------------------

eq(
  'resolve: unset falls back to public_origins + loopback wildcards',
  resolveHttpAllowedOrigins({ publicOrigins: ['https://egg-rolls.top', 'http://127.0.0.1:8642'] }),
  [
    'https://egg-rolls.top',
    'http://127.0.0.1:8642',
    'http://127.0.0.1:*',
    'http://localhost:*',
    'http://[::1]:*',
  ],
);
eq(
  'resolve: unset with no public_origins → default loopback wildcards only',
  resolveHttpAllowedOrigins({}),
  [...LOOPBACK_WILDCARD_ORIGINS],
);
eq(
  'resolve: explicit list wins (no implicit wildcard)',
  resolveHttpAllowedOrigins({
    allowedOrigins: ['https://egg-rolls.top'],
    publicOrigins: ['http://127.0.0.1:8642'],
  }),
  ['https://egg-rolls.top'],
);
eq(
  'resolve: explicit empty list = same-origin only',
  resolveHttpAllowedOrigins({ allowedOrigins: [], publicOrigins: ['https://egg-rolls.top'] }),
  [],
);
eq(
  'resolve: invalid entries dropped',
  resolveHttpAllowedOrigins({ allowedOrigins: ['nope', 'https://ok.example'] }),
  ['https://ok.example'],
);
eq(
  'resolve: public non-loopback wildcard dropped (validator errors first)',
  resolveHttpAllowedOrigins({ publicOrigins: ['https://egg-rolls.top:*'] }),
  [...LOOPBACK_WILDCARD_ORIGINS],
);

// ---- corsHeaders（跨源读响应 / 预检）-------------------------------------

const corsReq = (origin: string): Request =>
  new Request('http://127.0.0.1:8642/v1/rpc', { headers: { origin } });

{
  // 命中回环通配：回显请求 Origin（绝不 `*`）+ Vary: Origin
  const headers = corsHeaders(corsReq('http://127.0.0.1:8644'), ['http://127.0.0.1:*']);
  eq(
    'cors: wildcard hit echoes the request origin',
    headers['Access-Control-Allow-Origin'],
    'http://127.0.0.1:8644',
  );
  eq('cors: wildcard hit carries Vary: Origin', headers.Vary, 'Origin');
  check(
    'cors: 预检允许头含 Authorization 与 CSRF 头',
    headers['Access-Control-Allow-Headers']?.includes('Authorization') === true &&
      headers['Access-Control-Allow-Headers']?.includes('X-Vessel-CSRF') === true,
    headers['Access-Control-Allow-Headers'],
  );
  eq(
    'cors: 未开 credentials 时不给 Allow-Credentials',
    headers['Access-Control-Allow-Credentials'],
    undefined,
  );

  // 显式 origin 命中：同样回显，不是 `*`
  const exact = corsHeaders(corsReq('https://egg-rolls.top'), ['https://egg-rolls.top']);
  eq(
    'cors: exact hit echoes origin',
    exact['Access-Control-Allow-Origin'],
    'https://egg-rolls.top',
  );

  // 不命中：连 ACAO 都不给（更不给 credentials）
  const miss = corsHeaders(corsReq('http://192.0.2.7:9999'), ['https://egg-rolls.top']);
  eq('cors: miss → no Access-Control-Allow-Origin', miss['Access-Control-Allow-Origin'], undefined);
  eq(
    'cors: miss → no Access-Control-Allow-Headers',
    miss['Access-Control-Allow-Headers'],
    undefined,
  );
  eq('cors: miss still varies on origin', miss.Vary, 'Origin');

  // 通配不越界：另一个回环别名不命中
  const alias = corsHeaders(corsReq('http://localhost:8644'), ['http://127.0.0.1:*']);
  eq(
    'cors: wildcard does not cover another alias',
    alias['Access-Control-Allow-Origin'],
    undefined,
  );

  // cookie 会话路径（平台）才给 Allow-Credentials，且必须命中白名单
  const withCredentials = corsHeaders(corsReq('http://127.0.0.1:8644'), ['http://127.0.0.1:*'], {
    credentials: true,
  });
  eq(
    'cors: credentials=true + hit → Allow-Credentials true',
    withCredentials['Access-Control-Allow-Credentials'],
    'true',
  );
  const credentialsMiss = corsHeaders(corsReq('http://192.0.2.7:9999'), ['http://127.0.0.1:*'], {
    credentials: true,
  });
  eq(
    'cors: credentials=true + miss → 仍然不给 Allow-Credentials',
    credentialsMiss['Access-Control-Allow-Credentials'],
    undefined,
  );

  // 非 http(s) / 无 Origin：不发 CORS 头
  eq(
    'cors: file:// origin gets nothing',
    corsHeaders(corsReq('file:///tmp/x.html'), ['http://127.0.0.1:*'])[
      'Access-Control-Allow-Origin'
    ],
    undefined,
  );
  eq(
    'cors: no Origin header → only Vary',
    corsHeaders(new Request('http://127.0.0.1:8642/v1/rpc'), ['http://127.0.0.1:*']),
    { Vary: 'Origin' },
  );
  eq('cors: empty allowlist → {}', corsHeaders(corsReq('http://127.0.0.1:8644'), []), {});
}

// ---- originMatchesEdgeHost（受信 relay 声明的形参入口，未接线）------------

check(
  'edge-host: 同 host 通过',
  originMatchesEdgeHost({ origin: 'http://127.0.0.1:8642', edgeHost: '127.0.0.1:8642' }),
);
check(
  'edge-host: relay 场景（Origin 8644 / Host 8642）不通过 —— 这就是待 auth-strategy 接的格子',
  !originMatchesEdgeHost({ origin: 'http://127.0.0.1:8644', edgeHost: '127.0.0.1:8642' }),
);
check(
  'edge-host: 受信声明可以覆盖比较用的 origin',
  originMatchesEdgeHost({
    origin: 'http://127.0.0.1:8644',
    edgeHost: '127.0.0.1:8642',
    trustedOriginClaim: 'http://127.0.0.1:8642',
  }),
);
check(
  'edge-host: 声明不匹配仍然拒绝',
  !originMatchesEdgeHost({
    origin: 'http://127.0.0.1:8644',
    edgeHost: '127.0.0.1:8642',
    trustedOriginClaim: 'https://evil.example',
  }),
);
check(
  'edge-host: 声明不可解析 ⇒ fail-closed',
  !originMatchesEdgeHost({
    origin: 'http://127.0.0.1:8642',
    edgeHost: '127.0.0.1:8642',
    trustedOriginClaim: 'not a url',
  }),
);
check(
  'edge-host: edgeHost=null 一律拒绝',
  !originMatchesEdgeHost({ origin: 'http://127.0.0.1:8642', edgeHost: null }),
);

// ---- 0.63：auth.allow_loopback_anonymous → edge.localDirect -----------------
//
// 这四组就是验收单上的四条。背景（auth-strategy 的代码+实测双证）：
// 没配 `proxySecret` 时 `proxySecretAllowed()` 恒真 ⇒ `viaProxy` 恒真 ⇒ 旧判据下
// `localDirect` 恒假，文档承诺的「本机直连免登录」是死代码。现在改成显式开关。

const loopbackReq = (headers: Record<string, string> = {}): Request =>
  new Request('http://127.0.0.1:8642/platform/rpc', {
    method: 'POST',
    headers: { host: '127.0.0.1:8642', ...headers },
  });

// ① 开关关（缺省）+ 回环 + 回环 Host ⇒ false
check(
  'localDirect ①: 缺省（开关关）⇒ false',
  resolveRequestEdge(loopbackReq(), { address: '127.0.0.1' }).localDirect === false,
);
check(
  'localDirect ①: 显式 false ⇒ false',
  resolveRequestEdge(loopbackReq(), { address: '127.0.0.1', allowLoopbackAnonymous: false })
    .localDirect === false,
);
check(
  'localDirect ①: 开关关时配了/没配密钥都一样 false',
  resolveRequestEdge(loopbackReq(), { address: '127.0.0.1', proxySecret: 's3cret' }).localDirect ===
    false,
);

// ② 开关开 + 回环 + 回环 Host + 未配密钥 ⇒ true
check(
  'localDirect ②: 开关开 + 回环 socket + 回环 Host + 没配密钥 ⇒ true',
  resolveRequestEdge(loopbackReq(), { address: '127.0.0.1', allowLoopbackAnonymous: true })
    .localDirect === true,
);
check(
  'localDirect ②: [::1] 与 ::ffff:127.0.0.1 同样算回环',
  resolveRequestEdge(loopbackReq({ host: '[::1]:8642' }), {
    address: '::1',
    allowLoopbackAnonymous: true,
  }).localDirect === true &&
    resolveRequestEdge(loopbackReq(), {
      address: '::ffff:127.0.0.1',
      allowLoopbackAnonymous: true,
    }).localDirect === true,
);
check(
  'localDirect ②: localhost Host 也算回环',
  resolveRequestEdge(loopbackReq({ host: 'localhost:8642' }), {
    address: '127.0.0.1',
    allowLoopbackAnonymous: true,
  }).localDirect === true,
);

// ③ 开关开 + 密钥配了并带对 + X-Forwarded-Host: egg-rolls.top ⇒ false
const proxyReq = loopbackReq({
  host: '127.0.0.1:8642',
  'x-forwarded-host': 'egg-rolls.top',
  'x-vessel-proxy-secret': 'right-secret',
});
check(
  'localDirect ③: 开关开 + 密钥带对 + X-Forwarded-Host ⇒ false（受信反代不算直连）',
  resolveRequestEdge(proxyReq, {
    address: '127.0.0.1',
    proxySecret: 'right-secret',
    allowLoopbackAnonymous: true,
  }).localDirect === false,
);
check(
  // 只是边缘事实：平台数据面还有第 4 步（`auth.loopback` 要求 proxySecretOk），密钥带错
  // 会在那一步被 `platform_unauthorized / proxy_secret_missing` 拒掉 —— 真机实测 401。
  'localDirect ③b: 密钥带错 ⇒ 未证明是反代 ⇒ 边缘事实仍算直连（数据面第 4 步另兜底）',
  resolveRequestEdge(loopbackReq({ 'x-vessel-proxy-secret': 'wrong' }), {
    address: '127.0.0.1',
    proxySecret: 'right-secret',
    allowLoopbackAnonymous: true,
  }).localDirect === true,
);

// ④ 开关开 + 非回环 socket ⇒ false
check(
  'localDirect ④: 开关开 + 非回环 socket ⇒ false',
  resolveRequestEdge(loopbackReq(), { address: '203.0.113.9', allowLoopbackAnonymous: true })
    .localDirect === false,
);
check(
  'localDirect ④: 开关开 + 非回环 Host ⇒ false',
  resolveRequestEdge(loopbackReq({ host: 'egg-rolls.top' }), {
    address: '127.0.0.1',
    allowLoopbackAnonymous: true,
  }).localDirect === false,
);
check(
  'localDirect ④: 开关开 + 没有 Host ⇒ false',
  resolveRequestEdge(new Request('http://127.0.0.1:8642/platform/rpc'), {
    address: '127.0.0.1',
    allowLoopbackAnonymous: true,
  }).localDirect === false,
);
check(
  'localDirect ④: 开关开 + trustedProxies 不含本地址 ⇒ false',
  resolveRequestEdge(loopbackReq(), {
    address: '10.1.2.3',
    trustedProxies: ['10.1.2.'],
    allowLoopbackAnonymous: true,
  }).localDirect === false,
);

// 开关只影响 localDirect，不改 origin/凭据两道闸的判定（同一份 edge 事实喂进去）
{
  const edge = resolveRequestEdge(loopbackReq({ origin: 'http://192.0.2.7:9999' }), {
    address: '127.0.0.1',
    allowLoopbackAnonymous: true,
  });
  check(
    'localDirect 开关不放过非白名单 Origin（origin 闸照旧）',
    !originAllowed(loopbackReq({ host: '127.0.0.1:8642', origin: 'http://192.0.2.7:9999' }), [
      'https://egg-rolls.top',
    ]) && edge.localDirect === true,
  );
}

// ---- summary --------------------------------------------------------------

for (const failure of failures) console.error(`FAIL gateway-auth: ${failure}`);
if (failures.length === 0) {
  console.log(`OK gateway-auth: passed ${String(passed)} / ${String(passed)}`);
} else {
  console.log(`FAIL gateway-auth: passed ${String(passed)} / ${String(passed + failures.length)}`);
  process.exitCode = 1;
}
