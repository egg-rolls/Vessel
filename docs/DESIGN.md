# 设计系统（跨外壳）

> 适用于 Web 主控制台、插件宿主页与插件 iframe 页面。这里只写**规则与路径**，
> 不写版本状态、实现读数或单页特例；组件行为以代码为准，契约见
> `CONTRACT-0.46-ui-shell`（个人侧 `docs/dev/plans/`，不在此仓库）。

## 1. 页面骨架

所有顶层页面固定为三段：**title / subtitle / content**，由
`PageScaffold`（`packages/plugin-ui/src/Page.tsx`）实现。
**宿主页面与插件页面共用这一个组件**，不在各自的代码里复制第二套。

- title：页面唯一 `h1`，`font-serif text-title font-semibold leading-tight tracking-wide
  text-ink`。
- subtitle：一句话用途说明，`max-w-prose text-md leading-normal text-muted`。
- title → subtitle 间距：`PageScaffold` 与其迁移前的 `PluginPageHeader`、Web
  `PageHeader` 统一为 `gap-2.5`（10px）；使用既有间距刻度，不新增 token。
- content：`mt-5 flex flex-col gap-5`。

**标题行只放标题与说明。** 以下内容一律属于 content 区，不得放进 title / subtitle：

- actions / 按钮 / 操作菜单
- 搜索框 / 筛选器 / 范围 tab
- 版本号 / schema 标识
- 计数 / 统计数字
- 状态 chip

版本、计数、状态这类元数据放在 content 的 stat 行、Section header 或表格工具栏里。

路径：

- `PageScaffold`：`packages/plugin-ui/src/Page.tsx`，从包入口导出，宿主直接消费。
- Web 的 `PageFrame`（`apps/web/src/domains/settings/PageFrame.tsx`）只是
  **路由级滚动容器 + `PageScaffold`**，不自己写标题。
- `PageHeader`（`apps/web/src/components/PageHeader.tsx`，内部经
  `components/ui/EntityHeader.tsx` 渲染）与 `EntityHeader` 只保留给实体详情页的
  身份 / 状态场景；标题行同样不得放 `actions`，详情页动作下移到内容区第一行，
  不新增第二套 header。

### 1.1 适用范围与迁移

- 宿主页面：`hub / gateway / pluginHost / nodes / agents / runs / tools / mcp /
  channels / observe / plugins（空态）/ tenants / capabilities / visual / settings`
  统一用 `PageScaffold(title, subtitle, children)`；有表格的，控件用
  `TableToolbar` 放在表格上方。
- **排除**：`apps/web/src/domains/{chat,teams,team}/**` 不在骨架迁移范围内。
- 实体详情页：保留 `EntityHeader` 的身份 / 状态语义，但把 `actions` 从标题行
  下移到内容区第一行。
- 插件页面：`plugins/observability/usage/**`、`plugins/marketplace/marketplace/**`
  改用 `PageScaffold` + `TableToolbar`；迁移完删除 `PluginPageHeader`，以及不再
  被引用的 `PluginPage`。插件同样不得在 header 放 actions。

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

## 6. Design Lab

设计系统的活样例与验收页，同时是 `PageScaffold` 的参考实现。

- 路由：`#/designLab`，导航挂在「设置」组；label en `Design Lab` /
  zh `设计实验室`。
- 位置：`apps/web/src/domains/design/**`。
- **Tokens**：颜色、字号、间距、圆角、阴影、字体。颜色与数值通过
  `getComputedStyle(document.documentElement).getPropertyValue('--...')`
  运行时读取 CSS 变量，**不在页面里硬编码 token 值**。
- **Components**：`PageScaffold`（含 title / subtitle 间距）、`TableToolbar`、
  `DataTable`（1px 行间隙 + 圆角样例）、Button 变体、Badge tone、Section、
  Field / Input / Select、Stat、KeyValueList、SegmentedTabs、States。
- 每个示例带名称与说明，en / zh 双语文案。
- 静态页面：不依赖 gateway token；不新增 token / RPC / 配置键。
- 页面自身必须用 `PageScaffold`。

## 7. 指针

- 冻结契约：`CONTRACT-0.46-ui-shell`（UI shell / table / i18n）。
- 组件：`packages/plugin-ui/src/Page.tsx`、`TableToolbar.tsx`、`DataTable.tsx`。
- Design Lab：`apps/web/src/domains/design/**`、路由 `#/designLab`。
- Web 组件与 token：`docs/WEB-UI.md`。
- 插件文案与宿主参数：`docs/agents/plugins.md`、`docs/architecture/plugins.md`。
