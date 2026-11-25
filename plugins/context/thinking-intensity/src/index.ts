/**
 * @vessel-agent/thinking-intensity — 模型思考强度控制插件（in-process 能力插件）。
 *
 * 设计：docs/dev/plans/thinking-intensity-plugin-design.md。用户裁定：作为 config 的
 * 热配置——热启用 / 热调整，同步到 config.yaml，不需重启。
 *
 * 形态照 skills/model-registry 先例：package.json 声明 `vessel` 清单但无 `entry` ⇒
 * in-process capabilityManifest；装配层经 registerInProcessPlugin 登记贡献面与 RPC
 * （canonical plugin.thinking-intensity.*）。放 plugins/context/（category=context）：
 * provider category 被默认装载集排除（专用装配），hook+RPC 插件须走常规装载名单。
 *
 * 热配置机制（关键）：settings 存【模块级 live holder】。ESM 模块按 URL 缓存、跨
 * PluginLoader 实例共享单例；install 每次（启动 + config-watch→tools 热应用旁路
 * re-install）用 options.config 刷新 holder；BeforeLlm hook 每轮读 holder ⇒ 改设置
 * 即热生效（不重启）。state 亦模块级、按 session_id 键控，re-install 不丢。install
 * 无副作用（不建 watcher / 不发 I/O），避开旁路 re-install 泄漏（lifecycle R-C）。
 *
 * 纪律：core 只 import type（插件与宿主模块边界）；hook 无 I/O、无抛错路径（纯函数 +
 * 内存 Map，意外由 HookRunner 故障隔离兜底）；auto / enabled=false / 未知模型 ⇒ 不注入
 * （请求逐字节不变，零回归）。
 */

import type { Hook, HookContext, HookResult, Plugin, PluginHost } from '@vessel-agent/core';
import { type ConcreteLevel, MAPPING, resolveMapping } from './mapping.js';
import {
  budgetsOf,
  createState,
  DEFAULT_SETTINGS,
  isLevel,
  levelSource,
  parseSettings,
  resolveLevel,
  type ThinkingSettings,
  type ThinkingState,
} from './state.js';

export type { Budgets, ConcreteLevel, Level, MappingEntry, Shape, Status } from './mapping.js';
export { MAPPING, resolveMapping } from './mapping.js';
export {
  budgetsOf,
  createState,
  DEFAULT_SETTINGS,
  isLevel,
  LEVELS,
  levelSource,
  type ObservedEntry,
  parseSettings,
  resolveLevel,
  type ThinkingSettings,
  type ThinkingState,
} from './state.js';

export const THINKING_PLUGIN_NAME = 'thinking-intensity';

/**
 * 模块级 live settings holder + state（ESM 单例共享）。install 刷新 holder；hook 每轮读。
 * 这是热配置的核心：旁路 re-install 更新同一 holder，真实宿主的 hook 下一轮即读到新值。
 */
let liveSettings: ThinkingSettings = { ...DEFAULT_SETTINGS };
const state: ThinkingState = createState();

/**
 * BeforeLlm hook（请求期注入 + 降级，设计 §4.5）。纯函数：读 liveSettings + state，
 * 无 I/O、无抛错路径。任何意外由 HookRunner 隔离兜底（请求照常，无 extra）。
 */
function beforeLlm(ctx: HookContext): HookResult | undefined {
  const settings = liveSettings;
  const model = typeof ctx.model === 'string' ? ctx.model : undefined;
  const providerName = typeof ctx.providerName === 'string' ? ctx.providerName : undefined;
  const sessionId = ctx.session_id;
  const entry = resolveMapping(providerName, model);

  // 1. 观测记录（无论是否注入都学能力，UI get_state 靠它）。
  if (sessionId !== undefined) {
    state.observed.set(sessionId, {
      ...(providerName !== undefined ? { providerName } : {}),
      model: model ?? '',
      supported: entry !== undefined && entry.shape !== 'none',
      ...(entry !== undefined && model !== undefined
        ? { availableLevels: entry.availableLevels(model) }
        : {}),
    });
  }

  // 2. 降级闸（任一命中 ⇒ 不注入，请求逐字节不变）。
  if (!settings.enabled) return undefined; // kill switch
  const level = resolveLevel(state, settings, sessionId);
  if (level === 'auto') return undefined; // 默认 = provider 自决
  if (model === undefined) return undefined; // 无模型事实，不猜
  if (entry === undefined) return undefined; // 未知 provider/model
  if (entry.shape === 'none') return undefined; // 思考不可控
  if (entry.status === 'experimental' && !settings.experimental_providers) return undefined;

  // 3. 档位 → wire 参数（不支持的档位 ⇒ 不注入 + 观测记 hint，不静默替换）。
  const params = entry.map(level as ConcreteLevel, budgetsOf(settings), model);
  if (params === undefined) {
    if (sessionId !== undefined) {
      const observed = state.observed.get(sessionId);
      if (observed !== undefined) observed.hint = 'level_unsupported';
    }
    return undefined;
  }
  return { requestExtras: { params } };
}

function invalidParams(message: string): Error {
  return new Error(`invalid_params: ${message}`);
}

const SESSION_ID_MAX = 128;

function optionalSessionId(params: Record<string, unknown>): string | undefined {
  const value = params.session_id;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidParams('session_id must be a non-empty string when set');
  }
  if (value.length > SESSION_ID_MAX) {
    throw invalidParams(`session_id must be at most ${SESSION_ID_MAX} chars`);
  }
  return value;
}

/** get_state：当前档位 + 来源 + kill switch + 请求期观测能力（首轮请求前 provider 缺省）。 */
function getState(params: Record<string, unknown>): Record<string, unknown> {
  const sessionId = optionalSessionId(params);
  const level = resolveLevel(state, liveSettings, sessionId);
  const observed = sessionId !== undefined ? state.observed.get(sessionId) : undefined;
  return {
    level,
    source: levelSource(state, sessionId),
    enabled: liveSettings.enabled,
    // 通用菜单契约（设计 §4.7.2）顶层可选字段：options 能力过滤 / hint 说明 / supported。
    // 首轮请求前 observed 缺省 ⇒ 不带 options（全档可选，诚实降级）。
    ...(observed !== undefined
      ? {
          supported: observed.supported,
          options: observed.availableLevels ?? [],
          ...(observed.hint !== undefined ? { hint: observed.hint } : {}),
          provider: {
            ...(observed.providerName !== undefined ? { name: observed.providerName } : {}),
            model: observed.model,
            supported: observed.supported,
            ...(observed.availableLevels !== undefined
              ? { available_levels: observed.availableLevels }
              : {}),
            ...(observed.hint !== undefined ? { hint: observed.hint } : {}),
          },
        }
      : {}),
  };
}

/** set_level：会话级覆盖（带 session_id）或全局运行期默认（不带）。 */
function setLevel(params: Record<string, unknown>): Record<string, unknown> {
  const level = params.level;
  if (!isLevel(level)) {
    throw invalidParams('level must be auto | off | low | medium | high');
  }
  const sessionId = optionalSessionId(params);
  if (sessionId !== undefined) {
    if (level === 'auto') state.sessionLevels.delete(sessionId);
    else state.sessionLevels.set(sessionId, level);
    return { ok: true, level, scope: 'session' };
  }
  state.runtimeDefault = level === 'auto' ? undefined : level;
  return { ok: true, level, scope: 'global' };
}

/** capabilities：映射表摘要（只读诊断）。 */
function capabilities(): Record<string, unknown> {
  return {
    rows: MAPPING.map((row) => ({
      match: `${row.protocol ?? '*'}/${row.modelPattern.source}`,
      shape: row.shape,
      status: row.status,
    })),
  };
}

/** RPC dispatch（canonical plugin.thinking-intensity.*；装配层登记）。 */
export function dispatchThinkingRpc(
  name: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  switch (name) {
    case 'get_state':
      return getState(params);
    case 'set_level':
      return setLevel(params);
    case 'capabilities':
      return capabilities();
    default:
      throw invalidParams(`unknown rpc method "${name}"`);
  }
}

/** 创建插件实例（模块级单例；装配层经 pluginConfigs 透传 config）。 */
export function createThinkingPlugin(): Plugin {
  return {
    name: THINKING_PLUGIN_NAME,
    version: '0.1.0',
    description:
      'Model thinking-intensity control: contributes.settings hot config + BeforeLlm ' +
      'requestExtras injection (effort/budget/toggle per-provider mapping; auto = no injection)',
    install(host: PluginHost, installOptions?: { config?: Record<string, unknown> }): void {
      // 刷新模块级 live holder（启动 + tools 热应用旁路 re-install 都走这里）。
      // hook 每轮读 holder ⇒ 改设置即热生效。install 无其它副作用（re-install 安全）。
      liveSettings = parseSettings(installOptions?.config);
      host.registerHook({
        name: THINKING_PLUGIN_NAME,
        // 插件不做 core 运行时值导入：字面量 + Hook['type'] 保类型一致（模块边界纪律）。
        type: 'before_llm' as Hook['type'],
        priority: 60,
        run: async (ctx: HookContext): Promise<HookResult | undefined> => beforeLlm(ctx),
      });
    },
    async rpc(name: string, params: Record<string, unknown>): Promise<unknown> {
      return dispatchThinkingRpc(name, params);
    },
  };
}

/** 默认插件实例（装配层经 pluginConfigs['thinking-intensity'] 透传 config）。 */
export const thinkingPlugin: Plugin = createThinkingPlugin();

export default thinkingPlugin;
