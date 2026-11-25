# q-design-audit ③ 总报告：设计系统一致性审计与修复

- 分支：`fix/q-design-audit`（基于 redblue-dev @ `e2ec132e`）
- 任务：用户裁定「待处理按钮底色灰色默认、设置按钮及新加组件未用预设组件/token」→ 搜查 → 统一用预设 → 缺档位则新建 → 未来自定义样式自适应。
- 审计详情：`docs/dev/reports/q-design-audit/audit.md`（①，提交 `c5bb3b06`）

## 1. 提交链（每域一提交一报，均已报 main）

| 提交 | 域 | 内容 |
|---|---|---|
| `c5bb3b06` | docs | ① 审计报告（全量 grep + 82 颗原生 button 背景解析 + 颜色 utility 白名单对账） |
| `e38cb0ec` | styles | **P0 基座**：base.css + plugin-ui styles.css 两处 button 重置补 `background-color: transparent`（含根因/层序安全注释）；PendingStrip 4 颗 utility 按钮显式补 `bg-transparent` 双保险（main 裁定） |
| `84f51406` | auth | SetupPage 7 处归位：`text-page`→`text-surface`（主按钮两主题对比度恢复）、main `bg-page`→`bg-bg`、密码 input×2 `bg-page`→`bg-transparent`（GHOST）、otpauth 块/恢复码 li `bg-page`→`bg-sunken`、secondaryButton 补 `bg-transparent` |
| `1f91db04` | settings | SettingsSearchBar `shadow-elev` 死类→`shadow-elev-2`（@筛选下拉浮层阴影恢复） |
| （本提交） | docs | ③ 总报告 |

## 2. 门禁实证（bun run build，exit code + 日志）

| 阶段 | exit | 关键行 | 日志（docs/dev/tmp/q-design-audit/，tmp/ gitignore 留盘不入库） |
|---|---|---|---|
| ① 基线（redblue-dev 现状） | 0 | type check ✅ / lint ✅ / 📦 Build complete! | gates-baseline.log |
| ②-1 styles | 0 | 同上 | gates-c1-styles.log |
| ②-2 auth | 0 | 同上（首跑 lint 报 li 行超宽格式差，按 biome 建议拆行重跑通过；纯格式无逻辑变化） | gates-c2-auth.log |
| ②-3 settings = **总门禁**（最终代码态，其后仅 docs 提交） | 0 | 同上 | gates-c3-settings.log |

## 3. 审计发现处置闭环

| 发现 | 级别 | 处置 |
|---|---|---|
| button 基座缺 background-color（preflight 不引入）→ 新组件必回归 ButtonFace 灰板 | P0 | ✅ e38cb0ec 两处基座重置；未来新按钮默认透黑底，自定义样式只需写自己的 bg 档位（**自适应达成**） |
| PendingStrip 4 颗按钮无 bg（用户投诉残留半边） | P1-A | ✅ 基座重置 + 显式 bg-transparent 双保险 |
| SetupPage bg-page×5 / text-page×1 死 token + secondary 无 bg | P1-B | ✅ 84f51406 全部归位预设档位 |
| SettingsSearchBar shadow-elev 死类 | P2-C | ✅ 1f91db04 → shadow-elev-2 |
| 设置弹窗 / 运行日志灰底 | — | 审计确认已在 redblue-dev 修掉（8c34a2eb / cc0b56d5，HEAD 已含），无需重复修 |
| minimap / 来源卡 / 工具卡路由副行 | — | 审计确认全 token 合规，未动 |
| 缺档位 | — | **无**：bg-surface-hover 已有、激活态走 accent-soft、阴影 elev-1…4 齐全 → 未新建任何 token |

## 4. 最终残留盘点（刻意例外，保留有据）

1. `StreamItems.tsx` `QUEUED_ICON_VEIL = 'bg-white/10 enabled:hover:bg-white/20'` —— 琥珀带玻璃纱，665-680 行注释完整论证（--hover-tint 叠半透明底会被下层琥珀带偏）。全应用唯一 raw 颜色 utility，文档化设计决策。
2. `chat.css` mask-image `#000` —— mask 功能色（黑=不透明/transparent=渐隐），非视觉颜色。
3. 注释中的 hex 引用 —— 文档，非样式。

除此之外：raw Tailwind 调色板 0、内联 raw 色 0、任意值色 0、死 token 0（bg-page/text-page/shadow-elev 全仓 grep 零残留）。

## 5. 约束遵守

- **纯样式**：全部改动仅 className / CSS 声明级，零功能逻辑变化（SetupPage li 拆行为 biome 格式要求）。
- **plugin-ui 优先口径**：审计确认现有预设（Button 6 变体 / GHOST_BUTTON_CLASS / iconButtonClass / CARD_SURFACE_CLASS）已覆盖全部需求，无需换组件（换 Button 会改形状，超出最小 diff）。
- **并发避让**：未碰 ConversationIndex（q-index-tooltip）、未碰布局 transition / motion.css（q-sidebar-anim）；base.css 仅 button 规则加一行颜色面。
- **只提交自己分支** fix/q-design-audit；未碰生产 checkout / ~/.vessel；零测试/探针（扫描脚本只放 /tmp）。
- 增量提交防早退：①报告即首提交，②每域一提交一报，③总门禁+总报告。

## 6. 用户验证点（暗色档最直观）

1. 待处理条：同源折叠「N 条」/ 卡头三态开关 / 展开全部 / 收起 —— 不再出现灰板，透黑底细线文字。
2. 初始化设置页（/setup）：主按钮文字清晰可读（此前零对比）；密码输入框透底细线；「跳过」按钮无灰板。
3. 设置弹窗 @筛选下拉：浮层有标准阴影（elev-2）。
4. 未来新加按钮：不写 bg 也默认透黑底（基座保证）。