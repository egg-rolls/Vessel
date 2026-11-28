/**
 * thinking-intensity provider 映射表（插件内纯数据 + 纯函数，设计 §4.6）。
 *
 * 宪法第十三条：core 只有形状，知识在插件。「哪个 provider 的哪个模型吃哪个参数」
 * 全部在这里；core 合并闸对任何顶层键一视同仁，加厂商 = 加一行，0 行 core 改动。
 *
 * 统一档位 auto / off / low / medium / high；三种 wire 形状：
 * - effort：枚举参数（reasoning_effort）。
 * - budget：开关 + token 预算（anthropic thinking / qwen enable_thinking+thinking_budget）。
 * - toggle：只有开/关（low/medium/high 等效）。
 * - none：思考不可控（恒开或恒关）⇒ supported=false。
 *
 * P2 只带 stable 行（官方文档已核实）；experimental 行 P4 逐行核实后转正（受
 * experimental_providers 闸，默认 false）。匹配键是 (providerName, model) 二元组；
 * providerName 缺省时只按 model 模式匹配（裸 fallback 降级路径）。
 *
 * @module @vessel-agent/thinking-intensity/mapping
 */

export type Level = 'auto' | 'off' | 'low' | 'medium' | 'high';
export type Shape = 'effort' | 'budget' | 'toggle' | 'none';
export type Status = 'stable' | 'experimental';

/** budget 形状的三档 token 预算（来自 settings budget_low/medium/high）。 */
export interface Budgets {
  low: number;
  medium: number;
  high: number;
}

/** 非 auto 档位（map 的输入）。 */
export type ConcreteLevel = Exclude<Level, 'auto'>;

export interface MappingEntry {
  /** 精确 protocol 匹配；undefined = 任意 protocol（如 ^qwen 不依赖 protocol）。 */
  readonly protocol?: string;
  readonly modelPattern: RegExp;
  readonly shape: Shape;
  readonly status: Status;
  /**
   * 能力说明（i18n key，宿主菜单 footer 经插件 catalog 解析显示；q-ti-hint）。
   * none 形状必填：解释「为什么只有 auto 可选」。缺省 = 无说明行。
   */
  readonly hint?: string;
  /** 该模型可用的非 auto 档位（UI 能力过滤；不支持的档位不静默替换）。 */
  availableLevels(model: string): ConcreteLevel[];
  /** 档位 → wire 参数；不支持的档位返回 undefined（不注入）。纯函数，无 I/O。 */
  map(level: ConcreteLevel, budgets: Budgets, model: string): Record<string, unknown> | undefined;
}

const ALL_LEVELS: ConcreteLevel[] = ['off', 'low', 'medium', 'high'];
const NO_OFF: ConcreteLevel[] = ['low', 'medium', 'high'];

/** none 形状共用的能力说明 key（插件 i18n catalog 提供 en/zh 文案）。 */
const NONE_HINT_KEY = 'thinking-intensity.hint.none';

function budgetFor(level: ConcreteLevel, budgets: Budgets): number | undefined {
  if (level === 'low') return budgets.low;
  if (level === 'medium') return budgets.medium;
  if (level === 'high') return budgets.high;
  return undefined;
}

/**
 * 裸模型名：剥 vendor 前缀（dashscope/qwen4-max → qwen4-max）。
 * 匹配口径统一用裸名：resolveMapping 的 modelPattern 与行内模型判定
 * （gpt51OrLater）同口径；裸名输入原样返回。
 */
function bareModelName(model: string): string {
  return model.split('/').pop() ?? model;
}

/** gpt-5.1+ 才支持 reasoning_effort:'none'（o 系列 / gpt-5.0 不可关）。 */
function gpt51OrLater(model: string): boolean {
  return /^gpt-5\.[1-9]/.test(bareModelName(model));
}

/**
 * 映射表（按序首中）。P2 stable 行：1/2/3/6/9/10（设计 §4.6 表）。
 * experimental 行（4/5/7/8）P4 核实后加入。
 */
export const MAPPING: readonly MappingEntry[] = [
  // #1 anthropic / claude → budget（适配器兜底 temperature/budget 一致性）。
  {
    protocol: 'anthropic',
    modelPattern: /claude/i,
    shape: 'budget',
    status: 'stable',
    availableLevels: () => [...ALL_LEVELS],
    map: (level, budgets) => {
      if (level === 'off') return { thinking: { type: 'disabled' } };
      const budget = budgetFor(level, budgets);
      if (budget === undefined) return undefined;
      return { thinking: { type: 'enabled', budget_tokens: budget } };
    },
  },
  // #2 openai / o 系列 + gpt-5 → effort（gpt-5.1+ 可 off=none；o 系列/gpt-5.0 不可关）。
  {
    protocol: 'openai',
    modelPattern: /^(o[134]|gpt-5)/,
    shape: 'effort',
    status: 'stable',
    availableLevels: (model) => (gpt51OrLater(model) ? [...ALL_LEVELS] : [...NO_OFF]),
    map: (level, _budgets, model) => {
      if (level === 'off') {
        return gpt51OrLater(model) ? { reasoning_effort: 'none' } : undefined;
      }
      return { reasoning_effort: level };
    },
  },
  // #3 openai/dashscope / qwen → budget（不依赖 protocol；dashscope 常以 openai 兼容注册）。
  {
    modelPattern: /^qwen/i,
    shape: 'budget',
    status: 'stable',
    availableLevels: () => [...ALL_LEVELS],
    map: (level, budgets) => {
      if (level === 'off') return { enable_thinking: false };
      const budget = budgetFor(level, budgets);
      if (budget === undefined) return undefined;
      return { enable_thinking: true, thinking_budget: budget };
    },
  },
  // #6 openai / deepseek-reasoner → none（恒思考，无强度参数）。
  {
    protocol: 'openai',
    modelPattern: /^deepseek-reasoner/,
    shape: 'none',
    status: 'stable',
    hint: NONE_HINT_KEY,
    availableLevels: () => [],
    map: () => undefined,
  },
  // #9 moonshot / kimi → none（kimi-k2-thinking 恒思考；无公开强度参数）。
  {
    protocol: 'moonshot',
    modelPattern: /kimi/i,
    shape: 'none',
    status: 'stable',
    hint: NONE_HINT_KEY,
    availableLevels: () => [],
    map: () => undefined,
  },
  // #10 ollama / * → none（本地模型思考参数随 run 配置，OpenAI 兼容面不统一；二期评估）。
  {
    protocol: 'ollama',
    modelPattern: /.*/,
    shape: 'none',
    status: 'stable',
    hint: NONE_HINT_KEY,
    availableLevels: () => [],
    map: () => undefined,
  },
];

/**
 * 按 (providerName, model) 取首中映射行。providerName 缺省 ⇒ 只按 model 模式匹配
 * （裸 fallback 降级）；model 缺省 ⇒ undefined（不猜）。
 * modelPattern 一律对裸模型名匹配（vendor 前缀剥离，如 dashscope/qwen4-max）。
 */
export function resolveMapping(
  providerName: string | undefined,
  model: string | undefined,
): MappingEntry | undefined {
  if (model === undefined || model === '') return undefined;
  const bare = bareModelName(model);
  if (bare === '') return undefined; // 退化输入（如 "vendor/"）不猜
  for (const row of MAPPING) {
    if (providerName !== undefined && row.protocol !== undefined && row.protocol !== providerName) {
      continue;
    }
    if (row.modelPattern.test(bare)) return row;
  }
  return undefined;
}
