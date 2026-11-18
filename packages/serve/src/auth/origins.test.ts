/**
 * `auth/origins.ts` 的窄属性测试（0.61：回环端口通配 + 来源选择 fail-closed）。
 *
 * 为什么长成这样：仓库没有 test gate（见 AGENTS.md「验证纪律」），纯函数探针是被允许的
 * 例外；写法沿用 `src/member-cwd.test.ts`（`check()` + 计数 + 汇总）。直接跑：
 *
 *   bun run packages/serve/src/auth/origins.test.ts
 *
 * 判定看**输出文本**（`OK auth-origins: passed N / N` 或 `FAIL ...`）：本机 bun 是
 * Windows 版，退出码不可信。
 *
 * 断言的是**行为不变量**，不是实现细节：
 * - `normalizeOriginOrNull`：完整 origin 归一；回环端口通配保留；非回环通配 / 尾斜杠 /
 *   凭据 / path 一律 `null`；
 * - `mergePublicOrigins`：`publicOrigin` 在前、去重、非法条目丢弃、通配保留；
 * - `selectPublicOrigin`：**永不返回通配条目**（拼不出 redirect_uri，不许把请求端口拼进去）；
 *   单/多来源与「本机直连退回回环来源」的旧行为不变；Host 对不上且非直连 ⇒ `null`。
 */

import { mergePublicOrigins, normalizeOriginOrNull, selectPublicOrigin } from '../auth/origins';
import { resolvePlatformPublicOrigins } from '../platform/server';

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

// ---- normalizeOriginOrNull -------------------------------------------------

eq('plain https origin', normalizeOriginOrNull('https://egg-rolls.top'), 'https://egg-rolls.top');
eq('origin lowercased', normalizeOriginOrNull('HTTPS://Egg-Rolls.TOP'), 'https://egg-rolls.top');
eq(
  'default port dropped',
  normalizeOriginOrNull('https://egg-rolls.top:443'),
  'https://egg-rolls.top',
);
eq('loopback 127 wildcard kept', normalizeOriginOrNull('http://127.0.0.1:*'), 'http://127.0.0.1:*');
eq(
  'loopback localhost wildcard kept',
  normalizeOriginOrNull('http://localhost:*'),
  'http://localhost:*',
);
eq('loopback ipv6 wildcard kept', normalizeOriginOrNull('http://[::1]:*'), 'http://[::1]:*');
eq('loopback /8 wildcard kept', normalizeOriginOrNull('http://127.0.0.2:*'), 'http://127.0.0.2:*');
eq(
  'non-loopback wildcard rejected (public host)',
  normalizeOriginOrNull('https://egg-rolls.top:*'),
  null,
);
eq(
  'non-loopback wildcard rejected (private host)',
  normalizeOriginOrNull('http://192.168.1.10:*'),
  null,
);
eq('bare "*" rejected', normalizeOriginOrNull('*'), null);
eq(
  'trailing slash normalized (validator is the strict one)',
  normalizeOriginOrNull('https://egg-rolls.top/'),
  'https://egg-rolls.top',
);
eq('path rejected', normalizeOriginOrNull('https://egg-rolls.top/api'), null);
eq('query rejected', normalizeOriginOrNull('https://egg-rolls.top?x=1'), null);
eq('credentials rejected', normalizeOriginOrNull('https://u:p@egg-rolls.top'), null);
eq('ftp rejected', normalizeOriginOrNull('ftp://egg-rolls.top'), null);
eq('empty rejected', normalizeOriginOrNull('   '), null);
eq('non-string rejected', normalizeOriginOrNull(42), null);
eq('wildcard with explicit port rejected', normalizeOriginOrNull('http://127.0.0.1:8642:*'), null);

// ---- mergePublicOrigins ----------------------------------------------------

eq(
  'merge: single first, list after, deduped',
  mergePublicOrigins(['https://b.example', 'http://127.0.0.1:8642'], 'https://a.example'),
  ['https://a.example', 'https://b.example', 'http://127.0.0.1:8642'],
);
eq(
  'merge: wildcard survives (access-control side needs it)',
  mergePublicOrigins(['http://127.0.0.1:*'], 'https://egg-rolls.top'),
  ['https://egg-rolls.top', 'http://127.0.0.1:*'],
);
eq(
  'merge: invalid entries dropped',
  mergePublicOrigins(['not-a-url', 'https://ok.example'], undefined),
  ['https://ok.example'],
);
eq('merge: nothing configured', mergePublicOrigins(undefined, undefined), []);
eq(
  'merge: same origin twice',
  mergePublicOrigins(['https://a.example', 'https://a.example:443'], 'https://a.example'),
  ['https://a.example'],
);

// ---- selectPublicOrigin ----------------------------------------------------

const localDirect = { host: '127.0.0.1:8642', protocol: 'http' as const, localDirect: true };
const remote = { host: 'egg-rolls.top', protocol: 'https' as const, localDirect: false };

eq('select: empty whitelist → null', selectPublicOrigin(localDirect, []), null);
eq(
  'select: single origin wins verbatim',
  selectPublicOrigin(remote, ['https://egg-rolls.top']),
  'https://egg-rolls.top',
);
eq(
  'select: single origin wins even with a wildcard present',
  selectPublicOrigin(remote, ['https://egg-rolls.top', 'http://127.0.0.1:*']),
  'https://egg-rolls.top',
);
eq(
  'select: wildcard-only whitelist → null (never derive a port)',
  selectPublicOrigin(localDirect, ['http://127.0.0.1:*']),
  null,
);
eq(
  'select: wildcard-only whitelist, remote edge → null',
  selectPublicOrigin(remote, ['http://127.0.0.1:*', 'http://localhost:*', 'http://[::1]:*']),
  null,
);
eq(
  'select: host match among several',
  selectPublicOrigin(remote, ['https://a.example', 'https://egg-rolls.top']),
  'https://egg-rolls.top',
);
eq(
  'select: same host, protocol decides',
  selectPublicOrigin({ host: 'egg-rolls.top', protocol: 'https', localDirect: false }, [
    'http://egg-rolls.top',
    'https://egg-rolls.top',
  ]),
  'https://egg-rolls.top',
);
eq(
  'select: unknown host + not local direct → null (fail-closed)',
  selectPublicOrigin({ host: 'attacker.example', protocol: 'https', localDirect: false }, [
    'https://a.example',
    'https://egg-rolls.top',
  ]),
  null,
);
eq(
  'select: local direct falls back to a loopback entry from the whitelist',
  selectPublicOrigin({ host: 'localhost:5173', protocol: 'http', localDirect: true }, [
    'https://egg-rolls.top',
    'http://127.0.0.1:8642',
  ]),
  'http://127.0.0.1:8642',
);
eq(
  'select: local direct but whitelist has no loopback entry → null',
  selectPublicOrigin({ host: 'localhost:5173', protocol: 'http', localDirect: true }, [
    'https://a.example',
    'https://egg-rolls.top',
  ]),
  null,
);
eq(
  'select: forged forwarded host cannot pick a public origin',
  selectPublicOrigin({ host: 'egg-rolls.top:443', protocol: 'https', localDirect: false }, [
    'https://egg-rolls.top',
    'https://other.example',
  ]),
  'https://egg-rolls.top',
);

// ---- 平台入口的来源合并（fail-fast 面：通配不能把启动搞崩）------------------

eq(
  'platform: merge keeps plain origins verbatim',
  resolvePlatformPublicOrigins({
    publicOrigins: ['https://egg-rolls.top', 'http://127.0.0.1:8642'],
  }),
  ['https://egg-rolls.top', 'http://127.0.0.1:8642'],
);
eq(
  'platform: loopback port wildcard survives the fail-fast normalizer',
  resolvePlatformPublicOrigins({ publicOrigins: ['https://egg-rolls.top', 'http://127.0.0.1:*'] }),
  ['https://egg-rolls.top', 'http://127.0.0.1:*'],
);
let platformThrew = false;
try {
  resolvePlatformPublicOrigins({ publicOrigins: ['https://egg-rolls.top:*'] });
} catch {
  platformThrew = true;
}
check('platform: non-loopback wildcard still fails fast at startup', platformThrew);

// ---- summary ---------------------------------------------------------------

for (const failure of failures) console.error(`FAIL auth-origins: ${failure}`);
if (failures.length === 0) {
  console.log(`OK auth-origins: passed ${String(passed)} / ${String(passed)}`);
} else {
  console.log(`FAIL auth-origins: passed ${String(passed)} / ${String(passed + failures.length)}`);
  process.exitCode = 1;
}
