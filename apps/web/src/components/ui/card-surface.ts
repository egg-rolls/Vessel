/**
 * 列表卡片统一表面。
 *
 * Agent 卡片与节点卡片共用同一条 class 串，避免两处表面样式漂移。
 * 只使用既有 token（`bg-raised` / `border-line` / `hover:bg-hover` / focus ring）；
 * 外层 `<li>` 保持无边框无底色，表面由卡片按钮自己承担。
 */
export const CARD_SURFACE_CLASS =
  'flex h-full w-full min-w-0 cursor-pointer flex-col gap-2 rounded-md border border-line bg-raised px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface';
