/**
 * 透黑底细线覆盖（用户裁定：元素无底色、透出黑色底、简洁极简）。
 *
 * 只供设置弹窗 / 运行期事件日志做局部对齐，**不改 plugin-ui 的默认变体**：
 * Button plain / Input CONTROL_CLASS 的 sunken 底仍是其余域的默认（0.52 工具卡
 * 先例同款做法 —— 摘局部声明，不动共享 token / 共享组件）。
 *
 * 全部是既有 utilities，无新色板：
 * - `border border-line(-strong)`：细线勾形（交互控件用 strong 档保证可辨识）；
 * - `bg-transparent`：透出下层底（页面黑底 / 弹窗 raised 面）；
 * - `shadow-none`：摘掉 inset 凹槽（twMerge 会让掉基类的 shadow-elev-inset）。
 * 焦点环 / disabled 透明度 / tint-hover 仍由基类提供，对比度不降。
 */

/** Input / Select / SearchInput：sunken 凹槽 → 透明细线。 */
export const GHOST_CONTROL_CLASS = 'border border-line-strong bg-transparent shadow-none';

/** plain 按钮：灰底 → 透明细线（保留基类 tint-hover / tint-press）。 */
export const GHOST_BUTTON_CLASS = 'border border-line-strong bg-transparent';

/** 中性 Badge / CountBadge：灰底胶囊 → 透明细线胶囊。 */
export const GHOST_BADGE_CLASS = 'border border-line bg-transparent';

/** 被动面板 / 折叠 JSON 区：灰底板 → 透明细线框。 */
export const GHOST_PANEL_CLASS = 'border border-line bg-transparent';
