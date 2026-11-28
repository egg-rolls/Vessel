/**
 * CLI 命令单一真相源（cli-single-source P1 · S1）。
 *
 * 一条 CommandSpec 声明「命令是什么」：路径 / 摘要 / flag / 位置参数 / 约束 /
 * 路由面 / 懒实现引用。六消费面（执行分派 / argv 解析 / 命令页 help / 全局总览 /
 * shell 补全 / i18n 键声明）全部由 `project.ts` 纯函数投射，任何消费面不再手写
 * 命令 / flag 清单（设计 §2.1 / §3）。
 *
 * **纯数据硬约束**（S4 §2.3 help 早退零 IO）：本模块静态 import 闭包只含
 * 纯数据 + 轻校验器 + i18n 类型，**无 commands/* 实现**——实现经 `load()` 动态
 * thunk 懒加载，分派投射模块的 dynamic import 边界保持（cli.ts 先例）。
 *
 * 类型互锁（设计 D3 / §8.4 main 裁定：优先映射类型全推断）：
 * - `ParsedFlags<S>` 由 spec.flags 字面量联合映射——run 读未声明 flag = 编译红；
 * - summary 键由 path 约定派生（help.cmd.<camelPath>，§8.8 main 裁定），
 *   派生键不在 catalog 时强制显式声明。
 *
 * @module vessel/cli-command-spec
 */

import type { MessageKey } from '../i18n';

// ── flag 取值形态（单一声明，三处投射：解析 arity / help 占位 / 补全候选） ──

/** flag 取值形态（设计 §2.2 sketch）。 */
export type FlagValueKind =
  | { readonly kind: 'boolean' }
  | {
      readonly kind: 'string';
      readonly placeholder: string;
      readonly parse?: (raw: string) => { ok: true; value: string } | { ok: false; error: string };
    }
  | {
      readonly kind: 'number';
      readonly placeholder: string;
      readonly parse: (raw: string) => number | null;
    }
  | { readonly kind: 'enum'; readonly candidates: readonly string[] }
  | { readonly kind: 'dynamic'; readonly placeholder: string }
  | { readonly kind: 'optional-string'; readonly placeholder: string };

/** 一个 flag 的完整声明（合并现 CLI_FLAG_VALUE / CLI_FLAG_HELP / 补全三清单 / 解析校验）。 */
export interface FlagSpec {
  /** 长字面量 '--instance'（const 推断下为字面量类型成员） */
  readonly flag: string;
  /** 短别名 '-n'（今天只活在补全/解析，收敛到此；解析归一 + 补全候选） */
  readonly aliases?: readonly string[];
  readonly value: FlagValueKind;
  /** 说明键（现 CLI_FLAG_HELP） */
  readonly help: MessageKey;
  /** 全局 flag（现 GLOBAL_FLAGS）：任何命令可叠加，入口层处理 */
  readonly global?: boolean;
  /** 必填（现 CliHelpCommand.required）：usage 行不加方括号 */
  readonly required?: boolean;
  /** 弃用 warning 键（--stop-nodes 先例）：解析保留 + warning，help 带弃用标注 */
  readonly deprecated?: MessageKey;
  /** 解析但不渲染 / 不补全（内部 --orchestrate / --handoff 先例） */
  readonly hidden?: boolean;
  /** 可重复 flag（--filter / --allowed-origin / --mention 先例）：产物为数组 */
  readonly repeatable?: boolean;
  /** 缺值错误文案（现态 parser 口径 parity；缺省 `Missing value for <flag>`） */
  readonly missingError?: string;
  /** 非法值错误文案（现态 parser 口径 parity；缺省 `Invalid value for <flag>: <raw>`） */
  readonly invalidError?: (raw: string) => string;
}

// ── flag 规范表（每个 flag 单一声明；命令以字面量引用） ──

/**
 * 全部 flag 的规范声明（合并现 CLI_FLAG_VALUE / CLI_FLAG_HELP / 补全三清单 /
 * 解析校验器）。命令 spec.flags 只写字面量引用此表——flag 数据不重复，
 * 字面量 ⊆ keyof FLAG_DEFS 编译期校验（D3 守卫）。S2-S4 转录现态。
 * 实施微调（设计 sketch flags: FlagSpec[] → 字面量引用 + 规范表，候 lead 知悉）：
 * 守卫强度不变（ParsedFlags 仍由声明字面量映射），消除 ~96 命令的 FlagSpec 重复。
 */
export const FLAG_DEFS = {} as const satisfies Readonly<Record<string, FlagSpec>>;

/** flag 字面量联合（取代现 CliFlag 白名单）。 */
export type FlagLiteral = keyof typeof FLAG_DEFS;

/** 运行时 flag 规范查找（宽形状访问器；字面量互锁经 ParsedFlags 映射，不在此）。 */
export function flagDef(flag: string): FlagSpec | undefined {
  return (FLAG_DEFS as Readonly<Record<string, FlagSpec>>)[flag];
}

// ── 全局 / 入口层字段（现 CliArgs 全局字段原样保留；逐命令字段删除） ──

/**
 * 全局与入口模式字段（parse-engine 全局层产物）。
 * 语义与现 CliArgs 同名字段逐一对应（语义零变化硬验收）；
 * 入口模式（REPL / -c / -r / -p / --run / --serve）不是 schema 命令，
 * 由 cli.ts 入口处理（设计 §3.1 / §3.4）。
 */
export interface Globals {
  demo: boolean;
  /** null = 非 headless；'' = 从 stdin 读；非空 = 文本 prompt 或 @file */
  runArg: string | null;
  pipeMode: boolean;
  sessionArg: string | null;
  continueArg: boolean;
  /** null = 未使用；'' = 列出会话；非空 = 恢复该会话 */
  resumeArg: string | null;
  /** null = 不启动 gateway；0 = 由系统分配端口 */
  servePort: number | null;
  servePortExplicit: boolean;
  serveHost: string | null;
  allowRemote: boolean;
  tlsCert: string | null;
  tlsKey: string | null;
  /** null = 未使用；'' = 列出可恢复 run；非空 = 恢复该 run */
  resumeRunArg: string | null;
  help: boolean;
  version: boolean;
  tools: boolean;
  feishu: boolean;
  connectArg: string | null;
  connectTokenArg: string | null;
  caArg: string | null;
  nodeTargetArg: string | null;
  allowedOrigins: string[];
  dataDirArg: string | null;
  userConfigArg: string | null;
}

/** 一次性命令执行上下文（现 CliCommandContext 形状不变）。 */
export interface CommandContext {
  /** `VESSEL_MOCK=1|true` */
  useMock: boolean;
  /** 已解析配置（入口可注入；hub 等命令缺省自行 loadConfig）。 */
  config?: import('../../packages/config/src/index').VesselConfig;
}

// ── ParsedFlags 映射推断（§8.4 强守卫形态） ──

/** 单个 flag 的解析产物类型（由 value.kind + repeatable 映射）。 */
export type FlagBaseValue<F extends FlagSpec> = F['value'] extends { kind: 'boolean' }
  ? boolean
  : F['value'] extends { kind: 'number' }
    ? number | undefined
    : F['value'] extends { kind: 'enum'; candidates: readonly (infer C)[] }
      ? C | undefined
      : string | undefined;

export type FlagParsedValue<F extends FlagSpec> = F extends { repeatable: true }
  ? Exclude<FlagBaseValue<F>, undefined>[] | undefined
  : FlagBaseValue<F>;

/** spec.flags 字面量联合 → 解析产物映射（run 读未声明 flag = 编译红）。 */
export type ParsedFlags<S extends { readonly flags?: readonly FlagLiteral[] }> = {
  [K in NonNullable<S['flags']>[number]]: FlagParsedValue<(typeof FLAG_DEFS)[K]>;
};

/** 引擎产物：flag 映射 + 位置参数 + 全局层。 */
export interface ParsedCommand<S extends { readonly flags?: readonly FlagLiteral[] }> {
  readonly flags: ParsedFlags<S>;
  readonly positionals: readonly string[];
  readonly globals: Globals;
}
// ── i18n 键 path 约定派生（§8.8 main 裁定） ──

/** 'install-service' → 'installService'（类型级）。 */
type CamelCase<S extends string> = S extends `${infer H}-${infer T}`
  ? `${H}${Capitalize<CamelCase<T>>}`
  : S;

/** ['gateway','nodes','list'] → 'gatewayNodesList'（类型级）。 */
type CamelPath<P extends readonly string[]> = P extends readonly [
  infer H extends string,
  ...infer T extends readonly string[],
]
  ? T extends readonly []
    ? CamelCase<H>
    : `${CamelCase<H>}${Capitalize<CamelPath<T>>}`
  : '';

/** 派生摘要键：help.cmd.<camelPath>。 */
export type DefaultSummaryKey<P extends readonly string[]> = `help.cmd.${CamelPath<P>}`;

/** 运行时派生（与类型级 CamelPath 同口径；投射层用）。 */
export function defaultSummaryKey(path: readonly string[]): string {
  const camel = path
    .map((segment, index) => {
      const parts = segment.split('-');
      const head = parts[0] ?? '';
      const tail = parts
        .slice(1)
        .map((p) => (p === '' ? '' : (p[0]?.toUpperCase() ?? '') + p.slice(1)))
        .join('');
      const joined = head + tail;
      return index === 0
        ? joined
        : joined === ''
          ? ''
          : (joined[0]?.toUpperCase() ?? '') + joined.slice(1);
    })
    .join('');
  return `help.cmd.${camel}`;
}

/**
 * 摘要键约束：派生键 ∈ MessageKey 时 summary 可省（投射层派生）；
 * 否则强制显式 MessageKey（既有键不合约定者，如 gateway install-service →
 * help.cmd.gatewayInstall）。编译期守卫不降（D3）。
 */
export type SummaryField<P extends readonly string[]> =
  DefaultSummaryKey<P> extends MessageKey
    ? { readonly summary?: MessageKey }
    : { readonly summary: MessageKey };

// ── CommandSpec ──

/** 命令声明数据面（设计 §2.2 sketch；实施微调见 PLAN §3.4 / S1 决策报告）。 */
export interface CommandSpecBase {
  /** N 级路径：['gateway','nodes','add']，无两级上限 */
  readonly path: readonly [string, ...string[]];
  /** 位置参数形态：'<name>' / '[<hub-url>]' / '<member> <content...>' */
  readonly positional?: string;
  /** 本命令 flag 字面量（引用 FLAG_DEFS；不含 -h/--help，渲染统一追加） */
  readonly flags?: readonly FlagLiteral[];
  /** 命令级覆盖（现 flagValue/flagHelp：同名 flag 取值形态/含义因命令而异；展示层） */
  readonly flagOverrides?: Readonly<
    Partial<Record<FlagLiteral, { readonly value?: FlagValueKind; readonly help?: MessageKey }>>
  >;
  /** 互斥形态无法由 flag 列表表达时手写整行 usage（attention respond 先例） */
  readonly usage?: string;
  /** 互斥组（如 --allow|--deny|--answers） */
  readonly exclusive?: readonly (readonly FlagLiteral[])[];
  /** 互斥错误文案（现态 parser 口径 parity；缺省 `<a> and <b> cannot be combined`） */
  readonly exclusiveError?: string;
  /** 位置参数错误文案 parity：missing 整句；extra 前缀（Unexpected / Unknown argument） */
  readonly positionalErrors?: {
    readonly missing?: string;
    readonly extra?: 'unexpected' | 'unknown';
  };
  /** 路由面：one-shot 进注册表 / foreground 进前台管线 / entry 在入口处理 */
  readonly surface: 'one-shot' | 'foreground' | 'entry';
  /** 命令页脚注投射（§8.5；缺省不声明 = 无脚注） */
  readonly exitCodes?: readonly { readonly code: number; readonly summary: MessageKey }[];
  /** 不进总览/补全（内部命令面） */
  readonly hidden?: boolean;
}

/** 完整 CommandSpec（含懒实现引用；投射消费的基础形状）。 */
export interface CommandSpec extends CommandSpecBase {
  readonly summary: MessageKey;
  /** 纯分组（自身非命令）摘要（现 CLI_HELP_GROUPS）；兼作命令的分组用自身 summary */
  readonly groupSummary?: MessageKey;
  /** 跨字段约束（selector 互斥 / --self 规则）；返回错误文案或 null */
  readonly validate?: (parsed: ParsedCommand<CommandSpecBase>) => string | null;
  /** 懒实现引用：动态 import + flags→域选项映射（机械转录自现 registry 包装器） */
  readonly load: () => Promise<{
    run: (
      parsed: ParsedCommand<CommandSpecBase>,
      ctx: CommandContext,
    ) => Promise<number | undefined>;
  }>;
}

/**
 * 定义一条命令（const 泛型保留 flag/path 字面量 → ParsedFlags 映射互锁）。
 * summary 缺省时由 path 派生（§8.8）；派生键不在 catalog 时类型强制显式。
 * validate 接收完整 ParsedCommand（flags + positionals + globals；实施微调：
 * 跨字段约束需读全局层，如 stop 的 connect×selector，候 lead 知悉）。
 */
export function defineCommand<const S extends CommandSpecBase>(
  spec: S &
    SummaryField<S['path']> & {
      readonly groupSummary?: MessageKey;
      readonly validate?: (parsed: ParsedCommand<S>) => string | null;
      readonly load: () => Promise<{
        run: (parsed: ParsedCommand<S>, ctx: CommandContext) => Promise<number | undefined>;
      }>;
    },
): CommandSpec {
  const summary = (spec as { summary?: MessageKey }).summary;
  return {
    ...spec,
    summary: summary ?? (defaultSummaryKey(spec.path) as MessageKey),
  } as CommandSpec;
}

/**
 * 纯分组（自身非命令）摘要（现 CLI_HELP_GROUPS 中无独立命令的分组，如
 * 'gateway nodes' / 'federation peer' / 'hub node'）。分组**存在性**由命令
 * path 前缀派生（buildHelpTree），此表只声明摘要文案——仍在 schema 模块单一源。
 * 兼作命令的分组（team budget / attention）用自身 summary，不在此表。
 * S2-S4 转录现态 CLI_HELP_GROUPS 时核对哪些是纯分组。
 */
export const PURE_GROUP_SUMMARIES: Readonly<Record<string, MessageKey>> = {};

/**
 * 内置命令 schema（唯一声明处）。顺序 = 现 registry 命中即停顺序 + help 分组页
 * 排列同源（help-spec.ts:295 注释）。S1 为空壳；S2-S4 分批改录现态四份声明。
 * 插件命令不进内置 schema（另走 plugin-cli 预解析，CONTRACT-0.48 §4）。
 */
export const COMMAND_SCHEMA: readonly CommandSpec[] = [];
