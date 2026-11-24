/**
 * @vessel-agent/plugin-skills — frontmatter 子集解析
 * @module @vessel-agent/skills/frontmatter
 *
 * 设计 §5.2 / §9.1 T6：只认 `name / description / version / tags` 四键，
 * 标量与字符串数组；自写子集解析器——不引第三方 YAML 库、绝不 eval、
 * 不构造对象。未知键忽略并标 partial；解析失败标 invalid（条目仍入库，
 * load 返回原文）。**宿主 never 把 frontmatter 当指令解释**——它只是元数据。
 */

import { type FrontmatterState, MAX_DESCRIPTION_CHARS, MAX_TAG_CHARS, MAX_TAGS } from './types.js';

/** 解析结果：四键字段 + 正文 + 状态 + 告警 */
export interface FrontmatterResult {
  state: FrontmatterState;
  name?: string;
  description?: string;
  version?: string;
  tags?: string[];
  /** frontmatter 块之后的正文（无 frontmatter / 解析失败时为原文） */
  body: string;
  warnings: string[];
}

const KNOWN_KEYS = new Set(['name', 'description', 'version', 'tags']);

/** 剥成对引号（子集：不做转义展开） */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** 标量值形状检查：数组 / 对象 / 多行记法一律不支持（fail-closed 标 invalid） */
function isPlainScalar(value: string): boolean {
  if (value === '') return true;
  const first = value[0];
  return first !== '[' && first !== '{' && first !== '|' && first !== '>';
}

/** tags：只认内联字符串数组 `[a, b, "c"]`；个数 / 长度上限在类型常量里 */
function parseTags(value: string, warnings: string[]): string[] | undefined {
  if (!value.startsWith('[') || !value.endsWith(']')) {
    warnings.push('frontmatter: tags must be an inline string array [a, b, c]');
    return undefined;
  }
  const inner = value.slice(1, -1).trim();
  if (inner === '') return [];
  const items = inner
    .split(',')
    .map((item) => unquote(item.trim()))
    .filter((item) => item !== '');
  const tags: string[] = [];
  for (const item of items) {
    if (tags.length >= MAX_TAGS) {
      warnings.push(`frontmatter: tags truncated to ${MAX_TAGS} entries`);
      break;
    }
    tags.push(item.length > MAX_TAG_CHARS ? item.slice(0, MAX_TAG_CHARS) : item);
  }
  return tags;
}

/**
 * 解析技能文件的 frontmatter 子集。
 * 无 frontmatter → state 'none'，body = 原文；块不闭合 / 已知键形状非法 →
 * 'invalid'（body 仍回原文，load 不丢内容）；未知键 → 'partial'。
 */
export function parseFrontmatter(raw: string): FrontmatterResult {
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trim();
  if (first !== '---') {
    return { state: 'none', body: text, warnings: [] };
  }
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      close = index;
      break;
    }
  }
  if (close === -1) {
    return {
      state: 'invalid',
      body: text,
      warnings: ['frontmatter: opening --- has no closing --- line'],
    };
  }

  const warnings: string[] = [];
  const fields: { name?: string; description?: string; version?: string; tags?: string[] } = {};
  let invalid = false;
  let partial = false;

  for (let index = 1; index < close; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (match === null) {
      invalid = true;
      warnings.push(`frontmatter: unsupported line "${trimmed.slice(0, 60)}"`);
      continue;
    }
    const key = match[1] as string;
    const value = (match[2] ?? '').trim();
    if (!KNOWN_KEYS.has(key)) {
      // 未知键忽略 + partial 标注（R9：不追全量 YAML spec）
      partial = true;
      continue;
    }
    if (key === 'tags') {
      const tags = parseTags(value, warnings);
      if (tags === undefined) {
        invalid = true;
      } else {
        fields.tags = tags;
      }
      continue;
    }
    if (!isPlainScalar(value)) {
      invalid = true;
      warnings.push(`frontmatter: ${key} must be a plain scalar`);
      continue;
    }
    const scalar = unquote(value);
    if (scalar === '') continue;
    if (key === 'name') fields.name = scalar;
    else if (key === 'description') fields.description = scalar;
    else fields.version = scalar;
  }

  const state: FrontmatterState = invalid ? 'invalid' : partial ? 'partial' : 'ok';
  return {
    state,
    ...fields,
    body: lines.slice(close + 1).join('\n'),
    warnings,
  };
}

/**
 * 无 frontmatter.description 时的回落：正文首个标题 / 首段（截断 200 字符）。
 * 只取文本，不解释其中任何记法。
 */
export function deriveDescription(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const text = trimmed.startsWith('#') ? trimmed.replace(/^#+\s*/, '') : trimmed;
    if (text === '') continue;
    return text.length > MAX_DESCRIPTION_CHARS ? text.slice(0, MAX_DESCRIPTION_CHARS) : text;
  }
  return '';
}

/** description 统一截断口径（frontmatter 来的也限 200 字符） */
export function capDescription(value: string): string {
  return value.length > MAX_DESCRIPTION_CHARS ? value.slice(0, MAX_DESCRIPTION_CHARS) : value;
}
