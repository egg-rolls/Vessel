/**
 * @vessel-agent/guardrail-pii - PII 守卫插件
 * @module @vessel-agent/guardrail-pii
 *
 * ## 位置纪律（0.52 修 bug 的核心）
 *
 * 脱敏**只允许发生在展示 / 请求构造层，落盘原文一个字都不许改**。
 *
 * 0.52 之前本插件在 `GuardrailStage.Output` 返回 `replacement`，而 Output / ToolResult
 * 的 replacement 会被写进会话存储 —— append-only 的 transcript 是不可逆数据，于是
 * 「13 位毫秒时间戳被当成手机号」这条误伤直接改坏了历史正文（`1794482135404` →
 * `179*******404`），并且改过正文与流式渲染出来的正文对不上，是「重复渲染」的触发源。
 *
 * 现在分成两半：
 * - `PIIGuardrail.check()` **只检测、只报告**，永不返回 `replacement`（写侧零改写）；
 * - 真正的打码由 `createPiiMasker()` 以**读侧 masker** 登记到 `PluginHost`，只被
 *   请求构造层（`buildRequestMessages`）与展示投影调用。
 *
 * 判定口径（数字类 PII 必须整串命中 + 校验位）见 `./rules.js`。
 */

import type {
  Guardrail,
  GuardrailContext,
  GuardrailResult,
  Plugin,
  PluginHost,
  ReadSideMasker,
} from '@vessel-agent/core';
import { GuardrailStage } from '@vessel-agent/core';
import { detectPii, maskText, type PiiDetection, type PiiRuleOptions } from './rules.js';

export type { PiiDetection, PiiRuleOptions, PiiType } from './rules.js';
export {
  detectPii,
  isValidCnIdCard,
  maskText,
  passesLuhn,
  scanDigitRuns,
} from './rules.js';

/** PII 守卫配置 */
export interface PIIGuardrailConfig {
  /** 总开关（缺省 true）：关掉后检测与脱敏一起停 */
  enabled?: boolean;
  /** 是否检测邮箱 */
  detectEmail?: boolean;
  /** 是否检测电话 */
  detectPhone?: boolean;
  /** 是否检测身份证号（大陆 18 位，校验位说了算） */
  detectIdCard?: boolean;
  /** 是否检测美国式 SSN（要求带分隔符） */
  detectSSN?: boolean;
  /** 是否检测信用卡号 */
  detectCreditCard?: boolean;
  /** 自定义正则表达式 */
  customPatterns?: Array<{ name: string; pattern: RegExp }>;
  /** 脱敏策略 */
  maskingStrategy?: 'full' | 'partial' | 'hash';
  /** 读侧脱敏开关（缺省 true）：关掉后展示/请求两条路径都不打码 */
  maskOnRead?: boolean;
  /**
   * 命中后怎么办（缺省 `report`）：
   * - `report`：只记录，不改写任何东西；
   * - `block`：直接拒绝（`allowed: false`）。
   * 无论哪个值，写侧都不会拿到 `replacement`。
   */
  action?: 'report' | 'block';
}

/** E1：`install(host, {config})` 的窄类型（core 尚未声明第二参数） */
export interface PluginInstallOptions {
  config?: Record<string, unknown>;
}

/** 类型守卫 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把 YAML 插件配置解析成 PIIGuardrailConfig（pattern 支持字符串或 RegExp） */
export function parsePiiGuardrailConfig(value: unknown): PIIGuardrailConfig {
  if (!isRecord(value)) return {};
  const parsed: PIIGuardrailConfig = {};
  for (const key of [
    'enabled',
    'detectEmail',
    'detectPhone',
    'detectIdCard',
    'detectSSN',
    'detectCreditCard',
    'maskOnRead',
  ] as const) {
    if (typeof value[key] === 'boolean') parsed[key] = value[key];
  }
  if (
    value.maskingStrategy === 'full' ||
    value.maskingStrategy === 'partial' ||
    value.maskingStrategy === 'hash'
  ) {
    parsed.maskingStrategy = value.maskingStrategy;
  }
  if (value.action === 'report' || value.action === 'block') {
    parsed.action = value.action;
  }

  if (Array.isArray(value.customPatterns)) {
    const customPatterns: NonNullable<PIIGuardrailConfig['customPatterns']> = [];
    for (const item of value.customPatterns) {
      if (!isRecord(item) || typeof item.name !== 'string') continue;
      let pattern: RegExp | undefined;
      if (item.pattern instanceof RegExp) {
        pattern = new RegExp(item.pattern.source, item.pattern.flags);
      } else if (typeof item.pattern === 'string') {
        const rawFlags = typeof item.flags === 'string' ? item.flags : '';
        // 非全局正则在 exec 循环里不会前进
        const flags = rawFlags.includes('g') ? rawFlags : `${rawFlags}g`;
        try {
          pattern = new RegExp(item.pattern, flags);
        } catch {
          pattern = undefined;
        }
      }
      if (pattern !== undefined) customPatterns.push({ name: item.name, pattern });
    }
    parsed.customPatterns = customPatterns;
  }

  return parsed;
}

/** 默认配置 */
const DEFAULT_CONFIG: Required<
  Pick<PIIGuardrailConfig, 'enabled' | 'maskOnRead' | 'action' | 'maskingStrategy'>
> & {
  detectEmail: boolean;
  detectPhone: boolean;
  detectIdCard: boolean;
  detectSSN: boolean;
  detectCreditCard: boolean;
} = {
  enabled: true,
  maskOnRead: true,
  action: 'report',
  maskingStrategy: 'partial',
  detectEmail: true,
  detectPhone: true,
  detectIdCard: true,
  detectSSN: true,
  detectCreditCard: true,
};

/** 配置 → 规则选项 */
function toRuleOptions(config: PIIGuardrailConfig): PiiRuleOptions {
  return {
    ...(config.detectEmail !== undefined ? { detectEmail: config.detectEmail } : {}),
    ...(config.detectPhone !== undefined ? { detectPhone: config.detectPhone } : {}),
    ...(config.detectIdCard !== undefined ? { detectIdCard: config.detectIdCard } : {}),
    ...(config.detectSSN !== undefined ? { detectSSN: config.detectSSN } : {}),
    ...(config.detectCreditCard !== undefined ? { detectCreditCard: config.detectCreditCard } : {}),
    ...(config.customPatterns !== undefined ? { customPatterns: config.customPatterns } : {}),
    ...(config.maskingStrategy !== undefined ? { maskingStrategy: config.maskingStrategy } : {}),
  };
}

/**
 * 读侧脱敏器（0.52）：**这是唯一打码的位置**。
 *
 * 它被登记到 `PluginHost`，只被请求构造层与展示投影调用；落盘路径根本不经过它，
 * 因此历史正文永远是原文。`enabled` / `maskOnRead` 任一为 false 时原样返回。
 */
export function createPiiMasker(config: PIIGuardrailConfig = {}): ReadSideMasker {
  const merged: PIIGuardrailConfig = { ...DEFAULT_CONFIG, ...config };
  const options = toRuleOptions(merged);
  return {
    name: 'pii',
    mask(text: string): string {
      if (merged.enabled === false || merged.maskOnRead === false) return text;
      return maskText(text, options);
    },
  };
}

/**
 * PII 守卫实现：**只检测、只报告**。
 *
 * 关键不变量：`check()` 的返回值里永远没有 `replacement`。写侧任何阶段（Input /
 * Output / ToolResult）拿到它都不会改写正文 —— 否则 append-only 的会话正文会被
 * 不可逆地污染（0.52 的 bug）。
 */
export class PIIGuardrail implements Guardrail {
  name = 'pii-guardrail';
  stage = GuardrailStage.Output;
  priority = 100;

  private config: PIIGuardrailConfig;
  private options: PiiRuleOptions;

  constructor(config: PIIGuardrailConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.options = toRuleOptions(this.config);
  }

  async check(value: unknown, _ctx: GuardrailContext): Promise<GuardrailResult> {
    if (this.config.enabled === false || typeof value !== 'string') {
      return { allowed: true };
    }

    const detections: PiiDetection[] = detectPii(value, this.options);
    if (detections.length === 0) {
      return { allowed: true };
    }

    const types = [...new Set(detections.map((detection) => detection.type))];
    const reason = `pii_detected: ${detections.length} item(s) [${types.join(', ')}]`;

    if (this.config.action === 'block') {
      return { allowed: false, reason };
    }

    // report：只报告，**不返回 replacement**（脱敏在读侧，见 createPiiMasker）
    return { allowed: true, reason };
  }
}

/**
 * 创建 PII 守卫插件
 */
export function createPiiGuardrailPlugin(config?: PIIGuardrailConfig): Plugin {
  return {
    name: 'guardrail-pii',
    version: '0.2.0',
    description: 'PII detection guardrail + read-side masking',
    install(host: PluginHost, options?: PluginInstallOptions) {
      const merged = {
        ...(config ?? {}),
        ...parsePiiGuardrailConfig(options?.config),
      };
      host.registerGuardrail(new PIIGuardrail(merged));
      // 读侧脱敏：真正的打码位置。旧宿主没有这个方法时退化成「只报告」，不炸。
      if (typeof host.registerReadSideMasker === 'function') {
        host.registerReadSideMasker(createPiiMasker(merged));
      }
    },
  };
}

/** 默认实例——现有调用方无需改动 */
export const piiGuardrailPlugin: Plugin = createPiiGuardrailPlugin();

export default piiGuardrailPlugin;
