/**
 * `--tools` 的工具清单——不构造 ExecutionUnit、不需要 API Key。
 *
 * 输出口径固定为 headless 口径：能力工具 + vessel 控制面桥，
 * agent 缺省开启时再加 `agent`；显式 `agent.enabled: false` 不列 `agent`。
 * `ask` 在交互 REPL（TTY）、gateway / serve 与 headless（落盘后挂起）都注册
 * （见 cli.ts / bootstrap.ts），但一次性命令里不展开它的 schema，由调用方在末尾注明。
 */

import {
  createAgentService,
  createAgentTool,
  createMemberExecutionHost,
} from '@vessel-agent/agent';
import { loadConfig } from '../packages/config/src/index';
import {
  assertToolNameLegality,
  InProcessScheduler,
  MemoryPluginHost,
  Runtime,
  TOOL_NAME_ALIASES,
} from '../packages/core/src/index';
import { drainWebToolsWarnings } from '../plugins/tools/web-tools/src/index';
import { resolveDataDir } from './data-paths';
import { resolveAgentCwd } from './path-resolution';
import { buildPluginConfigMap, declarativePluginEntries, installWithConfig } from './plugin-config';
import { PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';
import { createVesselMetaSurface } from './vessel-meta';

export interface ToolSummary {
  name: string;
  description: string;
}

export interface ToolsListing {
  tools: ToolSummary[];
  plugins: string[];
  warnings: string[];
  /**
   * 0.55：改名别名（旧名 → 现行名）。不是工具，但属于工具面契约 ——
   * 旧名这一版还能调，命中时结果里会带一行弃用提示。
   */
  aliases: ToolAliasSummary[];
}

/** 一条改名别名（`--tools` / 文档同源，表见 core 的 `TOOL_NAME_ALIASES`） */
export interface ToolAliasSummary {
  alias: string;
  target: string;
  /** 计划移除的版本 */
  removeIn: string;
}

/** 按当前配置加载插件并列出工具（只读，无副作用） */
export async function listTools(): Promise<ToolsListing> {
  const { config, validation, tenantId } = await loadConfig();
  const warnings = [
    ...validation.warnings.map((w) => w.message),
    ...validation.errors.map((e) => e.message),
  ];

  const loader = new PluginLoader();
  const declarative = declarativePluginEntries(config);
  const selection = resolvePluginSelection(
    loader,
    config.plugins,
    Boolean(process.env.VESSEL_DEBUG),
    declarative,
  );
  // 告警只走 stderr，不进入 stdout / 返回的 warnings（JSON 输出保持干净）。
  warnExternalPluginsOnce(selection.external);
  const pluginNames = selection.names;

  const pluginConfigs = buildPluginConfigMap(
    config.plugins,
    declarative,
    resolveAgentCwd(config),
    resolveDataDir(config),
    config.envInjection,
  );
  const host = new MemoryPluginHost();
  for (const name of pluginNames) {
    const plugin = await loader.load(name);
    if (plugin) {
      await installWithConfig(plugin, host, pluginConfigs[plugin.name]);
    }
  }

  // 插件装配期的诊断要进 warnings：UI 侧未必显示 stderr，只留 stderr 会让用户
  // 「找不到工具」且不知怎么恢复。用插件侧的 drain 出口，而不是往上加 core 的
  // PluginHost API（PluginHost 不在本单边界内）。
  warnings.push(...drainWebToolsWarnings());

  // vessel 元工具：与 bootstrap 同一注册口径（装配层注册，先于 agent）。
  // 只读列举不执行任何调用，RPC 端口恒不可用（rpc/set_config 此时 fail-closed）。
  const vesselMeta = createVesselMetaSurface({ getLocalRpc: () => undefined });
  host.registerTool(vesselMeta.vessel);

  // `--tools` 是一次性只读命令：按 headless 口径；agent 缺省开启，
  // 显式 `agent.enabled: false` 才隐藏 canonical agent。
  const agentEnabled = config.agent?.enabled !== false;

  const pluginNamesWithFactories = [...pluginNames];
  if (agentEnabled) {
    // 只注册工具 schema；不 spawn 成员、不落 snapshot，故 Runtime 无需注册 profile。
    const model = config.agent?.model ?? config.provider?.model ?? 'mock-model';
    const runtime = createMemberExecutionHost({
      runtime: new Runtime(),
      model,
      pluginHost: host,
    });
    // 0.27：scheduler 必填；只读列举不投递任何 run，用无事件流的进程内调度器。
    const service = createAgentService({
      tenantId,
      runtime,
      scheduler: new InProcessScheduler(),
    });
    host.registerTool(createAgentTool(service, { ownerId: 'main' }));
    pluginNamesWithFactories.push('agent');
  }

  // 保持与运行时相同的注册顺序（能力工具 → agent），
  // 不要在这里单独按字母序排，否则 --tools 与 /tools、Web 会给出两种顺序。
  const tools = host.listTools().map((t) => ({ name: t.name, description: t.description }));

  // 0.55：装配期工具名审计（与 `installPluginsIntoHost` 同一道闸，判据同源）。
  // `--tools` 这条路径不走插件安装循环（agent 工具是这里手工注册的），所以在这里补一次：
  // 内置工具名不合规 ⇒ 直接抛错并列出全部违规项；外部（MCP）工具名不合规 ⇒ 只进 warnings。
  const audit = assertToolNameLegality(host, 'vessel --tools');
  warnings.push(...audit.warnings.map((warning) => warning.message));

  // 0.55：改名别名不是「工具」，但它是工具面的**契约**（旧名还能调，且会带弃用提示），
  // 所以要在这里列出来，而不是藏进代码里。
  const aliases = TOOL_NAME_ALIASES.map((entry) => ({
    alias: entry.alias,
    target: entry.target,
    removeIn: entry.removeIn,
  }));

  return { tools, plugins: pluginNamesWithFactories, warnings, aliases };
}
