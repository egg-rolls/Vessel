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
| 小屏        | `max-compact:`（680px 以下）                                                                                                                                                    |
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

## legacy CSS 迁移

`src/styles/**` 仍是未迁移域的来源；迁移一个组件时：
1. 组件改用 Tailwind + CVA，保持 public API 与行为。
2. 删除**仅被该组件使用**的 legacy 规则。
3. 保留仍被未迁移页面使用的规则（例如 `.btn` / `.input` / `.panel` / `.card` /
   `.modal-title`），以及未迁移容器依赖的 marker class：
   `btn`（`.card .btn` / `.multi-node-head .btn` 等上下文外边距）、
   `search-input`（filter-bar flex 布局）、`icon-btn`（session-row hover 显隐）、
   `action-menu`（行级菜单显隐）、`modal-body-scroll`（命令面板滚动结构）、
   `state-empty` 等状态 marker（测试与 forced-colors）。
4. `styles/tokens.css` 始终是值来源；新增 token 用 `--shape-*` / `--size-*` 原值
   加别名，避免 `@theme inline` 自引用。

`Integrations → Tools`（`domains/integrations/IntegrationsView.tsx` 的 `ToolsPanel`）
是 L3 参考实现：搜索 + `Button variant="chip"` + `Badge` + Tailwind 卡片网格。
