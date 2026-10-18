/**
 * CLI 参数解析（纯函数）
 *
 * 从 cli.ts 抽出，便于单测覆盖每个入口。解析只负责语法与互斥，
 * 不加载配置、不构造 runtime、不产生副作用。
 */

/** `--serve` 省略端口时的默认值 */
export const DEFAULT_SERVE_PORT = 8642;

export interface UpdateArgs {
  check: boolean;
  channel?: 'latest' | 'beta';
  json: boolean;
  force: boolean;
}

/** `workflow` 子命令的状态过滤值（DECISION-009 §5.1.3） */
export type WorkflowRunStatusArg =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type WorkflowCommand =
  | { kind: 'run'; target: string; inputs: Record<string, string> }
  | { kind: 'list'; status?: WorkflowRunStatusArg; limit?: number }
  | { kind: 'show'; workflowRunId: string }
  | { kind: 'resume'; workflowRunId: string }
  | { kind: 'cancel'; workflowRunId: string };

export interface EvalCommand {
  target: string;
  json: boolean;
  out?: string;
  filters: string[];
  allowNetwork: boolean;
}

export interface CliArgs {
  /** null = 非 headless；'' = 从 stdin 读；非空 = 文本 prompt 或 @file */
  runArg: string | null;
  /** `--pipe` 隐藏别名，等价 `--run` 无参 */
  pipeMode: boolean;
  sessionArg: string | null;
  /** null = 不启动 gateway；0 = 由系统分配端口 */
  servePort: number | null;
  /** 端口是否由用户显式给出（用于 config serve.port 回退） */
  servePortExplicit: boolean;
  /** --serve-host <host>；null = 未指定 */
  serveHost: string | null;
  /** --allow-remote：显式允许非回环监听 */
  allowRemote: boolean;
  /** --tls-cert <path> / --tls-key <path>：必须成对 */
  tlsCert: string | null;
  tlsKey: string | null;
  /** null = 未使用；'' = 列出可恢复 run；非空 = 恢复该 run */
  resumeRunArg: string | null;
  help: boolean;
  version: boolean;
  tools: boolean;
  /** `vessel update ...` 子命令 */
  update: UpdateArgs | null;
  /** `vessel workflow ...` 子命令 */
  workflow: WorkflowCommand | null;
  /** `vessel eval ...` 子命令 */
  eval: EvalCommand | null;
  /** 0.4：附加开关；只与 run/pipe/resume/tools/version/help 互斥 */
  feishu: boolean;
}

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; error: string };

// 0 是合法值：由系统分配（team loopback 节点推荐）
const MIN_PORT = 0;
const MAX_PORT = 65535;

/** 解析十进制端口；非法返回 null */
function parsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const port = Number.parseInt(raw, 10);
  if (port < MIN_PORT || port > MAX_PORT) return null;
  return port;
}

/**
 * 解析 argv（不含 node/bun 与脚本路径）。
 * 未知参数一律报错，不静默忽略。
 */
export function parseArgs(argv: string[]): ParseResult {
  const args: CliArgs = {
    runArg: null,
    pipeMode: false,
    sessionArg: null,
    servePort: null,
    servePortExplicit: false,
    serveHost: null,
    allowRemote: false,
    tlsCert: null,
    tlsKey: null,
    resumeRunArg: null,
    help: false,
    version: false,
    tools: false,
    update: null,
    workflow: null,
    eval: null,
    feishu: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';

    // `update` / `workflow` / `eval` 只允许作为第一个参数（子命令），
    // 其余位置按未知参数处理。
    if (a === 'update' && i === 0) {
      return parseUpdateArgs(argv.slice(1), args);
    }
    if (a === 'workflow' && i === 0) {
      return parseWorkflowArgs(argv.slice(1), args);
    }
    if (a === 'eval' && i === 0) {
      return parseEvalArgs(argv.slice(1), args);
    }

    switch (a) {
      case '--run':
      case '-r': {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          args.runArg = next;
          i++;
        } else {
          args.runArg = '';
        }
        break;
      }
      case '--pipe':
        args.pipeMode = true;
        break;
      case '--session':
      case '-s': {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          return { ok: false, error: 'Missing value for --session' };
        }
        args.sessionArg = next;
        i++;
        break;
      }
      case '--serve': {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          const port = parsePort(next);
          if (port === null) {
            return { ok: false, error: `Invalid port for --serve: ${next}` };
          }
          args.servePort = port;
          args.servePortExplicit = true;
          i++;
        } else {
          args.servePort = DEFAULT_SERVE_PORT;
          args.servePortExplicit = false;
        }
        break;
      }
      case '--serve-host': {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: 'Missing value for --serve-host' };
        }
        args.serveHost = next;
        i++;
        break;
      }
      case '--allow-remote':
        args.allowRemote = true;
        break;
      case '--tls-cert':
      case '--tls-key': {
        const next = argv[i + 1];
        const flag = a;
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: `Missing value for ${flag}` };
        }
        if (flag === '--tls-cert') args.tlsCert = next;
        else args.tlsKey = next;
        i++;
        break;
      }
      case '--resume-run': {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          args.resumeRunArg = next;
          i++;
        } else {
          args.resumeRunArg = '';
        }
        break;
      }
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      case '--tools':
        args.tools = true;
        break;
      case '--feishu':
        args.feishu = true;
        break;
      default:
        return { ok: false, error: `Unknown argument: ${a}` };
    }
  }

  // --resume-run 是独立模式：不能与其它输入/服务/一次性命令组合（Addendum A §6）。
  if (args.resumeRunArg !== null) {
    const conflicts = [
      args.runArg !== null ? '--run' : null,
      args.pipeMode ? '--pipe' : null,
      args.servePort !== null ? '--serve' : null,
      args.sessionArg !== null ? '--session' : null,
      args.tools ? '--tools' : null,
    ].filter((v): v is string => v !== null);
    if (conflicts.length > 0) {
      return { ok: false, error: `--resume-run cannot be combined with ${conflicts.join('/')}` };
    }
  }

  // TLS 必须成对；serve 专属参数必须有 --serve。
  if ((args.tlsCert !== null) !== (args.tlsKey !== null)) {
    return { ok: false, error: '--tls-cert and --tls-key must be provided together' };
  }

  const serveOnly = [
    args.serveHost !== null ? '--serve-host' : null,
    args.allowRemote ? '--allow-remote' : null,
    args.tlsCert !== null ? '--tls-cert' : null,
    args.tlsKey !== null ? '--tls-key' : null,
  ].filter((v): v is string => v !== null);
  if (serveOnly.length > 0 && args.servePort === null) {
    return { ok: false, error: `${serveOnly[0]} requires --serve` };
  }

  const oneShot = [
    args.help ? '--help' : null,
    args.version ? '--version' : null,
    args.tools ? '--tools' : null,
  ].filter((v): v is string => v !== null);

  if (oneShot.length > 1) {
    return { ok: false, error: `Cannot combine ${oneShot.join(' and ')}` };
  }
  if (oneShot.length === 1 && (args.runArg !== null || args.pipeMode || args.servePort !== null)) {
    return { ok: false, error: `${oneShot[0]} cannot be combined with --run/--serve` };
  }

  // 0.4：`--feishu` 是附加开关，可与 `--serve` / REPL / `--session` 同用；
  // 只与一次性输入命令互斥（Addendum B §11.3.5）。
  if (args.feishu) {
    const conflicts = [
      args.runArg !== null ? '--run' : null,
      args.pipeMode ? '--pipe' : null,
      args.resumeRunArg !== null ? '--resume-run' : null,
      args.tools ? '--tools' : null,
      args.version ? '--version' : null,
      args.help ? '--help' : null,
    ].filter((v): v is string => v !== null);
    if (conflicts.length > 0) {
      return { ok: false, error: `--feishu cannot be combined with ${conflicts.join('/')}` };
    }
  }

  return { ok: true, args };
}

/** 解析 `update` 子命令的剩余参数 */
function parseUpdateArgs(rest: string[], args: CliArgs): ParseResult {
  const update: UpdateArgs = { check: false, json: false, force: false };

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    switch (a) {
      case '--check':
        update.check = true;
        break;
      case '--channel': {
        const next = rest[i + 1];
        if (next === undefined || next.startsWith('-')) {
          return { ok: false, error: 'Missing value for --channel' };
        }
        if (next !== 'latest' && next !== 'beta') {
          return { ok: false, error: `Invalid channel: ${next} (expected "latest" or "beta")` };
        }
        update.channel = next;
        i++;
        break;
      }
      case '--json':
        update.json = true;
        break;
      case '--force':
        update.force = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        return { ok: false, error: `Unknown argument: ${a}` };
    }
  }

  args.update = update;
  return { ok: true, args };
}

// ── 0.4 workflow / eval 子命令 ───────────────────

const WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

const MAX_WORKFLOW_LIMIT = 200;
const INPUT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** 解析 `workflow` 子命令 */
function parseWorkflowArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return {
      ok: false,
      error: 'Missing workflow subcommand (run|list|show|resume|cancel)',
    };
  }

  const tail = rest.slice(1);
  switch (sub) {
    case 'run':
      return parseWorkflowRun(tail, args);
    case 'list':
      return parseWorkflowList(tail, args);
    case 'show':
    case 'resume':
    case 'cancel':
      return parseWorkflowId(sub, tail, args);
    default:
      return { ok: false, error: `Unknown workflow subcommand: ${sub}` };
  }
}

/** `workflow run <name-or-path> [--input key=value]...` */
function parseWorkflowRun(rest: string[], args: CliArgs): ParseResult {
  let target: string | undefined;
  const inputs: Record<string, string> = {};

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';

    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--input') {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { ok: false, error: 'Missing value for --input' };
      }
      const eq = next.indexOf('=');
      if (eq <= 0) {
        return { ok: false, error: `Invalid --input "${next}" (expected key=value)` };
      }
      const key = next.slice(0, eq);
      if (!INPUT_KEY_RE.test(key)) {
        return { ok: false, error: `Invalid --input key "${key}"` };
      }
      inputs[key] = next.slice(eq + 1);
      i++;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument: ${a}` };
    }
    if (target !== undefined) {
      return { ok: false, error: `Unexpected argument: ${a}` };
    }
    target = a;
  }

  // `--help` 优先：与 update --help 一致，允许没有位置参数。
  if (args.help) return { ok: true, args };

  if (target === undefined || target.trim() === '') {
    return { ok: false, error: 'Missing workflow definition (name or path)' };
  }

  args.workflow = { kind: 'run', target, inputs };
  return { ok: true, args };
}

/** `workflow list [--status <s>] [--limit <n>]` */
function parseWorkflowList(rest: string[], args: CliArgs): ParseResult {
  let status: WorkflowRunStatusArg | undefined;
  let limit: number | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';

    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--status') {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { ok: false, error: 'Missing value for --status' };
      }
      if (!WORKFLOW_STATUSES.has(next)) {
        return {
          ok: false,
          error:
            `Invalid workflow status: ${next} ` +
            '(expected pending|running|completed|failed|cancelled|interrupted)',
        };
      }
      status = next as WorkflowRunStatusArg;
      i++;
      continue;
    }
    if (a === '--limit') {
      const next = rest[i + 1];
      if (next === undefined || !/^\d+$/.test(next)) {
        return { ok: false, error: `Invalid value for --limit: ${next ?? ''}` };
      }
      const parsed = Number.parseInt(next, 10);
      if (parsed < 1 || parsed > MAX_WORKFLOW_LIMIT) {
        return {
          ok: false,
          error: `--limit must be an integer between 1 and ${MAX_WORKFLOW_LIMIT}`,
        };
      }
      limit = parsed;
      i++;
      continue;
    }
    return { ok: false, error: `Unknown argument: ${a}` };
  }

  args.workflow = {
    kind: 'list',
    ...(status !== undefined ? { status } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
  return { ok: true, args };
}

/** `workflow show|resume|cancel <workflowRunId>` */
function parseWorkflowId(
  sub: 'show' | 'resume' | 'cancel',
  rest: string[],
  args: CliArgs,
): ParseResult {
  let workflowRunId: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';

    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument: ${a}` };
    }
    if (workflowRunId !== undefined) {
      return { ok: false, error: `Unexpected argument: ${a}` };
    }
    workflowRunId = a;
  }

  if (args.help) return { ok: true, args };

  if (workflowRunId === undefined || workflowRunId.trim() === '') {
    return { ok: false, error: `Missing workflowRunId for workflow ${sub}` };
  }

  args.workflow = { kind: sub, workflowRunId };
  return { ok: true, args };
}

/** `eval <suite-name-or-path> [--json] [--out <path>] [--filter <tag>]... [--allow-network]` */
function parseEvalArgs(rest: string[], args: CliArgs): ParseResult {
  let target: string | undefined;
  let json = false;
  let out: string | undefined;
  let allowNetwork = false;
  const filters: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';

    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--allow-network') {
      allowNetwork = true;
      continue;
    }
    if (a === '--out') {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-') || next.trim() === '') {
        return { ok: false, error: 'Missing value for --out' };
      }
      out = next;
      i++;
      continue;
    }
    if (a === '--filter') {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-') || next.trim() === '') {
        return { ok: false, error: 'Missing value for --filter' };
      }
      filters.push(next);
      i++;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument: ${a}` };
    }
    if (target !== undefined) {
      return { ok: false, error: `Unexpected argument: ${a}` };
    }
    target = a;
  }

  if (args.help) return { ok: true, args };

  if (target === undefined || target.trim() === '') {
    return { ok: false, error: 'Missing eval suite (name or path)' };
  }

  args.eval = {
    target,
    json,
    ...(out !== undefined ? { out } : {}),
    filters,
    allowNetwork,
  };
  return { ok: true, args };
}
