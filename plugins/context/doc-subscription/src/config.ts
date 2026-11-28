/**
 * @vessel-agent/doc-subscription - 配置解析
 * @module @vessel-agent/doc-subscription/config
 *
 * 同时接受 camelCase 与 snake_case；未知键忽略。所有数值缺省时回落到默认值，
 * 非法值（非有限数 / 非正数）同样回落，避免配置错误让插件整体失效。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { EnvCadence, EnvChannel } from '@vessel-agent/core';

/**
 * 订阅脚本调度（q-subscription-script，设计 §2.3；P1 裁点变更）：
 * - 'run'（缺省）：每 run 首请求 kickoff；
 * - 'request'：每请求检查 kickoff（单飞约束下实际频率 = 脚本时长上限）；
 * - { intervalSeconds: N }：**真 timer**（q-subscription-script-p1，推翻 P0 裁点 4 惰性）——
 *   ScriptRunner 每订阅 setInterval，idle 也跑；单飞保持；结果仍在 BeforeLlm drain
 *   （ambient 非打断）；remove / dispose / allowlist 删名 / scope off ⇒ disarm。
 */
export type ScriptSchedule = 'run' | 'request' | { intervalSeconds: number };

/**
 * 一条订阅脚本声明（用户配置 allowlist，fail-closed 信任边界，设计 §2.7）：
 * 命令本体只来自用户配置；模型经 subscribe 工具只能按名订阅已声明的脚本，
 * 不能注入 / 修改命令。argv 数组 spawn，无 shell。
 */
export interface ScriptSpec {
  /** 订阅名（唯一键，[A-Za-z0-9_-]{1,64}） */
  name: string;
  /** argv 数组（非空，全字符串；无 shell） */
  command: string[];
  /** 脚本 cwd；缺省 = 装配层 agent cwd（config.cwd） */
  cwd?: string;
  /** 调度（缺省 'run'） */
  schedule: ScriptSchedule;
  /** 输出模式（缺省 'diff'：与上一版 stdout 做差异；'full'：每次非空投全文） */
  output: 'diff' | 'full';
  /** 超时 kill（缺省 30s） */
  timeoutMs: number;
  /** stdout 上限（超出截断 + 标记；缺省 64KiB） */
  maxOutputBytes: number;
  /** 环境卡 scope 词（缺省 'script'；未登记词回落 'script'，fail-closed） */
  scope: string;
}

/** 脚本默认值 */
export const SCRIPT_DEFAULTS = {
  timeoutMs: 30000,
  maxOutputBytes: 65536,
} as const;

/**
 * 已登记的脚本 scope 词（字面量副本；生产侧真相 = config `DEFAULT_ENV_CADENCE`，
 * 依赖方向不能 import config）。案 B 注册制：通用兜底词 'script' + 内置检测器专词
 * doc-lag（doc-sync --quiet）/ code-heaviness（code-size）（q-subscription-script-p1）。
 * 未登记词回落 'script'（fail-closed，防词表无界增长）。
 */
export const REGISTERED_SCRIPT_SCOPES: readonly string[] = ['script', 'doc-lag', 'code-heaviness'];

/** 订阅名语法（与 node_id / 联邦 principal 同形） */
const SCRIPT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 订阅名是否合法（allowlist 键 / 工具面按名订阅的校验） */
export function isValidScriptName(name: string): boolean {
  return SCRIPT_NAME_RE.test(name);
}

/** 插件配置（解析后形态） */
export interface DocSubscriptionConfig {
  /** 订阅状态目录；per-session JSON 写在 `<stateDir>/sessions/` */
  stateDir: string;
  /**
   * 数据目录（生命周期消费读会话壳用；会话根 = `resolveSingleTenantPaths(dataDir).sessions_dir`）。
   * 缺省 `VESSEL_DATA_DIR` → `~/.vessel/data`（recall 同口径）；装配层会显式注入 `data_dir`。
   */
  dataDir: string;
  /** 相对路径解析基准 */
  cwd: string;
  /** 允许的根；空 = 不限制根（内置 denylist 仍生效） */
  allowedRoots: string[];
  /** 追加到内置 denylist 的敏感路径 */
  denyPaths: string[];
  /** 首次投递（或无快照时）允许内联的最大字节数 */
  maxFullBytes: number;
  /** unified diff 字节上限 */
  maxDiffBytes: number;
  /** unified diff 行数上限 */
  maxDiffLines: number;
  /** 每个 run 注入内容的总字节预算 */
  maxTotalBytesPerRun: number;
  /** false 时 install 直接返回，不注册工具与 hook */
  enabled: boolean;
  /**
   * 注入粒度（env_injection 框架轴 A）：scope → 检测节奏，由装配层按 `env_injection` 配置
   * 解析后注入（doc-subscription 只产 files）。缺省 undefined = 内置默认（files='run'，
   * 每 run 首请求观察一次）。
   */
  envGranularity?: Record<string, EnvCadence>;
  /**
   * 投递通道（env_injection 框架轴 C，P2）：scope → channel，由装配层按 `env_injection.channels`
   * 解析后注入（doc-subscription 只产 files）。缺省 undefined = 内置默认（model+ui，零回归）。
   * `ui-only` ⇒ hook 只落 UI 卡事实（ctx.emitFact），不写 ctx.messages（模型不收）。
   */
  envChannels?: Record<string, EnvChannel>;
  /**
   * 订阅脚本 allowlist（q-subscription-script）：用户配置声明的检测命令清单。
   * 整块非法 / 缺省 ⇒ 空清单（fail-closed，不崩插件）；subscribe source:'script'
   * 只认这里声明过的名字。
   */
  scripts: ScriptSpec[];
}

/** 默认值 */
export const DEFAULT_CONFIG: Readonly<DocSubscriptionConfig> = {
  stateDir: path.join(os.homedir(), '.vessel', 'subscriptions'),
  dataDir: path.join(os.homedir(), '.vessel', 'data'),
  cwd: process.cwd(),
  allowedRoots: [],
  denyPaths: [],
  maxFullBytes: 102400,
  maxDiffBytes: 16384,
  maxDiffLines: 200,
  maxTotalBytesPerRun: 262144,
  enabled: true,
  scripts: [],
};

/** 类型守卫：值是否为对象记录 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 只展开开头的 `~`，其余保持原样 */
function expandHomePrefix(entry: string): string {
  if (entry === '~') return os.homedir();
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

/**
 * 用户输入按配置 cwd 解析为绝对路径。
 * subscribe / edit-write 自动订阅 / read 订阅 / 生命周期释放共用同一口径
 * （已知局限：AfterTool 无成员 cwd，成员 cwd 相对路径可能漏订/漏释放）。
 */
export function resolveInput(config: DocSubscriptionConfig, input: string): string {
  return path.resolve(config.cwd, expandHomePrefix(input));
}

/** 读取字符串数组字段（camelCase 优先，兼容 snake_case） */
function readStringArray(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): string[] | undefined {
  const value = record[camel] ?? record[snake];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/** 读取非空字符串字段（camelCase 优先，空值回落 snake_case） */
function readStringField(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): string | undefined {
  for (const value of [record[camel], record[snake]]) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** 读取正有限数字字段（camelCase 优先，兼容 snake_case） */
function readPositiveNumber(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): number | undefined {
  for (const value of [record[camel], record[snake]]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** 读取布尔字段（只认显式 boolean） */
function readBoolean(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): boolean | undefined {
  for (const value of [record[camel], record[snake]]) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

/**
 * 读取 envGranularity 字段（scope → cadence；认 'request' / 'run' / 'off'，P2）。
 * 非法值 / 未知键忽略 —— 缺省回落到 hook 的内置字面量节奏（files='run'，零回归）。
 */
function readEnvGranularity(
  record: Record<string, unknown>,
): Record<string, EnvCadence> | undefined {
  const value = record.envGranularity ?? record.env_granularity;
  if (!isRecord(value)) return undefined;
  const granularity: Record<string, EnvCadence> = {};
  for (const [scope, cadence] of Object.entries(value)) {
    if (cadence === 'request' || cadence === 'run' || cadence === 'off') {
      granularity[scope] = cadence;
    }
  }
  return Object.keys(granularity).length > 0 ? granularity : undefined;
}

/**
 * 读取 envChannels 字段（scope → channel；认 'model+ui' / 'ui-only'，P2 轴 C）。
 * 非法值 / 未知键忽略 —— 缺省回落到 model+ui（零回归）。
 */
function readEnvChannels(record: Record<string, unknown>): Record<string, EnvChannel> | undefined {
  const value = record.envChannels ?? record.env_channels;
  if (!isRecord(value)) return undefined;
  const channels: Record<string, EnvChannel> = {};
  for (const [scope, channel] of Object.entries(value)) {
    if (channel === 'model+ui' || channel === 'ui-only') channels[scope] = channel;
  }
  return Object.keys(channels).length > 0 ? channels : undefined;
}

/**
 * 解析 scripts allowlist（q-subscription-script，设计 §2.1）：
 * 沿用既有风格（camelCase/snake_case 双拼写、非法值回落默认、未知键忽略）。
 * 整块非法 ⇒ 空清单；单条非法（名字 / argv 不合法）⇒ 跳过该条（fail-closed）；
 * 重名 ⇒ 首条生效。scope 未登记 ⇒ 回落 'script'（注册制防词表无界）。
 */
export function parseScriptSpecs(value: unknown): ScriptSpec[] {
  if (!Array.isArray(value)) return [];
  const specs: ScriptSpec[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = readStringField(item, 'name', 'name');
    if (name === undefined || !SCRIPT_NAME_RE.test(name) || seen.has(name)) continue;
    const commandRaw = item.command;
    if (!Array.isArray(commandRaw)) continue;
    const command = commandRaw.filter(
      (arg): arg is string => typeof arg === 'string' && arg.trim() !== '',
    );
    if (command.length === 0 || command.length !== commandRaw.length) continue;

    // schedule：'run' / 'request' / { interval_seconds: N }（正有限数）；非法回落 'run'。
    let schedule: ScriptSchedule = 'run';
    const scheduleRaw = item.schedule;
    if (scheduleRaw === 'request') {
      schedule = 'request';
    } else if (isRecord(scheduleRaw)) {
      const interval = readPositiveNumber(scheduleRaw, 'intervalSeconds', 'interval_seconds');
      if (interval !== undefined) schedule = { intervalSeconds: interval };
    }

    const cwd = readStringField(item, 'cwd', 'cwd');
    const scopeRaw = readStringField(item, 'scope', 'scope');
    const scope =
      scopeRaw !== undefined && REGISTERED_SCRIPT_SCOPES.includes(scopeRaw) ? scopeRaw : 'script';
    seen.add(name);
    specs.push({
      name,
      command,
      ...(cwd !== undefined ? { cwd: path.resolve(expandHomePrefix(cwd)) } : {}),
      schedule,
      output: item.output === 'full' ? 'full' : 'diff',
      timeoutMs: readPositiveNumber(item, 'timeoutMs', 'timeout_ms') ?? SCRIPT_DEFAULTS.timeoutMs,
      maxOutputBytes:
        readPositiveNumber(item, 'maxOutputBytes', 'max_output_bytes') ??
        SCRIPT_DEFAULTS.maxOutputBytes,
      scope,
    });
  }
  return specs;
}

/** 把 YAML 配置解析成已知字段（未知键忽略） */
export function parseDocSubscriptionConfig(value: unknown): DocSubscriptionConfig {
  const source = isRecord(value) ? value : {};

  const stateDirValue = readStringField(source, 'stateDir', 'state_dir');
  const cwdValue = readStringField(source, 'cwd', 'working_dir');

  const stateDir =
    stateDirValue !== undefined
      ? path.resolve(expandHomePrefix(stateDirValue))
      : DEFAULT_CONFIG.stateDir;
  const cwd =
    cwdValue !== undefined ? path.resolve(expandHomePrefix(cwdValue)) : DEFAULT_CONFIG.cwd;

  // dataDir 优先级（recall 同口径）：用户显式（两拼写）> VESSEL_DATA_DIR > ~/.vessel/data。
  const dataDirValue = readStringField(source, 'dataDir', 'data_dir');
  const fromEnv = process.env.VESSEL_DATA_DIR;
  const dataDirRaw =
    dataDirValue ??
    (typeof fromEnv === 'string' && fromEnv.trim() !== ''
      ? fromEnv.trim()
      : DEFAULT_CONFIG.dataDir);
  const dataDir = path.resolve(expandHomePrefix(dataDirRaw));

  const envGranularity = readEnvGranularity(source);
  const envChannels = readEnvChannels(source);

  return {
    stateDir,
    dataDir,
    cwd,
    allowedRoots: readStringArray(source, 'allowedRoots', 'allowed_roots') ?? [],
    denyPaths: readStringArray(source, 'denyPaths', 'deny_paths') ?? [],
    maxFullBytes:
      readPositiveNumber(source, 'maxFullBytes', 'max_full_bytes') ?? DEFAULT_CONFIG.maxFullBytes,
    maxDiffBytes:
      readPositiveNumber(source, 'maxDiffBytes', 'max_diff_bytes') ?? DEFAULT_CONFIG.maxDiffBytes,
    maxDiffLines:
      readPositiveNumber(source, 'maxDiffLines', 'max_diff_lines') ?? DEFAULT_CONFIG.maxDiffLines,
    maxTotalBytesPerRun:
      readPositiveNumber(source, 'maxTotalBytesPerRun', 'max_total_bytes_per_run') ??
      DEFAULT_CONFIG.maxTotalBytesPerRun,
    enabled: readBoolean(source, 'enabled', 'enabled') ?? DEFAULT_CONFIG.enabled,
    scripts: parseScriptSpecs(source.scripts),
    ...(envGranularity !== undefined ? { envGranularity } : {}),
    ...(envChannels !== undefined ? { envChannels } : {}),
  };
}
