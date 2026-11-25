/**
 * 请求 extra 透传合并闸（additive，q-thinking-plugin P1）。
 *
 * core 只开放「额外头/参数」的**形状**与合并闸，不认识任何厂商思考参数
 * （reasoning_effort / thinking / enable_thinking 对 core 只是普通透传键）。
 * 「哪个 provider 的哪个模型吃哪个参数」全部是插件内的纯数据映射表（宪法第十三条）。
 *
 * 判据（设计 §3.2）：
 * - extra 缺省 / 空 ⇒ **返回 base 原对象**（调用点据此保持请求字面量逐字节不变）。
 * - 逐项校验：危险头 denylist / core 保留 body 键 / 键长 / 值长 / 条数 / 序列化字节上限 /
 *   值类型（头必须 string；参数必须 JSON 可序列化）。
 * - 违规项**丢弃 + warn 一次**（进程内按签名去重，避免每轮刷屏），合法项照常合并。
 *   **绝不抛错**——坏注入不能中断请求（HookRunner 故障隔离同判据）。
 * - 头名统一小写写入（HTTP/2 口径；fetch 大小写不敏感，统一后逐字节可预测）。
 * - 参数顶层浅合并 `{ ...base, ...合法extra }`——extra 只增键，不改 base 既有键。
 * - 只读投影：克隆合并，绝不改 `req.extra_*` 原对象（共享对象污染判据）。
 *
 * @module @vessel-agent/core/provider/request-extras
 */

import { writeStderrNotice } from '../log-hub.js';

/** 危险头 denylist（小写比较）：认证 / 传输 framing / 协议版本钉死。 */
export const RESERVED_HEADERS: readonly string[] = [
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'expect',
  'te',
  'trailer',
  'proxy-authorization',
  'content-type', // 必须保持 application/json
  'anthropic-version', // 适配器钉死 2023-06-01，不允许插件漂移协议版本
];

/** core 保留 body 键（OpenAI 兼容）：请求形状的所有权属于 core，插件不得覆盖。 */
export const RESERVED_BODY_KEYS_OPENAI: readonly string[] = [
  'model',
  'messages',
  'tools',
  'stream',
  'stream_options',
  'temperature',
  'max_tokens',
];

/** core 保留 body 键（Anthropic）。 */
export const RESERVED_BODY_KEYS_ANTHROPIC: readonly string[] = [
  'model',
  'messages',
  'system',
  'tools',
  'stream',
  'temperature',
  'max_tokens',
];

/** 上限（超限项丢弃 + 一次性告警，不抛错）。 */
export const EXTRA_LIMITS = {
  maxHeaders: 16,
  maxHeaderKeyLen: 64,
  maxHeaderValueLen: 1024,
  maxParamKeys: 16,
  maxSerializedBytes: 8192,
} as const;

/**
 * OpenAI 兼容 budget 形状：max_tokens 容纳 thinking_budget 时的输出余量（TI5-4）。
 * 抬升只在 max_tokens <= thinking_budget（必 400）时触发；余量保证严格大于约束
 * 且留足单轮响应空间（长 tool_call arguments / 代码块）。固定常量，无厂商语义。
 */
export const OPENAI_THINKING_OUTPUT_HEADROOM = 8192;

/** 进程内一次性告警去重（按签名；避免每轮请求刷屏）。 */
const warned = new Set<string>();

function warnOnce(warn: (msg: string) => void, signature: string, msg: string): void {
  if (warned.has(signature)) return;
  warned.add(signature);
  warn(msg);
}

/** 缺省 warn 通道：core 既有 stderr notice 一次性口径。 */
export const defaultExtraWarning = (msg: string): void => writeStderrNotice(msg);

/** 值是否 JSON 可序列化（函数 / symbol / 循环引用 / undefined ⇒ false）。 */
function isJsonSerializable(value: unknown): boolean {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return false;
  }
  try {
    const serialized = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'function' || typeof v === 'symbol') {
        throw new Error('non-serializable');
      }
      return v;
    });
    return typeof serialized === 'string';
  } catch {
    return false;
  }
}

/**
 * 合并额外请求头。extra 缺省 / 空 ⇒ 返回 base 原对象（逐字节不变）。
 * 危险头 / 非 string 值 / 超限项丢弃 + 一次性告警；合法项小写键合并。
 */
export function mergeExtraHeaders(
  base: Record<string, string>,
  extra: Readonly<Record<string, string>> | undefined,
  warn: (msg: string) => void = defaultExtraWarning,
): Record<string, string> {
  if (extra === undefined) return base;
  const keys = Object.keys(extra);
  if (keys.length === 0) return base;

  const merged: Record<string, string> = { ...base };
  let count = 0;
  for (const key of keys) {
    const lower = key.toLowerCase();
    const value = extra[key];
    if (RESERVED_HEADERS.includes(lower)) {
      warnOnce(
        warn,
        `header-reserved:${lower}`,
        `request-extras: dropped reserved header "${key}"`,
      );
      continue;
    }
    if (typeof value !== 'string') {
      warnOnce(warn, `header-type:${lower}`, `request-extras: dropped non-string header "${key}"`);
      continue;
    }
    if (key.length > EXTRA_LIMITS.maxHeaderKeyLen) {
      warnOnce(warn, 'header-key-len', 'request-extras: dropped over-long header key');
      continue;
    }
    if (value.length > EXTRA_LIMITS.maxHeaderValueLen) {
      warnOnce(
        warn,
        `header-value-len:${lower}`,
        `request-extras: dropped over-long header value "${key}"`,
      );
      continue;
    }
    if (count >= EXTRA_LIMITS.maxHeaders) {
      warnOnce(warn, 'header-count', 'request-extras: dropped headers beyond count limit');
      continue;
    }
    merged[lower] = value;
    count += 1;
  }
  return merged;
}

/**
 * 合并额外请求体参数（顶层浅合并）。extra 缺省 / 空 ⇒ 返回 base 原对象（逐字节不变）。
 * core 保留键 / 非 JSON 值 / 超限项丢弃 + 一次性告警；合法项 `{ ...base, ...extra }`。
 */
export function mergeExtraParams(
  base: Record<string, unknown>,
  extra: Readonly<Record<string, unknown>> | undefined,
  reserved: readonly string[],
  warn: (msg: string) => void = defaultExtraWarning,
): Record<string, unknown> {
  if (extra === undefined) return base;
  const keys = Object.keys(extra);
  if (keys.length === 0) return base;

  const valid: Record<string, unknown> = {};
  let count = 0;
  let bytes = 0;
  for (const key of keys) {
    const value = extra[key];
    if (reserved.includes(key)) {
      warnOnce(warn, `param-reserved:${key}`, `request-extras: dropped reserved body key "${key}"`);
      continue;
    }
    if (!isJsonSerializable(value)) {
      warnOnce(
        warn,
        `param-type:${key}`,
        `request-extras: dropped non-JSON-serializable param "${key}"`,
      );
      continue;
    }
    if (count >= EXTRA_LIMITS.maxParamKeys) {
      warnOnce(warn, 'param-count', 'request-extras: dropped params beyond count limit');
      continue;
    }
    const entryBytes = JSON.stringify(key).length + JSON.stringify(value).length;
    if (bytes + entryBytes > EXTRA_LIMITS.maxSerializedBytes) {
      warnOnce(warn, 'param-bytes', 'request-extras: dropped params beyond serialized byte limit');
      continue;
    }
    valid[key] = value;
    count += 1;
    bytes += entryBytes;
  }
  if (Object.keys(valid).length === 0) return base;
  return { ...base, ...valid };
}

/**
 * Anthropic extended thinking 形状一致性兜底（设计 §3.2.1）。
 *
 * 这是 core 唯一「认识 thinking 结构」的地方，且只做**形状一致性**不做语义映射——
 * 约束是 Anthropic 传输协议的硬事实（与 anthropic-version 钉死同类），不是厂商知识：
 * - thinking.type==='enabled' ⇒ 删除 temperature（让 API 用默认 1）。
 * - budget_tokens clamp 到 max_tokens-1；clamp 后 <1024 ⇒ 整个 thinking 键丢弃 + 告警
 *   （max_tokens 太小放不下思考预算 ⇒ 优雅降级为不思考，而不是发一个必 400 的请求）。
 *
 * 无 thinking / 非 enabled ⇒ 返回原对象（逐字节不变）。绝不抛错。
 */
export function applyAnthropicThinkingConsistency(
  body: Record<string, unknown>,
  warn: (msg: string) => void = defaultExtraWarning,
): Record<string, unknown> {
  const thinking = body.thinking;
  if (thinking === null || typeof thinking !== 'object') return body;
  const t = thinking as Record<string, unknown>;
  if (t.type !== 'enabled') return body;

  const next: Record<string, unknown> = { ...body };
  delete next.temperature;
  const maxTokens = typeof next.max_tokens === 'number' ? next.max_tokens : undefined;
  const budget = typeof t.budget_tokens === 'number' ? t.budget_tokens : undefined;
  if (budget !== undefined && maxTokens !== undefined) {
    const clamped = Math.min(budget, maxTokens - 1);
    if (clamped < 1024) {
      delete next.thinking;
      warnOnce(
        warn,
        'anthropic-thinking-budget',
        'request-extras: anthropic thinking budget does not fit max_tokens; dropped thinking',
      );
      return next;
    }
    next.thinking = { ...t, budget_tokens: clamped };
  }
  return next;
}

/**
 * OpenAI 兼容 budget 形状 thinking 一致性兜底（TI5-4，用户裁定：抬 max_tokens 容纳）。
 *
 * 与 applyAnthropicThinkingConsistency 同判据：只做**形状一致性**不做厂商语义映射——
 * 认识的是「budget 形状两数值键的序关系」这一传输协议硬事实（网关校验
 * max_completion_tokens > thinking_budget，max_tokens 被网关翻译为 max_completion_tokens），
 * 不认识任何厂商。哲学与 Anthropic 相反（用户裁定）：thinking 强度只是额外透传参数，
 * **不该被 clamp**；max_tokens 放不下预算 ⇒ 抬 max_tokens 容纳，而不是砍思考。
 *
 * 触发（全满足才动 body）：thinking_budget 为有限正数 && enable_thinking !== false
 * && max_tokens 为 number 且 <= thinking_budget（必 400 形状）。
 * 动作：max_tokens 抬到 thinking_budget + 8192（输出余量；严格大于约束 + 响应空间），
 * 克隆只改这一个键 + 一次性告警。不 clamp budget、不丢 thinking。
 *
 * 无 thinking_budget / 非 budget 形状 / 显式关闭 / max_tokens 已够 ⇒ 返回原对象
 * （逐字节不变）。绝不抛错。
 */
export function applyOpenAIThinkingConsistency(
  body: Record<string, unknown>,
  warn: (msg: string) => void = defaultExtraWarning,
): Record<string, unknown> {
  const budget = body.thinking_budget;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return body;
  if (body.enable_thinking === false) return body;
  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== 'number' || maxTokens > budget) return body;

  const raised = budget + OPENAI_THINKING_OUTPUT_HEADROOM;
  warnOnce(
    warn,
    'openai-thinking-budget-raise',
    `request-extras: max_tokens ${maxTokens} <= thinking_budget ${budget}; raised max_tokens to ${raised} to accommodate thinking`,
  );
  return { ...body, max_tokens: raised };
}
