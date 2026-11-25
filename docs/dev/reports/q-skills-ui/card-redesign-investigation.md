# q-skills-ui ① 调研笔记：技能库卡片重设计（用户裁定）

日期：2026-11-24 · 分支 fix/q-skills-ui（基于 redblue-dev，HEAD d2f453ca）

## 1. 现状锚点（codegraph 未索引本 worktree，用 grep/read 定位）

- 视图不在 apps/web/src/domains/（无 skills 域），而在插件内：
  `plugins/context/skills/web-src/SkillsView.tsx`（631 行，iframe + embed 两层共用）。
- 上一批（6cb3673b / d2f453ca）已把工具栏对齐工具页（TableToolbar 单行 + GHOST 局部覆盖），
  但主体仍是 **DataTable 表格 + 右侧详情栏**（master-detail 双栏 grid 5fr/4fr）——
  这正是用户裁定要推翻的部分：要卡片，不要表格。
- RPC 面（src/rpc.ts）：`list`（query/source/tag/offset/limit）、`get`（id → entry/content/trust/trustRecord）、
  `search`、`loads`、`rescan`、`trust_set`。视图现用 list/get/loads/rescan/trust_set，**无需后端改动**。
- DTO（web-src/types.ts）：SkillEntryDto 含 name/description/tags/source/trust/bytes/absPath/
  frontmatter/warnings/auxFiles；GetResult 含 content/truncated/trustRecord。卡片与详情所需字段齐全。

## 2. 工具页设计规范（参照物 = apps/web/src/domains/integrations/ToolsPanel.tsx）

- 布局：`grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3` 卡片网格。
- 卡片 = 整卡可点 `<button>`：名称（font-mono text-sm font-medium text-ink）+ 徽章 + 右侧 `›` 提示符；
  `aria-haspopup="dialog"`、title/sr-only 提示、focus-visible 环、pointer-coarse:min-h-touch。
- 点击 → **ModalShell 弹窗**（apps/web/src/components/Modal.tsx）：标题行（名称+徽章）→ 描述 →
  策略控件 → JsonView schema。Esc/遮罩关闭、焦点圈、body 滚动锁、portal 到 body。
- 工具栏：TableToolbar 单行（SearchInput grow basis-60 max-w-search + chip 过滤 + 计数胶囊）。
- 注意：工具页卡片底色是 bg-raised；**本次用户口径是 GHOST（透黑底细线）**，
  沿用本插件 shared.tsx 既有先例：GHOST_PANEL_CLASS = `border border-line bg-transparent`，
  hover 用 border-line-strong / bg-surface-hover，不动 plugin-ui 共享组件。

## 3. 关键约束与落点

1. **plugin-ui 没有 Modal/Dialog 组件**（index.ts 导出清单确认）。apps/web 的 ModalShell 依赖
   apps/web 私有组件（IconButton/cn）与宿主 @utility modal-fade/rise/pad，插件两层都够不着。
   → 在 web-src 内落一个**轻量本地 Modal**（role=dialog / aria-modal / Esc / 遮罩点击 / 焦点管理），
   只用两层都有的 utilities；不引第三方运行时依赖（设计 §8.3 既有裁定）。
2. **embed 层 token 缺口**：embed.css @theme inline 未别名 `--z-index-modal` / `--container-modal-md`
   （iframe 层 plugin-ui styles.css 已有；宿主 tokens.css 有 --z-modal/--modal-w-md/--scrim）。
   → embed.css 增补两条别名即可，additive，不动宿主。
3. 详情内容完整保留现 master-detail 右栏的全部段：元信息 KeyValueList、stale/revoked 告警条、
   正文 pre（truncated 提示）、附件清单、信任段（trust_set 按钮 + trustRecord）、会话加载清单。
   MissingSkill（unknown_id 降级）与内联告警卡逻辑原样搬进弹窗。
4. 搜索/筛选保留：TableToolbar 单行（搜索 + 来源 w-36 + 标签 w-40 + 重扫/刷新 + 计数胶囊）不动；
   分页脚注（PAGE_LIMIT=50，prev/next + generatedAt）从表格脚注改为网格下方独立行。
5. 卡片只展示名称 + 来源小标签（用户口径「只展示名称（+来源标签小字可选）」）；
   信任态/加载计数徽章放弹窗标题行，卡片保持极简（可选：trust 非 unknown 时小徽章，实施时定）。
6. 刷新策略不变：mutation 后重拉 + 手动刷新 + window focus；query 去抖 250ms；过滤变化回第一页。

## 4. 门禁口径

- 唯一门禁 `bun run build`（根 scripts/build.ts = typecheck + biome ci，显式判 rc + 输出证据）。
- 插件产物需 `bun run --cwd plugins/context/skills build:ui`（tsc web + vite iframe + vite embed）
  重建 web/assets + embed/index.mjs/css + skills.html 并随代码提交（上一批先例）。
- 零测试/探针；不碰生产 checkout 与 ~/.vessel。

## 5. 实施计划（②③④）

- ② 卡片网格 + 本地 Modal 详情（SkillsView 重写主体；shared.tsx 增 Modal；embed.css 补 token；i18n 增补）
- ③ 搜索/筛选/分页适配收尾 + i18n 清理（detail.empty 等不再用的键处置）
- ④ build:ui 产物重建 + 根门禁读数 + 收尾报告