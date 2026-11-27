/**
 * 会话卡地址子标题的树深度配色（depth-color）。
 *
 * 与 `address-style.ts` 同一个分工：纯函数（normalize / hueOf）可 Node 直测，
 * React 绑定只做「读 configStore 快照 → 归一化」这一层。
 *
 * 算法（设计稿 §3）：`hue(depth) = (rootHue + depth × hueStep) mod 360`——黄金角
 * 无理旋转永不精确重复（无限轮转不饱和）；颜色 = OKLCH(L_theme, C_theme, hue)，
 * 浏览器原生 `oklch()` 自带 gamut 映射（保 L/H 降 C），不在 JS 做色彩空间转换。
 *
 * 读的是服务端配置 `ui.depthColor.*`（Settings → Visual 写同一份 config.set），
 * 保存后无需刷新即生效；未连上 gateway / 未配置时按缺省（light depth0 逐字节 =
 * 现 accent-ink #086b56，零回归）。选择器只取 config data 引用（快照对象，引用
 * 稳定）：无关 store 切片变化不重渲染（address-style 同款纪律）。
 *
 * DOM 单一写者：`applyDepthColorTokens` 是 L/C 四变量的唯一写者（0.52「DOM 主题
 * 唯一写者」同款 invariant，theme.ts 先例）；调用点在 main.tsx（首帧订阅 +
 * 配置快照变化），不写 data-theme、不碰主题。
 */
import { useConfigStore } from '../stores/configStore';
import { readDisplayValue } from './display-settings';
import { resourceData } from './useResource';

/** 七键归一化结果（缺省 = 设计稿 §3.4 品牌锚点）。 */
export interface DepthColorParams {
  enabled: boolean;
  rootHue: number;
  hueStep: number;
  lightnessLight: number;
  chromaLight: number;
  lightnessDark: number;
  chromaDark: number;
}

/** 缺省参数：rootHue = 现 accent-ink 两档实测色相；light L/C = 精确品牌值（零回归）。 */
export const DEPTH_COLOR_DEFAULTS: DepthColorParams = {
  enabled: true,
  rootHue: 172.6,
  hueStep: 137.508,
  lightnessLight: 0.4714,
  chromaLight: 0.0887,
  lightnessDark: 0.85,
  chromaDark: 0.13,
};

/**
 * 值域护栏（与 config validator / serve config.set / CLI 白名单同界）：
 * L 上/下界由全 360 色相 WCAG 对比度实证锁定（边界压力档仍 ≥4.5:1）。
 * 服务端已拒绝非法值；这里再归一化一次是老 gateway / 手改 yaml 的兜底。
 */
const NUMBER_RANGES: Readonly<
  Record<
    Exclude<keyof DepthColorParams, 'enabled'>,
    { min: number; max: number; maxExclusive?: boolean }
  >
> = {
  rootHue: { min: 0, max: 360, maxExclusive: true },
  hueStep: { min: 0, max: 360 },
  lightnessLight: { min: 0.3, max: 0.51 },
  chromaLight: { min: 0, max: 0.37 },
  lightnessDark: { min: 0.73, max: 0.95 },
  chromaDark: { min: 0, max: 0.37 },
};

function readNumber(source: unknown, key: Exclude<keyof DepthColorParams, 'enabled'>): number {
  const fallback = DEPTH_COLOR_DEFAULTS[key];
  const raw = readDisplayValue(source, `ui.depthColor.${key}`);
  if (raw === '') return fallback;
  const value = Number(raw);
  const range = NUMBER_RANGES[key];
  const upperOk = range.maxExclusive === true ? value < range.max : value <= range.max;
  if (!Number.isFinite(value) || value < range.min || !upperOk) return fallback;
  return value;
}

/**
 * config 快照 → 归一化参数（纯函数，零 React / gateway import）。
 * 非法 / 缺省一律回缺省锚点；enabled 只有显式 'false' 才关（D6 缺省 true）。
 */
export function normalizeDepthColor(source: unknown): DepthColorParams {
  return {
    enabled: readDisplayValue(source, 'ui.depthColor.enabled') !== 'false',
    rootHue: readNumber(source, 'rootHue'),
    hueStep: readNumber(source, 'hueStep'),
    lightnessLight: readNumber(source, 'lightnessLight'),
    chromaLight: readNumber(source, 'chromaLight'),
    lightnessDark: readNumber(source, 'lightnessDark'),
    chromaDark: readNumber(source, 'chromaDark'),
  };
}

/**
 * 深度 → 色相（度，[0, 360)）。黄金角轮转：mod 360 保证无限轮转永不饱和；
 * 双重 mod 防御负值（depth 理论上 ∈ ℕ，负值按防御归一化）。保留 3 位小数
 * （DOM 字符串稳定，像素对照可复现；误差远低于感知阈）。
 */
export function hueOfDepth(depth: number, params: DepthColorParams): number {
  const hue = (((params.rootHue + depth * params.hueStep) % 360) + 360) % 360;
  return Math.round(hue * 1000) / 1000;
}

export interface DepthColorHook {
  enabled: boolean;
  params: DepthColorParams;
  /** enabled=false / depth 缺省 / 非法 depth ⇒ undefined（不着色，回落 accent-ink）。 */
  hueOf: (depth: number | undefined) => number | undefined;
}

/** 当前深度配色参数 + hueOf（configStore 快照驱动，保存即生效无需刷新）。 */
export function useDepthColor(): DepthColorHook {
  const data = useConfigStore((state) => resourceData(state.config));
  const params = normalizeDepthColor(data);
  const hueOf = (depth: number | undefined): number | undefined =>
    !params.enabled || depth === undefined || !Number.isFinite(depth) || depth < 0
      ? undefined
      : hueOfDepth(depth, params);
  return { enabled: params.enabled, params, hueOf };
}

/**
 * 把 L/C 四值写 documentElement（主题无关，一次写入；主题级联由 tokens.css 承担：
 * light 档读 --depth-l-light/-c-light，dark 双档读 --depth-l-dark/-c-dark）。
 * **唯一写者**（main.tsx 订阅 configStore 调用）；不写 data-theme、不碰主题。
 */
export function applyDepthColorTokens(
  source: unknown,
  root: HTMLElement = document.documentElement,
): void {
  const params = normalizeDepthColor(source);
  root.style.setProperty('--depth-l-light', String(params.lightnessLight));
  root.style.setProperty('--depth-c-light', String(params.chromaLight));
  root.style.setProperty('--depth-l-dark', String(params.lightnessDark));
  root.style.setProperty('--depth-c-dark', String(params.chromaDark));
}
