/**
 * 头像上的字符（纯函数）：首字母 / 双字母。
 *
 * 规则（与仓库既有风格一致；无先例处由本单定义）：
 * - **中文**（以及其它非拉丁文字）：只取**第一个字**（`张三` → `张`）；
 * - **英文名**：取前两个词的首字母（`Ada Lovelace` → `AL`）；只有一段时取首字母
 *   （`ada` → `A`）。词分隔认空格与 `.` / `_` / `-`（`ada-lovelace` 也能出 `AL`）；
 * - 取的是**码点**不是 UTF-16 单元 —— 否则 CJK / emoji 会被劈开；
 * - 没有 name 时退 id（降级态里可能只有 id）；两者都没有 ⇒ `null`，组件画通用人形，
 *   而不是显示 `?` 那种像报错的东西。
 *
 * 纯函数、单独模块：浮层组件不该为了这个规则带上 React。
 *
 * @module web/domains/auth/avatar-initial
 */

const LATIN = /^[a-zA-Z]$/;
const WORD_SEPARATORS = /[\s._-]+/;

/** 单字：取第一个**字**（码点）并尽量大写；`ß` → `S`（`SS` 只取首字，宽度才稳）。 */
function singleChar(source: string): string {
  const first = Array.from(source)[0];
  if (first === undefined) return '?';
  return Array.from(first.toUpperCase())[0] ?? first;
}

/**
 * 头像字符：1 个字（中文 / 其它文字 / 单个英文词）或 2 个字母（英文多词）。
 * 没有可用身份 ⇒ `null`，由组件退回通用人形图标。
 */
export function avatarMonogram(name: string | null | undefined, id?: string | null): string | null {
  const source = (name ?? '').trim() || (id ?? '').trim();
  if (source === '') return null;
  const first = Array.from(source)[0];
  if (first === undefined) return null;
  // 非拉丁开头（中文 / 日文 / emoji …）：只取第一个字，不拼第二个。
  if (!LATIN.test(first)) return singleChar(source);
  const words = source.split(WORD_SEPARATORS).filter((word) => word !== '');
  const second = words[1];
  if (second !== undefined) {
    const secondFirst = Array.from(second)[0];
    // 第二个词不是字母（`u_1`）时退回单字母：`U1` 像型号，不像人。
    if (secondFirst !== undefined && LATIN.test(secondFirst)) {
      return `${first}${secondFirst}`.toUpperCase();
    }
  }
  return singleChar(source);
}
