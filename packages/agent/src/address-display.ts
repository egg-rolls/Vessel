/**
 * 地址显示格式（q-addr-display，用户裁定：name 优先、轻量有质感）。
 *
 * **显示与路由分离**：路由地址（`agent send` 的 `to` / federation 投递）永远用
 * canonical full-id 三段；本模块只管「给人 / 模型看」的那一层。三档全局风格：
 *
 * - `name`（缺省）：各段能用名就用名 —— `main@soulkiller:vessel`；
 * - `compact`：principal 名 + node 短 id（前 8 位）+ team 名；
 * - `full`：现行为，各段原样（full uuid）。
 *
 * 兜底链：name 不可用 → short-id（前 8 位）→ full-id。两条约束：
 *
 * 1. **replyable**（渲染结果会被模型原样抄进 `to` 的场景，如 runtime 来源行）：
 *    principal 的 short-id 兜底**跳过**直达 full-id —— 解析侧
 *    （`resolveAddressMember` / `registry.resolve`）只做精确匹配，principal 短 id
 *    是死地址。node 短 id 例外：`isLocalNodeSegment` 已支持本机 nodeId 的 ≥8 位
 *    前缀匹配（只对本机一个 id，无前缀歧义），且 replyable 渲染只用于本机来源。
 *    跨节点来源（federation 入站）不走本模块，保持 canonical。
 * 2. **纯显示**（web 卡片 / 副行，replyable 缺省 false）：走完整兜底链，
 *    短 id 不可路由也无妨 —— 那一层本来就不供抄写。
 *
 * **零 import 的 leaf 模块**：runtime（packages/agent）与 web（apps/web 经
 * tsconfig paths + vite alias 按源码消费，先例：plugin-ui）共用这一份实现，
 * 不拖任何依赖图。per-segment 配置是留好的扩展位：`names` / `opts` 已按段组织，
 * 将来加 perSegment 键不破签名。
 *
 * @module vessel/address-display
 */

/** 地址显示风格三档（全局；缺省 name）。 */
export type AddressStyle = 'name' | 'compact' | 'full';

/** 缺省风格：name 优先（用户裁定）。 */
export const DEFAULT_ADDRESS_STYLE: AddressStyle = 'name';

/** 合法档位（config validator / gateway ENUM_KEYS / web 注册表共用同一份值）。 */
export const ADDRESS_STYLES: readonly AddressStyle[] = ['name', 'compact', 'full'];

/** 把任意输入归一化为合法档位；非法 / 缺省 → DEFAULT_ADDRESS_STYLE。 */
export function normalizeAddressStyle(value: unknown): AddressStyle {
  return value === 'name' || value === 'compact' || value === 'full'
    ? value
    : DEFAULT_ADDRESS_STYLE;
}

/** 地址三段（缺段不补占位符，与 runtime `formatMessageSource` 同口径）。 */
export interface AddressSegments {
  principal?: string;
  node?: string;
  team?: string;
}

/**
 * id → 展示名查找表（按段独立）。值可以是段本身已是名字的情形 ——
 * 非 uuid 形状的段一律视为「已是名字」原样渲染，不查表。
 */
export interface AddressNameMaps {
  node?: ReadonlyMap<string, string>;
  principal?: ReadonlyMap<string, string>;
}

export interface FormatAddressOptions {
  /**
   * 渲染结果会被原样抄进路由 `to`（runtime 来源行）。true 时 principal 兜底
   * 跳过 short-id 直达 full-id（解析侧无前缀匹配，短 id 是死地址）。
   * 缺省 false = 纯显示，走完整兜底链。
   */
  replyable?: boolean;
}

/** canonical uuid 形状（8-4-4-4-12 hex）；只有 id 才需要查名 / 截短。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 段值是否 uuid 形状（= 是 id，不是名字）。 */
export function isUuidLike(value: string): boolean {
  return UUID_RE.test(value);
}

/** 短 id：前 8 位（uuid 首段）。非 uuid 输入原样返回（名字不截断）。 */
export function shortAddressId(value: string): string {
  return isUuidLike(value) ? value.slice(0, 8) : value;
}

/**
 * 单段渲染。team 段恒原样：slug 本身就是名字，没有 id 形态。
 *
 * - full：原样；
 * - 段已是名字（非 uuid 形状）：原样（compact 的 node 也不截名字 —— 无从截起）；
 * - node：name 档查名，查不到兜底短 id；compact 档直接短 id；
 * - principal：name / compact 都先查名；查不到时 replyable → full-id，
 *   纯显示 → 短 id。
 */
function renderSegment(
  value: string,
  kind: 'principal' | 'node',
  style: AddressStyle,
  names: AddressNameMaps | undefined,
  replyable: boolean,
): string {
  if (style === 'full') return value;
  if (!isUuidLike(value)) return value;
  if (kind === 'node') {
    if (style === 'compact') return shortAddressId(value);
    const named = names?.node?.get(value);
    return named !== undefined && named !== '' ? named : shortAddressId(value);
  }
  const named = names?.principal?.get(value);
  if (named !== undefined && named !== '') return named;
  return replyable ? value : shortAddressId(value);
}

/**
 * 统一地址显示纯函数：解析好的三段 → 按 style 渲染 → 兜底。
 *
 * 拼接规则与 `formatMessageSource` 一致：有 node/team 才写 `@host`，
 * host 内 node:team 用 `:` 连接；缺的段不补占位符。无 principal 时
 * （web 工具卡路由副行只有 node:team）直接渲染 host。
 *
 * 不做字符集 / 可路由性校验：调用方负责保证输入段合法（runtime 侧已有
 * `isAddressSafePrincipal` 闸；web 侧输入来自持久化事实）。
 */
export function formatAddress(
  addr: AddressSegments,
  style: AddressStyle = DEFAULT_ADDRESS_STYLE,
  names?: AddressNameMaps,
  opts?: FormatAddressOptions,
): string {
  const replyable = opts?.replyable === true;
  const principal =
    addr.principal !== undefined && addr.principal !== ''
      ? renderSegment(addr.principal, 'principal', style, names, replyable)
      : undefined;
  const node =
    addr.node !== undefined && addr.node !== ''
      ? renderSegment(addr.node, 'node', style, names, replyable)
      : undefined;
  const team = addr.team !== undefined && addr.team !== '' ? addr.team : undefined;
  const host = [node, team].filter((part): part is string => part !== undefined).join(':');
  if (principal === undefined) return host;
  return host === '' ? principal : `${principal}@${host}`;
}
