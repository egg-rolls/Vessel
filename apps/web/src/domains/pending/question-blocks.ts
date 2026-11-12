/**
 * 问题正文的切块（纯函数）。
 *
 * ask 的 `question` 就是一段文本，用户可以写 markdown 图片语法或裸链接。
 * Gateway 的 CSP 是 `img-src 'self' data:`，所以只有同源路径与 `data:image/...`
 * 才能真的显示成图片；其余一律降级成链接，不静默丢内容、也不谎称渲染成功。
 */

export type QuestionBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'link'; href: string; label: string };

/** `![alt](url)`；alt 内不允许出现右方括号，避免跨行吞掉后文。 */
const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;

/** 裸 http(s) 链接（不含引号 / 尖括号 / 括号，避免把句末标点吞进去）。 */
const URL = /https?:\/\/[^\s<>()"']+/g;

/** 同源路径或 data URL 才允许内联；协议相对（`//host`）不算同源。 */
function inlineImage(src: string): boolean {
  const lower = src.toLowerCase();
  if (lower.startsWith('data:image/')) return true;
  return src.startsWith('/') && !src.startsWith('//');
}

function textBlocks(value: string): QuestionBlock[] {
  const blocks: QuestionBlock[] = [];
  let cursor = 0;
  URL.lastIndex = 0;
  let match = URL.exec(value);
  while (match !== null) {
    if (match.index > cursor) {
      blocks.push({ kind: 'text', text: value.slice(cursor, match.index) });
    }
    const href = match[0] ?? '';
    blocks.push({ kind: 'link', href, label: href });
    cursor = match.index + href.length;
    match = URL.exec(value);
  }
  if (cursor < value.length) blocks.push({ kind: 'text', text: value.slice(cursor) });
  return blocks;
}

/** 文本 → 块序列；顺序与原文一致，空文本不产生块。 */
export function questionBlocks(text: string): QuestionBlock[] {
  const blocks: QuestionBlock[] = [];
  let cursor = 0;
  IMAGE.lastIndex = 0;
  let match = IMAGE.exec(text);
  while (match !== null) {
    if (match.index > cursor) blocks.push(...textBlocks(text.slice(cursor, match.index)));
    const alt = match[1] ?? '';
    const src = match[2] ?? '';
    if (inlineImage(src)) {
      blocks.push({ kind: 'image', src, alt });
    } else {
      blocks.push({ kind: 'link', href: src, label: alt === '' ? src : alt });
    }
    cursor = match.index + (match[0] ?? '').length;
    match = IMAGE.exec(text);
  }
  if (cursor < text.length) blocks.push(...textBlocks(text.slice(cursor)));
  return blocks;
}
