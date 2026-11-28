/**
 * Shell 补全的单一数据源（cli-single-source W1：手写表删除，输入换 schema 投射）。
 *
 * 命令/flag 声明唯一源 = command-spec.ts（FLAG_DEFS + COMMAND_SCHEMA）；
 * 本模块保留消费形状类型 + shell 常量 + 保留字派生函数，表值来自 project.ts。
 * 生成器（completion-script.ts）只读这里；逻辑零改动（Option A 加法递归除外）。
 *
 * 约定：
 * - 命令 token / flag 是命令行上的字面量；`registryName` 对应注册表里的 `name`，
 *   入口处直接处理的命令（`demo` / `--help` / `--version`）为 `null`。
 * - 动态值（session / agent id）不写进脚本：交给各 shell 的默认文件补全。
 *
 * @module vessel/completion-spec
 */

import {
  COMPLETION_TABLE,
  DYNAMIC_VALUE_FLAG_TABLE,
  GLOBAL_FLAG_TABLE,
  OPTIONAL_VALUE_FLAG_TABLE,
} from './project';

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
  /**
   * N 级子命令（cli-single-source Option A，main 终批）：三级及以上路径
   * （gateway nodes add / federation peer list / hub node remove / team budget
   * override）递归表达。加法可选字段，既有两级渲染语义不变；生成器加法递归分支。
   */
  subcommands?: readonly CompletionSubcommand[];
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

/** 顶层命令表（schema 投射；原手写 COMPLETION_COMMANDS 删除） */
export const COMPLETION_COMMANDS: readonly CompletionCommand[] = COMPLETION_TABLE;

/** 顶层与全局可用的 flags（global:true 派生；原手写 GLOBAL_FLAGS 删除） */
export const GLOBAL_FLAGS: readonly string[] = GLOBAL_FLAG_TABLE;

/** 动态值 flag（dynamic/number/optional-string 派生；原手写 DYNAMIC_VALUE_FLAGS 删除） */
export const DYNAMIC_VALUE_FLAGS: readonly string[] = DYNAMIC_VALUE_FLAG_TABLE;

/** 值可省略的 flag（optional-string 派生；原手写 OPTIONAL_VALUE_FLAGS 删除） */
export const OPTIONAL_VALUE_FLAGS: readonly string[] = OPTIONAL_VALUE_FLAG_TABLE;

/**
 * 内置顶层命令 token（不含 `--flag` 形式的入口 flag）。
 *
 * 插件 CLI 命名空间（`vessel <plugin> ...`）不得占用这些名字，
 * 否则会遮蔽内置命令（CONTRACT-0.48 §4）；manifest 校验与预解析共用这份列表。
 */
export function builtinCommandTokens(): string[] {
  const tokens: string[] = [];
  for (const command of COMPLETION_COMMANDS) {
    if (command.token.startsWith('-')) continue;
    if (!tokens.includes(command.token)) tokens.push(command.token);
  }
  return tokens;
}

/** 顶层候选词（命令 token + 全局 flags，去重保序） */
export function topLevelWords(): string[] {
  const words = new Set<string>();
  for (const command of COMPLETION_COMMANDS) words.add(command.token);
  for (const flag of GLOBAL_FLAGS) words.add(flag);
  return [...words];
}
