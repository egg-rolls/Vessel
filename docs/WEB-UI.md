# Web UI 组件与样式约定

`apps/web` 的样式分为三层。新代码只写 L3；L1 / L2 不满足时先扩 L2，不要在各域
重复造 primitive。

| 层          | 位置                                                         | 职责                                      |
| ----------- | ------------------------------------------------------------ | ----------------------------------------- |
| L1 tokens   | `src/styles/tokens.css` + `src/index.css` 的 `@theme inline` | 唯一的颜色 / 圆角 / 字号 / 间距 / 阴影值  |
| L2 通用组件 | `src/components/ui/**`                                       | CVA variants + `cn()`；可访问性与交互行为 |
| L3 业务代码 | `src/domains/**`、`src/app/**`                               | 组合 L2 + 布局 utilities                  |

## 样式入口

`src/index.css` 只引入 Tailwind 的 theme 与 utilities，**不启用 preflight**：现有
Linen 视觉的 body、标题、表单默认样式仍由 `src/styles/base.css` 负责。legacy CSS
统一放在 `@layer legacy`，Tailwind utilities 优先级更高，因此迁移中的组件可以逐步
去掉 legacy class，未迁移页面保持原样。

```css
@layer theme, base, legacy, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@import "./styles/tokens.css" layer(legacy);
```

不要改成 `@import "tailwindcss"`——那会引入 preflight 并改变既有视觉。

## L1：token

值只写在 `styles/tokens.css`；`index.css` 的 `@theme inline` 只做别名
（`--color-*`、`--radius-*`、`--text-*` 等），utility 直接引用原 CSS 变量，因此暗色
主题的变量覆盖自动生效。

### 颜色

| Utility                                              | 用途                          |
| ---------------------------------------------------- | ----------------------------- |
| `bg-surface` / `bg-raised` / `bg-sunken` / `bg-deep` | 页面 / 卡片 / 凹陷 / 更深底色 |
| `text-ink` / `text-muted` / `text-faint`             | 正文 / 次要 / 弱化文本        |
| `border-line` / `border-line-strong`                 | 细线 / 强分隔线               |
| `bg-accent` / `text-accent-ink` / `bg-accent-soft`   | 强调色 / 强调文本 / 强调底    |
| `text-success` / `bg-success-soft`                   | 成功（token 原值 `--ok`）     |
| `text-warn` / `bg-warn-soft`                         | 警告                          |
| `text-danger` / `bg-danger-soft`                     | 错误 / 破坏性动作             |
| `text-info` / `bg-info-soft`                         | 信息                          |
| `bg-hover` / `bg-press`                              | hover / press 的半透明叠色    |
| `bg-scrim`                                           | 弹窗遮罩                      |

### 尺度

| 类别        | Utilities                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 间距        | `p-1` = 4px，`p-2` = 8，`p-3` = 12，`p-4` = 16，`p-5` = 20，`p-6` = 24，`p-8` = 32（同样适用于 `m-*` / `gap-*` / `space-*`）                                                    |
| 控件 / 触控 | `h-control`（32px）、`min-h-touch`（44px，配合 `pointer-coarse:`）                                                                                                              |
| 圆角        | `rounded-xs` 6 / `rounded-sm` 8 / `rounded-md` 12 / `rounded-lg` 16 / `rounded-xl` 20；胶囊用 `rounded-full`                                                                    |
| 字号        | `text-2xs` 10 / `text-xs` 10.5 / `text-sm` 11.5 / `text-md` 12.5 / `text-base` 14 / `text-lg` 16 / `text-xl` 19 / `text-2xl` 22；语义别名 `text-body`（14）/ `text-title`（22） |
| 字体        | `font-sans` / `font-serif` / `font-mono`                                                                                                                                        |
| 阴影        | `shadow-elev-1` … `shadow-elev-4`、`shadow-elev-inset`、`shadow-focus`                                                                                                          |
| 小屏 / 宽屏 | `max-compact:`（680px 以下）、`max-wide:`（1023px 以下）                                                                                                                        |
| 宽度        | `max-w-search`、`max-w-modal-sm/md/lg`、`max-w-palette`、`max-w-prose`                                                                                                          |

状态用变体表达：`hover:`、`focus-visible:`、`disabled:`、`aria-expanded:`、
`aria-pressed:`、`aria-selected:`、`data-[...]:`、`pointer-coarse:`。

## L2：通用组件

| 组件                                                                             | 位置                                 | 约定                                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                                                         | `components/ui/Button.tsx`           | `variant`: `plain` / `primary` / `danger` / `dangerGhost` / `link` / `chip`；`size`: `normal` / `small`；`type` 固定 `button`，forwardRef |
| `Badge`                                                                          | `components/ui/Badge.tsx`            | 行内短标签；`tone`: `neutral` / `accent` / `info` / `warn` / `danger` / `success`                                                         |
| `SearchInput`                                                                    | `components/ui/SearchInput.tsx`      | `value` + `onChange(value)` + `placeholder` + `ariaLabel`；容器可用 `className` 追加布局                                                  |
| `cn`                                                                             | `components/ui/cn.ts`                | `clsx` + `tailwind-merge`；从 `components/ui` 导出                                                                                        |
| `ModalShell` / `useModalA11y`                                                    | `components/Modal.tsx`               | 初始焦点、Tab 圈、Esc、关闭后归还焦点、body 滚动锁引用计数；`size`: `sm` / `md` / `lg`                                                    |
| `ConfirmDialog`                                                                  | `components/ConfirmDialog.tsx`       | 破坏性动作确认；初始焦点在取消；`danger` / `busy` / `confirmDisabled`                                                                     |
| `PageHeader`                                                                     | `components/PageHeader.tsx`          | 页面唯一 `h1` + tenant；`description` / `actions` 由调用方给                                                                              |
| `StatusChip` / `StatusGlyph` / `statusMeta`                                      | `components/StatusChip.tsx`          | 字形 + 文本 + 语义色；颜色只是增强                                                                                                        |
| `EmptyState` / `LoadingState` / `ErrorState` / `NotEnabledState` / `StaleNotice` | `components/States.tsx`              | 空 / 加载 / 错误（含 Retry）/ 未启用（不提供重试）/ 陈旧数据                                                                              |
| `ActionMenu`                                                                     | `components/ActionMenu.tsx`          | 行级 `⋯`；`aria-haspopup`、方向键 / Esc / 点外关闭                                                                                        |
| `CopyButton`                                                                     | `components/CopyButton.tsx`          | 复制文本，经 Toast 反馈                                                                                                                   |
| `SegmentedTabs`                                                                  | `components/Tabs.tsx`                | `role=tablist`；左右方向键切换                                                                                                            |
| `Tooltip` / `IconButton`                                                         | `components/Tooltip.tsx`             | 300ms 延迟、portal 定位、Esc 关闭；`IconButton` 必须带 `aria-label`                                                                       |
| `AutoGrowTextarea`                                                               | `components/ui/AutoGrowTextarea.tsx` | 自增高输入框                                                                                                                              |
| `Section`                                                                        | `components/ui/Section.tsx`          | 结构面板（等价旧 `.panel`）；`title` / `description` / `actions`；`titleAs`: `h2` / `h3`；forwardRef 到 `section`                          |
| `Field`                                                                          | `components/ui/Field.tsx`            | 表单字段容器；`label` / `htmlFor` / `hint` / `error` / `required`；error 带 `role=alert`                                                  |
| `Input` / `Textarea`                                                             | `components/ui/Field.tsx`            | 原生控件 + `invalid`；sunken + inset + focus ring；forwardRef                                                                                                                                              |
| `Select`                                                                         | `components/ui/Field.tsx`            | 自定义 listbox（`role=combobox` 触发器 + portal 弹层）；`value` / `onChange(event.target.value)` / `<option>` children 写法不变；方向键 / Home / End / Enter / Space / Esc / Tab / 点外关闭，焦点留在触发器 |
| `KeyValueList`                                                                   | `components/ui/KeyValueList.tsx`     | 两列 `dl` 网格（等价旧 `.diag-list`）；`items: { label, value }[]`，value 自动断行                                                      |
| `Stat`                                                                           | `components/ui/Stat.tsx`             | 指标块；`label` / `value` / `hint`                                                                                                                                                                        |
| `DataTable`                                                                      | `components/ui/DataTable.tsx`        | 语义化表格；`columns`（`hide: 'wide' \| 'compact'`）/ `rows` / `rowKey` / `activeKey`；不做排序、分页、虚拟化                         |

`StatusChip` 的 tone 只取 `muted` / `info` / `warn` / `ok` / `danger`；新增状态先加
`STATUS_META` 与 i18n key，不要在业务页手写颜色。

## 写法

### 变体：CVA + cn

```tsx
const card = cva('rounded-md bg-raised p-4 shadow-elev-1', {
  variants: {
    tone: {
      plain: 'text-ink',
      danger: 'bg-danger-soft text-danger',
    },
  },
  defaultVariants: { tone: 'plain' },
});

export function ToolCard({ tone, className, ...props }: ToolCardProps) {
  return <article className={cn(card({ tone }), className)} {...props} />;
}
```

自定义变体放在 L2 组件的 CVA 里；L3 只传 `variant` / `size` 和布局 class。
`className` 必须经 `cn()` 合并，保证调用方可以覆盖布局而不破坏语义色。

### 按钮

```tsx
<Button variant="primary" size="small" onClick={save}>保存</Button>
<Button variant="danger" onClick={remove}>删除</Button>
<Button variant="chip" size="small" aria-pressed={onlyConfirm} onClick={toggle}>
  只看需确认
</Button>
```

### 卡片（L3）

```tsx
<section className="flex flex-col gap-3 rounded-md bg-raised p-4 shadow-elev-1">
  <h2 className="text-sm font-medium text-ink">{title}</h2>
  <p className="text-sm text-muted">{description}</p>
  <div className="flex flex-wrap gap-2">
    <Button>查看</Button>
  </div>
</section>;
```

不要在 L3 复制 `rounded-md bg-raised shadow-elev-1` 后再加一套自己的 hover / focus；
这是 L2 的职责。

### 弹窗

```tsx
<ModalShell label={title} onClose={onClose} size="sm">
  <h2 className="font-serif text-xl font-semibold text-ink">{title}</h2>
  <p className="text-md text-muted">{body}</p>
</ModalShell>;
```

破坏性动作一律 `ConfirmDialog`（`danger`）；新增用弹窗，修改进页面。

### 搜索 / 过滤

```tsx
<div className="flex flex-wrap items-center gap-2">
  <SearchInput
    value={query}
    onChange={setQuery}
    placeholder={t('tools.searchPlaceholder')}
    ariaLabel={t('tools.searchLabel')}
    className="grow basis-60 max-w-search"
  />
  <Badge>
    {filtered.length}/{total}
  </Badge>
</div>;
```

### 状态

错误给 Retry；未启用不提供 Retry；陈旧数据用 `StaleNotice` 且不阻塞内容。
状态必须同时有字形或文本，不能只靠颜色。

### Toast

- 统一位置：右下角 `toast-region`（`feedback.css`）；不新增全局遮罩，也不为失效交互恢复顶部占位。
- 只在用户主动操作的成功 / 失败、连接失败、交互失效时使用；后台轮询与静默刷新不 toast。
- `ToastProvider` 对相同 `kind + message` 去重；最多同时 3 条；`success` / `info` 4s、`error` 5s
  自动消失，每条也可手动关闭。
- 容器 `role="status"`；错误条目 `role="alert"`，其余 `role="status"`。
- 失效交互在 hydration 后按 tenant + request id 集合只提示一次，重连不重复弹；
  详情只在 Observe → Attention 查看，Chat 内不再有失效卡片或本地忽略入口。

## 硬规则

1. **禁字面量 arbitrary value**：`p-[13px]`、`text-[12.5px]`、`bg-[#111]`、
   `w-[420px]` 一律不写。引用动态变量的值可以保留，例如
   `max-h-[min(86dvh,var(--modal-max-h))]`、`text-[var(--size-sm)]`。
2. **禁裸 hex / 内联颜色**：className 与 `style` 里都不写 `#rrggbb`；
   用 L1 颜色 utility。`style` 只用于位置 / 动态尺寸（`top`、`left`、`maxHeight`）。
3. **新 primitive 先进 L2**：跨域复用的按钮、标签、卡片、弹窗、搜索、状态先加到
   `components/ui/**` 并带 CVA variants；域专用组件留在 `domains/<domain>/`，
   但不得重写 L1 颜色与 L2 交互。
4. **L3 只组合**：布局用 utilities（`flex` / `grid` / `gap-*` / `p-*` /
   `max-compact:*`），语义色用 L1 token，交互用 L2 组件。
5. **文案走 i18n**：新增 key 同时加 `messages/zh-CN.ts` 与 `messages/en.ts`；
   技术词 / 命令 / 错误码保持原文。
6. **可访问性不回退**：`ModalShell` / `ActionMenu` / `SegmentedTabs` / `Tooltip`
   的焦点、键盘、Esc、portal 行为由 L2 保证，不要在业务页绕过。

运行 `bun run check:web-styles`（CI Architecture job 也会跑）检查第 1、2 条。

## legacy CSS 状态（P2 + P3 收口后）

P2 已迁移 Settings / Integrations / Runs / Observe / Nodes / Agents / Teams / Team / Chat
与 Markdown 渲染器；P3 又迁移了 app shell、表格与命令面板滚动结构。
`src/styles/**` 现在只剩：

1. **chat 工作区与 P3 之后的范围**：`layout.css` 的 chat-workspace / conversation /
   composer-area / resize-handle / 1023 媒体段。
2. **未迁移域**：`hub.css`、Gateway 的 `.panel` / `.diag-list`、`team.css` 的响应式布局、
   `attention.css`、`tools.css`。
3. **基础层**：`tokens.css`（唯一值来源）、`base.css`（body / 控件 / `.mono` / `.dim` /
   forced-colors）、`components/responsive.css`（pointer-coarse）。
4. **仍需保留的 marker**：
   - `state-*`：States 组件、测试与 forced-colors；不计划移除。
   - `.link-btn`：仅作为链接按钮的 legacy 视觉保留（`CopyButton` / 底部提示等），
     新代码用 `Button variant="link"`。
   P2/P3 的 `btn` / `btn-primary` / `search-input` / `icon-btn` / `action-menu` /
   `modal-body-scroll` / `filter-bar` / `domain-view` / `domain-content` / `data-table` /
   `col-*` / `row-active` 已清零。
5. **断点**：新代码用 `max-compact:`（680）与 `max-wide:`（1023）。其余断点不能静默
   折进这两个 token，逐条保留如下：

   | 断点 | 使用位置 | 能否用 680 / 1023 替代 | 保留原因 |
   | --- | --- | --- | --- |
   | 720 | `domains/nodes.css:58`（`.net-select` 全宽、`.net-command` 两列改一列） | 否 | 681–719 是节点表单的窄桌面区间；折到 680 会让命令块在窄列里溢出，折到 1023 会过早单列。 |
   | 720 | `domains/teams.css:25`（`.teams-grid` 单列、detail head padding） | 否 | 240px 卡片网格在 681–719 仍可排两列；680 会提前变成移动布局，1023 会过早单列。 |
   | 900 | `domains/attention.css:72`（隐藏第 4 列起，改三列 grid） | 否 | 六列 attention 表格在 901–1022 仍能容纳；折到 1023 会过早隐藏 agent / team 列，折到 680 会保留溢出列。 |
   | 1199 | `team.css:205`（`.team-chat-body` 成员栏 272→240px） | 否 | 这是成员栏宽度降档，不是抽屉切换；1023 才切抽屉（`team.css:211`）。折到 1023 会让 1024–1199 提前失去常驻成员栏。 |
   | 1023 | `layout.css`、`team.css`、`DataTable` / 页面 utilities | 是 | 已统一为 `max-wide:`。 |
   | 680 | `layout.css`、`team.css`、`base.css` 等 | 是 | 已统一为 `max-compact:`。 |

   边界语义：Tailwind `max-compact:` / `max-wide:` 编译为 `<680` / `<1023`，legacy
   `@media (max-width: …)` 是 `<=`；恰好 680 / 1023 像素时行为差 1px，已在 P3 视觉差异中记录。
   新增断点必须先论证不能复用 680 / 1023，并同时更新本表。

迁移新组件时：
1. 组件改用 Tailwind + CVA，保持 public API 与行为。
2. 删除**仅被该组件使用**的 legacy 规则；删前 grep `src` 的 ts/tsx/css 与 `tests`。
3. 动态拼接类（`conn-*` / `nav-*` / `tone-*` / `toast-*` / `perm-*` / `active` / `open`）
   不得按字面量判死。
4. `styles/tokens.css` 始终是值来源；新增 token 用 `--shape-*` / `--size-*` 原值
   加别名，避免 `@theme inline` 自引用。

`Integrations → Tools`（`domains/integrations/IntegrationsView.tsx` 的 `ToolsPanel`）
是 L3 参考实现：搜索 + `Button variant="chip"` + `Badge` + Tailwind 卡片网格。

P2 接受的视觉差异（记录，不逐一回改）：Section 标题 13→12.5、Stat 18→19、
Button 默认 12→11.5、部分 tracking / 行高取最近 token、Markdown 标题段距
0.7em→0.55em、Tool 结果最大高 220→224px。
