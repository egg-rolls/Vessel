/**
 * PII 规则的判定与脱敏（0.52 pii-guard）。
 * @module @vessel-agent/guardrail-pii
 *
 * 两条硬口径（0.52 修「13 位毫秒时间戳被当手机号打码」）：
 *
 * 1. **数字类 PII 必须整串命中**。判定不看「文本里任意 3+3+4 窗口」，而是先把文本
 *    切成一条条「最大数字串」（前导 `+`、18 位身份证末位 `X` 都计入同一条串），
 *    再对整串分类；候选没覆盖它所在的整条数字串就不算命中。`1794482135404`（13 位
 *    毫秒时间戳）因此再也不会被手机号的窗口从中咬下一截。
 * 2. **校验位说了算**。身份证要出生日期合法 + GB 11643 校验位通过，银行卡要 Luhn
 *    通过；随机凑出来的 16/17/18/19 位数串不会被误判成身份证或卡号。
 */

/** PII 类型（自定义规则的名字也落在这个位置） */
export type PiiType = 'email' | 'phone' | 'ssn' | 'id_card' | 'credit_card' | (string & {});

/** 一条命中：[start, end) 用原文下标，value 即原文切片 */
export interface PiiDetection {
  type: PiiType;
  value: string;
  start: number;
  end: number;
}

/** 判定开关（缺省全开；显式 false 才关） */
export interface PiiRuleOptions {
  detectEmail?: boolean;
  detectPhone?: boolean;
  /** 美国式 SSN：要求带分隔符，避免把长数串咬成 9 位 */
  detectSSN?: boolean;
  /** 大陆 18 位身份证（校验位） */
  detectIdCard?: boolean;
  detectCreditCard?: boolean;
  customPatterns?: Array<{ name: string; pattern: RegExp }>;
  maskingStrategy?: 'full' | 'partial' | 'hash';
}

const CN_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const CN_ID_CHECK = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'] as const;
/** 大陆手机：11 位、`1[3-9]` 开头 */
const CN_MOBILE = /^1[3-9][0-9]{9}$/;
/** 银行卡号形状（真伪再交给 Luhn） */
const CARD_SHAPES: readonly RegExp[] = [
  /^4[0-9]{12}(?:[0-9]{3})?$/,
  /^5[1-5][0-9]{14}$/,
  /^3[47][0-9]{13}$/,
  /^6(?:011|5[0-9]{2})[0-9]{12}$/,
];

/** 字符是否是 ASCII 数字 */
function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch.length === 1 && ch >= '0' && ch <= '9';
}

/** Luhn 校验（银行卡号） */
export function passesLuhn(digits: string): boolean {
  if (digits.length === 0 || /[^0-9]/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** 18 位大陆身份证：出生日期合法 + GB 11643 校验位通过 */
export function isValidCnIdCard(value: string): boolean {
  const normalized = value.toUpperCase();
  if (!/^[0-9]{17}[0-9X]$/.test(normalized)) return false;
  const year = Number(normalized.slice(6, 10));
  const month = Number(normalized.slice(10, 12));
  const day = Number(normalized.slice(12, 14));
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += Number(normalized[i]) * CN_ID_WEIGHTS[i]!;
  }
  return CN_ID_CHECK[sum % 11] === normalized[17];
}

/** 一条「最大数字串」：前导 `+` 与身份证末位 `X` 都算进同一条串 */
export interface DigitRun {
  start: number;
  end: number;
  /** 串里的文字（可能以 `+` 开头、以 `X` 结尾） */
  digits: string;
  /** 是否带前导 `+` */
  plus: boolean;
}

/**
 * 切出文本里所有最大数字串。
 * `1234-5678` 会被切成 `1234`、`5678` 两条（分隔符不是数字即断串）——
 * 这就是「前后紧邻数字不能当手机号」的落地方式：串内没有缺口可以咬。
 */
export function scanDigitRuns(text: string): DigitRun[] {
  const runs: DigitRun[] = [];
  let index = 0;
  while (index < text.length) {
    const plus = text[index] === '+' && isDigit(text[index + 1]);
    if (!plus && !isDigit(text[index])) {
      index += 1;
      continue;
    }
    const digitStart = plus ? index + 1 : index;
    let cursor = digitStart;
    while (isDigit(text[cursor])) cursor += 1;
    let digits = text.slice(digitStart, cursor);
    // 18 位身份证末位可能是 X：把紧邻的那一位 X 计入同一条串
    if (
      digits.length === 17 &&
      (text[cursor] === 'X' || text[cursor] === 'x') &&
      !isDigit(text[cursor + 1])
    ) {
      digits += text[cursor];
      cursor += 1;
    }
    runs.push({ start: index, end: cursor, digits, plus });
    index = cursor;
  }
  return runs;
}

/** 对「整条数字串」分类；不属于任何数字类 PII 就返回 undefined */
function classifyRun(run: DigitRun): PiiType | undefined {
  const { digits } = run;
  if (!/[^0-9]/.test(digits)) {
    const count = digits.length;
    // 手机：11 位本体；带国家码时整条串是 86 + 11 位
    if (count === 11 && CN_MOBILE.test(digits)) return 'phone';
    if (count === 13 && digits.startsWith('86') && CN_MOBILE.test(digits.slice(2))) return 'phone';
    // 银行卡：形状 + Luhn，缺一不判
    if (CARD_SHAPES.some((shape) => shape.test(digits)) && passesLuhn(digits)) return 'credit_card';
  }
  // 身份证：18 位，含末位 X 的形式
  if (isValidCnIdCard(digits)) return 'id_card';
  return undefined;
}

/** 重叠区间消解：先出现的优先，后出现的重叠片段丢弃（宁少遮也不遮错位置） */
export function resolveOverlaps(detections: readonly PiiDetection[]): PiiDetection[] {
  const sorted = [...detections].sort((a, b) => a.start - b.start || b.end - a.end);
  const result: PiiDetection[] = [];
  for (const detection of sorted) {
    const previous = result[result.length - 1];
    if (previous !== undefined && detection.start < previous.end) continue;
    result.push(detection);
  }
  return result;
}

/** 检测文本中的 PII（结果已排序、无重叠） */
export function detectPii(text: string, options: PiiRuleOptions = {}): PiiDetection[] {
  const detections: PiiDetection[] = [];

  if (
    options.detectPhone !== false ||
    options.detectCreditCard !== false ||
    options.detectIdCard !== false
  ) {
    for (const run of scanDigitRuns(text)) {
      const type = classifyRun(run);
      if (type === undefined) continue;
      // 每个类型各自受开关约束
      if (type === 'phone' && options.detectPhone === false) continue;
      if (type === 'credit_card' && options.detectCreditCard === false) continue;
      if (type === 'id_card' && options.detectIdCard === false) continue;
      detections.push({
        type,
        value: text.slice(run.start, run.end),
        start: run.start,
        end: run.end,
      });
    }
  }

  if (options.detectEmail !== false) {
    const pattern =
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g;
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

  if (options.detectSSN !== false) {
    // 必须带分隔符：`123-45-6789`。裸 9 位数字不判——它会咬长数串。
    const pattern = /(?<![0-9])[0-9]{3}-[0-9]{2}-[0-9]{4}(?![0-9])/g;
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

  for (const custom of options.customPatterns ?? []) {
    const flags = custom.pattern.flags.includes('g')
      ? custom.pattern.flags
      : `${custom.pattern.flags}g`;
    const pattern = new RegExp(custom.pattern.source, flags);
    let match = pattern.exec(text);
    while (match !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
      } else {
        detections.push({
          type: custom.name,
          value: match[0],
          start: match.index,
          end: match.index + match[0].length,
        });
      }
      match = pattern.exec(text);
    }
  }

  return resolveOverlaps(detections);
}

/** 脱敏单个值 */
export function maskPiiValue(
  value: string,
  type: PiiType,
  strategy: PiiRuleOptions['maskingStrategy'] = 'partial',
): string {
  switch (strategy) {
    case 'full':
      return '*'.repeat(value.length);
    case 'hash':
      return `[REDACTED_${String(type).toUpperCase()}]`;
    case 'partial':
    default: {
      if (type === 'email') {
        const at = value.indexOf('@');
        if (at <= 0) return `${value[0] ?? ''}***`;
        return `${value.slice(0, 1)}***${value.slice(at)}`;
      }
      if (type === 'phone') {
        // 保留后 4 位，其余数字打码（`13800138000` → `*******8000`）
        const total = value.replace(/[^0-9]/g, '').length;
        let seen = 0;
        return value.replace(/[0-9]/g, (char) => {
          seen += 1;
          return seen > total - 4 ? char : '*';
        });
      }
      if (value.length <= 4) return '*'.repeat(value.length);
      return `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(value.length - 2)}`;
    }
  }
}

/** 按命中位置脱敏整段文本（从后往前替换，避免下标漂移） */
export function maskWithDetections(
  text: string,
  detections: readonly PiiDetection[],
  strategy: PiiRuleOptions['maskingStrategy'] = 'partial',
): string {
  if (detections.length === 0) return text;
  let result = text;
  for (let i = detections.length - 1; i >= 0; i -= 1) {
    const detection = detections[i];
    if (detection === undefined) continue;
    result =
      result.slice(0, detection.start) +
      maskPiiValue(detection.value, detection.type, strategy) +
      result.slice(detection.end);
  }
  return result;
}

/**
 * 读侧脱敏：检测 + 打码一步到位。
 * 只在请求构造 / 展示投影里调用；落盘原文一个字都不许改。
 */
export function maskText(text: string, options: PiiRuleOptions = {}): string {
  return maskWithDetections(text, detectPii(text, options), options.maskingStrategy);
}
