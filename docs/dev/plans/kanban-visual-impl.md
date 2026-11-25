# q-kanban-visual ① 审计：看板视觉规范化 + 分页导航重设计

- 分支：`feat/q-kanban-visual`（基于 redblue-dev @ `98557883`）
- 任务：用户两件事——①看板页逐面视觉规范化；②按设计规范重设计「显示 1–1 / 1 上一页 下一页」分页条并替换 raw 实现。
- 规范依据：`docs/dev/reports/q-design-audit/{audit,summary}.md`（核心裁定：统一用预设组件/token，缺档位进共享基座新建，不自建）；skills-style 先例 `66d02d4f`（摘整页 GHOST 误套，真复用禁自建感）；button 基座重置 `e38cb0ec`。

## 0. 关键事实核对（审计前提）

1. **GHOST 的合法领地**：`apps/web/src/components/ui/ghost-control.ts` 头注明确「只供设置弹窗 / 运行期事件日志做局部对齐，sunken 底仍是其余域的默认」。全仓 GHOST 消费 grep 实证：JsonView / RunDetailPage / RunEventLog / ConfigView / SettingRow / SettingsSearchBar——全部是设置域与运行日志域；**唯一例外就是 kanban 两文件**（第四轮新增时误套）。
2. **工具页真实表面**：ToolsPanel 卡片 = `bg-raised` + transparent border + hover 细线/elev-1（默认表面）；McpPanel 来源卡（被动卡）= `rounded-md bg-raised px-4 py-3.5 shadow-elev-1 forced-colors:border`。KanbanView 头注声称「GHOST 样式对齐工具页」与事实相反——工具页从来不是 GHOST。skills-style 先例已就同一误套做过裁定并摘除。
3. **分页条出处**：「显示 {from}–{to} / {total}」raw 条全仓唯一出处 = `plugins/context/skills/web-src/SkillsView.tsx` L404-423（iframe/embed 共用 SkillsView）。宿主另有一处近亲：RunEventLog L258-281「第 X / Y 页」条（GHOST 域内合法，Button small + GHOST_BUTTON_CLASS + `text-muted tabular-nums`），可作排版参照但表面口径不同（skills 走默认表面）。
4. **plugin-ui 共享化成本**：Pager 只需 Button + cn + 既有 utilities（flex/gap/text-sm/text-muted/tabular-nums 全部已存在于 plugin-ui 源码，styles.css `@source "./"` 自动扫描生成）；纯展示、文案走 props，符合 plugin-ui v1「不依赖 i18n/context/router」约束。**成本低，裁定走 plugin-ui additive 新组件**，不退 skills shared.tsx。

## 1. 目标① 看板逐面审计（KanbanView / KanbanCard）

| # | 面 | 现状 | 规范依据 | 裁定 |
|---|---|---|---|---|
| K1 | KanbanCard 卡面 | `GHOST_PANEL_CLASS`（透明细线） | ghost-control 领地限定 + skills-style 先例；被动卡先例 McpPanel 来源卡 | **改**：`rounded-md bg-raised px-4 py-3.5 shadow-elev-1 forced-colors:border`（逐字对齐 McpPanel 被动卡；卡片非整卡可点，不用 CARD_SURFACE_CLASS 的 cursor-pointer/hover 抬起） |
| K2 | owner/branch Badge | `GHOST_BADGE_CLASS` 覆盖 | Badge 默认 neutral = sunken 胶囊；skills 来源 Badge 同款默认 | **改**：摘 GHOST 覆盖，用默认 `<Badge>` |
| K3 | 进展展开/收起 | raw `<button>` `text-xs text-faint hover:underline` | 预设 Button `link` 变体；先例 MessageFold / payload-section「展开全部」均 `Button variant="link"` | **改**：`Button variant="link" size="small"`，保留 aria-expanded |
| K4 | 验收勾选框 | `accent-accent` | pending（PendingClusterCard/AskOptionChips）/ teams 同款先例 | **合规不动** |
| K5 | 刷新按钮 | `GHOST_BUTTON_CLASS` 覆盖 | Button plain 默认 sunken；skills 工具条 Refresh 同款 | **改**：摘 GHOST 覆盖，用默认 `<Button>` |
| K6 | 警告 `<details>` | `GHOST_PANEL_CLASS + text-warn`（透明框） | 警告表面档位 = `bg-warn-soft text-warn`（StaleNotice / skills trust banner 先例） | **改**：`rounded-sm bg-warn-soft px-3 py-2 text-sm text-warn`（StaleNotice 逐字同款）；details/summary 交互与 ul mono 排版不动，列表色随 warn 面继承 |
| K7 | 空列占位 | `GHOST_PANEL_CLASS + text-faint` | 被动凹槽默认 = `bg-sunken`（States stateShell 先例） | **改**：`rounded-md bg-sunken p-3 text-sm text-faint` |
| K8 | 页骨架/标题/副标题 | PageScaffold | 唯一页面骨架 | 合规不动 |
| K9 | 板名行 / 列头 / CountBadge | `text-md/text-sm font-* text-ink` + CountBadge | 既有 token 档位，无死类无 raw 色 | 合规不动 |
| K10 | 空态/错误/加载/未连接/StaleNotice | States.tsx 共享组件 | 共享状态面 | 合规不动 |
| K11 | 归档确认弹窗 | ConfirmDialog（ModalShell 共享） | 共享弹窗 | 合规不动 |
| K12 | 列网格 `md:grid-cols-3` / 轮询 / 归档 / 兜底列 | 布局与数据流 | 任务红线：零改 | 不动 |

缺档位检查：以上全部落在既有档位（raised/sunken/warn-soft/elev-1/line），**无需新建任何 token / 共享 class**。

## 2. 目标② 分页导航重设计

### 现状偏差
- raw flex div + 两颗默认 Button + 裸 span，无 `nav` 语义、无 aria-label；范围文本无 `tabular-nums`（数字翻页跳动）；按钮与范围文本间距/分组无结构；generatedAt 尾注与控件混排同一 gap。
- 禁用态本身如实（offset===0 / offset+items.length>=total），保留语义。

### 设计（vessel 风格，默认表面口径）
新组件 `packages/plugin-ui/src/Pager.tsx`（additive，不动既有导出）：
- 语义：`<nav aria-label={label}>`（label 由调用方传已翻译文案，TableToolbar 同款口径）。
- 结构：范围文本（`text-sm text-muted tabular-nums`，RunEventLog 页码显示同款档位）→ 上一页/下一页按钮组（`Button size="small"` 默认 plain=sunken 表面，skills 默认表面裁定；组内 gap-1.5，组间 gap-2.5）→ 可选 `children` 尾注槽（generatedAt 等元信息，调用方自定 faint 样式）。
- 禁用/边界：`canPrev`/`canNext` 由调用方按真实 offset/total 传入，Button 基类 `disabled:opacity-45 disabled:cursor-not-allowed` 如实呈现；total=0 时调用方不渲染（skills 现有行为保持）。
- 纯展示：不内建 i18n、不持状态、不算页码——文案（rangeLabel/prevLabel/nextLabel/label）全 props，符合 plugin-ui v1 约束。
- i18n：skills 既有 `skills.page` / `common.prev` / `common.next`（zh/en 齐全）复用；additive 新增 `skills.pagination`（'Pagination' / '分页导航'）作 nav aria-label。

### skills 消费替换
SkillsView L404-423 raw 条 → `<Pager …>`，onPrev/onNext 回调与禁用条件逐字保留（数据流零改）；generatedAt 移入 children 尾注。随后 `bun run build:ui`（tsc web + vite iframe + vite embed）重建资产。

### 明确不做
- **看板不加分页**（用户未要求；板面任务量小，整板展示 + 兜底列逻辑不动）。
- skills 工具条 `items.length/total` 计数胶囊：与 ToolsPanel L138 **逐字同款**（宿主既有先例，非自建偏差），不动。
- RunEventLog 分页条：GHOST 域内合法先例，不在本次范围，不动。
- 不新建 token / 色板；不动 plugin-ui 既有导出与默认变体。

## 3. 实施与门禁计划

1. ✅ 本审计 commit → 报 main。
2. 看板修复（K1/K2/K3/K5/K6/K7 + 头注更正）commit。
3. Pager 组件 + skills 替换 + i18n additive + build:ui 资产重建 commit。
4. 总门禁：worktree 根 `set -o pipefail; bun run build 2>&1 | tee build.log; echo EXIT=$?`（typecheck+lint+📦 实证）→ 最终报告（commit hashes + 文件清单 + 日志关键行 + 资产 hash）。

宪法遵守：零测试/探针/临时进程；只提交 feat/q-kanban-visual；不碰生产 checkout / ~/.vessel；不合并；布局/交互/数据流零改。---

## 4. ④ 最终报告（实施完成，总门禁绿）

### 提交链（feat/q-kanban-visual，基线 redblue-dev @ 98557883）

| 阶段 | commit | 内容 |
|---|---|---|
| ① 审计 | `0576c89b` | 本文档 §0-3：两目标面偏差清单 + 规范依据 + 设计裁定（main 已验收采纳） |
| ② 看板修复 | `5bff3847` | K1/K2/K3/K5/K6/K7 六面归位默认表面 + 两文件头注更正 |
| ③ 分页组件 | `96e96c8d` | plugin-ui Pager additive + skills 替换 + i18n additive + build:ui 资产重建 |
| ④ 报告 | （本节所在 commit） | 门禁实证 + 资产 hash |

### 文件清单（98557883..HEAD，12 文件 +383/-229）

- `apps/web/src/domains/kanban/KanbanCard.tsx`（卡面 raised+elev-1 / Badge 默认 / link 展开钮）
- `apps/web/src/domains/kanban/KanbanView.tsx`（刷新钮默认 plain / warn-soft 警告 / sunken 空列）
- `packages/plugin-ui/src/Pager.tsx`（**新增**，63 行）
- `packages/plugin-ui/src/index.ts`（**仅 +1 行** additive 导出；既有导出/组件零改动，git diff 实证）
- `plugins/context/skills/web-src/SkillsView.tsx`（raw 条 → Pager，回调/禁用条件逐字保留）
- `plugins/context/skills/web-src/i18n.ts`（+2 行：skills.pagination zh/en）
- skills 资产（build:ui 重建）：`web/assets/skills-B42IixC9.js`、`web/assets/skills-xAKwVcZd.css`（旧 hash 资产删除）、`web/embed/index.mjs`、`web/skills.html`；`web/embed/index.css` 内容未变（Pager 全用既有 utilities，@source 扫描无新增类）
- `docs/dev/plans/kanban-visual-impl.md`（本文档）

### 总门禁实证（worktree 根，set -o pipefail + tee build.log + EXIT 兜底）

```
1️⃣ Type check（root + examples + apps/web） — ✅ 通过
2️⃣ Lint（biome ci .） — ✅ 通过（Checked 1343 files；25 warnings / 42 infos 全部既有，
   日志 grep Pager/kanban/SkillsView 零命中——本次改动零新增告警）
📦 Build complete!
EXIT=0
```

本仓无 bundle（ADR-006），📦 成功行为门禁实证；build.log 留盘（gitignore 内，不入库）。
skills build:ui 独立绿：tsc -p tsconfig.web.json --noEmit + vite iframe（57 modules）+ vite embed（29 modules）。

### 资产 sha256

```
b369c4772652d38f0aa07063ac5f29740cbbbeda74eb275c3df6936011db7f22  web/assets/skills-B42IixC9.js
6354b422510b73eab335c8623f00f01e8f98b82936c59415ad1c82e2f53a5b37  web/assets/skills-xAKwVcZd.css
e5f1925c69b2cee519c890b127f27631fb10dc8d1d5c630c4d3e256849a96158  web/embed/index.mjs
5dd87fdc57e041e15f9ef42f1a19255cbe4f832de776e9bbe398df2b6415b20f  web/embed/index.css（未变）
7f165aa95cf1bc734ebed4a24882bd45b7729269964df5fb630f628f9ff463a3  web/skills.html
```

### 红线遵守自查

- 布局/交互/数据流零改：轮询/归档确认/兜底列/翻页 offset 逻辑逐字保留；看板未加分页。
- plugin-ui 只 additive：index.ts 仅 +1 行，既有组件一行未动（批次 C 耦合回归护 skills-style 封存面）。
- 零新建 token/色板；零测试/探针/临时进程；未碰生产 checkout / ~/.vessel / 8642；未合并、未删 worktree/branch。
- 行为验证（看板视觉 / 分页翻页 / 禁用边界 / zh-en 切换）归用户/金丝雀。