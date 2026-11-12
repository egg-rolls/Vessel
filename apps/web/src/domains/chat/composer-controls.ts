/**
 * 输入框 toolbar 里「圆形图标控件」的唯一 class 来源（发送键 + 回形针共用）。
 *
 * 为什么单独一个模块：ComposerChrome 已经 import 了 ComposerAttach（回形针），
 * 若把共享 class 留在 ComposerChrome 里让 ComposerAttach 反向 import，就成了
 * 模块环 —— 环里的 const 在求值顺序不确定时会拿到 undefined。样式常量放在
 * 两者的下游，谁都能拿、谁都不互相依赖。
 *
 * 形状层（composerIconControlClass）只写一次：--control-h 的方盒
 * （size-control = 32px）、正圆（rounded-full）、--surface-sunken 底、
 * --line-strong 描边 —— 那就是这个凹槽里「按得动的东西」的轮廓。
 * 色调层按动作主次分两支（composerPrimaryIconTone / composerQuietIconTone）：
 * 发送键是主动作（--accent），回形针是次要动作（静止 --muted、hover --ink）。
 * 两支都不换形状，所以「回形针和发送键对齐」是同一个盒子的两套配色。
 *
 * 三态（两支同一套判定）：
 * - 静止：圆 + 描边 + 灰底，图标按各自的静止色；
 * - hover（仅可用态，enabled: 挡住禁用）：背景叠色来自 plugin-ui Button 的
 *   tint-hover（与其它 plain 按钮同一层叠色），图标按各自的 hover 色；
 * - 禁用：灰底与描边原地不动，图标转 --faint，并用 disabled:opacity-100
 *   抵掉 L2 的透明度衰减 —— 禁用是「灰色图标 + 灰底圆」，不是整块半透明，
 *   形状始终可辨；enabled:hover: 也保证它不假装可点。
 *
 * 图标本身的视觉大小不在这里，也不由盒子的字号决定：`Icon` 缺省 16px（`size-4`），
 * 回形针传 `size={14}` 把「墨迹面积」缩到与纸飞机同一占地（见 `ComposerAttach`）。
 * 盒子同尺寸 + 图标同占地，这一行里两个圆才读成一对。
 */

/** 形状层：32px 正圆 + 灰底 + 描边（发送键与次要图标键共用这一份）。 */
export const composerIconControlClass =
  'size-control flex-none rounded-full border border-line-strong p-0 bg-sunken pointer-coarse:min-w-touch disabled:opacity-100';

/**
 * 色调档名：**运行时数组 = 唯一事实源**（类型由它派生）。
 * 设计实验室遍历它出图（每档套同一个形状层），加一档不用改预览。
 */
export const COMPOSER_ICON_TONES = ['primary', 'quiet'] as const;

export type ComposerIconTone = (typeof COMPOSER_ICON_TONES)[number];

/**
 * 档名 → 色调 class。`satisfies Record<ComposerIconTone, string>` 双向钉住数组与
 * 这张表（漏写 / 多写都编译报错），所以两档色调不可能与数组漂移。
 */
export const COMPOSER_ICON_TONE_CLASS = {
  /** 主动作色调（发送）：主题色图标，hover 走 accent-soft / accent-ink。 */
  primary:
    'text-accent enabled:hover:bg-accent-soft enabled:hover:text-accent-ink disabled:text-faint',
  /**
   * 次要动作色调（回形针等）：静止灰色图标，hover 转 --ink —— 暗色主题下就是白，
   * 浅色主题下就是最深的 ink；两者都是「hover 拉对比」，与发送键同一策略，只是不借主题色。
   */
  quiet: 'text-muted enabled:hover:text-ink disabled:text-faint',
} satisfies Record<ComposerIconTone, string>;

/** 主动作色调（发送）。 */
export const composerPrimaryIconTone = COMPOSER_ICON_TONE_CLASS.primary;

/** 次要动作色调（回形针等）。 */
export const composerQuietIconTone = COMPOSER_ICON_TONE_CLASS.quiet;
