/**
 * 通用 argv 解析引擎（cli-single-source P1 · S1；设计 §3.2）。
 *
 * 读 schema（command-spec.ts）驱动解析，替代现 args.ts 顶层 if 链 + 逐命令
 * parseXxxArgs 的重复 flag 循环。**不是第二套解析**：手写 parser 同窗口删除，
 * 引擎是 schema 的解析投射（D2）。自定义校验纯函数（parsePort/parseTimeoutMs/
 * parseInstanceName/selector 等）保留为 FLAG_DEFS.value.parse / spec.validate 引用。
 *
 * 六步（设计 §3.2）：
 * 1. 全局前置摘出（--user-config 先例；--data-dir/targeting 入口层 S5 转录）
 * 2. 路径树最长前缀匹配（与 help.ts resolveNode 同算法）
 * 3. flag 表驱动解析（arity 由 value.kind；--flag=value 统一；别名归一；未知报错）
 * 4. 位置参数收集（必填 / 可选 / 变长 greedy）
 * 5. 约束校验（required / exclusive / validate）
 * 6. help 短路（-h/--help 任何位置，不校验其余参数；渲染仍由入口 planCliHelp 早退）
 *
 * 产物：{ path, flags, positionals, globals, help }。语义零变化是硬验收：
 * 边角语义（--resume 无值=列表 / --serve 缺省端口 / selector 归一 / --self 规则 /
 * attention respond 多形态）以 value.parse / spec.validate / positional 承接，
 * S5 逐命令对照现态 parser 核对；无法声明表达 → 停下报 lead，不造第二套。
 *
 * @module vessel/cli-parse-engine
 */

import {
  COMMAND_SCHEMA,
  type CommandSpec,
  FLAG_DEFS,
  type FlagSpec,
  type FlagValueKind,
  flagDef,
  type Globals,
  PURE_GROUP_ERRORS,
} from './command-spec';

/** 引擎产物（flags 在 thunk 边界经 ParsedFlags 映射互锁；引擎内部为宽形状）。 */
export interface EngineParsed {
  readonly path: readonly string[];
  readonly flags: Readonly<Record<string, unknown>>;
  readonly positionals: readonly string[];
  readonly globals: Globals;
  readonly help: boolean;
}

export type EngineResult = { ok: true; parsed: EngineParsed } | { ok: false; error: string };

/** 全局层默认值（与现 parseArgs 初始化逐一对应；入口 flag 解析 S5 转录）。 */
export function defaultGlobals(): Globals {
  return {
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
    feishu: false,
    connectArg: null,
    connectTokenArg: null,
    caArg: null,
    nodeTargetArg: null,
    allowedOrigins: [],
    dataDirArg: null,
    userConfigArg: null,
  };
}

// ── 1. 全局前置摘出（--user-config，extractUserConfigFlag 先例原样转录） ──

function extractUserConfig(
  argv: readonly string[],
): { ok: true; argv: string[]; value: string | null } | { ok: false; error: string } {
  const rest: string[] = [];
  let value: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--user-config') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-') || next.trim() === '') {
        return { ok: false, error: 'Missing value for --user-config' };
      }
      value = next;
      i++;
      continue;
    }
    if (a.startsWith('--user-config=')) {
      const inline = a.slice('--user-config='.length).trim();
      if (inline === '') return { ok: false, error: 'Missing value for --user-config' };
      value = inline;
      continue;
    }
    rest.push(a);
  }
  return { ok: true, argv: rest, value };
}

// ── 2. 路径树最长前缀匹配 ──────────────────────────

interface PathNode {
  spec?: CommandSpec;
  children: Map<string, PathNode>;
}

function buildPathTree(schema: readonly CommandSpec[]): PathNode {
  const root: PathNode = { children: new Map() };
  for (const spec of schema) {
    let node = root;
    for (const segment of spec.path) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.spec = spec;
  }
  return root;
}

const PATH_ROOT = buildPathTree(COMMAND_SCHEMA);

/** argv 开头非 flag 连续段的最长已知前缀（help.ts commandTokens/resolveNode 同算法）。 */
function matchPath(argv: readonly string[]): { node: PathNode; path: string[]; rest: string[] } {
  let node = PATH_ROOT;
  const path: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? '';
    if (token.startsWith('-')) break;
    const child = node.children.get(token);
    if (child === undefined) break;
    node = child;
    path.push(token);
    index += 1;
  }
  return { node, path, rest: argv.slice(index) as string[] };
}
// ── 3. flag 表驱动解析 ─────────────────────────────

/** 别名 → 规范 flag 归一表（模块求值期构建一次）。 */
const ALIAS_TO_FLAG: Readonly<Record<string, string>> = (() => {
  const table: Record<string, string> = {};
  for (const def of Object.values(FLAG_DEFS) as FlagSpec[]) {
    for (const alias of def.aliases ?? []) table[alias] = def.flag;
  }
  return table;
})();

/** 全局 flag → Globals 字段写回（现 parser 口径：--data-dir/targeting 写全局字段）。 */
const GLOBALS_FLAG_MAP: Readonly<Record<string, keyof Globals>> = {
  '--data-dir': 'dataDirArg',
  '--connect': 'connectArg',
  '--connect-token': 'connectTokenArg',
  '--ca': 'caArg',
  '--node': 'nodeTargetArg',
};

interface FlagParseState {
  flags: Record<string, unknown>;
  positionals: string[];
  help: boolean;
}

/** 单 token 是否 flag 形态（含别名 / 内联 =）。 */
function flagToken(token: string): boolean {
  return token.startsWith('-') && token !== '-';
}

/** 规范 flag 名（别名归一；内联 = 拆分）。 */
function canonicalFlag(token: string): { flag: string; inline?: string } {
  const eq = token.indexOf('=');
  const head = eq >= 0 ? token.slice(0, eq) : token;
  const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
  const flag = ALIAS_TO_FLAG[head] ?? head;
  return inline === undefined ? { flag } : { flag, inline };
}

/** 解析命中命令的剩余 argv（spec.flags 驱动；未知 flag 报错不静默）。 */
function parseCommandArgs(
  spec: CommandSpec,
  rest: readonly string[],
  globals: Globals,
): FlagParseState | { error: string } {
  const accepted = new Set<string>(spec.flags ?? []);
  const state: FlagParseState = { flags: {}, positionals: [], help: false };
  // boolean 缺省 false（现 parser 口径：未出现 = false）
  for (const flag of accepted) {
    const def = flagDef(flag);
    if (def?.value.kind === 'boolean') state.flags[flag] = false;
  }
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? '';
    if (token === '-h' || token === '--help' || token.startsWith('--help=')) {
      state.help = true;
      continue;
    }
    if (!flagToken(token)) {
      state.positionals.push(token);
      continue;
    }
    const { flag, inline } = canonicalFlag(token);
    if (!accepted.has(flag)) {
      return { error: `Unknown argument: ${token}` };
    }
    const def = flagDef(flag) as FlagSpec;
    const override = (
      spec.flagOverrides as
        | Readonly<
            Record<
              string,
              | {
                  value?: FlagValueKind;
                  missingError?: string;
                  invalidError?: (raw: string) => string;
                }
              | undefined
            >
          >
        | undefined
    )?.[flag];
    const value = override?.value ?? def.value;
    const missingError = override?.missingError ?? def.missingError;
    const invalidError = override?.invalidError ?? def.invalidError;
    if (value.kind === 'boolean') {
      if (inline !== undefined) return { error: `Unknown argument: ${token}` };
      state.flags[flag] = true;
      continue;
    }
    // 取值：内联优先；否则看下一 token（optional-string 可省略）。
    let raw: string | undefined = inline;
    if (raw === undefined) {
      const next = rest[i + 1];
      const dashOk = flag === '--connect-token';
      if (next !== undefined && next.trim() !== '' && (dashOk || !next.startsWith('-'))) {
        raw = next;
        i++;
      } else if (value.kind === 'optional-string') {
        raw = '';
      } else {
        return { error: missingError ?? `Missing value for ${flag}` };
      }
    }
    let parsedValue: unknown;
    if (value.kind === 'number') {
      const parsed = value.parse(raw);
      if (parsed === null) {
        return { error: invalidError?.(raw) ?? `Invalid value for ${flag}: ${raw}` };
      }
      parsedValue = parsed;
    } else if (value.kind === 'enum') {
      if (!value.candidates.includes(raw)) {
        return { error: invalidError?.(raw) ?? `Invalid value for ${flag}: ${raw}` };
      }
      parsedValue = raw;
    } else if (value.kind === 'string' && value.parse !== undefined) {
      const parsed = value.parse(raw);
      if (!parsed.ok) return { error: parsed.error };
      parsedValue = parsed.value;
    } else if (value.kind === 'dynamic' && value.parse !== undefined) {
      const parsed = value.parse(raw);
      if (!parsed.ok) return { error: parsed.error };
      parsedValue = parsed.value;
    } else {
      parsedValue = raw;
    }
    if (def.repeatable === true) {
      const list = (state.flags[flag] as unknown[] | undefined) ?? [];
      list.push(parsedValue);
      state.flags[flag] = list;
    } else {
      state.flags[flag] = parsedValue;
    }
    const globalsKey = GLOBALS_FLAG_MAP[flag];
    if (globalsKey !== undefined && typeof parsedValue === 'string') {
      (globals as unknown as Record<string, unknown>)[globalsKey] = parsedValue;
    }
  }
  return state;
}

// ── 4/5. 位置参数形态 + 约束校验 ───────────────────

/** positional 形态解析：'<name>' 必填 / '[<x>]' 可选 / '<content...>' 变长 greedy。 */
function checkPositionals(spec: CommandSpec, positionals: readonly string[]): string | null {
  const form = spec.positional;
  if (form === undefined) {
    return positionals.length === 0 ? null : `Unknown argument: ${positionals[0]}`;
  }
  const parts = form.split(/\s+/).filter((p) => p !== '');
  let required = 0;
  let variadic = false;
  for (const part of parts) {
    if (part.includes('...')) variadic = true;
    else if (part.startsWith('<')) required += 1;
  }
  if (positionals.length < required) {
    return spec.positionalErrors?.missing ?? `Missing argument: ${form}`;
  }
  if (!variadic && positionals.length > parts.length) {
    const token = positionals[parts.length] ?? '';
    return spec.positionalErrors?.extra?.(token) ?? `Unknown argument: ${token}`;
  }
  return null;
}

/** required / exclusive / validate（错误文案现态口径 S5 逐命令核对）。 */
async function checkConstraints(
  spec: CommandSpec,
  state: FlagParseState,
  globals: Globals,
): Promise<string | null> {
  const requiredFlags =
    spec.required ?? (spec.flags ?? []).filter((f) => flagDef(f)?.required === true);
  for (const flag of requiredFlags) {
    if (state.flags[flag] === undefined) {
      return spec.requiredError?.(flag) ?? `Missing required flag: ${flag}`;
    }
  }
  for (const group of spec.exclusive ?? []) {
    const present = group.filter((flag) => {
      const v = state.flags[flag];
      return v !== undefined && v !== false && v !== '';
    });
    if (present.length > 1) {
      return spec.exclusiveError ?? `${present.join(' and ')} cannot be combined`;
    }
  }
  if (spec.validate !== undefined) {
    return await spec.validate({
      flags: state.flags as never,
      positionals: state.positionals,
      globals,
    });
  }
  return null;
}

// ── 入口：parseBySpec ──────────────────────────────

/**
 * 解析 argv（不含 node/bun 与脚本路径）。
 * S1 骨架：全局前置摘出 + 路径匹配 + 逐命令解析 + 约束。
 * 入口模式层（REPL/serve/headless 全局 flag switch + 互斥校验）S5 自现态
 * parseArgs 965-1250 机械转录；未命中命令路径时当前返回空路径产物（入口层接管）。
 */
export async function parseBySpec(argv: readonly string[]): Promise<EngineResult> {
  const userConfig = extractUserConfig(argv);
  if (!userConfig.ok) return userConfig;
  const globals = defaultGlobals();
  globals.userConfigArg = userConfig.value;

  const { node, path, rest } = matchPath(userConfig.argv);
  const spec = node.spec;
  if (spec === undefined) {
    // 无命令路径命中：入口模式（S5 转录全局 flag switch + 校验）；
    // 纯分组 + 未知子命令 → 用法错误（renderUsageError 指路，exit 2）。
    if (path.length > 0 && node.children.size > 0) {
      const unknown = rest.find((token) => !token.startsWith('-'));
      if (unknown !== undefined) {
        const groupError = PURE_GROUP_ERRORS[path.join(' ')];
        return { ok: false, error: groupError?.(unknown) ?? `Unknown argument: ${unknown}` };
      }
      // 纯分组裸调用（fleet / session / permission 先例）：help 兜底 → 全局总览 exit 0。
      return { ok: true, parsed: { path, flags: {}, positionals: [], globals, help: true } };
    }
    return { ok: true, parsed: { path, flags: {}, positionals: rest, globals, help: false } };
  }

  const state = parseCommandArgs(spec, rest, globals);
  if ('error' in state) return { ok: false, error: state.error };
  if (!state.help) {
    const positionalError = checkPositionals(spec, state.positionals);
    if (positionalError !== null) return { ok: false, error: positionalError };
    const constraintError = await checkConstraints(spec, state, globals);
    if (constraintError !== null) return { ok: false, error: constraintError };
  }
  return {
    ok: true,
    parsed: {
      path,
      flags: state.flags,
      positionals: state.positionals,
      globals,
      help: state.help,
    },
  };
}
