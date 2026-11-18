/**
 * 头像底色：按身份**稳定**生成的渐变（没有真头像时用）。
 *
 * 三条硬约束：
 * 1. **确定性**：同一个 id 在任何设备、任何浏览器、任何一次打开都是同一组色 ——
 *    所以只用一个纯算术哈希（FNV-1a 32 位，`Math.imul`），不用 `Math.random` /
 *    `Date` / 自增序号，也不掺会话 id 之外的临时串；
 * 2. **不新造色板**：两档色标全部是 `styles/tokens.css` 里既有令牌的组合
 *    （`--accent` / `--accent-ink` / `--amber` / `--amber-ink` / `--danger` 与 `--ink`
 *    按比例 mix 出深一档），没有新的十六进制值；
 * 3. **两套主题都能读**：首字母用 `--surface`（亮色主题=白、暗色主题≈黑），
 *    正好跟着主题翻转，不需要为同一块渐变准备两套字号色。
 *
 * 中性色不属于这组调色板：`palette === null`（没身份）时由组件退回 `--surface-sunken`
 * 的静态中性底，二者不会撞色。
 *
 * @module web/domains/auth/avatar-palette
 */

/**
 * 一组头像底色。
 *
 * - `solid`：单色兜底。`color-mix()` 在某些老引擎里不解析时，渐变会被整条丢掉，
 *   这时靠它保证圆里仍有底色（首字母不会白字压白底）。
 * - `backgroundImage`：两个色标的固定 135°，色标只引用令牌。
 */
export interface AvatarPalette {
  /** 稳定标识，只用于测试 / 调试，不上屏。 */
  id: string;
  solid: string;
  backgroundImage: string;
}

/** 统一角度：所有头像同向，一眼是同一套东西。 */
const ANGLE = '135deg';

/** `hue` 往 `--ink` 方向压深一档（沿用仓库既有的 `color-mix(in srgb, …)` 写法）。 */
function deepen(hue: string, keep: number): string {
  return `color-mix(in srgb, var(${hue}) ${keep}%, var(--ink))`;
}

/** 5 组：3 个语义色族 × 深浅两档（`--danger` 只留一档，红在暗色主题里已经足够亮）。 */
const AVATAR_PALETTES: readonly AvatarPalette[] = [
  {
    id: 'accent',
    solid: 'var(--accent)',
    backgroundImage: `linear-gradient(${ANGLE}, var(--accent), ${deepen('--accent', 70)})`,
  },
  {
    id: 'accent-deep',
    solid: 'var(--accent-ink)',
    backgroundImage: `linear-gradient(${ANGLE}, var(--accent-ink), ${deepen('--accent-ink', 45)})`,
  },
  {
    id: 'amber',
    solid: 'var(--amber)',
    backgroundImage: `linear-gradient(${ANGLE}, var(--amber), ${deepen('--amber', 70)})`,
  },
  {
    id: 'amber-deep',
    solid: 'var(--amber-ink)',
    backgroundImage: `linear-gradient(${ANGLE}, var(--amber-ink), ${deepen('--amber-ink', 50)})`,
  },
  {
    id: 'coral',
    solid: 'var(--danger)',
    backgroundImage: `linear-gradient(${ANGLE}, var(--danger), ${deepen('--danger', 65)})`,
  },
];

/**
 * FNV-1a 32 位：跨引擎逐位一致（`Math.imul` 保证 32 位乘法不丢精度）。
 * 不用 `String#hashCode` 这类非标准实现，也不加盐 —— 加盐就会随会话变。
 */
function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 参与哈希的身份键：**先用 id，没有再退 name**（name 会改，id 不会；但降级态里
 * 可能只有名字）。两者都没有 ⇒ `null`，调用方走中性色，不要凭空造一个键。
 */
function avatarPaletteKey(
  id: string | null | undefined,
  name: string | null | undefined,
): string | null {
  const trimmedId = (id ?? '').trim();
  if (trimmedId !== '') return trimmedId;
  const trimmedName = (name ?? '').trim();
  return trimmedName !== '' ? trimmedName : null;
}

/** 身份 → 底色组。没有身份时 `null`（组件据此用中性色）。 */
export function avatarPalette(
  id: string | null | undefined,
  name: string | null | undefined,
): AvatarPalette | null {
  const key = avatarPaletteKey(id, name);
  if (key === null) return null;
  return AVATAR_PALETTES[stableHash(key) % AVATAR_PALETTES.length] ?? null;
}
