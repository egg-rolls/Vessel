/**
 * `config/validator.ts` 的 origin 条目口径窄属性测试（0.61）。
 *
 * 为什么长成这样：仓库没有 test gate（见 AGENTS.md「验证纪律」），纯函数探针是被允许的
 * 例外；写法沿用 `src/member-cwd.test.ts`（`check()` + 计数 + 汇总）。直接跑：
 *
 *   bun run packages/config/src/validator.test.ts
 *
 * 判定看**输出文本**（`OK config-validator: passed N / N` 或 `FAIL ...`）：本机 bun 是
 * Windows 版，退出码不可信。
 *
 * 断言的是**两处必须同口径**这条不变量：
 * - `auth.public_origins` 与 `http.allowed_origins` 对同一个条目给出**同样的判定**
 *   （回环端口通配收，非回环 `:*` 拒，裸 `*` 拒，尾斜杠拒）；
 * - 非法条目报在正确的 path 上（`auth.publicOrigins[i]` / `http.allowedOrigins[i]`）。
 */

import type { VesselConfig } from './types';
import { validateConfig } from './validator';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name}: got ${got}`);
}

function errorsFor(config: Partial<VesselConfig>): { path: string; message: string }[] {
  return validateConfig(config as VesselConfig).errors.map((error) => ({
    path: error.path,
    message: error.message,
  }));
}

function pathsFor(config: Partial<VesselConfig>): string[] {
  return errorsFor(config).map((error) => error.path);
}

// ---- auth.public_origins --------------------------------------------------

check(
  'public_origins: plain origins stay valid',
  pathsFor({ auth: { publicOrigins: ['https://egg-rolls.top', 'http://127.0.0.1:8642'] } })
    .length === 0,
);
check(
  'public_origins: 0.61 端口通配一律拒绝（三条回环逐条）',
  ['http://127.0.0.1:*', 'http://localhost:*', 'http://[::1]:*'].every(
    (entry) => pathsFor({ auth: { publicOrigins: [entry] } }).length === 1,
  ),
);
check(
  'public_origins: 通配错误文案指向 http.allowed_origins',
  (() => {
    const [first] = errorsFor({ auth: { publicOrigins: ['http://127.0.0.1:*'] } });
    return (
      first?.message.includes('only allowed in http.allowed_origins') === true &&
      first.message.includes('redirect_uri') === true
    );
  })(),
  errorsFor({ auth: { publicOrigins: ['http://127.0.0.1:*'] } })[0]?.message,
);
check(
  'public_origins: 127.0.0.0/8 通配同样拒绝',
  pathsFor({ auth: { publicOrigins: ['http://127.0.0.9:*'] } }).length === 1,
);
const publicNonLoopback = errorsFor({ auth: { publicOrigins: ['https://egg-rolls.top:*'] } });
check(
  'public_origins: 公网 host 的 :* 报在 auth.publicOrigins[0]',
  publicNonLoopback.length === 1 && publicNonLoopback[0]?.path === 'auth.publicOrigins[0]',
  JSON.stringify(publicNonLoopback),
);
check(
  'public_origins: 公网 :* 也是同一个「只属于 http.allowed_origins」文案',
  publicNonLoopback[0]?.message.includes('only allowed in http.allowed_origins') === true,
  publicNonLoopback[0]?.message,
);
check(
  'public_origins: private-host wildcard rejected too',
  pathsFor({ auth: { publicOrigins: ['http://192.168.1.10:*'] } }).length === 1,
);
check(
  'public_origins: wildcard with explicit port rejected',
  pathsFor({ auth: { publicOrigins: ['http://127.0.0.1:8642:*'] } }).length === 1,
);
check(
  'public_origins: trailing slash still rejected',
  pathsFor({ auth: { publicOrigins: ['https://egg-rolls.top/'] } }).length === 1,
);
check(
  'public_origins: http on a public host still rejected',
  pathsFor({ auth: { publicOrigins: ['http://egg-rolls.top'] } }).length === 1,
);
check(
  'public_origins: bare "*" still rejected',
  pathsFor({ auth: { publicOrigins: ['*'] } }).length === 1,
);

// ---- http.allowed_origins -------------------------------------------------

check(
  'http.allowed_origins: loopback port wildcards accepted',
  pathsFor({ http: { allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'] } }).length === 0,
);
check(
  'http.allowed_origins: public origin accepted',
  pathsFor({ http: { allowedOrigins: ['https://egg-rolls.top'] } }).length === 0,
);
const httpNonLoopback = errorsFor({ http: { allowedOrigins: ['http://192.168.1.10:*'] } });
check(
  'http.allowed_origins: non-loopback wildcard rejected (same 口径 as public_origins)',
  httpNonLoopback.length === 1 && httpNonLoopback[0]?.path === 'http.allowedOrigins[0]',
  JSON.stringify(httpNonLoopback),
);
check(
  'http.allowed_origins: bare "*" rejected',
  pathsFor({ http: { allowedOrigins: ['*'] } }).length === 1,
);
check(
  'http.allowed_origins: path rejected',
  pathsFor({ http: { allowedOrigins: ['https://egg-rolls.top/api'] } }).length === 1,
);
check(
  'http.allowed_origins: non-array rejected',
  pathsFor({ http: { allowedOrigins: 'https://egg-rolls.top' as unknown as string[] } }).length ===
    1,
);

// ---- 口径分离（0.61 的语义定死）------------------------------------------

/**
 * 0.61 起两处**故意不同口径**：
 * - `auth.public_origins` = `redirect_uri` 来源 ⇒ 必须是具体 origin，通配**拒**；
 * - `http.allowed_origins` = 访问控制 ⇒ 回环 host 的端口通配**收**，非回环**拒**。
 *
 * 共同点必须保持一致：非通配条目的判定完全相同（同一份 `publicOriginsEntryError`）。
 */
const publicOk = (entry: string): boolean =>
  pathsFor({ auth: { publicOrigins: [entry] } }).length === 0;
const httpOk = (entry: string): boolean =>
  pathsFor({ http: { allowedOrigins: [entry] } }).length === 0;

for (const entry of [
  'https://egg-rolls.top',
  'http://127.0.0.1:8642',
  'http://10.0.0.5',
  '*',
  'https://egg-rolls.top/',
  'https://egg-rolls.top/api',
  'https://u:p@egg-rolls.top',
  'http://egg-rolls.top',
]) {
  check(`two lists agree on non-wildcard "${entry}"`, publicOk(entry) === httpOk(entry));
}
for (const entry of ['http://127.0.0.1:*', 'http://localhost:*', 'http://[::1]:*']) {
  check(`wildcard "${entry}": public_origins 拒`, publicOk(entry) === false);
  check(`wildcard "${entry}": http.allowed_origins 收`, httpOk(entry) === true);
}
check(
  'wildcard on non-loopback host: 两处都拒',
  publicOk('https://egg-rolls.top:*') === false && httpOk('https://egg-rolls.top:*') === false,
);
check(
  'wildcard with explicit port: 两处都拒',
  publicOk('http://127.0.0.1:8642:*') === false && httpOk('http://127.0.0.1:8642:*') === false,
);

// ---- 未知键 / 形状 --------------------------------------------------------

check(
  'http: unknown nested key rejected',
  pathsFor({
    http: { allowed_origin: [] } as unknown as { allowedOrigins?: string[] },
  }).length === 1,
);
check(
  'http: non-object rejected',
  pathsFor({ http: 'nope' as unknown as { allowedOrigins?: string[] } }).length === 1,
);

// ---- 0.63：auth.allow_loopback_anonymous ----------------------------------

function warningsFor(config: Partial<VesselConfig>): { path: string; message: string }[] {
  return validateConfig(config as VesselConfig).warnings.map((warning) => ({
    path: warning.path,
    message: warning.message,
  }));
}

check(
  'allow_loopback_anonymous: 缺省不报错也不出 warning（安全默认）',
  validateConfig({} as VesselConfig).errors.length === 0 &&
    warningsFor({}).every((warning) => warning.path !== 'auth.allowLoopbackAnonymous'),
);
check(
  'allow_loopback_anonymous: true 合法',
  pathsFor({ auth: { allowLoopbackAnonymous: true } }).length === 0,
);
check(
  'allow_loopback_anonymous: false 合法且不出 warning',
  pathsFor({ auth: { allowLoopbackAnonymous: false } }).length === 0 &&
    warningsFor({ auth: { allowLoopbackAnonymous: false } }).length === 0,
);
check(
  'allow_loopback_anonymous: 非 boolean 报错（auth.allowLoopbackAnonymous）',
  pathsFor({ auth: { allowLoopbackAnonymous: 'true' as unknown as boolean } }).includes(
    'auth.allowLoopbackAnonymous',
  ),
);
{
  const warnings = warningsFor({ auth: { allowLoopbackAnonymous: true } });
  const ours = warnings.filter((warning) => warning.path === 'auth.allowLoopbackAnonymous');
  check(
    'allow_loopback_anonymous: 开启时出恰好一条 warning',
    ours.length === 1,
    String(ours.length),
  );
  const text = ours[0]?.message ?? '';
  check(
    'allow_loopback_anonymous: warning 点明「任何本机进程都免登录」',
    text.includes('any process on this machine') && text.includes('without logging in'),
    text,
  );
  check(
    'allow_loopback_anonymous: warning 点明单机可接受/共享与公网不要开',
    text.includes('local development') && text.includes('do not enable'),
    text,
  );
  check(
    'allow_loopback_anonymous: warning 不写命令行文本',
    !text.includes('vessel ') && !text.includes('命令'),
    text,
  );
}

// ---- summary --------------------------------------------------------------

for (const failure of failures) console.error(`FAIL config-validator: ${failure}`);
if (failures.length === 0) {
  console.log(`OK config-validator: passed ${String(passed)} / ${String(passed)}`);
} else {
  console.log(
    `FAIL config-validator: passed ${String(passed)} / ${String(passed + failures.length)}`,
  );
  process.exitCode = 1;
}
