/**
 * schema → 六消费面投射（cli-single-source P1 · S1；设计 §3）。
 *
 * 纯函数，模块求值期构建一次（静态常量，O(命令数) 上界明确，宪法第十一条）。
 * 投射产物形状 = 今天的消费形状（CliHelpCommand[] / CompletionCommand[] /
 * 分派条目），渲染 / 生成 / 保留字消费逻辑零改动，只换输入源（设计 §2.1 原则 2）。
 *
 * 消费面：
 * 1. 执行分派（registry）→ projectDispatch
 * 2. argv 解析（parse-engine 读 schema 本体，非投射）
 * 3. 命令页 / 分组页 / 错误提示（help.ts）→ projectHelp + flag 表 + 分组摘要
 * 4. 全局总览（help.ts renderGlobalHelp）→ projectOverviewCommands（布局常量在渲染层）
 * 5. shell 补全（completion-script.ts）→ projectCompletion + 三份 flag 清单
 * 6. i18n 键声明 → schema 的 summary/help 引用（MessageKey 编译期守卫，无运行时投射）
 *
 * @module vessel/cli-project
 */

import type { MessageKey } from '../i18n';
import {
  COMMAND_SCHEMA,
  type CommandContext,
  type CommandSpec,
  FLAG_DEFS,
  type FlagSpec,
  type FlagValueKind,
  flagDef,
  type ParsedCommandBase,
  PURE_GROUP_SUMMARIES,
} from './command-spec';
import type { CompletionCommand, CompletionSubcommand } from './completion-spec';

// ── help 投射产物类型（原 help-spec.ts CliHelpCommand；W1 移居，消费形状不变） ──

/** 一条命令级 help 规格（help.ts 建树/渲染消费形状）。 */
export interface CliHelpCommand {
  /** 命令路径：`['gateway', 'start']`；首段必须是顶层命令字面量 */
  readonly path: readonly [string, ...string[]];
  /** 一句话摘要（i18n key） */
  readonly summary: MessageKey;
  /** 位置参数形态：必填 `<x>`、可选 `[x]`、变长 `<x...>` */
  readonly args?: string;
  /** 本命令接受的 flag（不含 `-h/--help`） */
  readonly flags?: readonly string[];
  /** 必填 flag：出现在 usage 行且不加方括号 */
  readonly required?: readonly string[];
  /** 同名 flag 在本命令里取值形态不同时的展示覆盖 */
  readonly flagValue?: Partial<Record<string, string>>;
  /** 互斥形态无法由 flag 列表表达时手写整行 usage */
  readonly usage?: string;
  /** 同名 flag 在本命令里含义不同时的覆盖说明 */
  readonly flagHelp?: Partial<Record<string, MessageKey>>;
  /** 退出码脚注（§8.5；缺省不声明 = 无脚注） */
  readonly exitCodes?: readonly { readonly code: number; readonly summary: MessageKey }[];
}

/** flag 字面量（原 CliFlag 白名单 → schema FLAG_DEFS 字面量联合；渲染层宽形状）。 */
export type CliFlag = string;

// ── 1. 执行分派投射 ──────────────────────────────

/** 分派条目（现 CliCommand 形状收敛：match = 路径相等，不再手写 args 字段判空）。 */
export interface DispatchEntry {
  readonly name: string;
  readonly match: (parsed: { readonly path: readonly string[] }) => boolean;
  readonly run: (parsed: ParsedCommandBase, ctx: CommandContext) => Promise<number | undefined>;
}

/** 顺序 = schema 数组顺序（命中即停语义保持；entry surface 在入口处理，不进分派）。 */
export function projectDispatch(schema: readonly CommandSpec[]): DispatchEntry[] {
  return schema
    .filter((spec) => spec.surface !== 'entry')
    .map((spec) => {
      const name = spec.path.join(' ');
      return {
        name,
        match: (parsed) => parsed.path.join(' ') === name,
        run: async (parsed, ctx) => (await spec.load()).run(parsed, ctx),
      };
    });
}

// ── flag 展示辅助（value.kind → help 占位，单一声明三处投射） ──

/** flag 的 usage 占位：boolean → null（无值）；enum → '<a|b>'；其余 → placeholder。 */
export function flagPlaceholder(value: FlagValueKind): string | null {
  switch (value.kind) {
    case 'boolean':
      return null;
    case 'enum':
      return value.placeholder ?? `<${value.candidates.join('|')}>`;
    default:
      return value.placeholder;
  }
}

/** 命令级覆盖查找（宽形状访问器）。 */
function flagOverride(
  spec: CommandSpec,
  flag: string,
):
  | {
      readonly value?: FlagValueKind;
      readonly help?: MessageKey;
      readonly missingError?: string;
      readonly invalidError?: (raw: string) => string;
      readonly hidden?: boolean;
      readonly local?: boolean;
      readonly candidates?: readonly string[];
    }
  | undefined {
  return (
    spec.flagOverrides as
      | Readonly<
          Record<
            string,
            | {
                readonly value?: FlagValueKind;
                readonly help?: MessageKey;
                readonly missingError?: string;
                readonly invalidError?: (raw: string) => string;
                readonly hidden?: boolean;
                readonly local?: boolean;
                readonly candidates?: readonly string[];
              }
            | undefined
          >
        >
      | undefined
  )?.[flag];
}

/** 命令级覆盖后的展示占位（现 flagValue 先例；渲染层 flagSyntax 消费）。 */
export function specFlagPlaceholder(spec: CommandSpec, flag: string): string | null {
  const override = flagOverride(spec, flag)?.value;
  const def = flagDef(flag);
  return flagPlaceholder(override ?? def?.value ?? { kind: 'boolean' });
}

/** 命令级覆盖后的说明键（现 flagHelp 先例；渲染层 flagDescription 消费）。 */
export function specFlagHelp(spec: CommandSpec, flag: string): MessageKey {
  const override = flagOverride(spec, flag)?.help;
  const def = flagDef(flag);
  return override ?? def?.help ?? ('flag.help' as MessageKey);
}

// ── 3. help 投射（命令页 / 分组页 / 错误提示） ──

/** 可见 flag（hidden 不渲染；-h/--help 渲染层统一追加，不在 spec）。 */
function visibleFlags(spec: CommandSpec): string[] {
  return (spec.flags ?? []).filter(
    (flag) => flagDef(flag)?.hidden !== true && flagOverride(spec, flag)?.hidden !== true,
  );
}

/** CliHelpCommand[]（形状与今天 help-spec 一致；help.ts 建树 / 渲染零改动消费）。 */
export function projectHelp(schema: readonly CommandSpec[]): CliHelpCommand[] {
  return schema
    .filter((spec) => spec.hidden !== true)
    .map((spec) => {
      const flags = visibleFlags(spec);
      const required = spec.required ?? flags.filter((flag) => flagDef(flag)?.required === true);
      const flagValue: Record<string, string> = {};
      const flagHelp: Record<string, MessageKey> = {};
      for (const flag of flags) {
        const overrideValue = flagOverride(spec, flag)?.value;
        const overrideHelp = flagOverride(spec, flag)?.help;
        if (overrideValue !== undefined) flagValue[flag] = flagPlaceholder(overrideValue) ?? '';
        if (overrideHelp !== undefined) flagHelp[flag] = overrideHelp;
      }
      return {
        path: spec.path as unknown as CliHelpCommand['path'],
        summary: spec.summary,
        ...(spec.positional !== undefined || spec.helpArgs !== undefined
          ? { args: spec.helpArgs ?? spec.positional }
          : {}),
        ...(flags.length > 0 ? { flags: flags as CliFlag[] } : {}),
        ...(required.length > 0 ? { required: required as CliFlag[] } : {}),
        ...(Object.keys(flagValue).length > 0 ? { flagValue } : {}),
        ...(spec.usage !== undefined ? { usage: spec.usage } : {}),
        ...(Object.keys(flagHelp).length > 0 ? { flagHelp } : {}),
        ...(spec.exitCodes !== undefined ? { exitCodes: spec.exitCodes } : {}),
      } satisfies CliHelpCommand;
    });
}

/** 纯分组摘要（现 CLI_HELP_GROUPS 中自身非命令的分组；存在性由 path 前缀派生）。 */
export function projectHelpGroups(): Readonly<Record<string, MessageKey>> {
  return PURE_GROUP_SUMMARIES;
}

/** flag → usage 占位表（现 CLI_FLAG_VALUE 替代；help.ts flagSyntax 消费）。 */
export function projectFlagValue(): Readonly<Record<string, string | null>> {
  const table: Record<string, string | null> = {};
  for (const [flag, def] of Object.entries(FLAG_DEFS) as [string, FlagSpec][]) {
    if (def.hidden === true) continue;
    table[flag] = flagPlaceholder(def.value);
  }
  return table;
}

/** flag → 说明键表（现 CLI_FLAG_HELP 替代；help.ts flagDescription 消费）。 */
export function projectFlagHelp(): Readonly<Record<string, MessageKey>> {
  const table: Record<string, MessageKey> = {};
  for (const [flag, def] of Object.entries(FLAG_DEFS) as [string, FlagSpec][]) {
    if (def.hidden === true || def.help === undefined) continue;
    table[flag] = def.help;
  }
  return table;
}

// ── 4. 全局总览投射（命令行来自 schema；段布局 / 入口模式常量在渲染层 help.ts） ──

/** 总览命令行（非 hidden；renderGlobalHelp 按布局常量分段 + usageLine 渲染）。 */
export function projectOverviewCommands(schema: readonly CommandSpec[]): CliHelpCommand[] {
  return projectHelp(schema);
}
// ── 5. 补全投射（N 级递归，Option A main 终批） ──

/** flag → 静态候选（enum candidates / 补全候选字段；命令级覆盖优先）。 */
function specFlagValues(spec: CommandSpec): Record<string, readonly string[]> {
  const values: Record<string, readonly string[]> = {};
  for (const flag of visibleFlags(spec)) {
    const override = flagOverride(spec, flag);
    const def = flagDef(flag);
    const value = override?.value ?? def?.value;
    const candidates =
      override?.candidates ??
      (value?.kind === 'enum' ? value.candidates : undefined) ??
      def?.candidates;
    if (candidates !== undefined) values[flag] = candidates;
  }
  return values;
}

/** 补全 flag 候选（含短别名；现态 completion 口径 -y/-n 在候选词中）。 */
function completionFlags(spec: CommandSpec): string[] {
  const flags: string[] = [];
  for (const flag of visibleFlags(spec)) {
    flags.push(flag, ...(flagDef(flag)?.aliases ?? []));
  }
  return flags;
}

interface CompletionNode {
  name: string;
  spec?: CommandSpec;
  children: Map<string, CompletionNode>;
}

/** 路径树 → 递归 subcommands（两级上限 workaround 删除；第三词起由投射表达）。 */
function buildCompletionSubcommands(node: CompletionNode): CompletionSubcommand[] {
  return [...node.children.values()].map((child) => {
    const flags = child.spec !== undefined ? completionFlags(child.spec) : [];
    const flagValues = child.spec !== undefined ? specFlagValues(child.spec) : {};
    const subcommands = buildCompletionSubcommands(child);
    return {
      name: child.name,
      ...(flags.length > 0 ? { flags } : {}),
      ...(Object.keys(flagValues).length > 0 ? { flagValues } : {}),
      ...(subcommands.length > 0 ? { subcommands } : {}),
    };
  });
}

/**
 * CompletionCommand[]（形状与今天 completion-spec 一致 + 递归 subcommands 加法）。
 * token 顺序 = schema 首现顺序；registryName = 顶层自身是命令 ? 路径 : null（entry）。
 * 每命令 flags = spec.flags 可见字面量（含显式声明的全局 flag，D-3 显式化修复）；
 * 全局 flag 兜底语义不变（GLOBAL_FLAGS 派生清单供顶层 / 生成器）。
 */
export function projectCompletion(schema: readonly CommandSpec[]): CompletionCommand[] {
  const roots = new Map<string, CompletionNode>();
  for (const spec of schema) {
    // hidden 不进补全；例外：entry 且带 flag 声明（help --search 先例，保留字 token）
    if (spec.hidden === true && !(spec.surface === 'entry' && (spec.flags?.length ?? 0) > 0)) {
      continue;
    }
    let node: CompletionNode | undefined;
    for (const [index, segment] of spec.path.entries()) {
      const children = node === undefined ? roots : node.children;
      let child = children.get(segment);
      if (child === undefined) {
        child = { name: segment, children: new Map() };
        children.set(segment, child);
      }
      if (index === spec.path.length - 1) child.spec = spec;
      node = child;
    }
  }
  return [...roots.values()].map((root) => {
    const spec = root.spec;
    const flags = spec !== undefined ? completionFlags(spec) : [];
    const flagValues = spec !== undefined ? specFlagValues(spec) : {};
    let subcommands = buildCompletionSubcommands(root);
    // 位置参数静态候选（completion <shell> 先例）：投射为候选词子命令形状
    if (spec?.positionalCandidates !== undefined && subcommands.length === 0) {
      subcommands = spec.positionalCandidates.map((name) => ({ name }));
    }
    const registryName =
      spec === undefined || spec.surface === 'entry' ? null : spec.path.join(' ');
    return {
      token: root.name,
      registryName,
      ...(subcommands.length > 0 ? { subcommands } : {}),
      ...(flags.length > 0 ? { flags } : {}),
      ...(Object.keys(flagValues).length > 0 ? { flagValues } : {}),
    };
  });
}

/** 全局 flag 清单（现 GLOBAL_FLAGS 派生：global:true + 别名，声明序保持）。 */
export function projectGlobalFlags(): string[] {
  const flags: string[] = [];
  for (const def of Object.values(FLAG_DEFS) as FlagSpec[]) {
    if (def.global !== true || def.hidden === true) continue;
    flags.push(def.flag, ...(def.aliases ?? []));
  }
  return flags;
}

/** 动态值 flag 清单（现 DYNAMIC_VALUE_FLAGS 派生：无静态候选 = dynamic/number/optional-string + 别名）。 */
export function projectDynamicValueFlags(): string[] {
  const flags: string[] = [];
  for (const def of Object.values(FLAG_DEFS) as FlagSpec[]) {
    if (def.hidden === true) continue;
    const kind = def.value.kind;
    if (kind !== 'dynamic' && kind !== 'number' && kind !== 'optional-string') continue;
    flags.push(def.flag, ...(def.aliases ?? []));
  }
  return flags;
}

/** 可省略值 flag 清单（现 OPTIONAL_VALUE_FLAGS 派生：kind='optional-string' + 别名）。 */
export function projectOptionalValueFlags(): string[] {
  const flags: string[] = [];
  for (const def of Object.values(FLAG_DEFS) as FlagSpec[]) {
    if (def.value.kind !== 'optional-string' || def.hidden === true) continue;
    flags.push(def.flag, ...(def.aliases ?? []));
  }
  return flags;
}

// ── 模块求值期构建一次（静态常量；消费面 W1/W2 切换输入源） ──

export const DISPATCH_ENTRIES: readonly DispatchEntry[] = projectDispatch(COMMAND_SCHEMA);
export const HELP_COMMANDS: readonly CliHelpCommand[] = projectHelp(COMMAND_SCHEMA);
export const HELP_GROUPS: Readonly<Record<string, MessageKey>> = projectHelpGroups();
export const FLAG_VALUE_TABLE: Readonly<Record<string, string | null>> = projectFlagValue();
export const FLAG_HELP_TABLE: Readonly<Record<string, MessageKey>> = projectFlagHelp();
export const OVERVIEW_COMMANDS: readonly CliHelpCommand[] = projectOverviewCommands(COMMAND_SCHEMA);
export const COMPLETION_TABLE: readonly CompletionCommand[] = projectCompletion(COMMAND_SCHEMA);
export const GLOBAL_FLAG_TABLE: readonly string[] = projectGlobalFlags();
export const DYNAMIC_VALUE_FLAG_TABLE: readonly string[] = projectDynamicValueFlags();
export const OPTIONAL_VALUE_FLAG_TABLE: readonly string[] = projectOptionalValueFlags();
