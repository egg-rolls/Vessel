/**
 * 插件安装配置（0.6.1 E1）。
 *
 * - E1：把 `plugins[].config` 透传到 `install(host, { config })`。core 的类型在
 *   0.6.1 才扩展为可选第二参，这里用窄局部 cast，保证与旧签名兼容。
 * - 声明式 `guardrails:` / `hooks:`（0.6.1）：条目名即插件名，config 合并到该插件的
 *   安装配置；显式 `plugins:` 项优先。
 *
 * @module vessel/plugin-config
 */

import * as path from 'node:path';
import {
  type EnvInjectionConfig,
  type GuardrailConfig,
  getUserConfigPath,
  type HookConfig,
  type PluginConfig,
  readUserConfigRoot,
  resolveEnvCadence,
  resolveEnvChannel,
  type VesselConfig,
  withConfigLock,
  writeUserConfigRoot,
} from '../../packages/config/src/index';
import type {
  EnvCadence,
  EnvChannel,
  Plugin,
  PluginHost,
  PluginInitContext,
} from '../../packages/core/src/index';
import { resolveDataDir } from '../data/data-paths';
import { resolveAgentCwd } from '../data/path-resolution';

/** core 0.6.1 的 install 形状；旧签名只用第一个参数也能工作 */
export type PluginInstallOptions = { config?: Record<string, unknown> };
type InstallWithOptions = (
  host: PluginHost,
  options?: PluginInstallOptions,
) => void | Promise<void>;

/** 调用插件 install，并透传配置（无配置时保持旧调用形状） */
export function installWithConfig(
  plugin: Plugin,
  host: PluginHost,
  config: Record<string, unknown> | undefined,
): void | Promise<void> {
  const install = plugin.install as InstallWithOptions;
  return config === undefined ? install.call(plugin, host) : install.call(plugin, host, { config });
}

/**
 * 返回一个把安装配置绑定到 `install(host)` 的插件包装。
 * 不修改原对象（加载器对模块有缓存，避免跨 tenant 泄漏配置）。
 */
export function withPluginConfig(
  plugin: Plugin,
  config: Record<string, unknown> | undefined,
): Plugin {
  if (config === undefined) return plugin;
  return {
    name: plugin.name,
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    ...(plugin.description !== undefined ? { description: plugin.description } : {}),
    install: (host) => installWithConfig(plugin, host, config),
    // 0.9 生命周期 v2：包装层必须透传 init/dispose，否则配置过的插件
    // 不会收到 init，也不会在 ExecutionUnit.dispose() 时被清理。
    ...(plugin.init !== undefined ? { init: (ctx: PluginInitContext) => plugin.init?.(ctx) } : {}),
    ...(plugin.dispose !== undefined ? { dispose: () => plugin.dispose?.() } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `vessel plugin enable|disable` 的持久化选项 */
export interface SetPluginEnabledOptions {
  /** 用户配置文件；缺省 `~/.vessel/config.yaml` */
  configPath?: string;
}

/**
 * 持久化单个插件的启用状态：只改 `plugins[]` 里该 name 的 `enabled`，
 * 保留其它键与配置根对象。
 *
 * 0.56.1 覆盖层语义：**不再物化全量默认集**——`plugins:` 条目只覆盖默认集
 * （未列入 = 走默认），写目标单条即可。旧物化逻辑有两个缺陷：物化名单与运行时
 * 默认集漂移（getAvailablePlugins 不排除 media/hook-logging）；物化后新装插件
 * 被完整清单静默排除。覆盖层下两者都不复存在。
 */
export async function setPluginEnabled(
  name: string,
  enabled: boolean,
  options: SetPluginEnabledOptions = {},
): Promise<void> {
  if (name.trim() === '') throw new Error('plugin name must be non-empty');
  const configPath = options.configPath ?? getUserConfigPath();
  await withConfigLock(configPath, async () => {
    const root = await readUserConfigRoot(configPath);
    const raw = root.plugins;
    if (raw !== undefined && !Array.isArray(raw)) {
      throw new Error('config.yaml plugins must be an array');
    }

    const entries: unknown[] = (raw ?? []).map((entry) => (isRecord(entry) ? { ...entry } : entry));

    const index = entries.findIndex((entry) => isRecord(entry) && entry.name === name);
    if (index >= 0) {
      entries[index] = { ...(entries[index] as Record<string, unknown>), enabled };
    } else {
      entries.push({ name, enabled });
    }

    root.plugins = entries;
    await writeUserConfigRoot(configPath, root);
  });
}

/**
 * 覆盖层语义的启用判定（0.56.1，child 与 in-process 显示同一口径）：
 * 条目缺省 = 启用（装的插件默认开启）；只有显式 `enabled: false` 才关。
 * 宿主装配（pluginEnabledInConfig）与 CLI 列表（pluginEnabledByConfig）共用，
 * 消除「宿主加载了、CLI 显示 no」的两套口径漂移。
 */
export function pluginEntryEnabled(
  configured: readonly PluginConfig[] | undefined,
  name: string,
): boolean {
  const entry = configured?.find((candidate) => candidate.name === name);
  return entry === undefined || entry.enabled !== false;
}

/**
 * 工厂式插件的启用**显示**口径（0.56.1，CLI 列表与面板基础行共用）：
 * 工厂式插件不进 PluginLoader 装载名单，但确有启用语义——按实际装配门控标注
 * （与 bootstrap wiring 同源），不按 plugins[] 条目猜。engine-client 等装配层
 * 基础设施无用户面启用语义，恒显示未启用（与 CLI 列表同一口径）。
 */
export function factoryPluginDisplayEnabled(config: VesselConfig, name: string): boolean {
  switch (name) {
    case 'mcp-client':
      return Object.values(config.mcpServers ?? {}).some((server) => server.enabled !== false);
    case 'evals':
      return config.evals?.enabled !== false;
    case 'feishu':
      return config.feishu?.enabled === true;
    default:
      return false;
  }
}

/**
 * S4（vscode-settings-design §4.4）：写单个插件配置键。照 setPluginEnabled 先例：
 * withConfigLock → readUserConfigRoot → 只改 plugins[name].config[key] →
 * writeUserConfigRoot（保留其它键 / 其它插件）。值已由 serve 方法层按 manifest
 * spec 校验（type/enum/minmax）；这里不再二次校验类型。
 */
export async function setPluginConfigValue(
  name: string,
  key: string,
  value: string | number | boolean,
  options: { configPath?: string } = {},
): Promise<void> {
  if (name.trim() === '') throw new Error('plugin name must be non-empty');
  if (key.trim() === '') throw new Error('setting key must be non-empty');
  const configPath = options.configPath ?? getUserConfigPath();
  await withConfigLock(configPath, async () => {
    const root = await readUserConfigRoot(configPath);
    const raw = root.plugins;
    if (raw !== undefined && !Array.isArray(raw)) {
      throw new Error('config.yaml plugins must be an array');
    }
    const entries: unknown[] = (raw ?? []).map((entry) => (isRecord(entry) ? { ...entry } : entry));
    const index = entries.findIndex((entry) => isRecord(entry) && entry.name === name);
    const entry: Record<string, unknown> =
      index >= 0 ? (entries[index] as Record<string, unknown>) : { name };
    const config = isRecord(entry.config) ? { ...entry.config } : {};
    config[key] = value;
    entry.config = config;
    if (index >= 0) entries[index] = entry;
    else entries.push(entry);
    root.plugins = entries;
    await writeUserConfigRoot(configPath, root);
  });
}

/** 把声明式 guardrails / hooks 条目映射为插件配置（按 name 去重合并） */
export function declarativePluginEntries(config: VesselConfig): PluginConfig[] {
  const merged = new Map<string, PluginConfig>();

  const add = (entry: GuardrailConfig | HookConfig): void => {
    if (typeof entry.name !== 'string' || entry.name.trim() === '') return;
    const name = entry.name.trim();
    const existing = merged.get(name);
    if (!existing) {
      merged.set(name, {
        name,
        ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
        ...(entry.config !== undefined ? { config: { ...entry.config } } : {}),
      });
      return;
    }
    merged.set(name, {
      ...existing,
      // 任一条目显式 false 即停用；否则保持启用。
      ...(entry.enabled === false || existing.enabled === false ? { enabled: false } : {}),
      ...(entry.config !== undefined
        ? { config: { ...(existing.config ?? {}), ...entry.config } }
        : {}),
    });
  };

  for (const entry of config.guardrails ?? []) add(entry);
  for (const entry of config.hooks ?? []) add(entry);

  return [...merged.values()];
}

/**
 * 构造 `plugin.name → config` 映射（core 0.6.1 的 `ExecutionUnitOptions.pluginConfigs`）。
 * 声明式条目先合并，显式 `plugins[].config` 覆盖。
 *
 * 0.11.1（DECISION-022 §2.4）：`agentCwd` 是全局默认工作目录，只作为
 * `basic-tools` 安装配置的 `cwd` 兜底；显式/声明式插件配置里的 `cwd` 始终优先。
 *
 * 0.51：这份 `cwd` 是**全 tenant 一份的全局默认**，不是「成员 cwd」。工具调用期的完整
 * 优先级是 参数 cwd > 这里的 `agent.cwd` > 成员 cwd（`ToolContext.cwd`，Team 基础路径）
 * > `process.cwd()`（见 `plugins/tools/basic-tools/src/index.ts` 的 `resolveCallCwd`）。
 * 也就是说：只要用户显式配了 `agent.cwd`，它就压过 Team 基础路径 —— 这是用户口径。
 *
 * 0.52：合并完再补一次 `media` 的路径边界回落（`allowed_roots` / `deny_paths` 优先取
 * media 自己的，缺了才用 basic-tools 的），见 `applyPathBoundaryFallback`。
 */
export function buildPluginConfigMap(
  configured: PluginConfig[] | undefined,
  declarative: PluginConfig[] = [],
  agentCwd?: string,
  dataDir?: string,
  envInjection?: EnvInjectionConfig,
  getLiveConfig?: () => VesselConfig | undefined,
): Record<string, Record<string, unknown>> {
  const map: Record<string, Record<string, unknown>> = {};
  for (const entry of declarative) {
    if (entry.config === undefined) continue;
    map[entry.name] = { ...(map[entry.name] ?? {}), ...entry.config };
  }
  for (const entry of configured ?? []) {
    if (entry.config === undefined) continue;
    map[entry.name] = { ...(map[entry.name] ?? {}), ...entry.config };
  }
  if (agentCwd !== undefined && map['basic-tools']?.cwd === undefined) {
    map['basic-tools'] = { ...(map['basic-tools'] ?? {}), cwd: agentCwd };
  }
  // skills 的 project 根 = <cwd>/skills：cwd 回落与 basic-tools 同口径（显式优先）。
  if (agentCwd !== undefined && map['skills']?.cwd === undefined) {
    map['skills'] = { ...(map['skills'] ?? {}), cwd: agentCwd };
  }
  applyDataDirFallback(map, dataDir);
  // 边界回落在 dataDir/cwd 注入之后：skills 无显式 config 时也有 map 条目可继承
  // （media 行为不变：无 config 条目仍跳过）。
  applyPathBoundaryFallback(map);
  applySkillsLibraryIsolation(map, dataDir, skillsActive(configured, declarative));
  applyEnvGranularity(map, envInjection);
  // live 配置 getter（q-subscription-script，hot-gate 同族修复）：doc-subscription 的
  // cadence / channel / scripts 第一天走活配置 —— 注入 `liveConfig: () => 活合并安装配置`，
  // 插件每次 hook run / 工具调用重新解析（runtime-notice live resolver 样板）。
  // 成员 runtime 复制父 hook 引用后读的也是这份活配置（修 q-doc-subscription-hot-gate
  // 残留：成员持 install 快照，热改不生效）。内层调用不带 getLiveConfig ⇒ 无递归。
  // JSON.stringify（pluginConfigKeyOf）自然丢弃函数值 ⇒ 热应用键比较不受影响。
  if (getLiveConfig !== undefined) {
    map['doc-subscription'] = {
      ...(map['doc-subscription'] ?? {}),
      liveConfig: (): Record<string, unknown> | undefined => {
        const live = getLiveConfig();
        if (live === undefined) return undefined;
        return buildPluginConfigMap(
          live.plugins,
          declarativePluginEntries(live),
          resolveAgentCwd(live),
          resolveDataDir(live),
          live.envInjection,
        )['doc-subscription'];
      },
    };
  }
  return map;
}

/** skills 是否会被装载（默认集含 skills；显式 plugins[] 以列表为准） */
function skillsActive(
  configured: PluginConfig[] | undefined,
  declarative: PluginConfig[],
): boolean {
  if (configured === undefined) return true;
  const explicit = configured.find((entry) => entry.name === 'skills');
  if (explicit !== undefined) return explicit.enabled !== false;
  return declarative.some((entry) => entry.name === 'skills' && entry.enabled !== false);
}

/**
 * skills 收集库隔离（设计 §9.3，与信任门配套）：把
 * `<dataDir>/plugins/skills/library/` 追加进 basic-tools 的 deny_paths——
 * 模型 read/edit 收集库文件 → deny，技能内容只能经 `skills load` 的信任门
 * 进入语言空间。project/user 根不隔离（用户自己的文件，@path/read 现态保留）。
 *
 * 诚实声明：bash 命令本身不受路径沙箱约束（现态 ADR-055），隔离挡的是工具面
 * 顺手读，不是决心绕行的命令。skills 未装载时不追加（library 无管理方）。
 */
function applySkillsLibraryIsolation(
  map: Record<string, Record<string, unknown>>,
  dataDir: string | undefined,
  active: boolean,
): void {
  if (dataDir === undefined || dataDir === '' || !active) return;
  const libraryRoot = path.join(dataDir, 'plugins', 'skills', 'library');
  const basicTools = map['basic-tools'] ?? {};
  const key =
    ['denyPaths', 'deny_paths'].find((spell) => basicTools[spell] !== undefined) ?? 'deny_paths';
  const existing = Array.isArray(basicTools[key]) ? (basicTools[key] as unknown[]) : [];
  if (existing.includes(libraryRoot)) return;
  map['basic-tools'] = { ...basicTools, [key]: [...existing, libraryRoot] };
}

/**
 * 插件产哪些 env scope（asm 知道，插件自己不声明）：doc-subscription → files / health /
 * agent / script / doc-lag / code-heaviness（health 源 q-health-subscription；agent 源
 * q-sub-unify-p1；script 源 q-subscription-script；内置检测器专词 q-subscription-script-p1 案 B），
 * basic-tools → lock / conflict（写协调 producer）。
 */
const ENV_GRANULARITY_SCOPES: Readonly<Record<string, readonly string[]>> = {
  'doc-subscription': ['files', 'health', 'agent', 'script', 'doc-lag', 'code-heaviness'],
  'basic-tools': ['lock', 'conflict'],
};

/**
 * 把解析好的 per-scope 检测节奏注入插件安装配置，键 `envGranularity`
 * （`Record<string, EnvCadence>`；注入粒度框架轴 A）。
 *
 * 为什么在装配层拼：插件包不 import config 的 resolver（依赖方向），只读 install
 * config 里的字面量；缺省（无 `env_injection` 配置）**不注入**，插件用内置字面量
 * 默认（= 今天节奏，零回归）。显式插件配置里已有 `envGranularity` 时不覆盖
 * （用户显式配置优先，与 cwd / dataDir 回落同口径）。
 *
 * 生效链路：本函数是 `pluginConfigs` 的唯一产地 —— 运行时装配、热应用、`--tools`
 * 吃同一份结果；插件 install 时读 `envGranularity.<scope>` 决定 producer 的 gate。
 */
function applyEnvGranularity(
  map: Record<string, Record<string, unknown>>,
  envInjection?: EnvInjectionConfig,
): void {
  if (envInjection === undefined) return;
  for (const [name, scopes] of Object.entries(ENV_GRANULARITY_SCOPES)) {
    const config = map[name] ?? {};
    if (config.envGranularity !== undefined) continue;
    const granularity: Record<string, EnvCadence> = {};
    for (const scope of scopes) granularity[scope] = resolveEnvCadence(scope, envInjection);
    // P2 轴 C：per-scope 投递通道（缺省 model+ui）。与 envGranularity 同一注入点，
    // 插件 install 读 envChannels.<scope> 决定 ui-only 事件出口。
    const channels: Record<string, EnvChannel> = {};
    for (const scope of scopes) channels[scope] = resolveEnvChannel(scope, envInjection);
    map[name] = { ...config, envGranularity: granularity, envChannels: channels };
  }
}

/**
 * `recall` / `doc-subscription` / `skills` 的数据目录回落到**应用层解析出来的那份**
 * （0.56；doc-subscription 于蜂群协作增强切片加入，skills 于收集库切片加入）。
 *
 * 为什么必须在装配层拼：`recall` 要读 `<data_dir>/sessions/<id>/`（时间线 + 压缩索引），
 * `doc-subscription` 生命周期要读 `<data_dir>/sessions/<id>.json` 会话壳
 * （cleared_tool_call_ids），而数据目录的唯一权威是应用层的 `resolveDataDir(config)` ——
 * 它能被 `config.data_dir` 与 `VESSEL_DATA_DIR` 改写（本机就是 `openl-data`，不是
 * `~/.vessel/data`）。让插件自己去猜目录，等于把「同一个进程有两套数据目录」这个 bug
 * 装进工具里：它会稳定地回答「没有压缩索引」/ 生命周期永不触发。
 *
 * 优先级：**用户显式配置 > 应用层解析值**（两种拼写 `dataDir` / `data_dir` 都算显式）。
 * 没有解析值（库用法 / 非 CLI 入口）⇒ 不动，插件用 `VESSEL_DATA_DIR` / `~/.vessel/data` 兜底。
 */
function applyDataDirFallback(
  map: Record<string, Record<string, unknown>>,
  dataDir?: string,
): void {
  if (dataDir === undefined || dataDir === '') return;
  for (const name of ['recall', 'doc-subscription', 'skills']) {
    const config = map[name] ?? {};
    if (config.dataDir !== undefined || config.data_dir !== undefined) continue;
    map[name] = { ...config, data_dir: dataDir };
  }
}

/**
 * 路径边界键的两组拼写。插件配置两种都认（`readStringArray(source, 'allowedRoots',
 * 'allowed_roots')`），所以回退时**原样拷贝**命中的那个拼写，不做拼写归一。
 */
const PATH_BOUNDARY_KEY_GROUPS: readonly (readonly [string, string])[] = [
  ['allowedRoots', 'allowed_roots'],
  ['denyPaths', 'deny_paths'],
];

/**
 * `media` / `skills` 的路径边界回退到 `basic-tools` 的那份（0.52 附件引用改为读侧校验
 * 的配套；skills 于收集库切片加入，扫描读用户技能目录同口径）。
 *
 * 为什么在装配层拼：插件 `install(host, { config })` 只收到**自己那份** config
 *（`pluginConfigs[plugin.name]`），`PluginHost` 没有 config getter、`PluginInitContext`
 * 只有 `{ host }` —— media 插件里拿不到 basic-tools 的配置；让它自己去读
 * `~/.vessel/config.yaml` 会变成第二套配置解析，热应用语义也会分裂。
 *
 * 优先级：**media 自身 > basic-tools 回落**。
 * - media 任一个拼写存在就算「自己配了」，**包括显式空数组** —— 空数组是
 *   「明确不限制根」的意图，不能被回退覆盖；
 * - basic-tools 没装 / 该键没配 → 跳过，media 保持现状（空根 + 内置 denylist）；
 * - 只回退路径边界键，media 的其它配置（阈值 / CLI 路径 / enabled）不受影响。
 *
 * 生效链路：media 在 `install` 时用自己的配置构造 boundary
 * （`plugins/media/media/src/index.ts` 的 `buildPathBoundary`），而本函数是
 * `pluginConfigs` 的唯一产地 —— 运行时装配、热应用（`assemblePluginTools`）、
 * `--tools`、`plugin list --json` 吃的是同一份结果，改一处即全覆盖。
 */
function applyPathBoundaryFallback(map: Record<string, Record<string, unknown>>): void {
  const basicTools = map['basic-tools'];
  if (basicTools === undefined) return;
  // media（0.52）与 skills（收集库扫描读用户技能目录）同口径继承 basic-tools 边界。
  for (const name of ['media', 'skills']) {
    const own = map[name];
    if (own === undefined) continue;
    const merged: Record<string, unknown> = { ...own };
    let inherited = false;
    for (const spellings of PATH_BOUNDARY_KEY_GROUPS) {
      // 自己配了（任一个拼写存在，含空数组）→ 保持原值
      if (spellings.some((key) => merged[key] !== undefined)) continue;
      const source = spellings.find((key) => basicTools[key] !== undefined);
      if (source === undefined) continue;
      merged[source] = basicTools[source];
      inherited = true;
    }
    // 没有回退到任何键时保持原对象引用，避免制造无意义的新对象（配置指纹按 JSON 比）
    if (inherited) map[name] = merged;
  }
}

/**
 * 取某插件的安装配置：显式 `plugins[].config` 覆盖声明式条目；都没有返回 undefined。
 *
 * 注意：这是**原始视图**，不套 `buildPluginConfigMap` 的 media → basic-tools 路径边界
 * 回落。要看「实际生效的配置」用 `buildPluginConfigMap()[name]`（安装链路都走那条）。
 */
export function pluginConfigFor(
  name: string,
  configured: PluginConfig[] | undefined,
  declarative: PluginConfig[] = [],
): Record<string, unknown> | undefined {
  const explicit = configured?.find((entry) => entry.name === name);
  const declared = declarative.find((entry) => entry.name === name);
  const config: Record<string, unknown> = {
    ...(declared?.config ?? {}),
    ...(explicit?.config ?? {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}
