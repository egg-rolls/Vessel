/**
 * @vessel/guardrail-pii - PII 脱敏 Guardrail 插件
 * @module @vessel/guardrail-pii
 *
 * 检测并脱敏个人身份信息（PII），如邮箱、电话、身份证号等
 */

import type {
  Guardrail,
  GuardrailContext,
  GuardrailResult,
  Plugin,
  PluginHost,
} from '@vessel/core';
import { GuardrailStage } from '@vessel/core';

/** PII Guardrail 配置 */
export interface PIIGuardrailConfig {
  /** 是否检测邮箱 */
  detectEmail?: boolean;
  /** 是否检测电话 */
  detectPhone?: boolean;
  /** 是否检测身份证号 */
  detectSSN?: boolean;
  /** 是否检测信用卡号 */
  detectCreditCard?: boolean;
  /** 自定义正则表达式 */
  customPatterns?: Array<{ name: string; pattern: RegExp }>;
  /** 脱敏策略 */
  maskingStrategy?: 'full' | 'partial' | 'hash';
}

/** 默认配置 */
const DEFAULT_CONFIG: PIIGuardrailConfig = {
  detectEmail: true,
  detectPhone: true,
  detectSSN: true,
  detectCreditCard: true,
  maskingStrategy: 'partial',
};

/** PII 检测结果 */
interface PiiDetection {
  type: string;
  value: string;
  start: number;
  end: number;
}

/**
 * PII 检测器
 */
class PiiDetector {
  private config: PIIGuardrailConfig;

  constructor(config: PIIGuardrailConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检测文本中的 PII
   */
  detect(text: string): PiiDetection[] {
    const detections: PiiDetection[] = [];

    if (this.config.detectEmail) {
      const pattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
      let match = pattern.exec(text);
      while (match !== null) {
        detections.push({
          type: 'email',
          value: match[0],
          start: match.index,
          end: match.index + match[0].length,
        });
        match = pattern.exec(text);
      }
    }

    if (this.config.detectPhone) {
      const pattern = /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g;
      let match = pattern.exec(text);
      while (match !== null) {
        detections.push({
          type: 'phone',
          value: match[0],
          start: match.index,
          end: match.index + match[0].length,
        });
        match = pattern.exec(text);
      }
    }

    if (this.config.detectSSN) {
      const pattern = /\b[0-9]{3}[-\s]?[0-9]{2}[-\s]?[0-9]{4}\b/g;
      let match = pattern.exec(text);
      while (match !== null) {
        detections.push({
          type: 'ssn',
          value: match[0],
          start: match.index,
          end: match.index + match[0].length,
        });
        match = pattern.exec(text);
      }
    }

    if (this.config.detectCreditCard) {
      const pattern =
        /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g;
      let match = pattern.exec(text);
      while (match !== null) {
        detections.push({
          type: 'credit_card',
          value: match[0],
          start: match.index,
          end: match.index + match[0].length,
        });
        match = pattern.exec(text);
      }
    }

    if (this.config.customPatterns) {
      for (const { name, pattern } of this.config.customPatterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match = regex.exec(text);
        while (match !== null) {
          detections.push({
            type: name,
            value: match[0],
            start: match.index,
            end: match.index + match[0].length,
          });
          match = regex.exec(text);
        }
      }
    }

    return detections;
  }

  /**
   * 脱敏文本
   */
  mask(text: string, detections: PiiDetection[]): string {
    if (detections.length === 0) return text;

    let result = text;
    // 从后往前替换，避免索引偏移
    for (let i = detections.length - 1; i >= 0; i--) {
      const detection = detections[i];
      const masked = this.maskValue(detection.value, detection.type);
      result = result.substring(0, detection.start) + masked + result.substring(detection.end);
    }

    return result;
  }

  /**
   * 脱敏单个值
   */
  private maskValue(value: string, type: string): string {
    switch (this.config.maskingStrategy) {
      case 'full':
        return '*'.repeat(value.length);
      case 'partial': {
        if (type === 'email') {
          const [local, domain] = value.split('@');
          return `${local[0]}***@${domain}`;
        }
        if (type === 'phone') {
          return value.replace(/[0-9]/g, (char, index) => (index < 7 ? '*' : char));
        }
        return (
          value.substring(0, 2) + '*'.repeat(value.length - 4) + value.substring(value.length - 2)
        );
      }
      case 'hash':
        return `[REDACTED_${type.toUpperCase()}]`;
      default:
        return '*'.repeat(value.length);
    }
  }
}

/**
 * PII Guardrail 实现
 */
export class PIIGuardrail implements Guardrail {
  name = 'pii-guardrail';
  stage = GuardrailStage.Output;
  priority = 100;

  private detector: PiiDetector;

  constructor(config: PIIGuardrailConfig = {}) {
    this.detector = new PiiDetector(config);
  }

  async check(value: unknown, _ctx: GuardrailContext): Promise<GuardrailResult> {
    if (typeof value !== 'string') {
      return { allowed: true };
    }

    const detections = this.detector.detect(value);

    if (detections.length === 0) {
      return { allowed: true };
    }

    const masked = this.detector.mask(value, detections);
    const types = [...new Set(detections.map((d) => d.type))];

    return {
      allowed: true,
      replacement: masked,
      reason: `Detected and masked ${detections.length} PII item(s): ${types.join(', ')}`,
    };
  }
}

/**
 * PII Guardrail 插件
 */
export const piiGuardrailPlugin: Plugin = {
  name: 'guardrail-pii',
  version: '0.1.0',
  description: 'PII detection and masking guardrail',
  install(host: PluginHost) {
    host.registerGuardrail(new PIIGuardrail());
  },
};

export default piiGuardrailPlugin;
