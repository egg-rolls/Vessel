/**
 * Shell 补全的单一数据源（0.18）。
 *
 * 只放纯数据：顶层命令 → 二级子命令 → flags → 静态候选值。
 * 生成器（`completion-script.ts`）只读这里；`src/__tests__/completion-0.18.test.ts`
 * 断言 `src/commands/registry.ts` 里的每个一次性命令都能在此找到，
 * 新增命令忘加 spec 时测试会失败。
 *
 * 约定：
 * - 命令 token / flag 是命令行上的字面量；`registryName` 对应注册表里的 `name`，
 *   入口处直接处理的命令（`demo` / `--help` / `--version`）为 `null`。
 * - 这里不写动态值（session / tenant / agent id）：那些交给各 shell 的默认补全。
 *
 * @module vessel/completion-spec
 */

/** 支持的 shell（也是 `vessel completion <shell>` 的合法参数） */
export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

/** `vessel completion <shell>` 的解析结果（cli-args 与命令共用） */
export interface CompletionCommandArgs {
  /** 已识别的 shell；无参数 / 未知 shell 时为 null */
  shell: CompletionShell | null;
  /** 用户输入的原始值（错误提示用）；无参数时为 null */
  requested: string | null;
}

export interface CompletionSubcommand {
  /** 二级子命令字面量（`gateway start` 的 `start`） */
  name: string;
  /** 该子命令独占的 flags（不含全局 flags） */
  flags?: readonly string[];
  /** flag → 静态候选值 */
  flagValues?: Readonly<Record<string, readonly string[]>>;
}

export interface CompletionCommand {
  /** 命令行上直接输入的字面量：`gateway`、`--tools` */
  token: string;
  /** `src/commands/registry.ts` 的 name；`null` = 入口处直接处理 */
  registryName: string | null;
  /** 二级子命令；缺省/空数组表示没有 */
  subcommands?: readonly CompletionSubcommand[];
  /** 本命令可用的 flags（不含全局 flags） */
  flags?: readonly string[];
  /** 本命令范围内的 flag → 静态候选值 */
  flagValues?: Readonly<Record<string, readonly string[]>>;
}

/** 顶层与全局可用的 flags（子命令命令都可叠加） */
export const GLOBAL_FLAGS: readonly string[] = [
  '--help',
  '-h',
  '--version',
  '-v',
  '--tools',
  '--feishu',
  '--run',
  '-p',
  '--print',
  '--continue',
  '-c',
  '--resume',
  '-r',
  '--session',
  '-s',
  '--resume-run',
  '--serve',
  '--serve-host',
  '--allow-remote',
  '--tls-cert',
  '--tls-key',
  '--tenant',
  '--data-dir',
  '--exclusive',
  '--connect',
  '--connect-token',
  '--ca',
  '--connect-ca',
  '--allowed-origin',
];

/**
 * flag 的值是动态的（路径 / id / 数字），没有静态候选。
 * bash / zsh 遇到这些 flag 时直接返回，回落到文件补全。
 */
export const DYNAMIC_VALUE_FLAGS: readonly string[] = [
  '--run',
  '--print',
  '-p',
  '--resume',
  '-r',
  '--session',
  '-s',
  '--resume-run',
  '--serve',
  '--serve-host',
  '--tls-cert',
  '--tls-key',
  '--tenant',
  '--data-dir',
  '--connect',
  '--connect-token',
  '--ca',
  '--connect-ca',
  '--allowed-origin',
  '--instance',
  '--port',
  '--host',
  '--log',
  '--timeout',
  '--scope',
  '--lines',
  '-n',
  '--limit',
  '--input',
  '--out',
  '--filter',
  '--name',
  '--model',
  '--system-prompt',
  '--from',
  '--to',
  '--source',
];

/** 值可省略的 flag（`--resume` 无 id = 列出会话） */
export const OPTIONAL_VALUE_FLAGS: readonly string[] = [
  '--run',
  '--print',
  '-p',
  '--resume',
  '-r',
  '--resume-run',
  '--serve',
];

const AGENT_STATES: readonly string[] = [
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

const AGENT_VISIBILITIES: readonly string[] = ['private', 'team', 'tenant'];

/**
 * 顶层命令与二级结构。顺序即补全展示顺序：
 * 先命令，再入口 flag，最后是其它 flag-命令。
 */
export const COMPLETION_COMMANDS: readonly CompletionCommand[] = [
  {
    token: 'completion',
    registryName: 'completion',
    subcommands: COMPLETION_SHELLS.map((shell) => ({ name: shell })),
  },
  { token: 'demo', registryName: null },
  {
    token: 'update',
    registryName: 'update',
    flags: ['--check', '--channel', '--json', '--force', '--yes', '-y'],
    flagValues: { '--channel': ['latest', 'beta'] },
  },
  {
    token: 'eval',
    registryName: 'eval',
    flags: ['--json', '--out', '--filter', '--allow-network'],
  },
  {
    token: 'config',
    registryName: 'config',
    subcommands: [
      { name: 'path', flags: ['--json'] },
      { name: 'init', flags: ['--json', '--force'] },
      { name: 'show', flags: ['--json', '--sources', '--tenant'] },
      { name: 'set', flags: ['--json'] },
    ],
  },
  {
    token: 'tenant',
    registryName: 'tenant',
    subcommands: [
      { name: 'list', flags: ['--json'] },
      { name: 'get', flags: ['--json'] },
      { name: 'create', flags: ['--json', '--name'] },
      {
        name: 'update',
        flags: ['--json', '--name', '--status'],
        flagValues: { '--status': ['active', 'disabled'] },
      },
    ],
  },
  {
    token: 'migrate',
    registryName: 'migrate',
    flags: ['--from', '--to', '--apply', '--json', '--tenant', '--source'],
    flagValues: { '--from': ['sqlite', 'file-v1'], '--to': ['file-v2'] },
  },
  {
    token: 'trace',
    registryName: 'trace',
    subcommands: [{ name: 'prune', flags: ['--dry-run', '--json', '--tenant'] }],
  },
  {
    token: 'plugin',
    registryName: 'plugin',
    subcommands: [
      { name: 'list', flags: ['--json'] },
      { name: 'install', flags: ['--force'] },
      { name: 'remove', flags: ['--yes', '-y'] },
    ],
  },
  { token: 'doctor', registryName: 'doctor', flags: ['--json', '--deep'] },
  {
    token: 'logs',
    registryName: 'logs',
    subcommands: [{ name: 'tail', flags: ['--json', '--lines', '-n', '--instance'] }],
  },
  {
    token: 'gateway',
    registryName: 'gateway',
    subcommands: [
      {
        name: 'start',
        flags: ['--daemon', '--instance', '--port', '--host', '--log', '--exclusive'],
      },
      { name: 'stop', flags: ['--timeout', '--instance', '--port', '--all'] },
      { name: 'status', flags: ['--json', '--rpc', '--instance', '--port', '--all'] },
      { name: 'list', flags: ['--json'] },
      { name: 'restart', flags: ['--daemon', '--instance', '--port', '--all'] },
      {
        name: 'reload',
        flags: ['--scope', '--instance', '--port', '--all'],
        flagValues: { '--scope': ['config', 'plugins'] },
      },
      { name: 'install-service', flags: ['--systemd', '--launchd', '--schtasks'] },
      { name: 'uninstall-service' },
    ],
  },
  { token: 'status', registryName: 'status', flags: ['--json'] },
  { token: 'agents', registryName: 'agents', flags: ['--json'] },
  {
    token: 'agent',
    registryName: 'agent',
    subcommands: [
      {
        name: 'new',
        flags: ['--json', '--name', '--model', '--visibility', '--system-prompt'],
        flagValues: { '--visibility': AGENT_VISIBILITIES },
      },
      { name: 'send', flags: ['--json'] },
      { name: 'close', flags: ['--json'] },
      {
        name: 'list',
        flags: ['--json', '--visibility', '--state'],
        flagValues: { '--visibility': AGENT_VISIBILITIES, '--state': AGENT_STATES },
      },
    ],
  },
  { token: 'errors', registryName: 'errors', flags: ['--json', '--limit'] },
  { token: '--help', registryName: null },
  { token: '--version', registryName: null },
  { token: '--tools', registryName: 'tools' },
  { token: '--resume-run', registryName: 'resume-run-list' },
];

/** 顶层候选词（命令 token + 全局 flags，去重保序） */
export function topLevelWords(): string[] {
  const words = new Set<string>();
  for (const command of COMPLETION_COMMANDS) words.add(command.token);
  for (const flag of GLOBAL_FLAGS) words.add(flag);
  return [...words];
}
