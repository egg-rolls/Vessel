export interface HighlightSegment {
  text: string;
  match: boolean;
  /** 在原文中的起始下标；可直接作为渲染 key。 */
  start: number;
}

/** 查询串按字面量匹配；正则元字符不会触发语法错误。 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const needle = query.trim();
  if (!needle) return [{ text, match: false, start: 0 }];
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'gi');
  const parts: HighlightSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index), match: false, start: last });
    parts.push({ text: match[0], match: true, start: index });
    last = index + match[0].length;
  }
  if (last === 0) return [{ text, match: false, start: 0 }];
  if (last < text.length) parts.push({ text: text.slice(last), match: false, start: last });
  return parts;
}
