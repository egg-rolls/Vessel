/**
 * 列表卡片统一表面（CardShell 基座）。
 *
 * Agent 卡片与节点卡片共用同一条 class 串，避免两处表面样式漂移。
 * 只使用既有 token（`bg-raised` / `surface-hover` / `elev-1` / `elev-2` / focus ring）；
 * q-shadow-elevation：静止态就挂 elev-1（阴影代替 border 展现层次，亮色档不再
 * 与背景融在一起）；透明 border 只保几何稳定，hover 换底色并抬起一档（elev-2），
 * 不再描边。外层 `<li>` 保持无边框无底色，表面由卡片按钮自己承担。
 */
export const CARD_SURFACE_CLASS =
  'flex h-full w-full min-w-0 cursor-pointer flex-col gap-2 rounded-md border border-transparent bg-raised px-4 py-3 text-left shadow-elev-1 transition-colors hover:bg-surface-hover hover:shadow-elev-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface';
