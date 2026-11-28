/**
 * `vessel help --search <query>` — 命令面轻量搜索（q-cli-rpc-search）。
 *
 * 统一搜索两个面：
 * - CLI 命令：静态 `CLI_HELP_COMMANDS`（路径 + i18n 摘要），零 IO；
 * - RPC 方法：live `capabilities.list`（与 vessel rpc list 同源，绝不另维护一份清单）。
 *
 * 这是 help 家族里唯一的 live 分支：普通 help 仍纯静态（见 help.ts）。
 * 控制面不可达时静默降级为纯 CLI 搜索（附一行说明），不报错、不阻塞。
 *
 * 轻量口径：substring / subsequence 打分 + ranking + did-you-mean（编辑距离 ≤2），
 * 不做索引、不做分词、不做持久化；grep 已覆盖的粗需求不在这里重复造轮子。
 *
 * @module vessel/cli-help-search
 */

import { t } from '../i18n';
import { schemaSummary } from './commands/rpc-command';
import {
  type ControlPlaneTargetOptions,
  resolveControlPlaneTarget,
} from './control-plane-target';
import type { CliHelpPlan } from './help';
import { CLI_HELP_COMMANDS } from './help-spec';
import { ui } from './output';

/** 结果上限：一屏可读；更细的过滤交给 grep / vessel rpc list --json。 */
const MAX_RESULTS = 20;
/** RPC 探测超时：搜索是顺手动作，不可达就快速降级。 */
const RPC_TIMEOUT_MS = 4_000;

interface SearchEntry {
  readonly kind: 'cli' | 'rpc';
  readonly name: string;
  readonly description: string;
}

interface ScoredEntry extends SearchEntry {
  readonly score: number;
}

// ── 请求识别与解析 ─────────────────────────────────

/** 只认 `vessel help --search ...`（含 `--search=<query>` 写法）。 */
export function isHelpSearchRequest(argv: readonly string[]): boolean {
  return (
    argv[0] === 'help' &&
    argv.some((token) => token === '--search' || token.startsWith('--search='))
  );
}

interface SearchRequest {
  readonly query: string;
  readonly json: boolean;
  readonly target: ControlPlaneTargetOptions;
}

type ParseOutcome =
  | { ok: true; request: SearchRequest }
  | { ok: false; error: string };

/** targeting flag 与 rpc list 同口径（--connect / --connect-token / --ca / --node / --instance / --data-dir）。 */
const TARGET_FLAGS = new Set([
  '--connect',
  '--connect-token',
  '--ca',
  '--node',
  '--instance',
  '--data-dir',
]);

function parseSearchArgs(argv: readonly string[]): ParseOutcome {
  const words: string[] = [];
  let json = false;
  const target: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '-h' || token === '--help') continue;
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--search' || token.startsWith('--search=')) {
      const inline = token.startsWith('--search=') ? token.slice('--search='.length) : undefined;
      const value = inline ?? argv[i + 1];
      if (value === undefined || value.trim() === '' || value.startsWith('-')) {
        return { ok: false, error: t('help.search.missingQuery') };
      }
      if (inline === undefined) i++;
      words.push(value);
      continue;
    }
    const eq = token.indexOf('=');
    const flag = eq >= 0 ? token.slice(0, eq) : token;
    if (TARGET_FLAGS.has(flag)) {
      const value = eq >= 0 ? token.slice(eq + 1) : argv[i + 1];
      // token 值可能以 '-' 开头；其余（url/path/id）不允许。
      const dashOk = flag === '--connect-token';
      if (value === undefined || value.trim() === '' || (!dashOk && value.startsWith('-'))) {
        return { ok: false, error: t('help.search.missingQuery') };
      }
      if (eq < 0) i++;
      target[flag] = value;
      continue;
    }
    if (token.startsWith('-')) {
      return { ok: false, error: t('help.search.unknownArg', { arg: token }) };
    }
    // 位置词并入 query：`vessel help --search gateway start` 自然可用。
    words.push(token);
  }
  const query = words.join(' ').trim();
  if (query === '') return { ok: false, error: t('help.search.missingQuery') };
  return {
    ok: true,
    request: {
      query,
      json,
      target: {
        connectUrl: target['--connect'],
        connectToken: target['--connect-token'],
        caFile: target['--ca'],
        nodeId: target['--node'],
        instance: target['--instance'],
        dataDir: target['--data-dir'],
      },
    },
  };
}

// ── 打分（轻量：精确 > 前缀 > 包含 > 子序列）─────────

function isSubsequence(query: string, text: string): boolean {
  let index = 0;
  for (const ch of query) {
    index = text.indexOf(ch, index);
    if (index < 0) return false;
    index += 1;
  }
  return true;
}

function fuzzyScore(query: string, entry: SearchEntry): number {
  const q = query.toLowerCase();
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (description.includes(q)) return 40;
  // 子序列只认名字：长摘要里子序列几乎必中，只会制造噪声（did-you-mean 永远不触发）。
  if (isSubsequence(q, name)) return 30;
  return 0;
}

/** 编辑距离（上限 2，超出即弃）：did-you-mean 用，覆盖漏字 / 换字 / 相邻换位。 */
function nearMatch(query: string, text: string): boolean {
  const a = query.toLowerCase();
  const b = text.toLowerCase();
  if (Math.abs(a.length - b.length) > 2) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return (prev[b.length] ?? 3) <= 2;
}

function rank(entries: readonly SearchEntry[], query: string): ScoredEntry[] {
  return entries
    .map((entry) => ({ ...entry, score: fuzzyScore(query, entry) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_RESULTS);
}

/** 零结果时的候选：名字子序列或任一路径段编辑距离 ≤2，取前 3。 */
function didYouMean(entries: readonly SearchEntry[], query: string): string[] {
  const q = query.toLowerCase();
  const candidates = entries
    .filter((entry) => {
      const name = entry.name.toLowerCase();
      return (
        isSubsequence(q, name) || name.split(/[ .]/).some((segment) => nearMatch(q, segment))
      );
    })
    .map((entry) => entry.name)
    .sort();
  return [...new Set(candidates)].slice(0, 3);
}

// ── 候选面 ─────────────────────────────────────────

function cliEntries(): SearchEntry[] {
  return CLI_HELP_COMMANDS.map((spec) => ({
    kind: 'cli' as const,
    name: spec.path.join(' '),
    description: t(spec.summary),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** live capabilities.list；任何失败都降级（available=false），绝不让搜索报错。 */
async function rpcEntries(
  options: ControlPlaneTargetOptions,
): Promise<{ entries: SearchEntry[]; available: boolean }> {
  try {
    const resolved = await resolveControlPlaneTarget({
      ...options,
      requestTimeoutMs: RPC_TIMEOUT_MS,
    });
    if (!resolved.ok) return { entries: [], available: false };
    const target = resolved.target;
    try {
      const manifest = await target.request('capabilities.list', {});
      const methods = isRecord(manifest) && Array.isArray(manifest.methods) ? manifest.methods : [];
      const entries: SearchEntry[] = [];
      for (const method of methods) {
        if (!isRecord(method) || typeof method.name !== 'string' || method.name === '') continue;
        const permission = typeof method.permission === 'string' ? method.permission : '?';
        entries.push({
          kind: 'rpc',
          name: method.name,
          description: `${permission} · ${schemaSummary(method.params_schema)}`,
        });
      }
      return { entries, available: true };
    } finally {
      await target.close().catch(() => undefined);
    }
  } catch {
    return { entries: [], available: false };
  }
}

// ── 渲染 ───────────────────────────────────────────

function align(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([name]) => name.length));
  return rows.map(([name, desc]) => `  ${ui.brand(name.padEnd(width))}  ${desc}`).join('\n');
}

function renderHuman(
  query: string,
  results: readonly ScoredEntry[],
  rpcAvailable: boolean,
  suggestions: readonly string[],
): string {
  const lines = [ui.title(t('help.search.title', { query })), ui.rule(48)];
  const cli = results.filter((entry) => entry.kind === 'cli');
  const rpc = results.filter((entry) => entry.kind === 'rpc');
  if (results.length === 0) {
    lines.push('', `  ${t('help.search.empty')}`);
    if (suggestions.length > 0) {
      lines.push('', `  ${ui.section(t('help.search.didYouMean'))}`);
      for (const name of suggestions) lines.push(`  ${ui.brand(name)}`);
    }
  } else {
    if (cli.length > 0) {
      lines.push('', `  ${ui.section(`${t('help.search.cli')} (${cli.length})`)}`);
      lines.push(align(cli.map((entry) => [entry.name, entry.description])));
    }
    if (rpc.length > 0) {
      lines.push('', `  ${ui.section(`${t('help.search.rpc')} (${rpc.length})`)}`);
      lines.push(align(rpc.map((entry) => [entry.name, entry.description])));
    }
  }
  if (!rpcAvailable) lines.push('', `  ${ui.dim(t('help.search.rpcUnavailable'))}`);
  lines.push('', `  ${ui.dim(t('help.search.hint'))}`);
  return lines.join('\n');
}

// ── 入口 ───────────────────────────────────────────

/**
 * 入口早退计划：`null` = 本次 argv 不是 `help --search`。
 * 用法错误 exit 2；搜索本身（含零结果）exit 0。
 */
export async function planHelpSearch(argv: readonly string[]): Promise<CliHelpPlan | null> {
  if (!isHelpSearchRequest(argv)) return null;
  const parsed = parseSearchArgs(argv);
  if (!parsed.ok) return { stdout: '', stderr: ui.err(parsed.error), exitCode: 2 };
  const { query, json, target } = parsed.request;

  const cli = cliEntries();
  const rpc = await rpcEntries(target);
  const all = [...cli, ...rpc.entries];
  const results = rank(all, query);

  if (json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          query,
          rpc_available: rpc.available,
          results: results.map((entry) => ({
            kind: entry.kind,
            name: entry.name,
            description: entry.description,
            score: entry.score,
          })),
          ...(results.length === 0 ? { did_you_mean: didYouMean(all, query) } : {}),
        },
        null,
        2,
      ),
      stderr: '',
    };
  }
  const suggestions = results.length === 0 ? didYouMean(all, query) : [];
  return {
    exitCode: 0,
    stdout: renderHuman(query, results, rpc.available, suggestions),
    stderr: '',
  };
}
