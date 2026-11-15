#!/usr/bin/env bun
/**
 * check-replay-wiring.ts — A1 静态链路门（防"半截修复"）。
 *
 * 背景：commit 473bfc4c 在 `packages/serve` 加了 `sessions.events` RPC + `event_cursor`，
 * 但 `apps/web` 从未调用 => 前端刷新仍只靠易失的环 + 滞后的消息投影
 * （见 docs/dev/handoff/replay-gap-findings.md）。本门禁把"服务端有 RPC 就必须有前端
 * 真实调用点"钉死，任何半截修复立即变红。
 *
 * 断言（无白名单、无例外）：
 *   S = 网关方法表里是否存在 `sessions.events`
 *   W = `apps/web/src` 里是否存在对 `sessions.events` 的**真实请求调用**（不是注释/字符串常量）
 *   -  S && !W  => FAIL（服务端有、前端零引用 = 半截修复，正是 473bfc4c 形态）
 *   - !S &&  W  => FAIL（前端调了、服务端没这个 RPC）
 *   - 其它       => PASS
 *
 * 只读源码；不启动服务、不依赖真前端。`bun run scripts/check-replay-wiring.ts`
 * 退出码 0 = PASS，1 = FAIL，2 = 自身错误。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const METHOD = 'sessions.events';
const HERE = (import.meta as { dir?: string }).dir ?? process.cwd();
const ROOT = join(HERE, '..');
const METHODS_DIR = join(ROOT, 'packages/serve/src/gateway/methods');
const WEB_SRC = join(ROOT, 'apps/web/src');

interface ServeTable {
  has: boolean;
  names: string[];
  via: string;
}

async function readServeMethodTable(): Promise<ServeTable> {
  // 首选：导入真实方法表（createSessionMethods 返回 RpcMethodDefinition[]）。
  try {
    const mod = (await import('../packages/serve/src/gateway/methods/sessions.ts')) as {
      createSessionMethods: (deps: unknown) => { name: string }[];
    };
    const defs = mod.createSessionMethods({
      sessionFor: () => ({ load: async () => undefined }),
    });
    const names = defs.map((d) => d.name).sort();
    return { has: names.includes(METHOD), names, via: 'import method table' };
  } catch (err) {
    // 回落：静态扫描方法目录里的 `name: 'x.y'` 定义（成员 worktree 无 node_modules 也能跑）。
    const names: string[] = [];
    if (existsSync(METHODS_DIR)) {
      for (const f of readdirSync(METHODS_DIR)) {
        if (!f.endsWith('.ts')) continue;
        const src = readFileSync(join(METHODS_DIR, f), 'utf8');
        for (const m of src.matchAll(/name:\s*['"]([a-z][\w]*\.[\w.]+)['"]/g)) {
          const name = m[1];
          if (name !== undefined) names.push(name);
        }
      }
    }
    names.sort();
    return {
      has: names.includes(METHOD),
      names,
      via: 'static scan fallback (' + String(err) + ')',
    };
  }
}

/** 去掉 // 与 block 注释，避免把注释里的方法名当成调用点。 */
function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // `(^|[^:\\])//...` 避免把 `http://` 之类误删
  out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  return out;
}

const WEB_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function walk(dir: string, acc: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else {
      const dot = name.lastIndexOf('.');
      if (dot >= 0 && WEB_EXTS.has(name.slice(dot))) acc.push(p);
    }
  }
}

/**
 * 真实调用点检测：方法名必须作为某个 request-like 函数的**字符串实参**出现，例如
 * `this.request('sessions.events', …)` / `this.rpc('sessions.events', …)` /
 * `this.request<T>('sessions.events', …)`。单纯出现在类型联合 / 注释 / 常量里不算。
 * 返回命中片段（去重）。
 */
function realCallSites(code: string): string[] {
  const hits = new Set<string>();
  const prefixes = '(?:request|rpc|call|invoke|send|query)[A-Za-z]*';
  // 直接调用（无泛型）与带泛型 `request<T>(` 两种都覆盖。
  const patterns = [
    new RegExp('\\b' + prefixes + '\\s*\\(\\s*([\'"])' + METHOD.replace('.', '\\.') + '\\1', 'g'),
    new RegExp('\\b' + prefixes + '\\s*<[^>]*>\\s*\\(\\s*([\'"])' + METHOD.replace('.', '\\.') + '\\1', 'g'),
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null = re.exec(code);
    while (m !== null) {
      hits.add(m[0].slice(0, 90));
      m = re.exec(code);
    }
  }
  return [...hits];
}

/** 自检：证明检测器不把注释/字符串常量当接线、但能认出真实调用。 */
function selftest(): boolean {
  const cases: { name: string; code: string; want: number }[] = [
    { name: 'line-comment', code: "// this.request('sessions.events', {})", want: 0 },
    { name: 'block-comment', code: "/* x('sessions.events') */", want: 0 },
    { name: 'string-const', code: "const M = 'sessions.events';", want: 0 },
    { name: 'type-union', code: "type M = 'sessions.events' | 'other.x';", want: 0 },
    { name: 'real-call', code: "this.request('sessions.events', { session_id: 's' })", want: 1 },
    { name: 'real-generic', code: "await this.rpc<Foo>('sessions.events', p)", want: 1 },
    {
      name: 'http-then-real',
      code: '// see http://x/sessions.events\nthis.request(\'sessions.events\', {})',
      want: 1,
    },
  ];
  let ok = true;
  for (const c of cases) {
    const n = realCallSites(stripComments(c.code)).length;
    if (n !== c.want) {
      console.log('[A1 selftest] FAIL ' + c.name + ': got ' + n + ' want ' + c.want);
      ok = false;
    } else {
      console.log('[A1 selftest] PASS ' + c.name + ' (' + n + ')');
    }
  }
  console.log('[A1 selftest] result: ' + (ok ? 'PASS' : 'FAIL'));
  return ok;
}

async function main(): Promise<void> {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }
  const serve = await readServeMethodTable();

  const files: string[] = [];
  walk(WEB_SRC, files);
  const allHits: { file: string; snippet: string }[] = [];
  let rawMentions = 0;
  const mentionRe = new RegExp(METHOD.replace('.', '\\.'), 'g');
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const mentions = src.match(mentionRe);
    if (mentions !== null) rawMentions += mentions.length;
    const rel = file.startsWith(ROOT + '/') ? file.slice(ROOT.length + 1) : file;
    for (const snippet of realCallSites(stripComments(src))) allHits.push({ file: rel, snippet });
  }

  const wired = allHits.length > 0;
  const ok = serve.has === wired;

  const lines: string[] = [];
  lines.push('==================== check-replay-wiring (A1) ====================');
  lines.push('method table   : ' + serve.via + '  (' + serve.names.length + ' methods)');
  lines.push('serve exposes  : ' + METHOD + ' = ' + String(serve.has));
  lines.push('web files      : ' + files.length + ' scanned; raw mentions of "' + METHOD + '" = ' + rawMentions);
  lines.push('web real calls : ' + allHits.length);
  for (const h of allHits.slice(0, 5)) lines.push('   - ' + h.file + ': ' + h.snippet);
  if (rawMentions > 0 && allHits.length === 0) {
    lines.push('NOTE: "' + METHOD + '" only appears in comments/strings, no real request call => NOT wired');
  }
  lines.push('result         : ' + (ok ? 'PASS' : 'FAIL'));
  if (!ok) {
    if (serve.has && !wired) {
      lines.push('CAUSE: serve exposes ' + METHOD + ' but apps/web has zero real call site => half-fix (473bfc4c)');
      lines.push('FIX  : apps/web needs a real request(\'' + METHOD + '\', ...) call site (owned by replay-wire)');
    } else {
      lines.push('CAUSE: apps/web calls ' + METHOD + ' but the serve method table does not expose it');
    }
  }
  lines.push('===============================================================');
  console.log(lines.join('\n'));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('check-replay-wiring crashed:', err);
  process.exit(2);
});
