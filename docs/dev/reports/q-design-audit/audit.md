# q-design-audit ① 设计系统一致性审计报告

- 分支：`fix/q-design-audit`（基于 redblue-dev @ `e2ec132e`）
- 范围：`apps/web/src`（tsx / ts / css）；token 面 = `packages/plugin-ui/src/styles.css` + `apps/web/src/styles/tokens.css` + `apps/web/src/index.css` 的 `@theme inline`
- 方法：全量 grep（raw Tailwind 调色板 / gray·white·black / hex / 内联 rgba / 任意值色）+ 一次性扫描脚本（82 个原生 `<button>` 的背景解析、颜色 utility 名与 `@theme` 白名单对账）。脚本只放 `/tmp`，不入库（零探针宪法）。
- 门禁基线：`bun run build`，日志 `docs/dev/tmp/q-design-audit/gates-baseline.log`（tmp/ 被 gitignore，日志留盘不入库；结果见 §8）。

## 0. 结论摘要

1. **整体 token 化程度已经很高**：raw Tailwind 调色板（`bg-gray-*` / `text-red-*` 等）**0 处**；内联 raw 颜色 **0 处**；任意值颜色（`bg-[#…]`）**0 处**；hex 只出现在注释与 mask 功能色里。
2. **用户反馈的三个焦点，两个已在 redblue-dev 修掉**（HEAD 已含）：
   - 设置弹窗灰底 → `8c34a2eb`（CategoryTree / SettingsSearchBar / SettingsDialog scope tab 补 `bg-transparent`）；
   - 运行期日志灰底 → `cc0b56d5` + `8c34a2eb`（RunEventLog 透黑底）；
   - minimap / 来源卡 / 工具卡路由副行 → 全部走 token，无问题（§5）。
3. **剩余真实问题 3 组**（§2）：
   - **P1-A**：`PendingStrip` 4 颗 utility 按钮无显式背景 → 暗色档落回 UA ButtonFace 灰板 —— 正是用户反馈「待处理按钮底色灰色默认」的残留半边；
   - **P1-B**：`SetupPage`（auth 初始化页）`text-page` / `bg-page` 是**未定义 token**（6 处死类）+ secondaryButton 无背景；
   - **P2-C**：`SettingsSearchBar:51` `shadow-elev` 未定义档位（死类，@筛选下拉无阴影）。
4. **系统性根因（P0）**：preflight 刻意不引入（`index.css:6`），而 `base.css` 的 button 重置只有 `border: 0; cursor: pointer`，**没有 `background-color`** → 任何没写 bg 类的新按钮都落回 ButtonFace。历史修复是逐组件 `bg-transparent` 补丁（全应用 34 处），新组件必然回归 —— PendingStrip 与 SetupPage 就是证据。要做到任务书要求的「未来自定义样式自适应」，必须补基座重置（§3）。
5. **缺档位：无**。`bg-surface-hover` 已存在；语义激活态走 `accent-soft`（CategoryTree / SettingsDialog 现状即如此），不需要新建 `bg-surface-active`。也不需要换组件：现有预设（Button 6 变体 / GHOST_BUTTON_CLASS / iconButtonClass）已覆盖全部需求。

## 1. token 面盘点（现有预设）

**共享组件（packages/plugin-ui）**：Button（`plain / primary / danger / dangerGhost / link / chip` 6 变体，**全部带显式 bg**，见 `Button.tsx:38-45`）、Badge、CountBadge、Section、DataTable、Field、Tabs、SearchInput、Page、Stat、KeyValueList、ComposerToolbar 等。

**宿主共享 class 常量**：
- `GHOST_BUTTON_CLASS = 'border border-line-strong bg-transparent'`、`GHOST_BADGE_CLASS`（`components/ui/ghost-control.ts`）—— GHOST 透黑底细线的现成预设；
- `iconButtonClass`（`components/Tooltip.tsx:221`，bg-transparent 圆键）；
- `composerIconControlClass`（`domains/chat/composer-controls.ts:30`，bg-sunken 形状层）；
- `CARD_SURFACE_CLASS`（`plugin-ui/card-surface.ts`，bg-raised 卡面）。

**颜色 utility 面**（`index.css` 与 `plugin-ui/styles.css` 的 `@theme inline` 同源）：
`bg / surface / raised / surface-hover / sunken / deep / ink / muted / faint / line / line-strong / accent / accent-ink / accent-soft / success / success-soft / warn / warn-soft / amber / danger / danger-soft / info / info-soft / hover / press / scrim` + Tailwind 内置 `transparent / current / inherit / black / white`。
阴影档位：`elev-1 … elev-4 / elev-inset / focus`（**没有裸 `elev`**）。

## 2. 真实问题清单（文件:行:现值:应改 token）

### P1-A · chat 域 · PendingStrip（用户反馈焦点）

四颗按钮的文字色已是 token（`text-faint` / `hover:text-ink`），**唯独缺背景层**：无 bg 类 → 暗色档 UA ButtonFace（≈#6b6b6b 灰板，`8c34a2eb` 提交信息有探针实测）。

| 位置 | 元素 | 现值 | 应改 |
|---|---|---|---|
| `domains/chat/PendingStrip.tsx:226` | 同源折叠「N 条」 | className 无 bg | 补 `bg-transparent`（或依赖 §3 基座重置） |
| `domains/chat/PendingStrip.tsx:926` | 卡头 badge 三态开关 | 同上 | 同上 |
| `domains/chat/PendingStrip.tsx:1006` | 「展开全部（还有 N 条）」 | 同上 | 同上 |
| `domains/chat/PendingStrip.tsx:1015` | 「收起」 | 同上 | 同上 |

QueuedNotice 卡面本体（amber 带 + `QUEUED_ICON_VEIL` 圆键）不受影响、无需动。

### P1-B · auth 域 · SetupPage

`--color-page` 不存在（全仓 grep 无定义）→ `bg-page` / `text-page` 是**死类**：不产生任何声明，元素落回继承色 / UA 默认。

| 位置 | 现值 | 应改 | 说明 |
|---|---|---|---|
| `auth/SetupPage.tsx:107` | `text-page`（primaryButton） | `text-surface` | 现状继承 `text-ink`，与 `bg-ink` 同值 → **两套主题下按钮文字零对比**（暗字压暗底 / 亮字压亮底） |
| `auth/SetupPage.tsx:112` | `bg-page`（main） | `bg-bg` | 页面底 |
| `auth/SetupPage.tsx:136` | `bg-page`（密码 input） | `bg-transparent` | GHOST 透黑底细线（`border-line` 已有）；现状落回 UA Field |
| `auth/SetupPage.tsx:147` | `bg-page`（确认 input） | `bg-transparent` | 同上 |
| `auth/SetupPage.tsx:182` | `bg-page`（恢复码块） | `bg-sunken` | 凹陷内容块 |
| `auth/SetupPage.tsx:194` | `bg-page`（恢复码列表项） | `bg-sunken` | 同上 |
| `auth/SetupPage.tsx:108-109`（用于 167） | secondaryButton 无 bg | 补 `bg-transparent` | 否则 ButtonFace 灰板 |

### P2-C · settings 域 · SettingsSearchBar

| 位置 | 现值 | 应改 |
|---|---|---|
| `domains/settings/dialog/SettingsSearchBar.tsx:51` | `shadow-elev`（未定义，只有 elev-1…4） | `shadow-elev-2`（下拉浮层标准档） |

## 3. 系统性根因与修复建议（P0 ·「未来自定义样式自适应」）

**现状**：
- `index.css:6` 注释明确「不引入 preflight」；
- `base.css:37-40`：`button { border: 0; cursor: pointer }` —— 无 background-color；
- `plugin-ui/styles.css:37-40` minimal base 同样缺。

**后果**：任何没写 bg 类的 `<button>` 落回 UA ButtonFace。`8c34a2eb` 的修复方式是给 4 个文件逐颗补 `bg-transparent`（全应用现有 34 处补丁），**没有堵住产生源**：此后新加的 PendingStrip 三态按钮、SetupPage secondary 全部回归灰板。

**建议**：两处 button 重置各加一行 `background-color: transparent;`：
1. `apps/web/src/styles/base.css` 的 `button` 规则；
2. `packages/plugin-ui/src/styles.css` minimal base 的 `button` 规则（插件 iframe 同口径）。

**安全性论证**（为什么不会破坏现有视觉）：
1. 层序 `@layer theme, base, legacy, plugin, utilities`：重置在 legacy 层，显式 `bg-*` utility 在 utilities 层，**永远压过重置**；
2. 现有给按钮设背景的 CSS 类（`.link-btn` / `.load-more` / `.palette-option` / `.session-row` / `.composer-field > .composer-input` 等）都是类选择器，特异性高于元素选择器，不受影响；
3. plugin-ui Button 6 变体全部带显式 bg（§1），不受影响；
4. 与现有 34 处 `bg-transparent` 补丁意图一致 —— 它们变冗余但无害，**不删**（最小 diff）。

**效果**：未来任何新按钮默认透黑底，自定义样式只需写自己的 bg 档位；不写 bg 也不再出灰板 —— 正是任务书的「未来自定义样式自适应」。

**边界**：本次重置**只覆盖 button**，不含 input/textarea/select —— UA Field 随 `color-scheme` 走、composer 已显式 transparent（`chat.css:1286`），SetupPage 的 input 单独修（§2）；避免波及原生 checkbox / radio / select 外观。

## 4. 刻意例外（保留，不改）

1. **`StreamItems.tsx:681` `QUEUED_ICON_VEIL = 'bg-white/10 enabled:hover:bg-white/20'`** —— 全应用唯一的 raw 颜色 utility。665-680 行注释完整论证：琥珀带上的玻璃纱，白 10% 在浅色暖白 / 暗色暖黑两种底上都读成「同一块底提亮一点」，`--hover-tint` 叠在半透明底上会被下层琥珀带偏。属文档化设计决策，保留。（若要求绝对零 raw，可新建 `--amber-veil` 档位，但收益低于维护成本，不建议。）
2. **`chat.css:471/474/1543-1551` mask-image 的 `#000`** —— mask 功能色（黑=不透明 / transparent=渐隐），不是视觉颜色。
3. **注释里的 hex**（`RunEventLog.tsx:37`、`plugin-ui/DataTable.tsx:66`、`chat.css:1273-1274` 等）—— 文档引用，非样式。

## 5. 焦点组件核对表

| 组件 | 现状 | 结论 |
|---|---|---|
| PendingStrip 待处理卡 | QueuedNotice amber 带 + token 文字色；**4 颗 utility 按钮缺 bg** | 修（P1-A / §3） |
| 设置弹窗 | CategoryTree / SettingsSearchBar / SettingsDialog 已补 bg-transparent（`8c34a2eb`）；激活态 accent-soft | 已合规；仅剩 shadow-elev 死类（P2-C） |
| minimap（ConversationIndex） | `chat.css:1568-1593` `.conversation-index-dot`：`--line-strong` / `--muted` / `--accent` 全 token | 合规（q-index-tooltip 域，不碰） |
| 来源卡（EnvCard） | `text-accent/ink/danger/faint` token；卡面经 StreamCard | 合规 |
| 工具卡路由副行（ToolCard:180） | `text-faint` token | 合规 |
| RunEventLog | ROW_CLASS `bg-transparent` + tint-hover/press | 合规（`cc0b56d5` / `8c34a2eb`） |

## 6. ② 修复批次计划（按域拆提交，每域一提交一报）

| 提交 | 域 | 内容 | 门禁 |
|---|---|---|---|
| 1 | styles（系统性） | base.css + plugin-ui styles.css button 重置补 background-color: transparent + 注释 | bun run build |
| 2 | auth | SetupPage：text-page→text-surface、bg-page×5→bg-bg/bg-transparent/bg-sunken、secondaryButton 补 bg-transparent | bun run build |
| 3 | settings | SettingsSearchBar：shadow-elev→shadow-elev-2 | bun run build |

- 提交 1 落地后 P1-A 即被系统性解决；可选双保险：给 PendingStrip 4 颗按钮显式补 `bg-transparent`（防未来基座被回退），并入提交 1 或单独 chat 域提交，听 main 裁定。
- **不新建 token、不换组件**：现有预设全覆盖。SetupPage 理论上可换 plugin-ui Button，但形状会变（rounded-full→rounded-sm、内边距不同），超出「纯样式替换」最小 diff 口径，不建议。
- 全部修改仅 className / CSS 字符串级，不动功能逻辑。

## 7. 并发与约束

- 不碰 `ConversationIndex`（q-index-tooltip 域）、不碰布局 transition / `motion.css`（q-sidebar-anim 域）。
- `base.css` 是共享文件：本次只在 button 规则加一行（颜色面），与动画面无交集；若并行分支同改该规则块，冲突面极小。
- 只提交自己分支 `fix/q-design-audit`；不碰生产 checkout / ~/.vessel。

## 8. 扫描证据与门禁

grep 汇总（apps/web/src，tsx/ts/css）：

| 扫描 | 命中 | 判定 |
|---|---|---|
| A. gray/white/black utility | 3 | 全是 QUEUED_ICON_VEIL（含注释），刻意例外 |
| B. raw Tailwind 调色板（red/blue/green/slate/zinc…） | 0 | — |
| C. tsx 内 hex | 1 | 注释（RunEventLog:37） |
| D. css 内 hex（除 tokens.css） | 8 | mask #000 ×6 + 注释 ×2 |
| E. 内联 rgba/rgb | 0 | — |
| F. 任意值颜色 `bg-[…]` | 0 | — |
| G. 原生 button 背景解析 | 82 颗，初筛 25 | 常量解析后真实 5 颗（PendingStrip×4 + SetupPage secondary×1）；RunEventLog:36 为注释误报；其余 19 颗的 class 常量均含显式 bg |
| H. 颜色 utility 白名单对账 | 18 候选 | 真实 3 组（bg-page×5 / text-page×1 / shadow-elev×1）；其余为注释或非颜色 utility 误报（border-l-2 / ring-offset-* / gradient-to-bottom 等） |

门禁基线（① 纯文档提交，基线 = redblue-dev 现状）：
- 首跑 `bun run build` 前置检查失败：apps/web 依赖未装（worktree 新建）→ `cd apps/web && bun install`（86 packages）后重跑。
- 重跑：**exit=0**；日志关键行：`✅ Type check（root + examples + apps/web） 通过`、`✅ Lint（biome ci .） 通过`、`📦 Build complete!`。
- 日志归档：`docs/dev/tmp/q-design-audit/gates-baseline.log`（tmp/ 被 gitignore，留盘不入库）。