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
  type CommandSpecBase,
  FLAG_DEFS,
  type FlagSpec,
  type FlagValueKind,
  flagDef,
  type ParsedCommand,
  PURE_GROUP_SUMMARIES,
} from './command-spec';
import type { CompletionCommand, CompletionSubcommand } from './completion-spec';
import type { CliFlag, CliHelpCommand } from './help-spec';

// ── 1. 执行分派投射 ──────────────────────────────

/** 分派条目（现 CliCommand 形状收敛：match = 路径相等，不再手写 args 字段判空）。 */
export interface DispatchEntry {
  readonly name: string;
  readonly match: (parsed: { readonly path: readonly string[] }) => boolean;
  readonly run: (
    parsed: ParsedCommand<CommandSpecBase>,
    ctx: CommandContext,
  ) => Promise<number | undefined>;
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
      return `<${value.candidates.join('|')}>`;
    default:
      return value.placeholder;
  }
}

/** 命令级覆盖查找（宽形状访问器）。 */
function flagOverride(
  spec: CommandSpec,
  flag: string,
): { readonly value?: FlagValueKind; readonly help?: MessageKey } | undefined {
  return (
    spec.flagOverrides as
      | Readonly<Record<string, { readonly value?: FlagValueKind; readonly help?: MessageKey }>>
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
  return (spec.flags ?? []).filter((flag) => flagDef(flag)?.hidden !== true);
}

/** CliHelpCommand[]（形状与今天 help-spec 一致；help.ts 建树 / 渲染零改动消费）。 */
export function projectHelp(schema: readonly CommandSpec[]): CliHelpCommand[] {
  return schema
    .filter((spec) => spec.hidden !== true)
    .map((spec) => {
      const flags = visibleFlags(spec);
      const required = flags.filter((flag) => flagDef(flag)?.required === true);
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
        ...(spec.positional !== undefined ? { args: spec.positional } : {}),
        ...(flags.length > 0 ? { flags: flags as CliFlag[] } : {}),
        ...(required.length > 0 ? { required: required as CliFlag[] } : {}),
        ...(Object.keys(flagValue).length > 0 ? { flagValue } : {}),
        ...(spec.usage !== undefined ? { usage: spec.usage } : {}),
        ...(Object.keys(flagHelp).length > 0 ? { flagHelp } : {}),
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
    if (def.hidden === true) continue;
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

/** flag → 静态候选（enum candidates；命令级覆盖优先）。 */
function specFlagValues(spec: CommandSpec): Record<string, readonly string[]> {
  const values: Record<string, readonly string[]> = {};
  for (const flag of visibleFlags(spec)) {
    const override = flagOverride(spec, flag)?.value;
    const def = flagDef(flag);
    const value = override ?? def?.value;
    if (value?.kind === 'enum') values[flag] = value.candidates;
  }
  return values;
}

interface CompletionNode {
  name: string;
  spec?: CommandSpec;
  children: Map<string, CompletionNode>;
}

/** 路径树 → 递归 subcommands（两级上限 workaround 删除；第三词起由投射表达）。 */
function buildCompletionSubcommands(node: CompletionNode): CompletionSubcommand[] {
  return [...node.children.values()].map((child) => {
    const flags = child.spec !== undefined ? visibleFlags(child.spec) : [];
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
    if (spec.hidden === true) continue;
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
    const flags = spec !== undefined ? visibleFlags(spec) : [];
    const flagValues = spec !== undefined ? specFlagValues(spec) : {};
    const subcommands = buildCompletionSubcommands(root);
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

/** 动态值 flag 清单（现 DYNAMIC_VALUE_FLAGS 派生：kind='dynamic' + 别名）。 */
export function projectDynamicValueFlags(): string[] {
  const flags: string[] = [];
  for (const def of Object.values(FLAG_DEFS) as FlagSpec[]) {
    if (def.value.kind !== 'dynamic' || def.hidden === true) continue;
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
