# Web UI 组件与样式约定

`apps/web` 的通用组件与视觉规则。所有间距、圆角、字号、颜色只取
`apps/web/src/styles/tokens.css` 的 CSS 变量；不要在组件里写内联颜色。

## 组件

| 组件 | 位置 | 用途 | 约定 |
|---|---|---|---|
| `Button` | `src/components/ui/Button.tsx` | 普通 / 主 / 危险 / 危险幽灵按钮 | `variant` + `size="small"`；`type` 固定 `button` |
| `ModalShell` / `useModalA11y` | `src/components/Modal.tsx` | 弹窗外壳 | 处理初始焦点、Tab 圈、Esc、关闭后归还焦点 |
| `ConfirmDialog` | `src/components/ConfirmDialog.tsx` | 破坏性动作确认 | 初始焦点在取消；`danger` / `busy` / `confirmDisabled` |
| `PageHeader` | `src/components/PageHeader.tsx` | 页面唯一 `h1` + tenant | 可附带 `description`、`actions` |
| `StatusChip` / `StatusGlyph` / `statusMeta` | `src/components/StatusChip.tsx` | 统一状态 | 字形 + 文本 + `tone-*` 色；颜色只是增强 |
| `EmptyState` / `LoadingState` / `ErrorState` / `NotEnabledState` / `StaleNotice` | `src/components/States.tsx` | 空 / 加载 / 错误 / 未启用 / 陈旧数据 | 错误给 Retry；未启用不提供重试 |
| `ActionMenu` | `src/components/ActionMenu.tsx` | 行级 `⋯` 菜单 | `aria-haspopup`；方向键 / Esc / 点外关闭 |
| `CopyButton` | `src/components/CopyButton.tsx` | 复制文本 | 通过 Toast 反馈；标签走 i18n |
| `SegmentedTabs`（Tabs） | `src/components/Tabs.tsx` | 域内一级 tab | `role=tablist`；左右方向键切换 |
| `AutoGrowTextarea` | `src/components/ui/AutoGrowTextarea.tsx` | 自增高输入框 | 从 `components/ui` 导出 |

`SearchInput` 尚未抽成共享组件。列表搜索统一使用
`<input className="input search-input" type="search">`；若后续抽出，放在
`src/components/ui/` 并从 `index.ts` 导出，同时更新本表。

## 间距与尺度

| Token | 值 | 用途 |
|---|---|---|
| `--space-1` | 4px | 图标与文字、紧凑行内间距 |
| `--space-2` | 8px | 行内 / 卡片内小间距 |
| `--space-3` | 12px | 卡片内主间距 |
| `--space-4` | 16px | 区块间距 |
| `--space-5` | 20px | 面板间距 |
| `--space-6` | 24px | 页面分区间距 |
| `--space-8` | 32px | 大分区 / 留白 |

圆角：`--radius-xs` 6 / `--radius-sm` 8 / `--radius-md` 12 / `--radius-lg` 16 /
`--radius-xl` 20 / `--radius-pill`。字号：`--text-xs` 10 / `--text-sm` 11.5 /
`--text-body` 14 / `--text-title` 22。控件高度用 `--control-h`，触屏最小目标用
`--touch-target`。

## 使用规则

1. 先复用上表组件；只有跨域通用的新组件才放 `src/components/ui/`，域专用组件留在
   `src/domains/<domain>/`。
2. 新样式按职责写入 `src/styles/` 并在 `src/index.css` 引入；不要堆回单文件。
   状态色用 `--ok` / `--warn` / `--danger` / `--info` / `--faint`。
3. 所有用户可见文案走 `src/i18n` 的 `t()`，新增 key 同时加 `messages/zh-CN.ts`
   与 `messages/en.ts`；技术词、命令、错误码保持原文。
4. 危险操作一律 `ConfirmDialog`（`danger`）；新增用弹窗，修改进页面。
5. 状态必须同时有字形或文本，不能只靠颜色；`StatusChip` / `StatusGlyph` 已覆盖。
6. 页面骨架：`domain-view` → `PageHeader` → `domain-content`；内容块用 `panel`。
