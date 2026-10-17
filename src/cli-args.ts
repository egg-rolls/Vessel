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
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';

    // `update` 只允许作为第一个参数（子命令），其余位置按未知参数处理。
    if (a === 'update' && i === 0) {
      return parseUpdateArgs(argv.slice(1), args);
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
