/**
 * CLI 按位置 help 的声明式数据（用法 / flag / 摘要）。
 *
 * 一份数据同时喂三处，避免“帮助文案”与“错误提示”两份漂移：
 * - `vessel <cmd...> -h` / `vessel help <cmd...>` 的命令页；
 * - `vessel <group>` 的子命令列表；
 * - 用法错误（缺参数 / 未知 flag / 未知子命令）末尾的 `Try 'vessel ... --help'`。
 *
 * 约定：
 * - 只描述**已有**命令；新增命令时在这里加一条。`src/commands/registry.ts` 仍是
 *   执行入口，本文件不参与分派。
 * - 命令名与 flag 是命令行字面量，不翻译；文案走 `MessageKey`（zh-CN / en 两份 catalog）。
 * - `flags` 不含 `-h/--help`：任何命令都接受，渲染时统一追加。
 * - `usage` 只在 flag 列表无法表达互斥形态时手写（例如 `attention respond`）。
 *
 * @module vessel/cli-help-spec
 */

import type { MessageKey } from './i18n';

/**
 * flag 字面量 → usage 行里的取值占位；`null` = 布尔 flag。
 *
 * 同时是 flag 白名单：`CLI_FLAG_HELP` 必须给出每一项的说明。
 */
export const CLI_FLAG_VALUE = {
  '--json': null,
  '--daemon': null,
  '--force': null,
  '--yes': null,
  '--check': null,
  '--channel': '<latest|beta>',
  '--deep': null,
  '--rpc': null,
  '--sources': null,
  '--dry-run': null,
  '--apply': null,
  '--interactive': null,
  '--all-nodes': null,
  '--all': null,
  '--allow': null,
  '--deny': null,
  '--remember': null,
  '--interrupt': null,
  '--allow-auto-create': null,
  '--allow-network': null,
  '--allow-remote': null,
  '--no-auto-start': null,
  '--systemd': null,
  '--launchd': null,
  '--schtasks': null,
  '--clear-description': null,
  '--out': '<path>',
  '--filter': '<tag>',
  '--source': '<path>',
  '--from': '<value>',
  '--to': '<value>',
  '--name': '<name>',
  '--model': '<model>',
  '--visibility': '<private|team|tenant>',
  '--system-prompt': '<text>',
  '--workspace': '<path>',
  '--message-id': '<id>',
  '--state': '<state>',
  '--limit': '<n>',
  '--members': '<n>',
  '--mention': '<name|id>',
  '--description': '<text>',
  '--policy': '<json>',
  '--policy-file': '<path>',
  '--conversation': '<id>',
  '--conversation-id': '<id>',
  '--dimension': '<hops|turns|tokens|wall_clock|cycle>',
  '--max': '<n|unlimited>',
  '--hub-url': '<URL>',
  '--token-env': '<ENV>',
  '--ttl': '<seconds>',
  '--code': '<CODE>',
  '--code-env': '<ENV>',
  '--public-url': '<url>',
  '--ca': '<path>',
  '--connect': '<url>',
  '--connect-token': '<token>',
  '--data-dir': '<path>',
  '--instance': '<name>',
  '--port': '<N>',
  '--host': '<H>',
  '--log': '<path>',
  '--timeout': '<dur>',
  '--scope': '<config,plugins>',
  '--config': '<path>',
  '--lines': '<n>',
  '--select': '<ids>',
  '--answers': '<json>',
  '--node': '<name>',
  '--team': '<team_id>',
  '--agent': '<name>',
  '--status': '<pending|orphaned>',
  '--order': '<oldest|newest>',
  '--cursor': '<cursor>',
  '--tls-cert': '<path>',
  '--tls-key': '<path>',
} as const;

export type CliFlag = keyof typeof CLI_FLAG_VALUE;

/** 每个 flag 的一行说明（i18n key）；语义因命令而异的用 `flagHelp` 覆盖 */
export const CLI_FLAG_HELP: Readonly<Record<CliFlag, MessageKey>> = {
  '--json': 'flag.json',
  '--daemon': 'flag.daemon',
  '--force': 'flag.force',
  '--yes': 'flag.yes',
  '--check': 'flag.check',
  '--channel': 'flag.channel',
  '--deep': 'flag.deep',
  '--rpc': 'flag.rpc',
  '--sources': 'flag.sources',
  '--dry-run': 'flag.dryRun',
  '--apply': 'flag.apply',
  '--interactive': 'flag.interactive',
  '--all-nodes': 'flag.allNodes',
  '--all': 'flag.all',
  '--allow': 'flag.allow',
  '--deny': 'flag.deny',
  '--remember': 'flag.remember',
  '--interrupt': 'flag.interrupt',
  '--allow-auto-create': 'flag.allowAutoCreate',
  '--allow-network': 'flag.allowNetwork',
  '--allow-remote': 'flag.allowRemote',
  '--no-auto-start': 'flag.noAutoStart',
  '--systemd': 'flag.systemd',
  '--launchd': 'flag.launchd',
  '--schtasks': 'flag.schtasks',
  '--clear-description': 'flag.clearDescription',
  '--out': 'flag.out',
  '--filter': 'flag.filter',
  '--source': 'flag.source',
  '--from': 'flag.from',
  '--to': 'flag.to',
  '--name': 'flag.name',
  '--model': 'flag.model',
  '--visibility': 'flag.visibility',
  '--system-prompt': 'flag.systemPrompt',
  '--workspace': 'flag.workspace',
  '--message-id': 'flag.messageId',
  '--state': 'flag.state',
  '--limit': 'flag.limit',
  '--members': 'flag.members',
  '--mention': 'flag.mention',
  '--description': 'flag.description',
  '--policy': 'flag.policy',
  '--policy-file': 'flag.policyFile',
  '--conversation': 'flag.conversation',
  '--conversation-id': 'flag.conversationId',
  '--dimension': 'flag.dimension',
  '--max': 'flag.max',
  '--hub-url': 'flag.hubUrl',
  '--token-env': 'flag.tokenEnv',
  '--ttl': 'flag.ttl',
  '--code': 'flag.code',
  '--code-env': 'flag.codeEnv',
  '--public-url': 'flag.publicUrl',
  '--ca': 'flag.ca',
  '--connect': 'flag.connect',
  '--connect-token': 'flag.connectToken',
  '--data-dir': 'flag.dataDir',
  '--instance': 'flag.instance',
  '--port': 'flag.port',
  '--host': 'flag.host',
  '--log': 'flag.log',
  '--timeout': 'flag.timeout',
  '--scope': 'flag.scope',
  '--config': 'flag.config',
  '--lines': 'flag.lines',
  '--select': 'flag.select',
  '--answers': 'flag.answers',
  '--node': 'flag.node',
  '--team': 'flag.team',
  '--agent': 'flag.agent',
  '--status': 'flag.status',
  '--order': 'flag.order',
  '--cursor': 'flag.cursor',
  '--tls-cert': 'flag.tlsCert',
  '--tls-key': 'flag.tlsKey',
};

/** 一条命令级 help 规格 */
export interface CliHelpCommand {
  /** 命令路径：`['gateway', 'start']`；首段必须是顶层命令字面量 */
  readonly path: readonly [string, ...string[]];
  /** 一句话摘要（i18n key） */
  readonly summary: MessageKey;
  /** 位置参数形态：必填 `<x>`、可选 `[x]`、变长 `<x...>` */
  readonly args?: string;
  /** 本命令接受的 flag（不含 `-h/--help`） */
  readonly flags?: readonly CliFlag[];
  /** 必填 flag：出现在 usage 行且不加方括号 */
  readonly required?: readonly CliFlag[];
  /** 同名 flag 在本命令里取值形态不同时的展示覆盖（如 `--to` 是地址） */
  readonly flagValue?: Partial<Record<CliFlag, string>>;
  /** 互斥形态无法由 flag 列表表达时手写整行 usage */
  readonly usage?: string;
  /** 同名 flag 在本命令里含义不同时的覆盖说明 */
  readonly flagHelp?: Partial<Record<CliFlag, MessageKey>>;
}

/** 纯分组（自身不是命令）的一句话摘要；兼作命令的分组用自己的 `summary` */
export const CLI_HELP_GROUPS: Readonly<Record<string, MessageKey>> = {
  agent: 'help.group.agent',
  config: 'help.group.config',
  dev: 'help.group.dev',
  federation: 'help.group.federation',
  gateway: 'help.group.gateway',
  'gateway nodes': 'help.group.gatewayNodes',
  hub: 'help.group.hub',
  'hub node': 'help.group.hubNode',
  logs: 'help.group.logs',
  node: 'help.group.node',
  plugin: 'help.group.plugin',
  team: 'help.group.team',
  trace: 'help.group.trace',
};

/**
 * 全部命令级规格。顺序决定 group 页里子命令的排列顺序。
 * 与 `src/cli-args.ts` 的解析分支一一对应；改 flag 时同步这里。
 */
export const CLI_HELP_COMMANDS: readonly CliHelpCommand[] = [
  // ── 入口 / 元命令 ──
  { path: ['demo'], summary: 'help.cmd.demo' },
  { path: ['completion'], summary: 'help.cmd.completion', args: '<bash|zsh|fish|powershell>' },
  {
    path: ['update'],
    summary: 'help.cmd.update',
    flags: ['--check', '--channel', '--json', '--force', '--yes'],
  },
  { path: ['doctor'], summary: 'help.cmd.doctor', flags: ['--json', '--deep'] },
  {
    path: ['status'],
    summary: 'help.cmd.status',
    flags: ['--json', '--connect', '--connect-token', '--ca'],
  },
  {
    path: ['agents'],
    summary: 'help.cmd.agents',
    flags: ['--json', '--connect', '--connect-token', '--ca'],
  },
  {
    path: ['errors'],
    summary: 'help.cmd.errors',
    flags: ['--json', '--limit', '--connect', '--connect-token', '--ca'],
  },

  // ── attention（列表是命令，respond 是其子命令）──
  {
    path: ['attention'],
    summary: 'help.cmd.attention',
    flags: [
      '--json',
      '--interactive',
      '--all-nodes',
      '--node',
      '--to',
      '--team',
      '--agent',
      '--status',
      '--order',
      '--limit',
      '--cursor',
      '--connect',
      '--connect-token',
      '--ca',
    ],
    flagHelp: { '--to': 'flag.to.address' },
    flagValue: { '--to': '<principal@node:team>' },
  },
  {
    path: ['attention', 'respond'],
    summary: 'help.cmd.attentionRespond',
    usage:
      'vessel attention respond <request_id> --allow|--deny|--answers <json> ' +
      '| --select <ids> --allow|--deny | --all --yes [options]',
    flags: [
      '--allow',
      '--deny',
      '--answers',
      '--remember',
      '--select',
      '--all',
      '--yes',
      '--status',
      '--to',
      '--team',
      '--agent',
      '--node',
      '--connect',
      '--connect-token',
      '--ca',
    ],
    flagHelp: { '--to': 'flag.to.address' },
    flagValue: { '--to': '<principal@node:team>' },
  },

  // ── 能力 / 配置 / 迁移 ──
  {
    path: ['eval'],
    summary: 'help.cmd.eval',
    args: '<suite>',
    flags: ['--json', '--out', '--filter', '--allow-network'],
  },
  { path: ['config', 'path'], summary: 'help.cmd.configPath', flags: ['--json'] },
  { path: ['config', 'init'], summary: 'help.cmd.configInit', flags: ['--json', '--force'] },
  { path: ['config', 'show'], summary: 'help.cmd.configShow', flags: ['--json', '--sources'] },
  {
    path: ['config', 'set'],
    summary: 'help.cmd.configSet',
    args: '<key> <value>',
    flags: ['--json'],
  },
  {
    path: ['migrate'],
    summary: 'help.cmd.migrate',
    flags: ['--from', '--to', '--apply', '--json', '--source'],
    required: ['--from', '--to'],
    flagHelp: { '--from': 'flag.from.migrate', '--to': 'flag.to.migrate' },
    flagValue: { '--from': '<sqlite|file-v1>', '--to': '<file-v2>' },
  },
  { path: ['trace', 'prune'], summary: 'help.cmd.tracePrune', flags: ['--dry-run', '--json'] },

  // ── 插件 ──
  { path: ['plugin', 'list'], summary: 'help.cmd.pluginList', flags: ['--json'] },
  {
    path: ['plugin', 'install'],
    summary: 'help.cmd.pluginInstall',
    args: '<path>',
    flags: ['--force'],
  },
  {
    path: ['plugin', 'remove'],
    summary: 'help.cmd.pluginRemove',
    args: '<name>',
    flags: ['--yes'],
  },
  { path: ['plugin', 'enable'], summary: 'help.cmd.pluginEnable', args: '<name>' },
  { path: ['plugin', 'disable'], summary: 'help.cmd.pluginDisable', args: '<name>' },

  // ── 日志 ──
  {
    path: ['logs', 'tail'],
    summary: 'help.cmd.logsTail',
    flags: ['--json', '--lines', '--instance'],
  },

  // ── gateway ──
  {
    path: ['gateway', 'start'],
    summary: 'help.cmd.gatewayStart',
    flags: ['--daemon', '--instance', '--port', '--host', '--log'],
  },
  {
    path: ['gateway', 'status'],
    summary: 'help.cmd.gatewayStatus',
    flags: ['--json', '--rpc', '--instance', '--port', '--all'],
  },
  { path: ['gateway', 'list'], summary: 'help.cmd.gatewayList', flags: ['--json'] },
  {
    path: ['gateway', 'restart'],
    summary: 'help.cmd.gatewayRestart',
    flags: ['--daemon', '--instance', '--port', '--all'],
  },
  {
    path: ['gateway', 'reload'],
    summary: 'help.cmd.gatewayReload',
    flags: ['--scope', '--instance', '--port', '--all'],
  },
  {
    path: ['gateway', 'stop'],
    summary: 'help.cmd.gatewayStop',
    flags: ['--timeout', '--instance', '--port', '--all'],
  },
  {
    path: ['gateway', 'install-service'],
    summary: 'help.cmd.gatewayInstall',
    flags: ['--systemd', '--launchd', '--schtasks'],
  },
  { path: ['gateway', 'uninstall-service'], summary: 'help.cmd.gatewayUninstall' },
  { path: ['gateway', 'nodes', 'list'], summary: 'help.cmd.gatewayNodesList', flags: ['--json'] },
  {
    path: ['gateway', 'nodes', 'add'],
    summary: 'help.cmd.gatewayNodesAdd',
    args: '<name>',
    flags: ['--data-dir', '--config', '--no-auto-start'],
    required: ['--data-dir', '--config'],
  },
  {
    path: ['gateway', 'nodes', 'remove'],
    summary: 'help.cmd.gatewayNodesRemove',
    args: '<name>',
  },

  // ── node ──
  { path: ['node', 'start'], summary: 'help.cmd.nodeStart', flags: ['--daemon', '--config'] },
  { path: ['node', 'status'], summary: 'help.cmd.nodeStatus', flags: ['--json', '--rpc'] },
  { path: ['node', 'stop'], summary: 'help.cmd.nodeStop' },
  { path: ['node', 'reload'], summary: 'help.cmd.nodeReload', flags: ['--scope'] },

  // ── hub（service 侧 + node client 侧）──
  {
    path: ['hub', 'start'],
    summary: 'help.cmd.hubStart',
    flags: ['--host', '--port', '--data-dir', '--allow-remote', '--tls-cert', '--tls-key'],
  },
  {
    path: ['hub', 'directory'],
    summary: 'help.cmd.hubDirectory',
    flags: ['--hub-url', '--token-env', '--json'],
  },
  { path: ['hub', 'watch'], summary: 'help.cmd.hubWatch', flags: ['--hub-url', '--token-env'] },
  {
    path: ['hub', 'node', 'list'],
    summary: 'help.cmd.hubNodeList',
    flags: ['--hub-url', '--json'],
  },
  {
    path: ['hub', 'node', 'remove'],
    summary: 'help.cmd.hubNodeRemove',
    args: '<pairing_id>',
    flags: ['--hub-url'],
  },
  {
    path: ['hub', 'join-code'],
    summary: 'help.cmd.hubJoinCode',
    flags: ['--data-dir', '--ttl', '--json'],
  },
  {
    path: ['hub', 'join'],
    summary: 'help.cmd.hubJoin',
    args: '[<hub-url>]',
    flags: ['--code', '--code-env', '--public-url', '--ca', '--data-dir', '--json'],
  },

  // ── agent ──
  {
    path: ['agent', 'create'],
    summary: 'help.cmd.agentCreate',
    flags: ['--json', '--name', '--model', '--visibility', '--system-prompt', '--workspace'],
  },
  {
    path: ['agent', 'send'],
    summary: 'help.cmd.agentSend',
    args: '<member> <content...>',
    flags: ['--json', '--interrupt', '--message-id'],
  },
  { path: ['agent', 'inbox'], summary: 'help.cmd.agentInbox', args: '<member>', flags: ['--json'] },
  {
    path: ['agent', 'dispatch'],
    summary: 'help.cmd.agentDispatch',
    args: '<to> <content...>',
    flags: ['--json', '--allow-auto-create'],
  },
  {
    path: ['agent', 'close'],
    summary: 'help.cmd.agentClose',
    args: '<member...>',
    flags: ['--json'],
  },
  {
    path: ['agent', 'list'],
    summary: 'help.cmd.agentList',
    flags: ['--json', '--visibility', '--state'],
  },

  // ── team ──
  { path: ['team', 'list'], summary: 'help.cmd.teamList', flags: ['--json'] },
  {
    path: ['team', 'create'],
    summary: 'help.cmd.teamCreate',
    args: '<workspace>',
    flags: ['--json', '--name', '--description', '--policy', '--policy-file'],
  },
  {
    path: ['team', 'update'],
    summary: 'help.cmd.teamUpdate',
    args: '<team_id>',
    flags: [
      '--json',
      '--name',
      '--description',
      '--clear-description',
      '--policy',
      '--policy-file',
    ],
  },
  {
    path: ['team', 'archive'],
    summary: 'help.cmd.teamArchive',
    args: '<team_id>',
    flags: ['--json'],
  },
  {
    path: ['team', 'get'],
    summary: 'help.cmd.teamGet',
    args: '<team_id>',
    flags: ['--json', '--limit', '--members'],
  },
  {
    path: ['team', 'post'],
    summary: 'help.cmd.teamPost',
    args: '<team_id> <content...>',
    flags: ['--json', '--mention'],
  },
  {
    path: ['team', 'members'],
    summary: 'help.cmd.teamMembers',
    args: '<team_id> add|remove <member>',
    flags: ['--json'],
  },
  {
    path: ['team', 'budget'],
    summary: 'help.cmd.teamBudget',
    args: '<team_id>',
    flags: ['--json', '--conversation'],
  },
  {
    path: ['team', 'budget', 'override'],
    summary: 'help.cmd.teamBudgetOverride',
    args: '<team_id>',
    flags: ['--json', '--conversation', '--dimension', '--max'],
    required: ['--conversation', '--dimension', '--max'],
  },
  {
    path: ['team', 'freeze'],
    summary: 'help.cmd.teamFreeze',
    args: '<team_id>',
    flags: ['--json'],
  },
  {
    path: ['team', 'unfreeze'],
    summary: 'help.cmd.teamUnfreeze',
    args: '<team_id>',
    flags: ['--json'],
  },

  // ── federation ──
  {
    path: ['federation', 'post'],
    summary: 'help.cmd.federationPost',
    args: '<content...>',
    flags: ['--to', '--from', '--conversation-id', '--json'],
    required: ['--to', '--from'],
    flagHelp: { '--to': 'flag.to.address', '--from': 'flag.from.address' },
    flagValue: { '--to': '<principal@node:team>', '--from': '<principal@node:team>' },
  },
  { path: ['federation', 'peers'], summary: 'help.cmd.federationPeers', flags: ['--json'] },
  {
    path: ['federation', 'team-info'],
    summary: 'help.cmd.federationTeamInfo',
    flags: ['--to', '--members', '--json'],
    required: ['--to'],
    flagHelp: { '--to': 'flag.to.address' },
    flagValue: { '--to': '<principal@node:team>' },
  },

  // ── dev ──
  {
    path: ['dev', 'reset'],
    summary: 'help.cmd.devReset',
    flags: ['--yes', '--dry-run', '--json', '--data-dir'],
  },
];
