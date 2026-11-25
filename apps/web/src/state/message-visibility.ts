/**
 * 消息显示（q-msg-visibility）：五类消息独立 toggle 的**唯一解析口**（纯函数，零 React）。
 *
 * 配置形状见 `@vessel-agent/config` 的 `MessageVisibilityConfig`（ui.messageVisibility，
 * YAML `ui.message_visibility`）。七类消息里用户消息 / AI 正文恒显不给开关；这里只管
 * 思考 / 工具 / 环境 / 来源 / 系统五类。
 *
 * 兼容映射（不破坏存量配置）：
 * - `system` 未配置时回退旧键 `ui.showInternalEvents`（snake_case 也接受）；
 *   新键显式值优先 —— 用户在设置里切过「系统信息」后以新键为准。
 * - `verbosity: debug` 的「或」语义**不在这里**：那是档位 concern，由消费方
 *   （`visibility.showsInternalEvents`）叠加，与改动前同一口径。
 *
 * 缺省值 = 现行默认行为：reasoning / tools / environment / source 默认 true，
 * system 默认 false。未配置任何新键时观感与改动前逐字节一致。
 *
 * 本文件与 `runtime-kinds.ts` 一样不许 import react / zustand / store / .tsx
 * （根 tsconfig 无 DOM lib，纯函数半会被脚本与门禁 import）。
 */

/** 五类消息的生效 toggle（已解析缺省与兼容映射；不含 verbosity 档位叠加）。 */
export interface MessageVisibility {
  /** 思考过程（默认 true）。 */
  reasoning: boolean;
  /** 工具卡片（默认 true）；失败卡永不静默由消费方保证。 */
  tools: boolean;
  /** 环境信息卡 vessel:notice（默认 true）。 */
  environment: boolean;
  /** 来源卡 vessel:source（默认 true）；agent 卡吸收的折叠路径不受影响。 */
  source: boolean;
  /** 系统信息（默认 false；未配置新键时 = 旧 ui.showInternalEvents）。 */
  system: boolean;
}

export const DEFAULT_MESSAGE_VISIBILITY: MessageVisibility = {
  reasoning: true,
  tools: true,
  environment: true,
  source: true,
  system: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 兼容 `{config:{ui}}` 与已解包的 config 对象（与 visibility.ts 同一口径）。 */
function uiOf(source: unknown): Record<string, unknown> | undefined {
  if (!isRecord(source)) return undefined;
  const config = isRecord(source.config) ? source.config : source;
  return isRecord(config.ui) ? config.ui : undefined;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 读取 ui.messageVisibility（snake_case 回退）+ 旧键兼容映射。
 * 非法值（非布尔）按缺省处理，与 validator 拒绝后的消费侧容错同一口径。
 */
export function resolveMessageVisibility(source: unknown): MessageVisibility {
  const ui = uiOf(source);
  const raw = ui?.messageVisibility ?? ui?.message_visibility;
  const mv = isRecord(raw) ? raw : undefined;
  // 旧键兼容：system 未配置 → showInternalEvents（存量配置无损）；两者皆无 → false。
  const legacy = ui?.showInternalEvents ?? ui?.show_internal_events;
  const systemFallback = typeof legacy === 'boolean' ? legacy : false;
  return {
    reasoning: boolOr(mv?.reasoning, DEFAULT_MESSAGE_VISIBILITY.reasoning),
    tools: boolOr(mv?.tools, DEFAULT_MESSAGE_VISIBILITY.tools),
    environment: boolOr(mv?.environment, DEFAULT_MESSAGE_VISIBILITY.environment),
    source: boolOr(mv?.source, DEFAULT_MESSAGE_VISIBILITY.source),
    system: boolOr(mv?.system, systemFallback),
  };
}
