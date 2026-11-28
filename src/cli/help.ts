/**
 * CLI 按位置 help：`vessel <cmd...> -h` / `vessel help <cmd...>` / `vessel <group> help`。
 *
 * 目标（docker / GNU 口径）：
 * - help 在**任何位置**都先于参数校验生效（含跟在 flag 后面），命中命令即 exit 0；
 * - 只打印**当前命令**的用法，而不是整张大表；无参数时才是全局总览；
 * - `vessel <group> help` 是 `vessel help <group>` 的词形等价写法（只对纯分组生效，
 *   位置参数里的 `help` 不会被吞）；
 * - 纯静态：只读 `cli-help-spec.ts` + i18n catalog，不加载 config / gateway / 网络
 *   （唯一例外 `help --search` 住在 `help-search.ts`，live capabilities.list 可降级）。
 *
 * 用法错误（`renderUsageError`）与命令页共用同一份规格，因此 `Try 'vessel ... --help'`
 * 指到的就是刚才那条命令。
 *
 * @module vessel/cli-help
 */

import { t } from '../i18n';
import { ui } from './output';
import {
  type CliFlag,
  type CliHelpCommand,
  FLAG_HELP_TABLE,
  FLAG_VALUE_TABLE,
  HELP_COMMANDS,
  HELP_GROUPS,
  OVERVIEW_COMMANDS,
} from './project';

/** 识别 help 的写法（`vessel help ...` / `vessel <group> help` / 任意位置的 `-h`） */
const HELP_TOKENS: ReadonlySet<string> = new Set(['-h', '--help']);
const HELP_COMMAND = 'help';

// ── 命令树（由声明式表构建；不含手写 if 链）──────────

interface HelpNode {
  /** 路径末段；根节点为 '' */
  readonly name: string;
  readonly path: readonly string[];
  /** 自身是可执行命令时存在（可与 children 并存：`team budget`） */
  readonly spec?: CliHelpCommand;
  readonly children: readonly HelpNode[];
}

interface MutableNode {
  readonly name: string;
  readonly path: readonly string[];
  spec?: CliHelpCommand;
  readonly children: Map<string, MutableNode>;
}

function finalizeHelpNode(node: MutableNode): HelpNode {
  return {
    name: node.name,
    path: node.path,
    ...(node.spec !== undefined ? { spec: node.spec } : {}),
    children: [...node.children.values()].map(finalizeHelpNode),
  };
}

function buildHelpTree(commands: readonly CliHelpCommand[]): HelpNode {
  const root: MutableNode = { name: '', path: [], children: new Map() };
  for (const spec of commands) {
    let node = root;
    for (const [index, segment] of spec.path.entries()) {
      const existing = node.children.get(segment);
      const child: MutableNode = existing ?? {
        name: segment,
        path: spec.path.slice(0, index + 1),
        children: new Map(),
      };
      node.children.set(segment, child);
      node = child;
    }
    node.spec = spec;
  }
  return finalizeHelpNode(root);
}

const HELP_ROOT: HelpNode = buildHelpTree(HELP_COMMANDS);

/** 分组（自身不是命令）的摘要；兼作命令的分组用 spec.summary */
function nodeSummary(node: HelpNode): string {
  if (node.spec !== undefined) return t(node.spec.summary);
  const key = HELP_GROUPS[node.path.join(' ')];
  return key === undefined ? '' : t(key);
}

// ── 解析 ─────────────────────────────────────────

/**
 * 词形 `vessel <group> help`（等价 `vessel help <group>`）里 `help` 的位置；没有则 undefined。
 *
 * 只在 `help` 恰好落在**纯分组**（有子命令、自身不是命令）之后时才成立：
 * `vessel agent send main help` / `vessel team post <id> help` 里的正文 `help` 仍是位置参数，
 * 不会被误判成 help 请求。
 */
function groupHelpIndex(argv: readonly string[]): number | undefined {
  if (argv[0] === HELP_COMMAND) return undefined;
  let node = HELP_ROOT;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) return undefined;
    if (HELP_TOKENS.has(token) || token.startsWith('-')) return undefined;
    if (token === HELP_COMMAND) {
      const isGroup = node.spec === undefined && node.children.length > 0;
      return node.path.length > 0 && isGroup ? index : undefined;
    }
    const child = node.children.find((candidate) => candidate.name === token);
    if (child === undefined) return undefined;
    node = child;
  }
  return undefined;
}

/** 请求了 help 吗？`-h/--help` 任意位置、首 token 是 `help`，或 `<group> help` 词形 */
export function isHelpRequest(argv: readonly string[]): boolean {
  return (
    argv[0] === HELP_COMMAND ||
    argv.some((token) => HELP_TOKENS.has(token)) ||
    groupHelpIndex(argv) !== undefined
  );
}

/**
 * 命令路径候选：去掉 help token 后，取开头的非 flag 连续段。
 * flag 的值不会被当成命令名（`--instance foo` 之前就断开），因此不需要知道各 flag 的元数。
 * `<group> help` 里的 `help` 只是别名 token，不参与路径；其后的 token 仍按路径解析
 * （`vessel gateway help extra` 与 `vessel help gateway extra` 同为未知子命令）。
 */
function commandTokens(argv: readonly string[]): string[] {
  const start = argv[0] === HELP_COMMAND ? 1 : 0;
  const helpIndex = groupHelpIndex(argv);
  const tokens: string[] = [];
  for (let index = start; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) break;
    if (index === helpIndex) continue;
    if (HELP_TOKENS.has(token)) continue;
    if (token.startsWith('-')) break;
    tokens.push(token);
  }
  return tokens;
}

interface ResolvedPath {
  readonly node: HelpNode;
  /** 命中路径之后剩下的非 flag token（第一个用于“未知子命令”判定） */
  readonly rest: readonly string[];
}

function resolveNode(tokens: readonly string[]): ResolvedPath {
  let node = HELP_ROOT;
  let index = 0;
  while (index < tokens.length) {
    const child = node.children.find((candidate) => candidate.name === tokens[index]);
    if (child === undefined) break;
    node = child;
    index += 1;
  }
  return { node, rest: tokens.slice(index) };
}

/** argv → 最长的已知命令前缀 */
export function resolveCliPath(argv: readonly string[]): ResolvedPath {
  return resolveNode(commandTokens(argv));
}

/**
 * 纯分组后面的第一个 token 如果不是已知子命令，就是未知子命令。
 * 自身也是命令的节点（`team budget` / `attention`）把它当位置参数，不误判。
 */
function unknownSubcommand(node: HelpNode, rest: readonly string[]): string | undefined {
  const token = rest[0];
  if (token === undefined || node.spec !== undefined || node.children.length === 0)
    return undefined;
  return node.children.some((child) => child.name === token) ? undefined : token;
}

// ── 渲染辅助 ─────────────────────────────────────

/** 对齐两列（命令 / flag + 说明）并缩进；命令列走海洋绿，说明保持纯文本 */
function align(rows: Array<[string, string]>, width: number): string {
  return rows.map(([cmd, desc]) => `  ${ui.brand(cmd.padEnd(width))}  ${desc}`).join('\n');
}

function columnWidth(rows: Array<[string, string]>): number {
  return Math.max(...rows.map(([cmd]) => cmd.length));
}

/** flag 的展示形态：`--daemon` / `--instance <name>`（命令级可覆盖取值形态） */
function flagSyntax(spec: CliHelpCommand, flag: CliFlag): string {
  const value = spec.flagValue?.[flag] ?? FLAG_VALUE_TABLE[flag] ?? null;
  return value === null ? flag : `${flag} ${value}`;
}

function flagDescription(spec: CliHelpCommand, flag: CliFlag): string {
  return t(spec.flagHelp?.[flag] ?? FLAG_HELP_TABLE[flag] ?? 'flag.help');
}

/** `vessel <path> <args> <required flags> [optional flags]` */
function usageLine(spec: CliHelpCommand): string {
  if (spec.usage !== undefined) return spec.usage;
  const required = new Set(spec.required ?? []);
  const parts = ['vessel', ...spec.path];
  if (spec.args !== undefined) parts.push(spec.args);
  for (const flag of required) parts.push(flagSyntax(spec, flag));
  for (const flag of spec.flags ?? []) {
    if (!required.has(flag)) parts.push(`[${flagSyntax(spec, flag)}]`);
  }
  return parts.join(' ');
}

function subcommandRows(node: HelpNode): Array<[string, string]> {
  return node.children.map((child) => [child.path.join(' '), nodeSummary(child)]);
}

/** 子命令列表（group 页与用法错误共用） */
function subcommandList(node: HelpNode): string[] {
  const rows = subcommandRows(node);
  return [
    `  ${ui.section(t('help.subcommands'))}`,
    align(rows, columnWidth(rows)),
    '',
    `  ${ui.dim(t('help.groupHelpHint'))}`,
  ];
}

function tryHint(path: readonly string[]): string {
  return ui.dim(t('help.tryCommand', { command: ['vessel', ...path].join(' ') }));
}

// ── 页面 ─────────────────────────────────────────

/** 命令页：一行 usage + 每 flag 一行说明；兼作命令的节点再附子命令列表 */
function renderCommandHelp(node: HelpNode): string {
  const spec = node.spec as CliHelpCommand;
  const flags = spec.flags ?? [];
  const rows: Array<[string, string]> = flags.map((flag) => [
    flagSyntax(spec, flag),
    flagDescription(spec, flag),
  ]);
  rows.push(['-h, --help', t('flag.help')]);

  const lines = [
    ui.title(['vessel', ...spec.path].join(' ')),
    `  ${t(spec.summary)}`,
    '',
    `  ${ui.section(t('help.usage'))}`,
    `  ${ui.brand(usageLine(spec))}`,
    '',
    `  ${ui.section(t('help.flags'))}`,
    align(rows, columnWidth(rows)),
  ];
  if (node.children.length > 0) lines.push('', ...subcommandList(node));
  return lines.join('\n');
}

/** 分组页：子命令列表（每行 = 子命令路径 + 摘要） */
function renderGroupHelp(node: HelpNode): string {
  const rows = subcommandRows(node);
  const lines = [
    ui.title(['vessel', ...node.path].join(' ')),
    `  ${nodeSummary(node)}`,
    '',
    `  ${ui.section(t('help.usage'))}`,
    `  ${ui.brand(['vessel', ...node.path, '<subcommand>'].join(' '))}`,
    '',
    `  ${ui.section(t('help.subcommands'))}`,
    align(rows, columnWidth(rows)),
    '',
    `  ${ui.dim(t('help.groupHelpHint'))}`,
  ];
  return lines.join('\n');
}

/** 全局总览：schema 纯投射（§8.7）+ 渲染层布局常量（段序/入口模式行）。
 * 命令行 = usageLine(spec)（与命令页同一函数）；新增命令自动落位（D-16 顺序收敛）。 */
export function renderGlobalHelp(): string {
  // 段布局常量（渲染层，不是命令声明）：顶层 group → 段；hub join 特例入 hubNode。
  const SECTION_OF_GROUP: Readonly<Record<string, string>> = {
    demo: 'usage',
    ps: 'gateway',
    status: 'gateway',
    agents: 'gateway',
    attention: 'gateway',
    team: 'gateway',
    federation: 'gateway',
    errors: 'gateway',
    gateway: 'gateway',
    token: 'gateway',
    node: 'gateway',
    stop: 'gateway',
    restart: 'gateway',
    fleet: 'gateway',
    session: 'gateway',
    permission: 'gateway',
    kanban: 'gateway',
    rpc: 'gateway',
    hub: 'hubService',
    eval: 'capability',
    config: 'config',
    model: 'config',
    plugin: 'plugins',
    migrate: 'migrate',
    trace: 'migrate',
    prune: 'migrate',
    dev: 'debug',
    doctor: 'meta',
    logs: 'meta',
    update: 'meta',
    completion: 'meta',
  };
  const sectionOf = (spec: CliHelpCommand): string => {
    if (spec.path[0] === 'hub' && spec.path[1] === 'join') return 'hubNode';
    return SECTION_OF_GROUP[spec.path[0] ?? ''] ?? 'meta';
  };
  const projected: Record<string, Array<[string, string]>> = {};
  for (const spec of OVERVIEW_COMMANDS) {
    const section = sectionOf(spec);
    const rows = projected[section] ?? [];
    rows.push([usageLine(spec), t(spec.summary)]);
    projected[section] = rows;
  }
  // 入口模式行（不是 schema 命令；存在性在 cli.ts 入口处理，help 只展示）
  const usage: Array<[string, string]> = [
    ['vessel', t('help.cmd.repl')],
    ...(projected.usage ?? []),
    ['vessel help [command]', t('help.cmd.helpCommand')],
    ['vessel help --search <query>', t('help.cmd.helpSearch')],
    ['vessel <command> --data-dir <path>', t('help.cmd.globalDataDir')],
    ['vessel <command> --user-config <path>', t('help.cmd.globalUserConfig')],
  ];
  const session: Array<[string, string]> = [
    ['vessel -c', t('help.cmd.continue')],
    ['vessel -r <id>', t('help.cmd.resume')],
    ['vessel -r', t('help.cmd.resumeList')],
    ['vessel --session <id>', t('help.cmd.session')],
  ];
  const headless: Array<[string, string]> = [
    ['vessel -p "<prompt>"', t('help.cmd.print')],
    ['vessel --run @path', t('help.cmd.runFile')],
    ['echo "..." | vessel --run', t('help.cmd.stdin')],
    ['vessel -c --run "..."', t('help.cmd.continueRun')],
    ['vessel --resume-run <runId>', t('help.cmd.resumeRun')],
  ];
  const gateway = projected.gateway ?? [];
  const hubService = projected.hubService ?? [];
  const hubNode = projected.hubNode ?? [];
  const capability: Array<[string, string]> = [
    ...(projected.capability ?? []),
    ['vessel --feishu', t('help.cmd.feishu')],
  ];
  const config: Array<[string, string]> = [
    ['vessel --data-dir <path> ...', t('help.cmd.dataDir')],
    ['vessel --connect <url> --connect-token <t> --ca <pem> ...', t('help.cmd.connect')],
    ...(projected.config ?? []),
  ];
  const plugins = projected.plugins ?? [];
  const migrate = projected.migrate ?? [];
  const debug: Array<[string, string]> = [
    ['VESSEL_MOCK=1 vessel --run "x"', t('help.cmd.mock')],
    ...(projected.debug ?? []),
  ];
  const meta: Array<[string, string]> = [
    ...(projected.meta ?? []),
    ['vessel --resume-run', t('help.cmd.resumeRunList')],
    ['vessel --version', t('help.cmd.version')],
    ['vessel --tools', t('help.cmd.tools')],
    ['vessel --help', t('help.cmd.help')],
  ];
  // 布局常量：对齐宽度上限（纯投射 usage 行可达 500+ 字符；超限行长行溢出，
  // 摘要紧随其后。上限 ≈ 现态精选表宽度，保持短行对齐观感。W1 parity 报告列明。）
  const width = Math.min(
    98,
    Math.max(
      ...[
        ...usage,
        ...session,
        ...headless,
        ...gateway,
        ...hubService,
        ...hubNode,
        ...capability,
        ...config,
        ...plugins,
        ...migrate,
        ...debug,
        ...meta,
      ].map(([cmd]) => cmd.length),
    ),
  );

  return [
    ui.title(t('help.title')),
    ui.rule(48),
    '',
    `  ${ui.section(t('help.section.usage'))}`,
    align(usage, width),
    '',
    `  ${ui.section(t('help.section.session'))}`,
    align(session, width),
    '',
    `  ${ui.section(t('help.section.headless'))}`,
    align(headless, width),
    `  ${ui.dim(t('help.note.askSuspended'))}`,
    '',
    `  ${ui.section(t('help.section.gateway'))}`,
    align(gateway, width),
    '',
    `  ${ui.section(t('help.section.hubService'))}`,
    align(hubService, width),
    '',
    `  ${ui.section(t('help.section.hubNode'))}`,
    align(hubNode, width),
    '',
    `  ${ui.section(t('help.section.capability'))}`,
    align(capability, width),
    '',
    `  ${ui.section(t('help.section.config'))}`,
    align(config, width),
    '',
    `  ${ui.section(t('help.section.plugins'))}`,
    align(plugins, width),
    '',
    `  ${ui.section(t('help.section.migrate'))}`,
    align(migrate, width),
    '',
    `  ${ui.section(t('help.section.debug'))}`,
    align(debug, width),
    '',
    `  ${ui.section(t('help.section.other'))}`,
    align(meta, width),
  ].join('\n');
}

// ── 入口 ─────────────────────────────────────────

export interface CliHelpPlan {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * 入口早退计划：`null` = 本次 argv 没请求 help。
 *
 * - 已知命令 / 分组 → stdout 页面，exit 0；
 * - 未知子命令 / 未知命令 → stderr（含该 group 的子命令列表 + `Try 'vessel ... --help'`），exit 2。
 */
export function planCliHelp(argv: readonly string[]): CliHelpPlan | null {
  if (!isHelpRequest(argv)) return null;
  const { node, rest } = resolveCliPath(argv);
  const unknown = unknownSubcommand(node, rest);
  if (unknown !== undefined) {
    const lines = [
      ui.err(t('help.unknownCommand', { command: [...node.path, unknown].join(' ') })),
    ];
    // 根节点不给全表（那是 stdout 全局总览的活）；分组给出自己的子命令列表。
    if (node.path.length > 0) lines.push(...subcommandList(node));
    lines.push(tryHint(node.path));
    return { stdout: '', stderr: lines.join('\n'), exitCode: 2 };
  }
  if (node.path.length === 0) return { stdout: renderGlobalHelp(), stderr: '', exitCode: 0 };
  if (node.spec === undefined) {
    return { stdout: renderGroupHelp(node), stderr: '', exitCode: 0 };
  }
  return { stdout: renderCommandHelp(node), stderr: '', exitCode: 0 };
}

/**
 * 用法错误的 stderr 正文：原始错误 + （纯分组时）子命令列表 + 该命令的 `--help` 提示。
 * 与 `planCliHelp` 共用同一份路径解析，因此提示永远指向用户刚敲的那条命令。
 */
export function renderUsageError(argv: readonly string[], error: string): string {
  const { node } = resolveCliPath(argv);
  const lines = [ui.err(error)];
  if (node.path.length > 0 && node.spec === undefined && node.children.length > 0) {
    lines.push(...subcommandList(node));
  }
  lines.push(tryHint(node.path));
  return lines.join('\n');
}
