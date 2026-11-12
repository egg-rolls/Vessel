/**
 * Design Lab token catalog —— **自动枚举版**（不再手写清单）。
 *
 * 唯一事实源是 document.documentElement 上**实际存在**的自定义属性：
 * 用 getComputedStyle(document.documentElement) 逐项枚举出所有 '--' 开头的属性，
 * 再按 TOKEN_GROUP_RULES 的**前缀规则**分组。于是：
 *
 * - 往 styles/tokens.css 里加一个 token，**不改本目录任何代码**，刷新设计实验室
 *   就能看到它（新前缀没被规则命中时落到「其它」组，也不会消失）；
 * - 值的来源是运行时计算值，light / dark 切换（data-theme 或系统主题）自动跟着变；
 * - 颜色类 token 额外采样一份**强制暗色**下的值（sampleDarkValues），这样在亮色主题
 *   下也能并排看到暗色档，不必真的切主题。
 *
 * 枚举走两条路：优先 getComputedStyle 的枚举（Chrome / Firefox / Safari 都会把
 * 自定义属性列在 computed style 里）；万一某个运行时枚举为空（旧引擎），退回到
 * 扫同源样式表的 :root 声明 —— 两条路都只读 DOM，不发任何请求。
 */
import { useEffect, useMemo, useState } from 'react';

export type TokenKind =
  | 'color'
  | 'shadow'
  | 'radius'
  | 'space'
  | 'type'
  | 'font'
  | 'motion'
  | 'size'
  | 'z'
  | 'other';

export interface TokenGroupRule {
  id: string;
  /** 组名的 i18n key（designLab.tokens.*）。 */
  titleKey: string;
  kind: TokenKind;
  /**
   * 命中规则：token 名 startsWith 任一项即归本组。**顺序即优先级**，
   * 空数组 = 兜底组（放最后）。新增 token 只可能落到已有组或兜底组，不会丢。
   */
  prefixes: readonly string[];
}

/**
 * 前缀 → 组的映射表（唯一需要手工维护的地方）。
 *
 * 规则按顺序匹配：更专的前缀写在前面，语义相近的家族用显式前缀分开
 * （字号家族的 --size-* 与尺寸组的容器宽度不是同一回事）。
 */
export const TOKEN_GROUP_RULES: readonly TokenGroupRule[] = [
  {
    id: 'color',
    titleKey: 'designLab.tokens.colors',
    kind: 'color',
    prefixes: [
      '--color',
      '--bg',
      '--surface',
      '--ink',
      '--muted',
      '--faint',
      '--line',
      '--accent',
      '--ok',
      '--warn',
      '--amber',
      '--danger',
      '--info',
      '--hover',
      '--press',
      '--scrim',
      '--overlay',
    ],
  },
  {
    id: 'shadow',
    titleKey: 'designLab.tokens.shadows',
    kind: 'shadow',
    prefixes: ['--shadow', '--elev', '--focus-ring'],
  },
  {
    id: 'radius',
    titleKey: 'designLab.tokens.radii',
    kind: 'radius',
    prefixes: ['--radius', '--shape'],
  },
  {
    id: 'space',
    titleKey: 'designLab.tokens.spacing',
    kind: 'space',
    prefixes: ['--space', '--gap'],
  },
  {
    id: 'type',
    titleKey: 'designLab.tokens.typography',
    kind: 'type',
    prefixes: ['--size', '--text', '--tracking', '--leading'],
  },
  {
    id: 'font',
    titleKey: 'designLab.tokens.fonts',
    kind: 'font',
    prefixes: ['--font'],
  },
  {
    id: 'motion',
    titleKey: 'designLab.tokens.motion',
    kind: 'motion',
    prefixes: ['--motion', '--ease', '--duration'],
  },
  {
    id: 'size',
    titleKey: 'designLab.tokens.sizes',
    kind: 'size',
    prefixes: [
      '--appbar',
      '--nav',
      '--sessions',
      '--team',
      '--dock',
      '--bottom',
      '--composer',
      '--modal',
      '--panel',
      '--palette',
      '--drawer',
      '--search',
      '--select',
      '--row',
      '--control',
      '--content',
      '--transcript',
      '--touch',
      '--msg-fold',
      '--vvh',
    ],
  },
  {
    id: 'z',
    titleKey: 'designLab.tokens.layers',
    kind: 'z',
    prefixes: ['--z'],
  },
  {
    id: 'other',
    titleKey: 'designLab.tokens.other',
    kind: 'other',
    prefixes: [],
  },
];

/** 兜底规则：任何前缀都没命中的 token 落在这里，所以「新的 token 不会消失」。 */
const FALLBACK_RULE = TOKEN_GROUP_RULES[TOKEN_GROUP_RULES.length - 1] as TokenGroupRule;

/** token 名 → 组规则（前缀顺序即优先级）。 */
export function groupRuleFor(name: string): TokenGroupRule {
  for (const rule of TOKEN_GROUP_RULES) {
    if (rule.prefixes.some((prefix) => name.startsWith(prefix))) return rule;
  }
  return FALLBACK_RULE;
}

export interface TokenGroup {
  id: string;
  titleKey: string;
  kind: TokenKind;
  tokens: readonly string[];
}

export type TokenValues = Readonly<Record<string, string>>;

/** 自定义属性名前缀。 */
const CUSTOM_PROPERTY = '--';

/** 一个 computed style 上枚举到的自定义属性（去重交给调用方）。 */
function customPropertiesOf(style: CSSStyleDeclaration): string[] {
  const names: string[] = [];
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    if (name.startsWith(CUSTOM_PROPERTY)) names.push(name);
  }
  return names;
}

/**
 * 作者声明的两套值（**方案 A**）：亮色 = ':root' 块里作者写的那套，暗色 =
 * ':root[data-theme="dark"]' 块里那套。两份都从**样式表对象模型**读，所以
 * 与用户当前在哪个主题**完全无关** —— 切主题时这两列不会变。
 *
 * 为什么不用「临时 data-theme 采样」拿亮色：tokens.css 没有
 * ':root[data-theme="light"]' 块，系统暗色时 @media 那条会盖住 ':root'，改属性
 * 拿不到亮色值。而暗色侧**另有**显式块，同样能直接从对象模型读到，于是两侧同源、
 * 同一套解析规则、同一份显示格式（作者写的字面量），也不需要改任何属性。
 */
export interface AuthorTables {
  light: TokenValues;
  dark: TokenValues;
  /** 是否读到过样式表规则（读不到时退回到 computed 采样，见 readSnapshot）。 */
  readable: boolean;
}

function declarationMap(style: CSSStyleDeclaration): TokenValues {
  const values: Record<string, string> = {};
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    if (!name.startsWith(CUSTOM_PROPERTY)) continue;
    values[name] = style.getPropertyValue(name).trim();
  }
  return values;
}

/**
 * 递归遍历样式表规则：顶层规则、@import 进来的表、@layer / @supports / @container
 * 块都要进；**@media 整块跳过** —— 那里是「系统暗色」与窄屏覆盖，不属于作者为
 * 某个主题写的那套值（窄屏覆盖只影响尺寸类 token，那些仍走当前主题的 computed）。
 */
function walkRules(list: CSSRuleList | null, visit: (rule: CSSStyleRule) => void, depth = 0): void {
  if (list === null || depth > 4) return;
  for (const rule of Array.from(list)) {
    if (rule instanceof CSSStyleRule) {
      visit(rule);
      continue;
    }
    if (typeof CSSMediaRule !== 'undefined' && rule instanceof CSSMediaRule) continue;
    if (typeof CSSImportRule !== 'undefined' && rule instanceof CSSImportRule) {
      // 类型上 styleSheet 可能非空，但跨域 / 未加载时运行时会给 null，所以先落到可空变量。
      const imported: CSSStyleSheet | null = rule.styleSheet;
      let inner: CSSRuleList | null = null;
      try {
        inner = imported === null ? null : imported.cssRules;
      } catch {
        inner = null;
      }
      walkRules(inner, visit, depth + 1);
      continue;
    }
    const nested = (rule as unknown as { cssRules?: CSSRuleList }).cssRules;
    if (nested !== undefined) walkRules(nested, visit, depth + 1);
  }
}

/** ':root' 精确一段（允许 ':root, :host' 这种并列，Tailwind 的 theme 变量就是这样发的）。 */
function isLightRootSelector(selectorText: string): boolean {
  return selectorText.split(',').some((part) => part.trim() === ':root');
}

/** ':root[data-theme="dark"]'（引号风格交给浏览器归一，只认「root + 属性含 dark」）。 */
function isDarkRootSelector(selectorText: string): boolean {
  return selectorText
    .split(',')
    .some((part) => part.includes(':root') && part.includes('data-theme') && part.includes('dark'));
}

/** 读作者声明的两套值；跨域样式表读 cssRules 会抛，跳过即可。 */
export function readAuthorTables(): AuthorTables {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  if (typeof document === 'undefined') return { light, dark, readable: false };
  let readable = false;
  const visit = (rule: CSSStyleRule): void => {
    readable = true;
    const target = isDarkRootSelector(rule.selectorText)
      ? dark
      : isLightRootSelector(rule.selectorText)
        ? light
        : null;
    if (target === null) return;
    Object.assign(target, declarationMap(rule.style));
  };
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    walkRules(rules, visit);
  }
  return { light, dark, readable };
}

/** var(--x) 独占整个值时才值得跟；复合值（阴影 / min() / calc()）保留原文。 */
const VAR_PREFIX = /^var\(\s*(--[a-z0-9-]+)\s*\)/i;

/** 纯别名（整个值就是一个 var(--x)）→ 目标 token 名；否则 undefined。 */
function pureAliasTarget(value: string): string | undefined {
  const match = VAR_PREFIX.exec(value);
  if (match === null || match[0].length !== value.length) return undefined;
  return match[1];
}

function otherSide(side: 'light' | 'dark'): 'light' | 'dark' {
  return side === 'light' ? 'dark' : 'light';
}

/** 顺着 var(--x) 再查一次（最多 8 跳），目标 token 本侧优先、另一侧兜底。 */
function resolveAlias(
  raw: string,
  side: 'light' | 'dark',
  tables: AuthorTables,
  depth = 0,
  seen = new Set<string>(),
): string {
  const target = pureAliasTarget(raw);
  if (target === undefined || depth > 8 || seen.has(target)) return raw;
  seen.add(target);
  const next = tables[side][target] ?? tables[otherSide(side)][target];
  if (next === undefined) return raw;
  return resolveAlias(next, side, tables, depth + 1, seen);
}

/**
 * 某个 token 在某一侧（亮 / 暗）的显示值。
 *
 * - 本侧没声明、另一侧是**纯别名**（例如 --color-bg: var(--bg) 这种主题无关的间接层）
 *   → 用本侧的表把别名解开，得到本侧的真值；
 * - 本侧没声明、另一侧是**字面量** → 返回 undefined，交给 UI 显示「未定义」
 *   （不替用户编一个值）。
 */
export function sideValue(
  name: string,
  side: 'light' | 'dark',
  tables: AuthorTables,
): string | undefined {
  const direct = tables[side][name];
  if (direct !== undefined) return resolveAlias(direct, side, tables);
  const alias = tables[otherSide(side)][name];
  if (alias === undefined || pureAliasTarget(alias) === undefined) return undefined;
  return resolveAlias(alias, side, tables);
}

/**
 * 兜底枚举：扫同源样式表里**顶层规则**的自定义属性声明（只用来补名字，
 * 值以 :root 的 computed 为准）。跨域样式表读 cssRules 会抛，忽略即可。
 */
function customPropertiesFromStyleSheets(): string[] {
  const names = new Set<string>();
  if (typeof document === 'undefined') return [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (rules === null) continue;
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      for (const name of customPropertiesOf(rule.style)) names.add(name);
    }
  }
  return [...names];
}

/**
 * 枚举 :root 上实际存在的自定义属性（已排序，数字感知：--space-2 排在 --space-10 前）。
 *
 * 这是验收点「新增一个 token 不改本页代码就能出现」的实现手段。
 */
export function enumerateTokenNames(): string[] {
  if (typeof document === 'undefined') return [];
  const computed = customPropertiesOf(getComputedStyle(document.documentElement));
  const names = computed.length > 0 ? computed : customPropertiesFromStyleSheets();
  return [...new Set(names)]
    .filter((name) => name.startsWith(CUSTOM_PROPERTY))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
}

function readValues(names: readonly string[], style: CSSStyleDeclaration): TokenValues {
  const values: Record<string, string> = {};
  for (const name of names) values[name] = style.getPropertyValue(name).trim();
  return values;
}

/**
 * **退化路径**：样式表读不到时（跨域 / 构造式样式表）临时把 data-theme="dark" 挂到
 * html 读一次再还原。同步完成、浏览器不在中间绘制，所以没有闪烁；采样结果缓存一次。
 * 正常路径（同源 CSS）不会走到这里 —— 那时亮 / 暗两列都直接从样式表对象模型读。
 */
let darkSample: TokenValues | null = null;
let darkSampleKey = '';

function sampleDarkValues(names: readonly string[]): TokenValues {
  const key = names.join(',');
  if (darkSample !== null && darkSampleKey === key) return darkSample;
  if (typeof document === 'undefined') return {};
  const root = document.documentElement;
  const previous = root.getAttribute('data-theme');
  root.setAttribute('data-theme', 'dark');
  const values = readValues(names, getComputedStyle(root));
  if (previous === null) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', previous);
  darkSample = values;
  darkSampleKey = key;
  return values;
}

interface TokenSnapshot {
  names: readonly string[];
  /** 当前主题（computed）：非颜色 token 显示它。 */
  values: TokenValues;
  /** 颜色 token 的亮色值（与当前主题无关）。 */
  lightValues: TokenValues;
  /** 颜色 token 的暗色值（与当前主题无关）。 */
  darkValues: TokenValues;
}

function readSnapshot(): TokenSnapshot {
  if (typeof document === 'undefined') {
    return { names: [], values: {}, lightValues: {}, darkValues: {} };
  }
  const names = enumerateTokenNames();
  const values = readValues(names, getComputedStyle(document.documentElement));
  const tables = readAuthorTables();
  const hasAuthorValues =
    Object.keys(tables.light).length > 0 || Object.keys(tables.dark).length > 0;
  if (!tables.readable || !hasAuthorValues) {
    // 退化：亮色侧只能给当前主题的 computed，暗色侧临时采样（这一档仍会跟着主题走）。
    return { names, values, lightValues: values, darkValues: sampleDarkValues(names) };
  }
  const lightValues: Record<string, string> = {};
  const darkValues: Record<string, string> = {};
  for (const name of names) {
    const light = sideValue(name, 'light', tables);
    const dark = sideValue(name, 'dark', tables);
    if (light !== undefined) lightValues[name] = light;
    if (dark !== undefined) darkValues[name] = dark;
  }
  return { names, values, lightValues, darkValues };
}

/** 快照签名：值没变就不重渲染（主题无关的 DOM 变动也会触发 observer）。 */
function snapshotKey(snapshot: TokenSnapshot): string {
  let key = snapshot.names.join(',');
  const append = (label: string, values: TokenValues): void => {
    key += `#${label}`;
    for (const name of snapshot.names) key += `|${values[name] ?? ''}`;
  };
  append('current', snapshot.values);
  append('light', snapshot.lightValues);
  append('dark', snapshot.darkValues);
  return key;
}

export interface TokenCatalog {
  groups: readonly TokenGroup[];
  /** 当前主题下的值（非颜色 token 用）。 */
  values: TokenValues;
  /** 颜色 token 的亮色值（缺省 = 该 token 在亮色块里没有定义）。 */
  lightValues: TokenValues;
  /** 颜色 token 的暗色值（缺省 = 该 token 在暗色块里没有定义）。 */
  darkValues: TokenValues;
  /** 枚举到的自定义属性总数（页面顶部显示「实际存在 N 个」）。 */
  total: number;
}

function buildGroups(names: readonly string[]): TokenGroup[] {
  const buckets = new Map<string, string[]>();
  for (const name of names) {
    const rule = groupRuleFor(name);
    const bucket = buckets.get(rule.id);
    if (bucket === undefined) buckets.set(rule.id, [name]);
    else bucket.push(name);
  }
  const groups: TokenGroup[] = [];
  for (const rule of TOKEN_GROUP_RULES) {
    const tokens = buckets.get(rule.id);
    if (tokens === undefined) continue;
    groups.push({ id: rule.id, titleKey: rule.titleKey, kind: rule.kind, tokens });
  }
  return groups;
}

/**
 * 订阅 :root 的 token 快照：主题属性 / class / style 变化与系统配色变化都会重读，
 * 所以切主题后「当前主题」的值（非颜色 token）立刻跟上；颜色的亮 / 暗两列不随主题变。
 */
export function useTokenCatalog(): TokenCatalog {
  const [snapshot, setSnapshot] = useState<TokenSnapshot>(readSnapshot);

  useEffect(() => {
    const update = () => {
      const next = readSnapshot();
      setSnapshot((previous) => (snapshotKey(previous) === snapshotKey(next) ? previous : next));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    });
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    media?.addEventListener('change', update);
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', update);
    };
  }, []);

  return useMemo(
    () => ({
      groups: buildGroups(snapshot.names),
      values: snapshot.values,
      lightValues: snapshot.lightValues,
      darkValues: snapshot.darkValues,
      total: snapshot.names.length,
    }),
    [snapshot],
  );
}

/** Font stacks / calc 值会带多余空白与换行；展示前折叠一下。 */
export function formatTokenValue(kind: TokenKind, raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (value === '') return '—';
  return kind === 'font' || kind === 'size' || kind === 'shadow'
    ? value.replace(/\s+/g, ' ')
    : value;
}
