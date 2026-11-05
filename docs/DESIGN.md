# 设计系统（跨外壳）

> 适用于 Web 主控制台、插件宿主页与插件 iframe 页面。这里只写**规则与路径**，
> 不写版本状态、实现读数或单页特例；组件行为以代码为准，契约见
> `CONTRACT-0.46-ui-shell`（个人侧 `docs/dev/plans/`，不在此仓库）。

## 1. 页面骨架

所有顶层页面固定为三段：**title / subtitle / content**。

- title：页面唯一 `h1`，`font-serif text-title font-semibold leading-tight tracking-wide
  text-ink`（Web 的 `PageHeader` 与插件页的 `PageScaffold` 逐字一致）。
- subtitle：一句话用途说明，`max-w-prose text-md leading-normal text-muted`。
- content：`mt-5 flex flex-col gap-5`。

**标题行只放标题与说明。** 以下内容一律属于 content 区，不得放进 title / subtitle：

- actions / 按钮 / 操作菜单
- 搜索框 / 筛选器 / 范围 tab
- 版本号 / schema 标识
- 计数 / 统计数字
- 状态 chip

版本、计数、状态这类元数据放在 content 的 stat 行、Section header 或表格工具栏里。

路径：`packages/plugin-ui/src/Page.tsx`（`PageScaffold`）、
`apps/web/src/components/PageHeader.tsx`、`apps/web/src/domains/settings/PageFrame.tsx`。

## 2. 表格控件位置

- **表格的控件放在表格上方。** 筛选、范围 tab、搜索、刷新、批量动作都属于表格控件。
- 一个页面有多张表时：控件放在对应表格所属 Section 的 header 下方、表格正上方。
- 跨表共用的范围控件放在页面 content 顶部的 toolbar。
- 不得把上述控件放进页面 title / subtitle 行，也不得放到表格下方。

路径：`packages/plugin-ui/src/TableToolbar.tsx`（`role="toolbar"`，
`flex flex-wrap items-center gap-2`，默认 `mb-2`）。

## 3. 表格视觉

- 行与行之间保留 **1px 间隙**（`border-separate` + `border-spacing-y-px` 或等价实现），
  间隙透出页面底色，不新增边框色。
- 表格整体使用 **小圆角**（`rounded-md`），四角裁切，首行 / 末行跟随。
- 表头吸顶只在表格自身处于有界滚动容器时开启；页面级表格保持不吸顶。
- **不新增颜色 token。** 颜色、圆角、字号、间距一律引用 L1 token 或既有语义 utility。
- 不改列断点与 `headerFilter` 行为。

路径：`packages/plugin-ui/src/DataTable.tsx`、
`apps/web/src/components/ui/DataTable.tsx`、`docs/WEB-UI.md`。

## 4. 时间戳

- 日志与表格时间列使用 **ISO 8601**：`YYYY-MM-DD HH:mm:ss`（UTC，必要时带 `Z`）。
- 不调用无 locale 的 `toLocaleString()`；日期结构在 en / zh 下必须一致，
  不出现中文日期格式。
- tooltip 可以给完整 `toISOString()`。
- 后端已经给出字符串的日期（如 `usage.by_day` 的 `date`）保持原样，不在前端重排。

## 5. 插件 i18n

- 每个插件的字典以 **英文表为 key 真源**：
  `const EN = {...} as const; type MessageKey = keyof typeof EN;`
- 其它语言必须 `Record<MessageKey, string>`；缺 key 由 typecheck 拦截。
- `t()` 的 key 参数收紧为 `MessageKey`；动态 key 先证明来源再放宽。
- 仓库门禁 `bun run scripts/check-i18n.ts` 同时校验 Web catalog 与
  `plugins/**/web-src/i18n.ts`：
  - key 集合双向相等；
  - `{placeholder}` 集合相等；
  - 译文与英文相同的 key 报告为 warn（专有名词进脚本内显式 allowlist，并写明理由）。
- zh 文案不得保留 `Marketplace` / `Registry` 等未翻译标签；确需保留英文的专有名词
  必须进 allowlist。

路径：`scripts/check-i18n.ts`、`plugins/**/web-src/i18n.ts`。

## 6. 指针

- 冻结契约：`CONTRACT-0.46-ui-shell`（UI shell / table / i18n）。
- 组件：`packages/plugin-ui/src/Page.tsx`、`TableToolbar.tsx`、`DataTable.tsx`。
- Web 组件与 token：`docs/WEB-UI.md`。
- 插件文案与宿主参数：`docs/agents/plugins.md`、`docs/architecture/plugins.md`。
