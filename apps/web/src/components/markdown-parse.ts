/**
 * 轻量 Markdown 解析（0.6.1 P1，无重依赖）。
 *
 * 只覆盖聊天里最常见的块级/内联语法：段落、标题、fenced code、表格、
 * 有序/无序列表、引用、分隔线；内联 code、链接、粗体、斜体。
 * 永远不输出原始 HTML；链接由 `isSafeHref` 过滤（拒绝 javascript:/data:）。
 */

/** 列表项：正文 + 可选的嵌套子块（子列表 / 代码块等，按缩进归属）。 */
export interface MarkdownListItem {
  text: string;
  children?: MarkdownBlock[];
}

export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'list'; ordered: boolean; start?: number; items: MarkdownListItem[] }
  | { type: 'blockquote'; text: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'hr' };

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'link'; text: string; href: string };

const FENCE = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^\s{0,3}([-*+]|\d+[.)])\s+(.*)$/;
const BLOCKQUOTE = /^\s{0,3}>\s?(.*)$/;
// 分隔行允许单列（q-table-separator-min-cols，vessel-block fence 试点暴露）：
// `*` 量词放宽旧「至少两列 dashes」限制，`| --- |` 也是合法分隔行。
// 单列裸 `---` 不在此放行 —— 那是 HR 的领地（见 isTableSeparator 的管道守卫）。
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** 是否表格分隔行：正则之外还要求行内至少一个管道符。
 * 放宽单列后裸 `---` 也命中正则，但它必须保持水平线（HR）语义，
 * 不能把含 `|` 的段落下一行抢成表格。多列分隔行天然含管道，零损失。 */
function isTableSeparator(line: string): boolean {
  return line.includes('|') && TABLE_SEPARATOR.test(line);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  // 表格单元里的 `|` 有两种来源，都必须当成**内容**而不是分隔符：
  //   1) GFM 转义的 `\|`（模型写 markdown 表格时，单元格里出现管道符的标准写法）；
  //   2) 行内 code 里的 `|`（例如给 shell 管道符加反引号，这是模型最容易踩的写法）。
  // 之前直接 split('|')，于是「`| head`」这类单元格会把后面的内容挤到下一列 —— 表格整体错位。
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (line.trim() === '') return true;
  if (FENCE.test(line) || HEADING.test(line) || HR.test(line)) return true;
  if (LIST_ITEM.test(line) || BLOCKQUOTE.test(line)) return true;
  const next = lines[index + 1];
  return line.includes('|') && next !== undefined && isTableSeparator(next);
}

/** 行首空白宽度（与 LIST_ITEM 的 `\s` 口径一致：tab 记 1）。 */
function indentWidth(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? '').length;
}

/** 解析选项（只有流式入口需要；历史 / 落盘渲染保持默认值）。 */
export interface MarkdownParseOptions {
  /**
   * 这段文本仍在流式增长（尚未落盘）。
   *
   * 唯一影响：**吃到了正文末尾的表格**先按纯文本降级（见下）。别的东西不解构：
   * - 未闭合的 fenced code 本来就由下面的 `while` 吃到 EOF，正文一行不丢；
   * - 未闭合的 `**` / `*` / `[` / `` ` `` 由 `parseInline` 原样当文本保留（不吞字、不抛错）。
   */
  streaming?: boolean;
}

/**
 * 解析块级 Markdown；容忍未闭合的 fenced code（流式尾部）。
 *
 * `blockStarts`（可选，流式增量解析用）：与返回 blocks 一一对应的**块起始字符偏移**
 * （相对规范化后的 source）。只有顶层调用传；列表子块的递归解析不传。
 * 增量解析据此只重解析尾块（见 parseMarkdownStreaming）。
 */
export function parseMarkdown(
  source: string,
  options?: MarkdownParseOptions,
  blockStarts?: number[],
): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  // 行首字符偏移表（只在需要块偏移时算，历史渲染零开销）。
  let lineStarts: number[] | undefined;
  if (blockStarts) {
    lineStarts = [];
    let acc = 0;
    for (const line of lines) {
      lineStarts.push(acc);
      acc += line.length + 1;
    }
  }

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // 本块起始偏移 + 统一 push（块与偏移一一对应）。
    const blockStart = lineStarts?.[index] ?? 0;
    const push = (block: MarkdownBlock): void => {
      blocks.push(block);
      blockStarts?.push(blockStart);
    };

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const lang = fence[2] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (
          current.trim().startsWith(marker.slice(0, 3)) &&
          current.trim().length === marker.length
        ) {
          index += 1;
          break;
        }
        body.push(current);
        index += 1;
      }
      push({
        type: 'code',
        ...(lang ? { lang } : {}),
        text: body.join('\n'),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      push({
        type: 'heading',
        level: (heading[1] ?? '#').length,
        text: (heading[2] ?? '').trim(),
      });
      index += 1;
      continue;
    }

    if (HR.test(line)) {
      push({ type: 'hr' });
      index += 1;
      continue;
    }

    const next = lines[index + 1];
    if (line.includes('|') && next !== undefined && isTableSeparator(next)) {
      const tableStart = index;
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const row = lines[index] ?? '';
        if (row.trim() === '' || !row.includes('|')) break;
        rows.push(splitTableRow(row));
        index += 1;
      }
      // 流式**降级**：表格还没闭合时先按纯文本渲染。
      //
      // 「闭合」= 表格之后出现了别的块（哪怕只剩空行也无所谓——模型换行继续写下一行
      // 数据时不能判成闭合，否则表格 / 纯文本会随每个 chunk 反复横跳）。
      // 判据取「后面还有非空行」而不是「吃到了 EOF」：流式 chunk 常常正好断在换行之后。
      //
      // 代价：半张表期间用户看到的是一行行 `| a | b |` 原文（列宽不动）；表格写完
      // （模型开始写下一段 / run 结束）时**一次**变成 <table>。相比直接上表，这是
      // 更小的视觉成本：半张表每来一行都可能触发列宽重算与横向滚动条出现/消失。
      let rest = index;
      while (rest < lines.length && (lines[rest] ?? '').trim() === '') rest += 1;
      if (options?.streaming === true && rest >= lines.length) {
        push({ type: 'paragraph', text: lines.slice(tableStart, rest).join('\n') });
        index = rest;
        continue;
      }
      push({ type: 'table', header, rows });
      continue;
    }

    const quote = BLOCKQUOTE.exec(line);
    if (quote) {
      const parts: string[] = [];
      while (index < lines.length) {
        const current = BLOCKQUOTE.exec(lines[index] ?? '');
        if (!current) break;
        parts.push(current[1] ?? '');
        index += 1;
      }
      push({ type: 'blockquote', text: parts.join('\n') });
      continue;
    }

    const listItem = LIST_ITEM.exec(line);
    if (listItem) {
      // 列表解析分两步：先收集属于本列表的所有行（含缩进子内容与 loose 空行），
      // 再按「同级标记行」切项、把缩进行递归解析成子块。
      //
      // 修掉的两个渲染 bug（用户截图实证）：
      //   1) 旧实现遇空行即断列表 → loose list（项间空行，模型最常见写法）每项
      //      各成一个 <ol>，序号全部从 1 重新开始；
      //   2) 旧 LIST_ITEM 允许 0–3 空格缩进 → 嵌套子项被当成同级项拍平，
      //      子 bullet 混进父 <ol> 继续编号（2.3.4.5…）。
      const baseIndent = indentWidth(line);
      const ordered = /^\d/.test(listItem[1] ?? '');
      const start = ordered ? Number.parseInt(listItem[1] ?? '1', 10) : 1;
      const isSiblingMarker = (candidate: string): boolean => {
        if (indentWidth(candidate) >= baseIndent + 2) return false;
        const match = LIST_ITEM.exec(candidate);
        return match !== null && /^\d/.test(match[1] ?? '') === ordered;
      };

      const raw: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (current.trim() === '') {
          // 空行后仍是本列表的内容（同级同类标记 / 缩进子内容）→ loose list 延续；
          // 否则列表到此结束。
          let ahead = index + 1;
          while (ahead < lines.length && (lines[ahead] ?? '').trim() === '') ahead += 1;
          const nextLine = lines[ahead];
          if (nextLine === undefined) break;
          if (indentWidth(nextLine) >= baseIndent + 2 || isSiblingMarker(nextLine)) {
            raw.push(current);
            index += 1;
            continue;
          }
          break;
        }
        if (indentWidth(current) >= baseIndent + 2 || isSiblingMarker(current)) {
          raw.push(current);
          index += 1;
          continue;
        }
        break;
      }

      const items: MarkdownListItem[] = [];
      let text = '';
      let subs: string[] = [];
      let started = false;
      const flushItem = () => {
        if (!started) return;
        // 按子行的最小缩进脱进（≥ base+2）：保留相对嵌套结构，同时让
        // `1. `（内容缩进 3）下的围栏代码不残留多余前导空格。
        const nonBlank = subs.filter((sub) => sub.trim() !== '');
        const strip =
          nonBlank.length > 0
            ? nonBlank.reduce(
                (min, sub) => Math.min(min, indentWidth(sub)),
                Number.POSITIVE_INFINITY,
              )
            : 0;
        const childLines = subs.map((sub) => sub.slice(strip));
        // 前导的普通缩进续行并入项正文（保持旧行为）；遇到第一个块级语法
        // （子列表 / 围栏 / 引用…）起，剩余行递归解析为嵌套子块。
        let cursor = 0;
        while (cursor < childLines.length) {
          const childLine = childLines[cursor] ?? '';
          if (childLine.trim() === '') {
            cursor += 1;
            continue;
          }
          if (startsBlock(childLines, cursor)) break;
          text = `${text} ${childLine.trim()}`;
          cursor += 1;
        }
        const rest = childLines.slice(cursor);
        const children = rest.length > 0 ? parseMarkdown(rest.join('\n'), options) : [];
        items.push({ text, ...(children.length > 0 ? { children } : {}) });
      };
      for (const rawLine of raw) {
        if (isSiblingMarker(rawLine)) {
          flushItem();
          text = LIST_ITEM.exec(rawLine)?.[2] ?? '';
          subs = [];
          started = true;
          continue;
        }
        subs.push(rawLine);
      }
      flushItem();

      push({
        type: 'list',
        ordered,
        ...(ordered && start !== 1 ? { start } : {}),
        items,
      });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraph.push((lines[index] ?? '').trimEnd());
      index += 1;
    }
    if (paragraph.length > 0) {
      push({ type: 'paragraph', text: paragraph.join('\n') });
    } else {
      // 防御：startsBlock 判定为 true 但没有分支消费时，至少前进一行。
      index += 1;
    }
  }

  return blocks;
}

/** 流式增量解析缓存（每个 Markdown 实例一份，挂在组件 ref 上，不跨实例共享）。 */
export interface StreamingParseCache {
  /** 已解析的规范化全文（上次提交的前缀）。 */
  source: string;
  /** 上次的块结果（前缀块对象引用稳定 ⇒ memo(Block) 跳过重渲染）。 */
  blocks: MarkdownBlock[];
  /** 与 blocks 一一对应的块起始字符偏移（重解析锚点取倒数第二块）。 */
  starts: number[];
}

/**
 * 流式增量解析（流式平滑化 A 正文配套，豆包式 typewriter 的成本约束）。
 *
 * 正文只在尾部追加 ⇒ 只有尾块的源码会增长。但**不能只重解析尾块**：尾块可能是
 * 退化形态（裸 `-` 行按段落降级 / 半张表降级段），追加会改变它首行的语法类型，
 * 从而**并入前块**（裸 `-` 长成列表项并入前面的 list；半张表闭合改变降级判定）。
 * 受影响的边界只有「倒数第二块 / 尾块」这一条：更前的块，其末行由后继块的首行
 * 钉死，追加够不到。所以从**倒数第二块起点**重解析（末两块），前缀块对象原样
 * 复用（引用相等 ⇒ memo(Block) 整棵子树跳过）。每帧成本 O(末两块) 而非 O(全文)，
 * 这是「逐帧 reveal 不逐帧全量 parse」的关键。
 *
 * 正确性边界：缓存只在 `新文本.startsWith(旧文本)` 时命中；换文 / 缩短 / 非流式
 * 一律全量解析。尾段重解析若意外为空（防御），回落全量。
 */
export function parseMarkdownStreaming(
  source: string,
  cache: StreamingParseCache | null,
): { blocks: MarkdownBlock[]; cache: StreamingParseCache } {
  const normalized = source.replace(/\r\n?/g, '\n');
  if (cache && cache.blocks.length > 0 && normalized.startsWith(cache.source)) {
    const anchor = cache.starts[cache.starts.length - 2] ?? 0;
    const tailStarts: number[] = [];
    const tailBlocks = parseMarkdown(normalized.slice(anchor), { streaming: true }, tailStarts);
    if (tailBlocks.length > 0) {
      const keep = Math.max(0, cache.blocks.length - 2);
      const blocks = [...cache.blocks.slice(0, keep), ...tailBlocks];
      const starts = [...cache.starts.slice(0, keep), ...tailStarts.map((off) => anchor + off)];
      return { blocks, cache: { source: normalized, blocks, starts } };
    }
  }
  const starts: number[] = [];
  const blocks = parseMarkdown(normalized, { streaming: true }, starts);
  return { blocks, cache: { source: normalized, blocks, starts } };
}

/**
 * 仅允许 http(s)/mailto/锚点/相对路径；
 * 拒绝 javascript:/data:/协议相对 URL，以及反斜杠变体（`\\evil` / `/\evil`
 * 会被 WHATWG URL 归一化成 `//evil`）。
 */
export function isSafeHref(href: string): boolean {
  const value = href.trim();
  if (value === '') return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('//')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return /^(https?|mailto):/i.test(value);
  }
  return true;
}

/**
 * 单行内联扫描上限：超过后退化为纯文本。
 * 避免模型输出的病态超长行（几万 `[`/`*`）拖死主线程。
 */
const MAX_INLINE_LENGTH = 20_000;

/**
 * 解析内联 Markdown（线性扫描）；粗体/斜体内部不再嵌套解析（聊天场景足够）。
 * 括号/圆括号的查找位置会被缓存，未闭合的定界符不会导致重复全行扫描。
 */
export function parseInline(source: string): InlineNode[] {
  if (source.length > MAX_INLINE_LENGTH) return [{ type: 'text', text: source }];

  const nodes: InlineNode[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer !== '') {
      nodes.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  let closeBracket: number | undefined;
  let closeParen: number | undefined;
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === '`') {
      const end = source.indexOf('`', index + 1);
      if (end === -1) {
        buffer += source.slice(index);
        break;
      }
      flush();
      nodes.push({ type: 'code', text: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }

    if (char === '[') {
      // `-1` 一旦算出即代表其后没有 `]`，无需再扫描。
      if (closeBracket === undefined || (closeBracket !== -1 && closeBracket <= index)) {
        closeBracket = source.indexOf(']', index + 1);
      }
      const close = closeBracket;
      if (close === -1) {
        buffer += source.slice(index);
        break;
      }
      if (source[close + 1] === '(') {
        // 尖括号目标形 `[name](<scheme:target>)`（CommonMark；file-ref-ux A6）：
        // 容空格 / 圆括号（Windows 路径 `D:/my file (1).pdf`）。安全性在渲染侧
        // 判（scheme 白名单 / 增强器），这里只解析形状。
        if (source[close + 2] === '<') {
          const gt = source.indexOf('>', close + 3);
          if (gt !== -1 && source[gt + 1] === ')') {
            const href = source.slice(close + 3, gt);
            if (href.length > 0 && !/[\n]/.test(href)) {
              flush();
              nodes.push({ type: 'link', text: source.slice(index + 1, close), href });
              index = gt + 2;
              closeBracket = undefined;
              closeParen = undefined;
              continue;
            }
          }
        }
        if (closeParen === undefined || (closeParen !== -1 && closeParen <= close + 1)) {
          closeParen = source.indexOf(')', close + 2);
        }
        const end = closeParen;
        if (end !== -1 && end > close + 2) {
          const href = source.slice(close + 2, end);
          if (!/\s/.test(href)) {
            flush();
            const label = source.slice(index + 1, close);
            // 安全 scheme ⇒ 可点击链接；带 scheme 但不安全 ⇒ 仍出 link 节点，
            // 渲染侧落「不可点击文本（名称+目标可见）」档（A9 通用兜底）；
            // 其余（javascript: 等无 scheme 形状的怪值）保持旧行为只留 label。
            if (isSafeHref(href) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) {
              nodes.push({ type: 'link', text: label, href });
            } else {
              nodes.push({ type: 'text', text: label });
            }
            index = end + 1;
            closeBracket = undefined;
            closeParen = undefined;
            continue;
          }
        }
      }
      buffer += char;
      index += 1;
      continue;
    }

    if (source.startsWith('**', index)) {
      const end = source.indexOf('**', index + 2);
      if (end >= index + 3) {
        const content = source.slice(index + 2, end);
        if (!content.includes('*')) {
          flush();
          nodes.push({ type: 'strong', text: content });
          index = end + 2;
          continue;
        }
      }
      buffer += '**';
      index += 2;
      continue;
    }

    if (char === '*') {
      const end = source.indexOf('*', index + 1);
      if (end === -1) {
        buffer += source.slice(index);
        break;
      }
      if (end >= index + 2) {
        const content = source.slice(index + 1, end);
        if (!content.includes('*')) {
          flush();
          nodes.push({ type: 'em', text: content });
          index = end + 1;
          continue;
        }
      }
      buffer += char;
      index += 1;
      continue;
    }

    buffer += char;
    index += 1;
  }

  flush();
  return nodes;
}
