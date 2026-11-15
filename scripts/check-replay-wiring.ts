#!/usr/bin/env bun
/**
 * check-replay-wiring.ts — A1 静态链路门（防"半截修复" + 防"浏览器摸盘/绕封装层"）。
 *
 * 背景：浏览器连的是（可能远程的）gateway。刷新回填必须**走 RPC 客户端**，不能假设本地盘、
 * 不能裸 transport。commit 473bfc4c 曾在 `packages/serve` 加了 `sessions.events` 但
 * `apps/web` 零调用 => 前端仍只靠易失环 + 滞后投影（见 docs/dev/handoff/replay-gap-findings.md）。
 *
 * 规则（并列、无白名单/无例外名单）：
 *   F  逐方法接线：对 `sessions.events` 与 `events.list` **各自**断言
 *        serveHas(method) && webRealCall(method)（两者都必须在 apps/web 有真实 request 调用）；
 *        serve 有而 web 无 => 半截修复；web 有而 serve 无 => 调了不存在的 RPC。
 *   F1 禁止本地文件系统：apps/web 扫描范围内不得出现 `node:fs`/`fs`/`node:path`/`path`
 *        的 import/require，以及 `.vessel/…`、`events.ndjson`、`/sessions/<id>/events.ndjson`
 *        这类本地路径**字符串常量**（注释不算，字符串常量算——那说明它假设本地盘）。
 *   F2 必须走封装层：裸 `fetch(`/`WebSocket(` 命中**网关地址**（127.0.0.1/localhost/:8644/
 *        /v1/、ws://、wss://）而**不在既定传输封装层**内 => FAIL。封装层 = 唯一的 transport 模块。
 *
 * 只读源码；不启动服务、不依赖真前端。`bun run scripts/check-replay-wiring.ts`
 * 退出码 0 = PASS，1 = FAIL，2 = 自身错误（本 WSL shim 下 bun 退出码可能恒 0，请看 stdout `result:`）。
 * `--selftest` 对每条规则跑正/反例，证明不误判/不漏判。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SESSIONS_EVENTS = 'sessions.events';
const EVENTS_LIST = 'events.list';
const METHODS = [SESSIONS_EVENTS, EVENTS_LIST];

const HERE = (import.meta as { dir?: string }).dir ?? process.cwd();
const ROOT = join(HERE, '..');
const METHODS_DIR = join(ROOT, 'packages/serve/src/gateway/methods');
const WEB_SRC = join(ROOT, 'apps/web/src');

/** 既定的**传输封装层**：唯一允许出现 raw fetch/WebSocket 的地方（其余必须经它）。 */
const TRANSPORT_LAYER = new Set([
  'apps/web/src/gateway/node/protocol.ts', // WS + /health
  'apps/web/src/gateway/node/rpc.ts', // HTTP /v1/rpc
  'apps/web/src/gateway/nodes.ts', // node registry /v1/rpc
  'apps/web/src/gateway/platform/client.ts', // platform /platform/rpc
  'apps/web/src/gateway/platform/hub.ts', // hub transport
]);

const WEB_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// ───────────────────────────── 文本工具 ─────────────────────────────

/** 把注释替换成空格（保留换行与长度 ⇒ 行号精确）；**字符串内容保留**（F1 要看字符串常量）。 */
function stripCommentsKeepLines(src: string): string {
  const out = src.split('');
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'bt' = 'code';
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        state = 'line';
        i += 1;
      } else if (c === '/' && n === '*') {
        out[i] = ' ';
        out[i + 1] = ' ';
        state = 'block';
        i += 1;
      } else if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'bt';
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
      else out[i] = ' ';
    } else if (state === 'block') {
      if (c === '*' && n === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        state = 'code';
        i += 1;
      } else if (c !== '\n') out[i] = ' ';
    } else {
      // 字符串态：保留内容，跳过转义
      if (c === '\\') i += 1;
      else if (
        (state === 'sq' && c === "'") ||
        (state === 'dq' && c === '"') ||
        (state === 'bt' && c === '`')
      ) {
        state = 'code';
      }
    }
  }
  return out.join('');
}

function lineAt(code: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < code.length; i += 1) if (code[i] === '\n') line += 1;
  return line;
}
function snippetAt(code: string, idx: number): string {
  const end = code.indexOf('\n', idx);
  return code.slice(idx, end < 0 ? code.length : end).trim().slice(0, 100);
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 真实调用点：方法名必须作为 request-like 函数的字符串实参（`this.request('m',…)` / `this.rpc<T>('m',…)`）。 */
function realCallSites(code: string, method: string): number {
  const m = escapeRe(method);
  const prefixes = '(?:request|rpc|call|invoke|send|query)[A-Za-z]*';
  const patterns = [
    new RegExp('\\b' + prefixes + '\\s*\\(\\s*([\'"])' + m + '\\1', 'g'),
    new RegExp('\\b' + prefixes + '\\s*<[^>]*>\\s*\\(\\s*([\'"])' + m + '\\1', 'g'),
  ];
  let count = 0;
  for (const re of patterns) {
    let hit: RegExpExecArray | null = re.exec(code);
    while (hit !== null) {
      count += 1;
      hit = re.exec(code);
    }
  }
  return count;
}

const FS_IMPORT_PATTERNS: RegExp[] = [
  /\bfrom\s*(['"])node:fs\1/,
  /\bfrom\s*(['"])fs\1/,
  /\brequire\s*\(\s*(['"])node:fs\1\s*\)/,
  /\brequire\s*\(\s*(['"])fs\1\s*\)/,
  /\bimport\s*\(\s*(['"])node:fs\1\s*\)/,
  /\bfrom\s*(['"])node:path\1/,
  /\bfrom\s*(['"])path\1/,
  /\brequire\s*\(\s*(['"])node:path\1\s*\)/,
  /\brequire\s*\(\s*(['"])path\1\s*\)/,
  /\bimport\s*\(\s*(['"])node:path\1\s*\)/,
];
const LOCAL_PATH_PATTERNS: RegExp[] = [
  /\.vessel[\\/]/,
  /\bevents\.ndjson\b/,
  /[\\/]sessions[\\/][^'"\n]{0,80}events\.ndjson/,
];

function findLocalFsViolations(code: string): { line: number; snippet: string }[] {
  const hits: { line: number; snippet: string }[] = [];
  for (const re of [...FS_IMPORT_PATTERNS, ...LOCAL_PATH_PATTERNS]) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null = g.exec(code);
    while (m !== null) {
      hits.push({ line: lineAt(code, m.index), snippet: snippetAt(code, m.index) });
      m = g.exec(code);
    }
  }
  return hits;
}

const GATEWAY_MARKERS = /(\b127\.0\.0\.1\b|\blocalhost\b|:8644|\/v1\/|\/v1\b|ws:\/\/|wss:\/\/|\/health\b|\/hub\/events\b|\/v1\/rpc\b)/;
const TRANSPORT_CALL = /\b(fetch|XMLHttpRequest|WebSocket)\s*\(/g;

/** 裸 transport 打网关地址（封装层内的不算）。 */
function findBareTransport(
  code: string,
  isTransportLayer: boolean,
): { line: number; snippet: string }[] {
  if (isTransportLayer) return [];
  const hits: { line: number; snippet: string }[] = [];
  let m: RegExpExecArray | null = TRANSPORT_CALL.exec(code);
  while (m !== null) {
    const i = m.index;
    const window = code.slice(Math.max(0, i - 140), i + 260);
    if (GATEWAY_MARKERS.test(window)) hits.push({ line: lineAt(code, i), snippet: snippetAt(code, i) });
    m = TRANSPORT_CALL.exec(code);
  }
  return hits;
}

// ───────────────────────────── 方法表 ─────────────────────────────

function readServeMethodTable(): { names: string[]; via: string } {
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
  return { names: [...new Set(names)].sort(), via: 'method table scan (packages/serve/src/gateway/methods/*.ts)' };
}

// ───────────────────────────── 遍历 ─────────────────────────────

function relOf(file: string): string {
  return file.replace(ROOT, '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
}
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

// ───────────────────────────── 自检 ─────────────────────────────

function selftest(): boolean {
  let ok = true;
  const check = (name: string, cond: boolean): void => {
    if (!cond) {
      ok = false;
      console.log('[A1 selftest] FAIL ' + name);
    } else {
      console.log('[A1 selftest] PASS ' + name);
    }
  };

  // F: 方法调用检测
  check('F comment', realCallSites(stripCommentsKeepLines("// this.request('sessions.events',{})"), SESSIONS_EVENTS) === 0);
  check('F string-const', realCallSites(stripCommentsKeepLines("const M='sessions.events';"), SESSIONS_EVENTS) === 0);
  check('F type-union', realCallSites(stripCommentsKeepLines("type M='sessions.events'|'x'"), SESSIONS_EVENTS) === 0);
  check('F real-call', realCallSites(stripCommentsKeepLines("this.request('sessions.events',{})"), SESSIONS_EVENTS) === 1);
  check('F real-generic', realCallSites(stripCommentsKeepLines("this.rpc<Foo>('events.list',p)"), EVENTS_LIST) === 1);
  check('F http-then-real', realCallSites(stripCommentsKeepLines("// x http://a/sessions.events\nthis.request('sessions.events',{})"), SESSIONS_EVENTS) === 1);

  // F1: 本地文件系统（字符串常量算，注释不算）
  check('F1 node:fs import', findLocalFsViolations(stripCommentsKeepLines("import fs from 'node:fs';")).length >= 1);
  check('F1 require fs', findLocalFsViolations(stripCommentsKeepLines("const fs=require('fs');")).length >= 1);
  check('F1 path literal .vessel', findLocalFsViolations(stripCommentsKeepLines("const p='~/.vessel/data/x';")).length >= 1);
  check('F1 events.ndjson literal', findLocalFsViolations(stripCommentsKeepLines("const p='/sessions/abc/events.ndjson';")).length >= 1);
  check('F1 comment ok', findLocalFsViolations(stripCommentsKeepLines('// never import node:fs here')).length === 0);
  check('F1 clean ok', findLocalFsViolations(stripCommentsKeepLines('const x = 1;')).length === 0);

  // F2: 裸 transport（封装层内豁免；非网关地址不算）
  check('F2 bare fetch gateway', findBareTransport(stripCommentsKeepLines("await fetch('http://127.0.0.1:8644/v1/events')"), false).length >= 1);
  check('F2 wrapper exempt', findBareTransport(stripCommentsKeepLines("await fetch('http://127.0.0.1:8644/v1/events')"), true).length === 0);
  check('F2 rpc-call ok', findBareTransport(stripCommentsKeepLines("this.request('sessions.events',{})"), false).length === 0);
  check('F2 non-gateway fetch ok', findBareTransport(stripCommentsKeepLines("await fetch('/build.json')"), false).length === 0);

  console.log('[A1 selftest] result: ' + (ok ? 'PASS' : 'FAIL'));
  return ok;
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }

  const table = readServeMethodTable();
  const files: string[] = [];
  walk(WEB_SRC, files);

  const perMethod = new Map<string, { serve: boolean; web: number }>();
  for (const m of METHODS) perMethod.set(m, { serve: table.names.includes(m), web: 0 });
  const fsHits: { file: string; line: number; snippet: string }[] = [];
  const transportHits: { file: string; line: number; snippet: string }[] = [];

  for (const file of files) {
    const rel = relOf(file);
    const code = stripCommentsKeepLines(readFileSync(file, 'utf8'));
    for (const m of METHODS) {
      const n = realCallSites(code, m);
      if (n > 0) {
        const entry = perMethod.get(m);
        if (entry !== undefined) entry.web += n;
      }
    }
    for (const h of findLocalFsViolations(code)) fsHits.push({ file: rel, ...h });
    for (const h of findBareTransport(code, TRANSPORT_LAYER.has(rel))) transportHits.push({ file: rel, ...h });
  }

  let ok = true;
  const lines: string[] = [];
  lines.push('==================== check-replay-wiring (A1) ====================');
  lines.push('method table   : ' + table.via + '  (' + table.names.length + ' methods)');

  lines.push('--- rule F: per-method wiring ---');
  for (const m of METHODS) {
    const st = perMethod.get(m);
    const serve = st !== undefined && st.serve;
    const web = st !== undefined ? st.web : 0;
    const good = serve && web > 0;
    if (!good) ok = false;
    let tag = 'ok';
    if (serve && web === 0) tag = 'FAIL half-fix (serve has, web zero call)';
    else if (!serve && web > 0) tag = 'FAIL web calls non-existent RPC';
    else if (!serve) tag = 'FAIL serve missing RPC';
    lines.push('  ' + m.padEnd(16) + ' serve=' + (serve ? 'YES' : 'NO ') + ' webCalls=' + web + '  => ' + tag);
  }

  lines.push('--- rule F1: no local filesystem in apps/web ---');
  if (fsHits.length === 0) lines.push('  violations: 0');
  else {
    ok = false;
    lines.push('  violations: ' + fsHits.length);
    for (const h of fsHits.slice(0, 20)) lines.push('   - ' + h.file + ':' + h.line + '  ' + h.snippet);
    if (fsHits.length > 20) lines.push('   ... (+' + (fsHits.length - 20) + ')');
  }

  lines.push('--- rule F2: no bare transport to gateway outside the transport layer ---');
  if (transportHits.length === 0) lines.push('  violations: 0');
  else {
    ok = false;
    lines.push('  violations: ' + transportHits.length);
    for (const h of transportHits.slice(0, 20)) lines.push('   - ' + h.file + ':' + h.line + '  ' + h.snippet);
  }
  lines.push('  transport layer (allowed): ' + [...TRANSPORT_LAYER].join(', '));

  lines.push('result         : ' + (ok ? 'PASS' : 'FAIL'));
  lines.push('===============================================================');
  console.log(lines.join('\n'));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('check-replay-wiring crashed:', err);
  process.exit(2);
});
