/**
 * 正文抽取（M1，无第三方依赖）。
 *
 * 两步：
 * 1. `HTMLRewriter`（Bun 内建）做净化：删掉 script/style/nav/footer/form 控件，
 *    以及**隐藏元素**（`hidden`、`aria-hidden="true"`、`display:none`/`visibility:hidden`/`opacity:0`）——
 *    隐藏文本是提示注入最常见的藏匿点，必须在抽取阶段就丢掉。
 * 2. 自己的小扫描器把净化后的 HTML 拍平成纯文本：块级标签变成换行（保留段落与标题），
 *    顺便收 `<a href>`（后续在 http.ts 里再按同源过滤、去重、限量）。
 *
 * 质量目标不是 Readability 级别，只要求「不丢正文、不留垃圾、不留隐藏文本」。
 */

export interface ExtractOptions {
  /** 收集链接的上限（同源过滤在调用方做） */
  maxLinks: number;
}

export interface ExtractOutput {
  text: string;
  title: string;
  links: string[];
}

/** 这些元素整体丢掉：无正文价值，且常被用来塞提示注入。 */
const NOISE_SELECTOR =
  'script, style, noscript, template, svg, canvas, iframe, object, embed, ' +
  'nav, footer, form, button, input, select, textarea';

/** HTML 的 void 元素：没有闭合标签，扫描时不能拿它们去加减 skip 深度。 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** 扫描器里整体跳过文本的标签（净化后基本不会出现，作为兜底）。 */
const SKIP_TEXT_TAGS = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'nav',
  'footer',
  'form',
  'button',
  'input',
  'select',
  'textarea',
]);

/** 块级标签：前后补换行，保证段落/标题之间不会粘成一行。 */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'br',
  'hr',
  'li',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'tr',
  'table',
  'thead',
  'tbody',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'section',
  'article',
  'header',
  'main',
  'aside',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'address',
  'details',
  'summary',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  times: '×',
  divide: '÷',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  sect: '§',
  para: '¶',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
  micro: 'µ',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
};

export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

interface RewriterElementLike {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  remove(): void;
}

/** 只描述本模块用到的那部分 HTMLRewriter API，避免绑死某个版本的运行时类型声明。 */
interface RewriterLike {
  on(selector: string, handlers: { element(element: RewriterElementLike): void }): RewriterLike;
  transform(input: Response): { text(): Promise<string> };
}

/** 隐藏元素的判定：属性 + 内联样式的常见写法。 */
export function isHiddenElement(element: RewriterElementLike): boolean {
  if (element.hasAttribute('hidden')) return true;
  const ariaHidden = (element.getAttribute('aria-hidden') ?? '').trim().toLowerCase();
  if (ariaHidden === 'true') return true;

  const style = (element.getAttribute('style') ?? '').toLowerCase();
  if (style === '') return false;
  const compact = style.replace(/\s+/g, '');
  if (compact.includes('display:none')) return true;
  if (compact.includes('visibility:hidden')) return true;
  // opacity: 0 / 0.0 / 0.00 —— 不要用 includes('opacity:0')，会把 opacity:0.5 也误杀
  if (/(^|[;])opacity:0(\.0+)?(;|$)/.test(compact)) return true;
  return false;
}

/**
 * 用 HTMLRewriter 净化。HTMLRewriter 不可用（非 Bun 运行时）时退化成原文，
 * 由扫描器按标签兜底跳过噪声——只是失去隐藏元素识别，不会崩。
 */
async function sanitizeWithRewriter(html: string): Promise<string> {
  const rewriterCtor = (globalThis as { HTMLRewriter?: new () => RewriterLike }).HTMLRewriter;
  if (typeof rewriterCtor !== 'function') return html;

  const rewriter = new rewriterCtor()
    .on(NOISE_SELECTOR, {
      element(element) {
        element.remove();
      },
    })
    .on('*', {
      element(element) {
        if (isHiddenElement(element)) element.remove();
      },
    });

  return rewriter.transform(new Response(html)).text();
}

function findTagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let index = from + 1; index < html.length; index += 1) {
    const char = html[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let match = pattern.exec(raw);
  while (match !== null) {
    const name = (match[1] ?? '').toLowerCase();
    let value = match[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (name !== '') attributes.set(name, decodeEntities(value));
    match = pattern.exec(raw);
  }
  return attributes;
}

function normalizeText(raw: string): string {
  const lines = raw
    // 去掉零宽字符与 bidi 覆写符：它们能让「肉眼看到的文本」与模型读到的文本不一致
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim());
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把净化后的 HTML 拍平成纯文本 + 链接 + 标题。 */
export function flattenHtml(html: string, base: URL, options: ExtractOptions): ExtractOutput {
  const links: string[] = [];
  const body: string[] = [];
  const titleParts: string[] = [];

  let index = 0;
  let skipDepth = 0;
  let inTitle = false;

  const pushText = (chunk: string): void => {
    if (chunk === '') return;
    if (inTitle) {
      titleParts.push(chunk);
      return;
    }
    if (skipDepth > 0) return;
    body.push(decodeEntities(chunk));
  };

  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) {
      pushText(html.slice(index));
      break;
    }
    pushText(html.slice(index, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break;
      index = end + 3;
      continue;
    }

    const gt = findTagEnd(html, lt);
    if (gt === -1) break;
    const rawTag = html.slice(lt + 1, gt);
    index = gt + 1;

    if (rawTag.startsWith('!') || rawTag.startsWith('?')) continue;

    const closing = rawTag.startsWith('/');
    const withoutSlash = closing ? rawTag.slice(1) : rawTag;
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(withoutSlash);
    if (!nameMatch) continue;
    const name = (nameMatch[0] ?? '').toLowerCase();
    const selfClosing = /\/\s*$/.test(rawTag);

    if (name === 'title') {
      inTitle = !closing;
      continue;
    }

    if (SKIP_TEXT_TAGS.has(name)) {
      if (!VOID_TAGS.has(name) && !selfClosing) {
        skipDepth = closing ? Math.max(0, skipDepth - 1) : skipDepth + 1;
      }
      continue;
    }

    if (closing) {
      if (BLOCK_TAGS.has(name) && skipDepth === 0) body.push('\n\n');
      continue;
    }

    const attributes = parseAttributes(withoutSlash.slice(name.length));

    if (name === 'a' && links.length < options.maxLinks) {
      const href = attributes.get('href');
      if (href !== undefined && href !== '' && !href.startsWith('#')) {
        try {
          const resolved = new URL(href, base);
          if (resolved.protocol === 'http:' || resolved.protocol === 'https:')
            links.push(resolved.href);
        } catch {
          // 解析不了的 href 直接忽略
        }
      }
    }

    if (name === 'img' && skipDepth === 0) {
      const alt = (attributes.get('alt') ?? '').trim();
      if (alt !== '') body.push(`\n[图片: ${alt}]\n`);
    }

    if (BLOCK_TAGS.has(name) && skipDepth === 0) {
      body.push(name === 'li' ? '\n- ' : '\n\n');
      if (selfClosing) body.push('\n');
    }
  }

  // 标题放在最前面：既是正文的一部分，也让模型一眼知道页面主题
  // 标题也限量：某些站点标题能堆几千字符，不该白吃 budget
  const title = normalizeText(titleParts.join(' ')).replace(/\n+/g, ' ').slice(0, 200);
  const text = normalizeText(body.join(''));
  return {
    text: title === '' ? text : `${title}\n\n${text}`,
    title,
    links,
  };
}

export async function extractDocument(
  html: string,
  base: URL,
  options: ExtractOptions,
): Promise<ExtractOutput> {
  const sanitized = await sanitizeWithRewriter(html);
  return flattenHtml(sanitized, base, options);
}
