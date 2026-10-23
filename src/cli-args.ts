/**
 * CLI 参数解析（纯函数）
 *
 * 从 cli.ts 抽出，便于单测覆盖每个入口。解析只负责语法与互斥，
 * 不加载配置、不构造 runtime、不产生副作用。
 */

import { allowedOriginError } from '../packages/config/src/index';
import { type CompletionCommandArgs, isCompletionShell } from './completion-spec';

/** `--serve` 省略端口时的默认值 */
export const DEFAULT_SERVE_PORT = 8642;

export interface UpdateArgs {
  check: boolean;
  channel?: 'latest' | 'beta';
  json: boolean;
  force: boolean;
  /** 跳过自更新确认（DECISION-023 §2.4） */
  yes: boolean;
}

/** 支持的服务管理器（DECISION-023 §2.2） */
export type GatewayInstallTarget = 'systemd' | 'launchd' | 'schtasks';

/** gateway 实例选择器（0.14；三者互斥，all 单独使用） */
export interface GatewaySelector {
  instance?: string;
  port?: number;
  all?: boolean;
}

/** `vessel gateway` 子命令（DECISION-023 §2.1；0.14 增加多实例） */
export type GatewayCommand =
  | {
      kind: 'start';
      daemon: boolean;
      instance?: string;
      port?: number;
      host?: string;
      log?: string;
    }
  | ({ kind: 'stop'; timeoutMs: number } & GatewaySelector)
  | ({ kind: 'status'; json: boolean; rpc?: boolean } & GatewaySelector)
  | { kind: 'list'; json: boolean }
  | ({ kind: 'restart'; daemon: boolean } & GatewaySelector)
  | ({ kind: 'reload'; scopes?: string[] } & GatewaySelector)
  | { kind: 'install-service'; target?: GatewayInstallTarget }
  | { kind: 'uninstall-service' };

export interface EvalCommand {
  target: string;
  json: boolean;
  out?: string;
  filters: string[];
  allowNetwork: boolean;
}

/** `config` 子命令（0.5；0.11 增加 set） */
export type ConfigCommandArgs =
  | { kind: 'path'; json: boolean }
  | { kind: 'init'; json: boolean; force: boolean }
  | { kind: 'show'; json: boolean; sources: boolean; tenantId?: string }
  | {
      kind: 'set';
      key:
        | 'ui.language'
        | 'ui.showReasoning'
        | 'ui.statusBars'
        | 'ui.verbosity'
        | 'ui.showInternalEvents'
        | 'ui.errorLevel'
        | 'ui.askUser'
        | 'observability.showProcessErrors'
        | 'agent.cwd';
      value: string;
      json: boolean;
    };

/** `tenant` 子命令（0.5） */
export type TenantCommandArgs =
  | { kind: 'list'; json: boolean }
  | { kind: 'get'; id: string; json: boolean }
  | { kind: 'create'; id: string; json: boolean; name?: string }
  | {
      kind: 'update';
      id: string;
      json: boolean;
      name?: string;
      status?: 'active' | 'disabled';
    };

/** `migrate` 子命令（0.5） */
export interface MigrateCommandArgs {
  from: string;
  to: string;
  apply: boolean;
  json: boolean;
  tenantId?: string;
  source?: string;
}

/** `trace` 子命令（0.5） */
export type TraceCommandArgs = {
  kind: 'prune';
  dryRun: boolean;
  json: boolean;
  tenantId?: string;
};

/** `plugin` 子命令（0.6.1；仅本地目录，不做市场） */
export type PluginCommandArgs =
  | { kind: 'list'; json: boolean }
  | { kind: 'install'; path: string; force: boolean }
  | { kind: 'remove'; name: string; yes: boolean };

/** `doctor` 子命令（0.6.1；0.15 增加 --deep） */
export interface DoctorCommandArgs {
  json: boolean;
  /** 仅显式给出 `--deep` 时存在（additive） */
  deep?: boolean;
}

/** `logs` 子命令（0.15） */
export interface LogsCommandArgs {
  kind: 'tail';
  json: boolean;
  lines: number;
  instance?: string;
}

/** 成员可见性（CLI 语法层） */
export type AgentVisibilityArg = 'private' | 'team' | 'tenant';

/** 成员状态（CLI 语法层；与 MemberState 同名同义） */
export type AgentStateArg =
  | 'created'
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'closed'
  | 'stale';

/** `vessel agent ...` 子命令（0.17 Phase A） */
export type AgentCommand =
  | {
      kind: 'new';
      json: boolean;
      name?: string;
      model?: string;
      visibility?: AgentVisibilityArg;
      systemPrompt?: string;
      /** 0.19 S3：显式 workspace → 隐式建 / 复用 Team 并绑定 */
      workspace?: string;
    }
  | { kind: 'send'; json: boolean; member: string; content: string }
  | { kind: 'dispatch'; json: boolean; to: string; content: string }
  | {
      kind: 'rotate';
      json: boolean;
      to: string;
      startupPrompt: string;
      handoffPath?: string;
    }
  | { kind: 'close'; json: boolean; members: string[] }
  | { kind: 'list'; json: boolean; visibility?: AgentVisibilityArg; state?: AgentStateArg };

/** `vessel team ...` 子命令（0.19 S3；owner 私有端点） */
export type TeamCommand =
  | { kind: 'list'; json: boolean }
  | { kind: 'get'; teamId: string; limit?: number; json: boolean }
  | { kind: 'post'; teamId: string; content: string; mentions: string[]; json: boolean }
  | {
      kind: 'members';
      teamId: string;
      action: 'add' | 'remove';
      member: string;
      json: boolean;
    };

/** `vessel hub ...` 子命令（S5） */
export type HubCommand =
  | {
      kind: 'start';
      host?: string;
      port?: number;
      dataDir?: string;
      allowRemote?: boolean;
      tlsCert?: string;
      tlsKey?: string;
    }
  | { kind: 'directory'; hubUrl?: string; tokenEnv?: string; json: boolean }
  | { kind: 'watch'; hubUrl?: string; tokenEnv?: string }
  | { kind: 'pair'; dataDir?: string; tenant?: string; ttl?: number }
  | { kind: 'join-code'; dataDir?: string; tenant?: string; ttl?: number; json: boolean }
  | {
      kind: 'join';
      hubUrl?: string;
      code?: string;
      codeEnv?: string;
      tenant?: string;
      publicUrl?: string;
      caFile?: string;
      dataDir?: string;
      json: boolean;
    }
  | {
      kind: 'node-add';
      url: string;
      code: string;
      alias?: string;
      ca?: string;
      hubUrl?: string;
    }
  | { kind: 'node-list'; hubUrl?: string; json: boolean }
  | { kind: 'node-remove'; pairingId: string; hubUrl?: string }
  | {
      kind: 'token-exchange';
      nodeUrl: string;
      teamId: string;
      ttl?: number;
      adminTokenEnv?: string;
      json: boolean;
    }
  | { kind: 'token-revoke'; nodeUrl: string; tokenId: string; adminTokenEnv?: string }
  | { kind: 'token-list'; nodeUrl: string; adminTokenEnv?: string; json: boolean }
  | {
      kind: 'data-token';
      pairingId: string;
      teamId: string;
      hubUrl?: string;
      tokenEnv?: string;
      ttl?: number;
    };

export interface CliArgs {
  /** `vessel demo`：无 Key 交互演示（mock + tools 场景） */
  demo: boolean;
  /** null = 非 headless；'' = 从 stdin 读；非空 = 文本 prompt 或 @file */
  runArg: string | null;
  /** `--pipe` 隐藏别名，等价 `--run` 无参 */
  pipeMode: boolean;
  sessionArg: string | null;
  /** 0.6.1：`-c/--continue`（续接最近会话） */
  continueArg: boolean;
  /** 0.6.1：null = 未使用；'' = 列出会话；非空 = 恢复该会话 */
  resumeArg: string | null;
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
  /** `vessel eval ...` 子命令 */
  eval: EvalCommand | null;
  /** 0.4：附加开关；只与 run/pipe/resume/tools/version/help 互斥 */
  feishu: boolean;
  /** 0.5：全局 `--tenant <id>`；null = 未指定 */
  tenantArg: string | null;
  /** 0.5：`--connect <url>`（或 VESSEL_CONNECT，由 cli 合并） */
  connectArg: string | null;
  /** 0.6：`--connect-token <token>`（最高优先级；不回显） */
  connectTokenArg: string | null;
  /** 0.6：`--ca <path>`（自签/私有 CA，PEM） */
  caArg: string | null;
  /** 0.6：`--allowed-origin <origin>`（可重复；需 --serve） */
  allowedOrigins: string[];
  /** 0.5 一次性本地命令 */
  configCommand: ConfigCommandArgs | null;
  tenantCommand: TenantCommandArgs | null;
  migrate: MigrateCommandArgs | null;
  trace: TraceCommandArgs | null;
  /** 0.6.1：`vessel plugin ...` */
  pluginCommand: PluginCommandArgs | null;
  /** 0.6.1：`vessel doctor` */
  doctorCommand: DoctorCommandArgs | null;
  /** 0.15：`vessel logs tail` */
  logsCommand: LogsCommandArgs | null;
  /** 0.15：全局 `--data-dir <path>`；null = 未指定 */
  dataDirArg: string | null;
  /** 0.15：全局 `--exclusive` 强制 tenant 单写者锁 */
  exclusive: boolean;
  /** 0.12：`vessel gateway ...` */
  gateway: GatewayCommand | null;
  /** 0.14：`vessel status [--json]` */
  statusCommand: { json: boolean } | null;
  /** 0.14：`vessel agents [--json]` */
  agentsCommand: { json: boolean } | null;
  /** 0.17：`vessel agent new|send|close|list|dispatch|rotate` */
  agentCommand: AgentCommand | null;
  /** 0.19 S3：`vessel team list|get|post|members` */
  teamCommand: TeamCommand | null;
  /** S5：`vessel hub ...`；缺省 null（可选以兼容既有 parseArgs 快照测试） */
  hubCommand?: HubCommand | null;
  /** 0.14：`vessel errors [--json] [--limit N]` */
  errorsCommand: { json: boolean; limit?: number } | null;
  /** 0.18：`vessel completion <bash|zsh|fish|powershell>` */
  completionCommand: CompletionCommandArgs | null;
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
    demo: false,
    runArg: null,
    pipeMode: false,
    sessionArg: null,
    continueArg: false,
    resumeArg: null,
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
    eval: null,
    feishu: false,
    tenantArg: null,
    connectArg: null,
    connectTokenArg: null,
    caArg: null,
    allowedOrigins: [],
    configCommand: null,
    tenantCommand: null,
    migrate: null,
    trace: null,
    pluginCommand: null,
    doctorCommand: null,
    logsCommand: null,
    dataDirArg: null,
    exclusive: false,
    gateway: null,
    statusCommand: null,
    agentsCommand: null,
    agentCommand: null,
    teamCommand: null,
    errorsCommand: null,
    completionCommand: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';

    // `update` / `eval` / `config` / `tenant` / `migrate` / `trace`
    // 只允许作为第一个参数（子命令），其余位置按未知参数处理。
    if (a === 'update' && i === 0) {
      return parseUpdateArgs(argv.slice(1), args);
    }
    if (a === 'eval' && i === 0) {
      return parseEvalArgs(argv.slice(1), args);
    }
    if (a === 'config' && i === 0) {
      return parseConfigArgs(argv.slice(1), args);
    }
    if (a === 'tenant' && i === 0) {
      return parseTenantArgs(argv.slice(1), args);
    }
    if (a === 'migrate' && i === 0) {
      return parseMigrateArgs(argv.slice(1), args);
    }
    if (a === 'trace' && i === 0) {
      return parseTraceArgs(argv.slice(1), args);
    }
    if (a === 'plugin' && i === 0) {
      return parsePluginArgs(argv.slice(1), args);
    }
    if (a === 'doctor' && i === 0) {
      return parseDoctorArgs(argv.slice(1), args);
    }
    if (a === 'logs' && i === 0) {
      return parseLogsArgs(argv.slice(1), args);
    }
    if (a === 'gateway' && i === 0) {
      return parseGatewayArgs(argv.slice(1), args);
    }
    if (a === 'status' && i === 0) {
      return parseStatusArgs(argv.slice(1), args);
    }
    if (a === 'agents' && i === 0) {
      return parseAgentsArgs(argv.slice(1), args);
    }
    if (a === 'agent' && i === 0) {
      return parseAgentArgs(argv.slice(1), args);
    }
    if (a === 'team' && i === 0) {
      return parseTeamArgs(argv.slice(1), args);
    }
    if (a === 'hub' && i === 0) {
      return parseHubArgs(argv.slice(1), args);
    }
    if (a === 'errors' && i === 0) {
      return parseErrorsArgs(argv.slice(1), args);
    }
    if (a === 'demo' && i === 0) {
      return parseDemoArgs(argv.slice(1), args);
    }
    if (a === 'completion' && i === 0) {
      return parseCompletionArgs(argv.slice(1), args);
    }

    switch (a) {
      case '--run':
      case '--print':
      case '-p': {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          args.runArg = next;
          i++;
        } else {
          args.runArg = '';
        }
        break;
      }
      case '-c':
      case '--continue':
        args.continueArg = true;
        break;
      case '-r':
      case '--resume': {
        // 0.6.1：`-r` 是 resume（不再等同 --run）；无 id = 列出会话。
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          args.resumeArg = next;
          i++;
        } else {
          args.resumeArg = '';
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
      case '--tenant': {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: 'Missing value for --tenant' };
        }
        args.tenantArg = next;
        i++;
        break;
      }
      case '--data-dir': {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: 'Missing value for --data-dir' };
        }
        args.dataDirArg = next;
        i++;
        break;
      }
      case '--exclusive':
        args.exclusive = true;
        break;
      case '--connect': {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: 'Missing value for --connect' };
        }
        args.connectArg = next;
        i++;
        break;
      }
      case '--connect-token': {
        const next = argv[i + 1];
        if (next === undefined || next.trim() === '') {
          return { ok: false, error: 'Missing value for --connect-token' };
        }
        args.connectTokenArg = next;
        i++;
        break;
      }
      case '--ca':
      case '--connect-ca': {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: `Missing value for ${a}` };
        }
        args.caArg = next;
        i++;
        break;
      }
      case '--allowed-origin': {
        const next = argv[i + 1];
        if (next === undefined || next.trim() === '') {
          return { ok: false, error: 'Missing value for --allowed-origin' };
        }
        const message = allowedOriginError(next);
        if (message !== null) {
          return { ok: false, error: `Invalid --allowed-origin: ${message}` };
        }
        args.allowedOrigins.push(next);
        i++;
        break;
      }
      default:
        return { ok: false, error: `Unknown argument: ${a}` };
    }
  }

  // 0.5：全局 --tenant 与 --help / --version 同用是用法错误。
  if (args.tenantArg !== null && (args.help || args.version)) {
    return { ok: false, error: '--tenant cannot be combined with --help/--version' };
  }
  // 0.5：客户端模式与服务端模式互斥。
  if (args.connectArg !== null && args.servePort !== null) {
    return { ok: false, error: '--connect cannot be combined with --serve' };
  }
  // 0.6：connect 专属参数只能用于连接（--connect 或 VESSEL_CONNECT）。
  const connectOnly = [
    args.connectTokenArg !== null ? '--connect-token' : null,
    args.caArg !== null ? '--ca' : null,
  ].filter((v): v is string => v !== null);
  if (
    connectOnly.length > 0 &&
    args.connectArg === null &&
    (process.env.VESSEL_CONNECT ?? '').trim() === ''
  ) {
    return { ok: false, error: `${connectOnly[0]} requires --connect` };
  }
  // 0.6：Origin allowlist 只服务 --serve。
  if (args.allowedOrigins.length > 0 && args.servePort === null) {
    return { ok: false, error: '--allowed-origin requires --serve' };
  }

  // --resume-run 是独立模式：不能与其它输入/服务/一次性命令组合（Addendum A §6）。
  if (args.resumeRunArg !== null) {
    const conflicts = [
      args.runArg !== null ? '--run' : null,
      args.pipeMode ? '--pipe' : null,
      args.servePort !== null ? '--serve' : null,
      args.sessionArg !== null ? '--session' : null,
      args.continueArg ? '--continue' : null,
      args.resumeArg !== null ? '--resume' : null,
      args.tools ? '--tools' : null,
    ].filter((v): v is string => v !== null);
    if (conflicts.length > 0) {
      return { ok: false, error: `--resume-run cannot be combined with ${conflicts.join('/')}` };
    }
  }

  // 0.6.1：会话续接 flag 互斥
  if (args.continueArg && args.resumeArg !== null) {
    return { ok: false, error: '--continue cannot be combined with --resume' };
  }
  if (args.continueArg && args.sessionArg !== null) {
    return { ok: false, error: '--continue cannot be combined with --session' };
  }
  if (args.resumeArg !== null && args.sessionArg !== null) {
    return { ok: false, error: '--resume cannot be combined with --session' };
  }
  if ((args.continueArg || args.resumeArg !== null) && args.servePort !== null) {
    return { ok: false, error: '--continue/--resume cannot be combined with --serve' };
  }
  if (args.continueArg && args.pipeMode) {
    return { ok: false, error: '--continue cannot be combined with --pipe' };
  }
  // `-r` 无 id = 列出会话：不能再要求一次 run 输入，也不能带会被忽略的模式开关。
  if (args.resumeArg === '') {
    if (args.runArg !== null) {
      return { ok: false, error: '--resume without an id cannot be combined with --run' };
    }
    if (args.pipeMode) {
      return { ok: false, error: '--resume without an id cannot be combined with --pipe' };
    }
    if (args.feishu) {
      return { ok: false, error: '--resume without an id cannot be combined with --feishu' };
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
  if (
    oneShot.length === 1 &&
    (args.runArg !== null ||
      args.pipeMode ||
      args.servePort !== null ||
      args.continueArg ||
      args.resumeArg !== null)
  ) {
    return { ok: false, error: `${oneShot[0]} cannot be combined with --run/--serve/--continue` };
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
  const update: UpdateArgs = { check: false, json: false, force: false, yes: false };

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
      case '--yes':
      case '-y':
        update.yes = true;
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

// ── 0.4 eval 子命令 ───────────────────

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

// ── 0.5 config / tenant / migrate / trace 子命令 ───────────────

/** 读取 `--tenant <id>`；非法时返回错误文本 */
function readTenantFlag(
  rest: string[],
  index: number,
): { ok: true; value: string; next: number } | { ok: false; error: string } {
  const next = rest[index + 1];
  if (next === undefined || next.startsWith('-') || next.trim() === '') {
    return { ok: false, error: 'Missing value for --tenant' };
  }
  return { ok: true, value: next, next: index + 1 };
}

/** `config path|init|show` */
function parseConfigArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h' || sub === undefined) {
    if (sub === undefined)
      return { ok: false, error: 'Missing config subcommand (path|init|show)' };
    args.help = true;
    return { ok: true, args };
  }

  const tail = rest.slice(1);
  let json = false;
  let force = false;
  let sources = false;
  let tenantId: string | undefined;

  // 0.11/0.11.1：`config set <key> <value> [--json]`
  if (sub === 'set') {
    const positional: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for config set: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    if (positional.length !== 2) {
      return {
        ok: false,
        error:
          'Usage: vessel config set <ui.language|ui.showReasoning|ui.statusBars|ui.verbosity|ui.showInternalEvents|ui.errorLevel|ui.askUser|observability.showProcessErrors|agent.cwd> <value> [--json]',
      };
    }
    const [key = '', value = ''] = positional;
    if (
      key !== 'ui.language' &&
      key !== 'ui.showReasoning' &&
      key !== 'ui.statusBars' &&
      key !== 'ui.verbosity' &&
      key !== 'ui.showInternalEvents' &&
      key !== 'ui.errorLevel' &&
      key !== 'ui.askUser' &&
      key !== 'observability.showProcessErrors' &&
      key !== 'agent.cwd'
    ) {
      return {
        ok: false,
        error:
          `Unsupported config key: ${key} (supported: ui.language, ui.showReasoning, ` +
          'ui.statusBars, ui.verbosity, ui.showInternalEvents, ui.errorLevel, ui.askUser, ' +
          'observability.showProcessErrors, agent.cwd)',
      };
    }
    if (key === 'ui.language' && value !== 'zh-CN' && value !== 'en') {
      return { ok: false, error: 'ui.language must be "zh-CN" or "en"' };
    }
    if (key === 'ui.showReasoning' && value !== 'true' && value !== 'false') {
      return { ok: false, error: 'ui.showReasoning must be "true" or "false"' };
    }
    if (key === 'ui.statusBars' && !['top', 'bottom', 'both', 'none'].includes(value)) {
      return { ok: false, error: 'ui.statusBars must be "top", "bottom", "both" or "none"' };
    }
    if (key === 'ui.verbosity' && !['minimal', 'normal', 'debug'].includes(value)) {
      return { ok: false, error: 'ui.verbosity must be "minimal", "normal" or "debug"' };
    }
    if (
      (key === 'ui.showInternalEvents' ||
        key === 'ui.askUser' ||
        key === 'observability.showProcessErrors') &&
      value !== 'true' &&
      value !== 'false'
    ) {
      return { ok: false, error: `${key} must be "true" or "false"` };
    }
    if (key === 'ui.errorLevel' && value !== 'user' && value !== 'all') {
      return { ok: false, error: 'ui.errorLevel must be "user" or "all"' };
    }
    if (key === 'agent.cwd' && value.trim() === '') {
      return { ok: false, error: 'agent.cwd must be a non-empty path' };
    }
    args.configCommand = { kind: 'set', key, value, json };
    return { ok: true, args };
  }

  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--tenant' && sub === 'show') {
      const parsedTenant = readTenantFlag(tail, i);
      if (!parsedTenant.ok) return parsedTenant;
      tenantId = parsedTenant.value;
      i = parsedTenant.next;
      continue;
    }
    if (a === '--force' && sub === 'init') {
      force = true;
      continue;
    }
    if (a === '--sources' && sub === 'show') {
      sources = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for config ${sub}: ${a}` };
  }

  if (args.help) return { ok: true, args };

  if (sub === 'path') {
    if (force || sources || tenantId !== undefined) {
      return { ok: false, error: 'config path only supports --json' };
    }
    args.configCommand = { kind: 'path', json };
    return { ok: true, args };
  }
  if (sub === 'init') {
    if (sources || tenantId !== undefined) {
      return { ok: false, error: 'config init only supports --force and --json' };
    }
    args.configCommand = { kind: 'init', json, force };
    return { ok: true, args };
  }
  if (sub === 'show') {
    if (force) return { ok: false, error: 'config show does not support --force' };
    args.configCommand = {
      kind: 'show',
      json,
      sources,
      ...(tenantId !== undefined ? { tenantId } : {}),
    };
    return { ok: true, args };
  }
  return { ok: false, error: `Unknown config subcommand: ${sub}` };
}

const TENANT_STATUSES: ReadonlySet<string> = new Set(['active', 'disabled']);

/** `tenant list|get|create|update` */
function parseTenantArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return { ok: false, error: 'Missing tenant subcommand (list|get|create|update)' };
  }

  const tail = rest.slice(1);
  let json = false;
  let name: string | undefined;
  let status: 'active' | 'disabled' | undefined;
  let id: string | undefined;

  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--name' && (sub === 'create' || sub === 'update')) {
      const next = tail[i + 1];
      if (next === undefined || next.startsWith('-') || next.trim() === '') {
        return { ok: false, error: 'Missing value for --name' };
      }
      name = next;
      i++;
      continue;
    }
    if (a === '--status' && sub === 'update') {
      const next = tail[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { ok: false, error: 'Missing value for --status' };
      }
      if (!TENANT_STATUSES.has(next)) {
        return { ok: false, error: 'Invalid tenant status (expected active|disabled)' };
      }
      status = next as 'active' | 'disabled';
      i++;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for tenant ${sub}: ${a}` };
    }
    if (id !== undefined) return { ok: false, error: `Unexpected argument: ${a}` };
    id = a;
  }

  if (args.help) return { ok: true, args };

  if (sub === 'list') {
    if (id !== undefined || name !== undefined || status !== undefined) {
      return { ok: false, error: 'tenant list only supports --json' };
    }
    args.tenantCommand = { kind: 'list', json };
    return { ok: true, args };
  }
  if (sub !== 'get' && sub !== 'create' && sub !== 'update') {
    return { ok: false, error: `Unknown tenant subcommand: ${sub}` };
  }
  if (id === undefined || id.trim() === '') {
    return { ok: false, error: `Missing tenant id for tenant ${sub}` };
  }
  if (sub === 'get') {
    if (name !== undefined || status !== undefined) {
      return { ok: false, error: 'tenant get only supports --json' };
    }
    args.tenantCommand = { kind: 'get', id, json };
    return { ok: true, args };
  }
  if (sub === 'create') {
    if (status !== undefined)
      return { ok: false, error: 'tenant create does not support --status' };
    args.tenantCommand = { kind: 'create', id, json, ...(name !== undefined ? { name } : {}) };
    return { ok: true, args };
  }
  args.tenantCommand = {
    kind: 'update',
    id,
    json,
    ...(name !== undefined ? { name } : {}),
    ...(status !== undefined ? { status } : {}),
  };
  return { ok: true, args };
}

/** `migrate --from sqlite|file-v1 --to file-v2 [--apply] [--tenant <id>] [--source <path>]` */
function parseMigrateArgs(rest: string[], args: CliArgs): ParseResult {
  let from: string | undefined;
  let to: string | undefined;
  let apply = false;
  let json = false;
  let tenantId: string | undefined;
  let source: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--apply') {
      apply = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--from' || a === '--to' || a === '--source' || a === '--tenant') {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-') || next.trim() === '') {
        return { ok: false, error: `Missing value for ${a}` };
      }
      if (a === '--from') from = next;
      else if (a === '--to') to = next;
      else if (a === '--source') source = next;
      else tenantId = next;
      i++;
      continue;
    }
    return { ok: false, error: `Unknown argument for migrate: ${a}` };
  }

  if (args.help) return { ok: true, args };
  if (from === undefined) return { ok: false, error: 'migrate requires --from sqlite|file-v1' };
  if (to === undefined) return { ok: false, error: 'migrate requires --to file-v2' };

  args.migrate = {
    from,
    to,
    apply,
    json,
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(source !== undefined ? { source } : {}),
  };
  return { ok: true, args };
}

/** `trace prune [--dry-run] [--json] [--tenant <id>]` */
function parseTraceArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) return { ok: false, error: 'Missing trace subcommand (prune)' };
  if (sub !== 'prune') return { ok: false, error: `Unknown trace subcommand: ${sub}` };

  let dryRun = false;
  let json = false;
  let tenantId: string | undefined;

  const tail = rest.slice(1);
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--tenant') {
      const parsedTenant = readTenantFlag(tail, i);
      if (!parsedTenant.ok) return parsedTenant;
      tenantId = parsedTenant.value;
      i = parsedTenant.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for trace prune: ${a}` };
  }

  if (args.help) return { ok: true, args };

  args.trace = {
    kind: 'prune',
    dryRun,
    json,
    ...(tenantId !== undefined ? { tenantId } : {}),
  };
  return { ok: true, args };
}

/** 插件短名：防止 `remove` 越出用户插件目录 */
export const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `plugin list [--json] | install <path> [--force] | remove <name> [--yes]` */
function parsePluginArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return { ok: false, error: 'Missing plugin subcommand (list|install|remove)' };
  }

  if (sub === 'list') {
    let json = false;
    for (const a of rest.slice(1)) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      return { ok: false, error: `Unknown argument for plugin list: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.pluginCommand = { kind: 'list', json };
    return { ok: true, args };
  }

  if (sub === 'install') {
    let source: string | undefined;
    let force = false;
    const tail = rest.slice(1);
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--force') {
        force = true;
        continue;
      }
      if (a.startsWith('-'))
        return { ok: false, error: `Unknown argument for plugin install: ${a}` };
      if (source !== undefined) {
        return { ok: false, error: `Unexpected extra argument for plugin install: ${a}` };
      }
      source = a;
    }
    if (args.help) return { ok: true, args };
    if (source === undefined) return { ok: false, error: 'Missing <path> for plugin install' };
    args.pluginCommand = { kind: 'install', path: source, force };
    return { ok: true, args };
  }

  if (sub === 'remove') {
    let name: string | undefined;
    let yes = false;
    const tail = rest.slice(1);
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--yes' || a === '-y') {
        yes = true;
        continue;
      }
      if (a.startsWith('-'))
        return { ok: false, error: `Unknown argument for plugin remove: ${a}` };
      if (name !== undefined) {
        return { ok: false, error: `Unexpected extra argument for plugin remove: ${a}` };
      }
      name = a;
    }
    if (args.help) return { ok: true, args };
    if (name === undefined) return { ok: false, error: 'Missing <name> for plugin remove' };
    if (!PLUGIN_NAME_RE.test(name)) {
      return { ok: false, error: `Invalid plugin name: ${name}` };
    }
    args.pluginCommand = { kind: 'remove', name, yes };
    return { ok: true, args };
  }

  return { ok: false, error: `Unknown plugin subcommand: ${sub}` };
}

/**
 * `completion <bash|zsh|fish|powershell>`（0.18）。
 * 无参数 / 未知 shell 不在这里报解析错误：交给命令打印用法并 exit 1。
 */
function parseCompletionArgs(rest: string[], args: CliArgs): ParseResult {
  if (rest[0] === '--help' || rest[0] === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (rest.length > 1) {
    return { ok: false, error: `Unexpected argument for completion: ${rest[1]}` };
  }
  const requested = rest[0];
  if (requested === undefined) {
    args.completionCommand = { shell: null, requested: null };
    return { ok: true, args };
  }
  args.completionCommand = {
    shell: isCompletionShell(requested) ? requested : null,
    requested,
  };
  return { ok: true, args };
}

/** `demo`：无参数（`--help` 由顶层处理） */
function parseDemoArgs(rest: string[], args: CliArgs): ParseResult {
  for (const a of rest) {
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for demo: ${a}` };
  }
  if (!args.help) args.demo = true;
  return { ok: true, args };
}

// ── 0.12 gateway 子命令（DECISION-023 §2.1）─────────────

/** `gateway stop` 缺省等待时长 */
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const MAX_STOP_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** 解析 `10s` / `500ms` / `1m`（裸数字按秒）；非法返回 null */
export function parseTimeoutMs(raw: string): number | null {
  const match = /^(\d+)(ms|s|m)?$/.exec(raw.trim());
  if (!match) return null;
  const amount = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2] ?? 's';
  const ms = unit === 'ms' ? amount : unit === 's' ? amount * 1000 : amount * 60_000;
  if (ms < 100 || ms > MAX_STOP_TIMEOUT_MS) return null;
  return ms;
}

const GATEWAY_TARGETS: ReadonlySet<string> = new Set(['systemd', 'launchd', 'schtasks']);
const RELOAD_SCOPE_RE = /^[a-z][a-z0-9_-]*$/;

/** 逗号分隔的 reload scope；非法返回 null */
function parseReloadScopes(raw: string): string[] | null {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return null;
  return parts.every((part) => RELOAD_SCOPE_RE.test(part)) ? parts : null;
}

/** 读取 flag 的值（拒绝缺失/空/下一个 flag） */
function readFlagValue(
  rest: string[],
  index: number,
  flag: string,
): { ok: true; value: string; next: number } | { ok: false; error: string } {
  const next = rest[index + 1];
  if (next === undefined || next.startsWith('-') || next.trim() === '') {
    return { ok: false, error: `Missing value for ${flag}` };
  }
  return { ok: true, value: next, next: index + 1 };
}

/** gateway 实例名（与 gateway/pid 的校验一致；解析层只做语法） */
const GATEWAY_INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function parseInstanceName(raw: string): string | null {
  return GATEWAY_INSTANCE_RE.test(raw) ? raw : null;
}

/**
 * 解析 stop/status/restart/reload 的选择器 flags。
 * `matched=false` 表示当前 token 不是选择器，交给调用方继续处理。
 */
function parseGatewaySelectorArg(
  rest: string[],
  index: number,
  selector: GatewaySelector,
  command: string,
): { ok: true; next: number; matched: boolean } | { ok: false; error: string } {
  const a = rest[index] ?? '';
  if (a === '--all') {
    selector.all = true;
    return { ok: true, next: index, matched: true };
  }
  if (a === '--instance') {
    const value = readFlagValue(rest, index, '--instance');
    if (!value.ok) return value;
    const instance = parseInstanceName(value.value);
    if (instance === null) {
      return {
        ok: false,
        error: `Invalid --instance: ${value.value} (expected ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$)`,
      };
    }
    selector.instance = instance;
    return { ok: true, next: value.next, matched: true };
  }
  if (a === '--port') {
    const value = readFlagValue(rest, index, '--port');
    if (!value.ok) return value;
    const port = parsePort(value.value);
    if (port === null || port === 0) {
      return {
        ok: false,
        error: `Invalid --port for gateway ${command}: ${value.value} (1-65535)`,
      };
    }
    selector.port = port;
    return { ok: true, next: value.next, matched: true };
  }
  return { ok: true, next: index, matched: false };
}

/** 选择器互斥检查；通过返回 null */
function gatewaySelectorError(selector: GatewaySelector, command: string): string | null {
  const selected = [
    selector.instance !== undefined,
    selector.port !== undefined,
    selector.all === true,
  ];
  if (selected.filter(Boolean).length > 1) {
    return `gateway ${command} accepts only one of --instance, --port, --all`;
  }
  return null;
}

/** `gateway start [--port N] [--host H] [--daemon] [--log <path>]` */
function parseGatewayStart(rest: string[], args: CliArgs): ParseResult {
  const command: Extract<GatewayCommand, { kind: 'start' }> = { kind: 'start', daemon: false };

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--daemon') {
      command.daemon = true;
      continue;
    }
    if (a === '--exclusive') {
      // 0.15：daemon 父进程把全局 flag 透传给子进程。
      args.exclusive = true;
      continue;
    }
    if (a === '--instance') {
      const value = readFlagValue(rest, i, '--instance');
      if (!value.ok) return value;
      const instance = parseInstanceName(value.value);
      if (instance === null) {
        return {
          ok: false,
          error: `Invalid --instance: ${value.value} (expected ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$)`,
        };
      }
      command.instance = instance;
      i = value.next;
      continue;
    }
    if (a === '--port') {
      const value = readFlagValue(rest, i, '--port');
      if (!value.ok) return value;
      const port = parsePort(value.value);
      if (port === null) return { ok: false, error: `Invalid port for --port: ${value.value}` };
      command.port = port;
      i = value.next;
      continue;
    }
    if (a === '--host') {
      const value = readFlagValue(rest, i, '--host');
      if (!value.ok) return value;
      command.host = value.value;
      i = value.next;
      continue;
    }
    if (a === '--log') {
      const value = readFlagValue(rest, i, '--log');
      if (!value.ok) return value;
      command.log = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway start: ${a}` };
  }

  if (args.help) return { ok: true, args };
  if (command.port === 0 && command.instance === undefined) {
    return { ok: false, error: 'gateway start --port 0 requires --instance <name>' };
  }
  args.gateway = command;
  return { ok: true, args };
}

/** `gateway stop [--timeout 10s] [--instance N|--port N|--all]` */
function parseGatewayStop(rest: string[], args: CliArgs): ParseResult {
  let timeoutMs = DEFAULT_STOP_TIMEOUT_MS;
  const selector: GatewaySelector = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--timeout') {
      const value = readFlagValue(rest, i, '--timeout');
      if (!value.ok) return value;
      const parsed = parseTimeoutMs(value.value);
      if (parsed === null) {
        return { ok: false, error: `Invalid --timeout: ${value.value} (expected e.g. 10s)` };
      }
      timeoutMs = parsed;
      i = value.next;
      continue;
    }
    const selected = parseGatewaySelectorArg(rest, i, selector, 'stop');
    if (!selected.ok) return selected;
    if (selected.matched) {
      i = selected.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway stop: ${a}` };
  }
  if (args.help) return { ok: true, args };
  const selectorError = gatewaySelectorError(selector, 'stop');
  if (selectorError !== null) return { ok: false, error: selectorError };
  args.gateway = { kind: 'stop', timeoutMs, ...selector };
  return { ok: true, args };
}

/** `gateway status [--json] [--instance N|--port N|--all]` */
function parseGatewayStatus(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  let rpc = false;
  const selector: GatewaySelector = {};
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
    if (a === '--rpc') {
      rpc = true;
      continue;
    }
    const selected = parseGatewaySelectorArg(rest, i, selector, 'status');
    if (!selected.ok) return selected;
    if (selected.matched) {
      i = selected.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway status: ${a}` };
  }
  if (args.help) return { ok: true, args };
  const selectorError = gatewaySelectorError(selector, 'status');
  if (selectorError !== null) return { ok: false, error: selectorError };
  args.gateway = { kind: 'status', json, ...(rpc ? { rpc: true } : {}), ...selector };
  return { ok: true, args };
}

/** `gateway list [--json]` */
function parseGatewayList(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  for (const a of rest) {
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway list: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.gateway = { kind: 'list', json };
  return { ok: true, args };
}

/** `gateway restart [--daemon] [--instance N|--port N|--all]` */
function parseGatewayRestart(rest: string[], args: CliArgs): ParseResult {
  let daemon = false;
  const selector: GatewaySelector = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--daemon') {
      daemon = true;
      continue;
    }
    const selected = parseGatewaySelectorArg(rest, i, selector, 'restart');
    if (!selected.ok) return selected;
    if (selected.matched) {
      i = selected.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway restart: ${a}` };
  }
  if (args.help) return { ok: true, args };
  const selectorError = gatewaySelectorError(selector, 'restart');
  if (selectorError !== null) return { ok: false, error: selectorError };
  if (selector.all === true && !daemon) {
    return { ok: false, error: 'gateway restart --all requires --daemon' };
  }
  args.gateway = { kind: 'restart', daemon, ...selector };
  return { ok: true, args };
}

/** `gateway reload [--scope config,plugins] [--instance N|--port N|--all]` */
function parseGatewayReload(rest: string[], args: CliArgs): ParseResult {
  let scopes: string[] | undefined;
  const selector: GatewaySelector = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--scope') {
      const value = readFlagValue(rest, i, '--scope');
      if (!value.ok) return value;
      const parsed = parseReloadScopes(value.value);
      if (parsed === null) {
        return {
          ok: false,
          error: `Invalid --scope: ${value.value} (expected e.g. config,plugins)`,
        };
      }
      scopes = [...new Set([...(scopes ?? []), ...parsed])];
      i = value.next;
      continue;
    }
    const selected = parseGatewaySelectorArg(rest, i, selector, 'reload');
    if (!selected.ok) return selected;
    if (selected.matched) {
      i = selected.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway reload: ${a}` };
  }
  if (args.help) return { ok: true, args };
  const selectorError = gatewaySelectorError(selector, 'reload');
  if (selectorError !== null) return { ok: false, error: selectorError };
  args.gateway = {
    kind: 'reload',
    ...(scopes !== undefined ? { scopes } : {}),
    ...selector,
  };
  return { ok: true, args };
}

/** `gateway install-service [--systemd|--launchd|--schtasks]` */
function parseGatewayInstallService(rest: string[], args: CliArgs): ParseResult {
  let target: GatewayInstallTarget | undefined;
  for (const a of rest) {
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a.startsWith('--') && GATEWAY_TARGETS.has(a.slice(2))) {
      const requested = a.slice(2) as GatewayInstallTarget;
      if (target !== undefined && target !== requested) {
        return { ok: false, error: 'gateway install-service accepts one platform flag' };
      }
      target = requested;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway install-service: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.gateway = { kind: 'install-service', ...(target !== undefined ? { target } : {}) };
  return { ok: true, args };
}

/** `gateway uninstall-service` */
function parseGatewayUninstallService(rest: string[], args: CliArgs): ParseResult {
  for (const a of rest) {
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway uninstall-service: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.gateway = { kind: 'uninstall-service' };
  return { ok: true, args };
}

/** `gateway <subcommand>` 分发 */
function parseGatewayArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return {
      ok: false,
      error:
        'Missing gateway subcommand ' +
        '(start|stop|status|list|restart|reload|install-service|uninstall-service)',
    };
  }

  const tail = rest.slice(1);
  switch (sub) {
    case 'start':
      return parseGatewayStart(tail, args);
    case 'stop':
      return parseGatewayStop(tail, args);
    case 'status':
      return parseGatewayStatus(tail, args);
    case 'list':
      return parseGatewayList(tail, args);
    case 'restart':
      return parseGatewayRestart(tail, args);
    case 'reload':
      return parseGatewayReload(tail, args);
    case 'install-service':
      return parseGatewayInstallService(tail, args);
    case 'uninstall-service':
      return parseGatewayUninstallService(tail, args);
    default:
      return { ok: false, error: `Unknown gateway subcommand: ${sub}` };
  }
}

// ── 0.14 status / agents / errors ─────────────────────

/** `status [--json]` */
function parseStatusArgs(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  for (const a of rest) {
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for status: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.statusCommand = { json };
  return { ok: true, args };
}

/** `agents [--json]` */
function parseAgentsArgs(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  for (const a of rest) {
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for agents: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.agentsCommand = { json };
  return { ok: true, args };
}

/** `agent new|send|close|list|dispatch|rotate`（0.17 Phase A；0.19 dispatch / rotate） */
function parseAgentArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  const tail = rest.slice(1);

  if (sub === 'new') {
    let json = false;
    let name: string | undefined;
    let model: string | undefined;
    let visibility: AgentVisibilityArg | undefined;
    let systemPrompt: string | undefined;
    let workspace: string | undefined;
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (
        a === '--name' ||
        a === '--model' ||
        a === '--visibility' ||
        a === '--system-prompt' ||
        a === '--workspace'
      ) {
        const value = readFlagValue(tail, i, a);
        if (!value.ok) return value;
        if (value.value === '') return { ok: false, error: `Invalid ${a}: empty value` };
        if (a === '--name') name = value.value;
        else if (a === '--model') model = value.value;
        else if (a === '--system-prompt') systemPrompt = value.value;
        else if (a === '--workspace') workspace = value.value;
        else {
          if (value.value !== 'private' && value.value !== 'team' && value.value !== 'tenant') {
            return {
              ok: false,
              error: `Invalid --visibility: ${value.value} (expected private|team|tenant)`,
            };
          }
          visibility = value.value;
        }
        i = value.next;
        continue;
      }
      return { ok: false, error: `Unknown argument for agent new: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.agentCommand = {
      kind: 'new',
      json,
      ...(name !== undefined ? { name } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    };
    return { ok: true, args };
  }

  if (sub === 'send') {
    let json = false;
    const positional: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [member, ...contentParts] = positional;
    if (member === undefined || member === '') {
      return { ok: false, error: 'agent send requires <member> <content...>' };
    }
    const content = contentParts.join(' ');
    if (content === '') {
      return { ok: false, error: 'agent send requires non-empty <content...>' };
    }
    args.agentCommand = { kind: 'send', json, member, content };
    return { ok: true, args };
  }

  if (sub === 'dispatch') {
    let json = false;
    const positional: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for agent dispatch: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [to, ...contentParts] = positional;
    const content = contentParts.join(' ');
    if (to === undefined || to === '' || content === '') {
      return { ok: false, error: 'agent dispatch requires <to> <content...>' };
    }
    args.agentCommand = { kind: 'dispatch', json, to, content };
    return { ok: true, args };
  }

  if (sub === 'rotate') {
    let json = false;
    let startupPrompt: string | undefined;
    let handoffPath: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--startup' || a === '--handoff') {
        const value = readFlagValue(tail, i, a);
        if (!value.ok) return value;
        if (a === '--startup') startupPrompt = value.value;
        else handoffPath = value.value;
        i = value.next;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for agent rotate: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [to, extra] = positional;
    if (to === undefined || to === '') {
      return { ok: false, error: 'agent rotate requires <to>' };
    }
    if (extra !== undefined) {
      return { ok: false, error: `Unknown argument for agent rotate: ${extra}` };
    }
    if (startupPrompt === undefined || startupPrompt === '') {
      return { ok: false, error: 'agent rotate requires non-empty --startup <text>' };
    }
    args.agentCommand = {
      kind: 'rotate',
      json,
      to,
      startupPrompt,
      ...(handoffPath !== undefined ? { handoffPath } : {}),
    };
    return { ok: true, args };
  }

  if (sub === 'close') {
    let json = false;
    const members: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for agent close: ${a}` };
      }
      if (a !== '') members.push(a);
    }
    if (args.help) return { ok: true, args };
    if (members.length === 0) {
      return { ok: false, error: 'agent close requires at least one <member>' };
    }
    args.agentCommand = { kind: 'close', json, members };
    return { ok: true, args };
  }

  if (sub === 'list') {
    let json = false;
    let visibility: AgentVisibilityArg | undefined;
    let state: AgentStateArg | undefined;
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--visibility' || a === '--state') {
        const value = readFlagValue(tail, i, a);
        if (!value.ok) return value;
        if (a === '--visibility') {
          if (value.value !== 'private' && value.value !== 'team' && value.value !== 'tenant') {
            return {
              ok: false,
              error: `Invalid --visibility: ${value.value} (expected private|team|tenant)`,
            };
          }
          visibility = value.value;
        } else {
          const states: readonly AgentStateArg[] = [
            'created',
            'idle',
            'running',
            'waiting_permission',
            'completed',
            'failed',
            'cancelled',
            'closed',
            'stale',
          ];
          if (!states.includes(value.value as AgentStateArg)) {
            return { ok: false, error: `Invalid --state: ${value.value}` };
          }
          state = value.value as AgentStateArg;
        }
        i = value.next;
        continue;
      }
      return { ok: false, error: `Unknown argument for agent list: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.agentCommand = {
      kind: 'list',
      json,
      ...(visibility !== undefined ? { visibility } : {}),
      ...(state !== undefined ? { state } : {}),
    };
    return { ok: true, args };
  }

  return { ok: false, error: `Unknown agent subcommand: ${sub}` };
}

/**
 * `team list|get|post|members`（0.19 S3）。
 * 只做语法；workspace / roster 解析在 `src/team-command.ts`。
 */
function parseTeamArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  const tail = rest.slice(1);

  if (sub === 'list') {
    let json = false;
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      return { ok: false, error: `Unknown argument for team list: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.teamCommand = { kind: 'list', json };
    return { ok: true, args };
  }

  if (sub === 'get') {
    let json = false;
    let limit: number | undefined;
    const positional: string[] = [];
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--limit') {
        const value = readFlagValue(tail, i, '--limit');
        if (!value.ok) return value;
        if (!/^\d+$/.test(value.value) || Number.parseInt(value.value, 10) <= 0) {
          return { ok: false, error: `Invalid --limit: ${value.value}` };
        }
        limit = Number.parseInt(value.value, 10);
        i = value.next;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for team get: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [teamId, extra] = positional;
    if (teamId === undefined || teamId === '') {
      return { ok: false, error: 'team get requires <team_id>' };
    }
    if (extra !== undefined) {
      return { ok: false, error: `Unknown argument for team get: ${extra}` };
    }
    args.teamCommand = {
      kind: 'get',
      teamId,
      ...(limit !== undefined ? { limit } : {}),
      json,
    };
    return { ok: true, args };
  }

  if (sub === 'post') {
    let json = false;
    const mentions: string[] = [];
    const positional: string[] = [];
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--mention') {
        const value = readFlagValue(tail, i, '--mention');
        if (!value.ok) return value;
        if (value.value === '') {
          return { ok: false, error: 'Invalid --mention: empty value' };
        }
        mentions.push(value.value);
        i = value.next;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for team post: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [teamId, ...contentParts] = positional;
    const content = contentParts.join(' ');
    if (teamId === undefined || teamId === '' || content === '') {
      return { ok: false, error: 'team post requires <team_id> <content...>' };
    }
    args.teamCommand = { kind: 'post', teamId, content, mentions, json };
    return { ok: true, args };
  }

  if (sub === 'members') {
    let json = false;
    const positional: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for team members: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [teamId, action, member, extra] = positional;
    if (teamId === undefined || action === undefined || member === undefined) {
      return { ok: false, error: 'team members requires <team_id> add|remove <member>' };
    }
    if (action !== 'add' && action !== 'remove') {
      return {
        ok: false,
        error: `Invalid team members action: ${action} (expected add|remove)`,
      };
    }
    if (extra !== undefined) {
      return { ok: false, error: `Unknown argument for team members: ${extra}` };
    }
    args.teamCommand = { kind: 'members', teamId, action, member, json };
    return { ok: true, args };
  }

  return { ok: false, error: `Unknown team subcommand: ${sub}` };
}

// ── S5 hub 子命令 ─────────────────────────────────

const HUB_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function parseHubTtl(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

function parseHubEnvName(
  raw: string,
  flag: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (!HUB_ENV_NAME_RE.test(raw)) {
    return { ok: false, error: `Invalid ${flag}: expected an environment variable name` };
  }
  return { ok: true, value: raw };
}

/** `hub start [--host --port --data-dir --allow-remote --tls-cert --tls-key]` */
function parseHubStart(rest: string[], args: CliArgs): ParseResult {
  const command: Extract<HubCommand, { kind: 'start' }> = { kind: 'start' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--allow-remote') {
      command.allowRemote = true;
      continue;
    }
    if (
      a === '--host' ||
      a === '--port' ||
      a === '--data-dir' ||
      a === '--tls-cert' ||
      a === '--tls-key'
    ) {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--port') {
        const port = parsePort(value.value);
        if (port === null) return { ok: false, error: `Invalid port for --port: ${value.value}` };
        command.port = port;
      } else if (a === '--host') {
        command.host = value.value;
      } else if (a === '--data-dir') {
        command.dataDir = value.value;
      } else if (a === '--tls-cert') {
        command.tlsCert = value.value;
      } else {
        command.tlsKey = value.value;
      }
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for hub start: ${a}` };
  }
  if (args.help) return { ok: true, args };
  if ((command.tlsCert === undefined) !== (command.tlsKey === undefined)) {
    return { ok: false, error: 'hub start requires both --tls-cert and --tls-key' };
  }
  args.hubCommand = command;
  return { ok: true, args };
}

/** `hub directory [--hub-url] [--token-env] [--json]` */
function parseHubDirectory(rest: string[], args: CliArgs): ParseResult {
  let hubUrl: string | undefined;
  let tokenEnv: string | undefined;
  let json = false;
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
    if (a === '--hub-url' || a === '--token-env') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--hub-url') hubUrl = value.value;
      else {
        const envName = parseHubEnvName(value.value, '--token-env');
        if (!envName.ok) return envName;
        tokenEnv = envName.value;
      }
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for hub directory: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.hubCommand = {
    kind: 'directory',
    json,
    ...(hubUrl !== undefined ? { hubUrl } : {}),
    ...(tokenEnv !== undefined ? { tokenEnv } : {}),
  };
  return { ok: true, args };
}

/** `hub watch [--hub-url] [--token-env]` */
function parseHubWatch(rest: string[], args: CliArgs): ParseResult {
  let hubUrl: string | undefined;
  let tokenEnv: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--hub-url' || a === '--token-env') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--hub-url') hubUrl = value.value;
      else {
        const envName = parseHubEnvName(value.value, '--token-env');
        if (!envName.ok) return envName;
        tokenEnv = envName.value;
      }
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for hub watch: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.hubCommand = {
    kind: 'watch',
    ...(hubUrl !== undefined ? { hubUrl } : {}),
    ...(tokenEnv !== undefined ? { tokenEnv } : {}),
  };
  return { ok: true, args };
}

/** `hub pair [--data-dir] [--tenant] [--ttl]` */
function parseHubPair(rest: string[], args: CliArgs): ParseResult {
  let dataDir: string | undefined;
  let tenant: string | undefined;
  let ttl: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--data-dir' || a === '--tenant' || a === '--ttl') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--data-dir') dataDir = value.value;
      else if (a === '--tenant') tenant = value.value;
      else {
        const parsed = parseHubTtl(value.value, 60, 3600);
        if (parsed === null) {
          return { ok: false, error: `Invalid --ttl: ${value.value} (60-3600 seconds)` };
        }
        ttl = parsed;
      }
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for hub pair: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.hubCommand = {
    kind: 'pair',
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(tenant !== undefined ? { tenant } : {}),
    ...(ttl !== undefined ? { ttl } : {}),
  };
  return { ok: true, args };
}

/** `hub join-code [--tenant] [--ttl] [--json]`（hub 侧，S5.1） */
function parseHubJoinCode(rest: string[], args: CliArgs): ParseResult {
  let dataDir: string | undefined;
  let tenant: string | undefined;
  let ttl: number | undefined;
  let json = false;
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
    if (a === '--data-dir' || a === '--tenant' || a === '--ttl') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--data-dir') dataDir = value.value;
      else if (a === '--tenant') tenant = value.value;
      else {
        const parsed = parseHubTtl(value.value, 60, 3600);
        if (parsed === null) {
          return { ok: false, error: `Invalid --ttl: ${value.value} (60-3600 seconds)` };
        }
        ttl = parsed;
      }
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for hub join-code: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.hubCommand = {
    kind: 'join-code',
    json,
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(tenant !== undefined ? { tenant } : {}),
    ...(ttl !== undefined ? { ttl } : {}),
  };
  return { ok: true, args };
}

/** `hub join [hub-url] --code <CODE> | --code-env <ENV> [...]`（node 侧，S5.1） */
function parseHubJoin(rest: string[], args: CliArgs): ParseResult {
  let code: string | undefined;
  let codeEnv: string | undefined;
  let tenant: string | undefined;
  let publicUrl: string | undefined;
  let caFile: string | undefined;
  let dataDir: string | undefined;
  let json = false;
  const positional: string[] = [];

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
    if (
      a === '--code' ||
      a === '--code-env' ||
      a === '--tenant' ||
      a === '--public-url' ||
      a === '--ca' ||
      a === '--data-dir'
    ) {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--code') code = value.value;
      else if (a === '--code-env') {
        const envName = parseHubEnvName(value.value, '--code-env');
        if (!envName.ok) return envName;
        codeEnv = envName.value;
      } else if (a === '--tenant') tenant = value.value;
      else if (a === '--public-url') publicUrl = value.value;
      else if (a === '--ca') caFile = value.value;
      else dataDir = value.value;
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for hub join: ${a}` };
    }
    positional.push(a);
  }
  if (args.help) return { ok: true, args };

  const [hubUrl, extra] = positional;
  if (extra !== undefined) {
    return { ok: false, error: `Unknown argument for hub join: ${extra}` };
  }
  if (code !== undefined && codeEnv !== undefined) {
    return { ok: false, error: 'hub join accepts only one of --code and --code-env' };
  }

  args.hubCommand = {
    kind: 'join',
    json,
    ...(hubUrl !== undefined ? { hubUrl } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(codeEnv !== undefined ? { codeEnv } : {}),
    ...(tenant !== undefined ? { tenant } : {}),
    ...(publicUrl !== undefined ? { publicUrl } : {}),
    ...(caFile !== undefined ? { caFile } : {}),
    ...(dataDir !== undefined ? { dataDir } : {}),
  };
  return { ok: true, args };
}

/** `hub node add <url> --code <CODE> [--alias] [--ca] [--hub-url]` */
function parseHubNodeAdd(rest: string[], args: CliArgs): ParseResult {
  let code: string | undefined;
  let alias: string | undefined;
  let ca: string | undefined;
  let hubUrl: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--code' || a === '--alias' || a === '--ca' || a === '--hub-url') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--code') code = value.value;
      else if (a === '--alias') alias = value.value;
      else if (a === '--ca') ca = value.value;
      else hubUrl = value.value;
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) return { ok: false, error: `Unknown argument for hub node add: ${a}` };
    positional.push(a);
  }
  if (args.help) return { ok: true, args };
  const [url, extra] = positional;
  if (url === undefined || url === '') return { ok: false, error: 'hub node add requires <url>' };
  if (extra !== undefined) {
    return { ok: false, error: `Unknown argument for hub node add: ${extra}` };
  }
  if (code === undefined || code === '') {
    return { ok: false, error: 'hub node add requires --code <CODE>' };
  }
  args.hubCommand = {
    kind: 'node-add',
    url,
    code,
    ...(alias !== undefined ? { alias } : {}),
    ...(ca !== undefined ? { ca } : {}),
    ...(hubUrl !== undefined ? { hubUrl } : {}),
  };
  return { ok: true, args };
}

/** `hub node list [--hub-url] [--json]` */
function parseHubNodeList(rest: string[], args: CliArgs): ParseResult {
  let hubUrl: string | undefined;
  let json = false;
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
    if (a === '--hub-url') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      hubUrl = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for hub node list: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.hubCommand = { kind: 'node-list', json, ...(hubUrl !== undefined ? { hubUrl } : {}) };
  return { ok: true, args };
}

/** `hub node remove <pairing_id> [--hub-url]` */
function parseHubNodeRemove(rest: string[], args: CliArgs): ParseResult {
  let hubUrl: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--hub-url') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      hubUrl = value.value;
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for hub node remove: ${a}` };
    }
    positional.push(a);
  }
  if (args.help) return { ok: true, args };
  const [pairingId, extra] = positional;
  if (pairingId === undefined || pairingId === '') {
    return { ok: false, error: 'hub node remove requires <pairing_id>' };
  }
  if (extra !== undefined) {
    return { ok: false, error: `Unknown argument for hub node remove: ${extra}` };
  }
  args.hubCommand = {
    kind: 'node-remove',
    pairingId,
    ...(hubUrl !== undefined ? { hubUrl } : {}),
  };
  return { ok: true, args };
}

/** `hub token exchange <node-url> --team <id> [--ttl] [--admin-token-env] [--json]` */
function parseHubTokenExchange(rest: string[], args: CliArgs): ParseResult {
  let teamId: string | undefined;
  let ttl: number | undefined;
  let adminTokenEnv: string | undefined;
  let json = false;
  const positional: string[] = [];
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
    if (a === '--team' || a === '--ttl' || a === '--admin-token-env') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--team') teamId = value.value;
      else if (a === '--admin-token-env') {
        const envName = parseHubEnvName(value.value, '--admin-token-env');
        if (!envName.ok) return envName;
        adminTokenEnv = envName.value;
      } else {
        const parsed = parseHubTtl(value.value, 1, 86_400);
        if (parsed === null) {
          return { ok: false, error: `Invalid --ttl: ${value.value} (1-86400 seconds)` };
        }
        ttl = parsed;
      }
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for hub token exchange: ${a}` };
    }
    positional.push(a);
  }
  if (args.help) return { ok: true, args };
  const [nodeUrl, extra] = positional;
  if (nodeUrl === undefined || nodeUrl === '') {
    return { ok: false, error: 'hub token exchange requires <node-url>' };
  }
  if (extra !== undefined) {
    return { ok: false, error: `Unknown argument for hub token exchange: ${extra}` };
  }
  if (teamId === undefined || teamId === '') {
    return { ok: false, error: 'hub token exchange requires --team <id>' };
  }
  args.hubCommand = {
    kind: 'token-exchange',
    nodeUrl,
    teamId,
    json,
    ...(ttl !== undefined ? { ttl } : {}),
    ...(adminTokenEnv !== undefined ? { adminTokenEnv } : {}),
  };
  return { ok: true, args };
}

/** `hub token revoke <node-url> --token-id <id> [--admin-token-env]` */
function parseHubTokenRevoke(rest: string[], args: CliArgs): ParseResult {
  let tokenId: string | undefined;
  let adminTokenEnv: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--token-id' || a === '--admin-token-env') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--token-id') tokenId = value.value;
      else {
        const envName = parseHubEnvName(value.value, '--admin-token-env');
        if (!envName.ok) return envName;
        adminTokenEnv = envName.value;
      }
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for hub token revoke: ${a}` };
    }
    positional.push(a);
  }
  if (args.help) return { ok: true, args };
  const [nodeUrl, extra] = positional;
  if (nodeUrl === undefined || nodeUrl === '') {
    return { ok: false, error: 'hub token revoke requires <node-url>' };
  }
  if (extra !== undefined) {
    return { ok: false, error: `Unknown argument for hub token revoke: ${extra}` };
  }
  if (tokenId === undefined || tokenId === '') {
    return { ok: false, error: 'hub token revoke requires --token-id <id>' };
  }
  args.hubCommand = {
    kind: 'token-revoke',
    nodeUrl,
    tokenId,
    ...(adminTokenEnv !== undefined ? { adminTokenEnv } : {}),
  };
  return { ok: true, args };
}

/** `hub token list <node-url> [--admin-token-env] [--json]` */
function parseHubTokenList(rest: string[], args: CliArgs): ParseResult {
  let adminTokenEnv: string | undefined;
  let json = false;
  const positional: string[] = [];
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
    if (a === '--admin-token-env') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      const envName = parseHubEnvName(value.value, '--admin-token-env');
      if (!envName.ok) return envName;
      adminTokenEnv = envName.value;
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for hub token list: ${a}` };
    }
    positional.push(a);
  }
  if (args.help) return { ok: true, args };
  const [nodeUrl, extra] = positional;
  if (nodeUrl === undefined || nodeUrl === '') {
    return { ok: false, error: 'hub token list requires <node-url>' };
  }
  if (extra !== undefined) {
    return { ok: false, error: `Unknown argument for hub token list: ${extra}` };
  }
  args.hubCommand = {
    kind: 'token-list',
    nodeUrl,
    json,
    ...(adminTokenEnv !== undefined ? { adminTokenEnv } : {}),
  };
  return { ok: true, args };
}

/** `hub data-token <pairing_id> --team <id> [--hub-url] [--token-env] [--ttl]` */
function parseHubDataToken(rest: string[], args: CliArgs): ParseResult {
  let teamId: string | undefined;
  let hubUrl: string | undefined;
  let tokenEnv: string | undefined;
  let ttl: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--team' || a === '--hub-url' || a === '--token-env' || a === '--ttl') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--team') teamId = value.value;
      else if (a === '--hub-url') hubUrl = value.value;
      else if (a === '--token-env') {
        const envName = parseHubEnvName(value.value, '--token-env');
        if (!envName.ok) return envName;
        tokenEnv = envName.value;
      } else {
        const parsed = parseHubTtl(value.value, 1, 86_400);
        if (parsed === null) {
          return { ok: false, error: `Invalid --ttl: ${value.value} (1-86400 seconds)` };
        }
        ttl = parsed;
      }
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for hub data-token: ${a}` };
    }
    positional.push(a);
  }
  if (args.help) return { ok: true, args };
  const [pairingId, extra] = positional;
  if (pairingId === undefined || pairingId === '') {
    return { ok: false, error: 'hub data-token requires <pairing_id>' };
  }
  if (extra !== undefined) {
    return { ok: false, error: `Unknown argument for hub data-token: ${extra}` };
  }
  if (teamId === undefined || teamId === '') {
    return { ok: false, error: 'hub data-token requires --team <id>' };
  }
  args.hubCommand = {
    kind: 'data-token',
    pairingId,
    teamId,
    ...(hubUrl !== undefined ? { hubUrl } : {}),
    ...(tokenEnv !== undefined ? { tokenEnv } : {}),
    ...(ttl !== undefined ? { ttl } : {}),
  };
  return { ok: true, args };
}

/** `hub node <add|list|remove>` */
function parseHubNodeArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return { ok: false, error: 'Missing hub node subcommand (add|list|remove)' };
  }
  const tail = rest.slice(1);
  switch (sub) {
    case 'add':
      return parseHubNodeAdd(tail, args);
    case 'list':
      return parseHubNodeList(tail, args);
    case 'remove':
      return parseHubNodeRemove(tail, args);
    default:
      return { ok: false, error: `Unknown hub node subcommand: ${sub}` };
  }
}

/** `hub token <exchange|revoke|list>` */
function parseHubTokenArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return { ok: false, error: 'Missing hub token subcommand (exchange|revoke|list)' };
  }
  const tail = rest.slice(1);
  switch (sub) {
    case 'exchange':
      return parseHubTokenExchange(tail, args);
    case 'revoke':
      return parseHubTokenRevoke(tail, args);
    case 'list':
      return parseHubTokenList(tail, args);
    default:
      return { ok: false, error: `Unknown hub token subcommand: ${sub}` };
  }
}

/** `hub <subcommand>` 分发 */
function parseHubArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    args.hubCommand = null;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return {
      ok: false,
      error:
        'Missing hub subcommand ' +
        '(start|directory|watch|pair|join-code|join|node|token|data-token)',
    };
  }
  const tail = rest.slice(1);
  switch (sub) {
    case 'start':
      return parseHubStart(tail, args);
    case 'directory':
      return parseHubDirectory(tail, args);
    case 'watch':
      return parseHubWatch(tail, args);
    case 'pair':
      return parseHubPair(tail, args);
    case 'join-code':
      return parseHubJoinCode(tail, args);
    case 'join':
      return parseHubJoin(tail, args);
    case 'node':
      return parseHubNodeArgs(tail, args);
    case 'token':
      return parseHubTokenArgs(tail, args);
    case 'data-token':
      return parseHubDataToken(tail, args);
    default:
      return { ok: false, error: `Unknown hub subcommand: ${sub}` };
  }
}

/** `errors [--json] [--limit N]` */
function parseErrorsArgs(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  let limit: number | undefined;
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
    if (a === '--limit') {
      const value = readFlagValue(rest, i, '--limit');
      if (!value.ok) return value;
      if (!/^\d+$/.test(value.value)) {
        return { ok: false, error: `Invalid --limit: ${value.value}` };
      }
      const parsed = Number.parseInt(value.value, 10);
      if (parsed < 1 || parsed > 200) {
        return { ok: false, error: `Invalid --limit: ${value.value} (1-200)` };
      }
      limit = parsed;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for errors: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.errorsCommand = { json, ...(limit !== undefined ? { limit } : {}) };
  return { ok: true, args };
}

/** `doctor [--json] [--deep]` */
function parseDoctorArgs(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  let deep = false;
  for (const a of rest) {
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--deep') {
      deep = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for doctor: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.doctorCommand = { json, ...(deep ? { deep: true } : {}) };
  return { ok: true, args };
}

/** `logs tail [--json] [--lines N] [--instance <name>]` */
function parseLogsArgs(rest: string[], args: CliArgs): ParseResult {
  if (rest[0] !== 'tail') {
    return { ok: false, error: 'Usage: vessel logs tail [--json] [--lines N]' };
  }
  let json = false;
  let lines = 50;
  let instance: string | undefined;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--lines' || a === '-n') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (!/^\d+$/.test(value.value)) {
        return { ok: false, error: `Invalid --lines: ${value.value}` };
      }
      const parsed = Number.parseInt(value.value, 10);
      if (parsed < 1 || parsed > 10_000) {
        return { ok: false, error: `Invalid --lines: ${value.value} (1-10000)` };
      }
      lines = parsed;
      i = value.next;
      continue;
    }
    if (a === '--instance') {
      const value = readFlagValue(rest, i, '--instance');
      if (!value.ok) return value;
      const parsed = parseInstanceName(value.value);
      if (parsed === null) {
        return { ok: false, error: `Invalid --instance: ${value.value}` };
      }
      instance = parsed;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for logs tail: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.logsCommand = { kind: 'tail', json, lines, ...(instance !== undefined ? { instance } : {}) };
  return { ok: true, args };
}
