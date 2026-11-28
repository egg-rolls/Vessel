/**
 * vessel-block fence（块 P1 试点，docs/architecture/blocks.md §5）的纯函数层：
 * 识别 + schema 校验 + 渲染投影。
 *
 * ## 格式（新 type 统一 fenced JSON）
 *
 * ````
 * ```vessel-block
 * {"type":"table","caption":"…","columns":[…],"rows":[…]}
 * ```
 * ````
 *
 * - info string **精确匹配** `vessel-block`（markdown-parse 的 FENCE 字符类
 *   `[A-Za-z0-9_+-]*` 天然认它）；AI 可直接产出，无需新工具。
 * - **试点范围（最小）**：整条正文（前序信封剥掉后）trim 恰为**一个闭合**
 *   vessel-block fence 才提升；正文中段 fence 保持 markdown 原生 code 渲染
 *   （table/code 原生够用裁定，blocks.md §5）。与 lift 契约「一条消息每个
 *   宿主 type 至多一块」一致。
 * - **流式硬约束**：未闭合（缺收尾 ``` 行）返回 null —— 正文原样留给
 *   markdown-parse 既有保守策略（未闭合 fence 吃到 EOF 逐字渲染），不提升
 *   半截块（否则流式闪烁回归）。
 * - **坏 payload 兜底**：JSON 解析失败 / type 未注册 / 形状不对一律 null，
 *   fence 原文渲染（markdown code 块），不猜、不吞字。
 * - **可见性对等**：模型侧投影 = fence 原文（可读 JSON）；渲染投影 =
 *   payload → markdown 表格文本 → 既有 Markdown 组件（组件复用第一原则，
 *   不造独立卡）。
 *
 * @module web/chat/vessel-block
 */
import { tableToMarkdown } from '../../text';

/** 试点 type：table。新 type 在此扩 union + 校验分支（blocks.md §5.1）。 */
export interface VesselBlockTablePayload {
  type: 'table';
  /** 可选表题（非空字符串）；渲为表格前强调行。 */
  caption?: string;
  /** 表头：≥1 列，字符串数组。 */
  columns: string[];
  /** 数据行：每行字符串数组且长度 == columns.length；可为空数组（空表合法）。 */
  rows: string[][];
}

/**
 * 块 P2 新增 type：code（AI 工具 attachToolBlocks surface 的代码块）。
 * 投影 = markdown 原生 fenced code（复用 Markdown 组件高亮/复制，不造独立卡，
 * blocks.md「table/code 原生够用」裁定）；fence 只是结构化载体。
 */
export interface VesselBlockCodePayload {
  type: 'code';
  /** 可选语言标签（非空字符串）；投影为 fence info string。 */
  language?: string;
  /** 代码正文（非空字符串；可含任意字符，投影时围栏自适应加长防内嵌 ```）。 */
  code: string;
}

/** 已注册 type 的联合（parse/投影的统一口径）。 */
export type VesselBlockPayload = VesselBlockTablePayload | VesselBlockCodePayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 严格形状校验（blocks.md §5.1 schema）；不对返回 null。未知附加键忽略（additive）。 */
function validateTablePayload(value: unknown): VesselBlockTablePayload | null {
  if (!isRecord(value) || value.type !== 'table') return null;
  const { columns, rows, caption } = value;
  if (!Array.isArray(columns) || columns.length === 0) return null;
  if (!columns.every((cell) => typeof cell === 'string')) return null;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== columns.length) return null;
    if (!row.every((cell) => typeof cell === 'string')) return null;
  }
  if (caption !== undefined && (typeof caption !== 'string' || caption.length === 0)) return null;
  return {
    type: 'table',
    ...(caption !== undefined ? { caption } : {}),
    columns: columns as string[],
    rows: rows as string[][],
  };
}

/** code schema（块 P2）：与 core tool-attachment.ts 入口校验同口径。 */
function validateCodePayload(value: unknown): VesselBlockCodePayload | null {
  if (!isRecord(value) || value.type !== 'code') return null;
  const { code, language } = value;
  if (typeof code !== 'string' || code.length === 0) return null;
  if (language !== undefined && (typeof language !== 'string' || language.length === 0))
    return null;
  return {
    type: 'code',
    ...(language !== undefined ? { language } : {}),
    code,
  };
}

/**
 * 整条正文 → vessel-block payload；不是「单个闭合 vessel-block fence + 合法
 * schema」返回 null（原文渲染兜底）。只认 ``` 围栏（spec 口径；~~~ 不认）。
 */
export function parseVesselBlockFence(content: string): VesselBlockPayload | null {
  const lines = content.trim().split('\n');
  // 开栏 + ≥1 行 payload + 收栏。
  if (lines.length < 3) return null;
  if (lines[0] !== '```vessel-block') return null;
  if (lines[lines.length - 1]?.trim() !== '```') return null;
  // 中段不得出现收栏行：markdown 在第一个恰为 ``` 的行闭合，若中段有则
  // 这不是「整条正文单 fence」，留给原文渲染。
  for (let index = 1; index < lines.length - 1; index += 1) {
    if (lines[index]?.trim() === '```') return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines.slice(1, -1).join('\n'));
  } catch {
    return null;
  }
  if (isRecord(parsed) && parsed.type === 'code') return validateCodePayload(parsed);
  return validateTablePayload(parsed);
}

/**
 * 渲染投影：payload → markdown 文本（喂既有 Markdown 组件，原生 table / code
 * 渲染：横向滚动 + 复制按钮全复用）。表格序列化与复制按钮共用 text.ts#tableToMarkdown。
 * code 投影围栏自适应加长（比正文内最长反引号串多 1，≥3）——正文含 ``` 也不会
 * 提前闭合（CommonMark 围栏规则），不吞字。
 */
export function vesselBlockMarkdown(payload: VesselBlockPayload): string {
  if (payload.type === 'code') {
    let longestRun = 0;
    for (const match of payload.code.match(/`+/g) ?? []) {
      if (match.length > longestRun) longestRun = match.length;
    }
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    return `${fence}${payload.language ?? ''}\n${payload.code}\n${fence}`;
  }
  const table = tableToMarkdown(payload.columns, payload.rows);
  return payload.caption !== undefined ? `**${payload.caption}**\n\n${table}` : table;
}
