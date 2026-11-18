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
  'public_origins: loopback port wildcards accepted',
  pathsFor({
    auth: { publicOrigins: ['http://127.0.0.1:*', 'http://localhost:*', 'http://[::1]:*'] },
  }).length === 0,
  JSON.stringify(
    pathsFor({
      auth: { publicOrigins: ['http://127.0.0.1:*', 'http://localhost:*', 'http://[::1]:*'] },
    }),
  ),
);
check(
  'public_origins: 127.0.0.0/8 wildcard accepted',
  pathsFor({ auth: { publicOrigins: ['http://127.0.0.9:*'] } }).length === 0,
);
const publicNonLoopback = errorsFor({ auth: { publicOrigins: ['https://egg-rolls.top:*'] } });
check(
  'public_origins: non-loopback wildcard rejected',
  publicNonLoopback.length === 1 && publicNonLoopback[0]?.path === 'auth.publicOrigins[0]',
  JSON.stringify(publicNonLoopback),
);
check(
  'public_origins: non-loopback wildcard message says why',
  publicNonLoopback[0]?.message.includes('non-loopback') === true,
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

// ---- 同口径（同一条目两处判定一致）---------------------------------------

const sameEntry = (entry: string): boolean => {
  const authOk = pathsFor({ auth: { publicOrigins: [entry] } }).length === 0;
  const httpOk = pathsFor({ http: { allowedOrigins: [entry] } }).length === 0;
  return authOk === httpOk;
};
for (const entry of [
  'http://127.0.0.1:*',
  'http://localhost:*',
  'http://[::1]:*',
  'https://egg-rolls.top',
  'https://egg-rolls.top:*',
  'http://10.0.0.5:*',
  '*',
  'https://egg-rolls.top/',
  'http://127.0.0.1:8642:*',
]) {
  check(`same 口径 on "${entry}"`, sameEntry(entry));
}

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
