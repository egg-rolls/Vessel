# Web UI 组件与样式约定

`apps/web` 的样式分为三层。新代码只写 L3；L1 / L2 不满足时先扩 L2，不要在各域
重复造 primitive。

跨外壳的设计系统规则（页面骨架、表格控件位置、DataTable 行距、时间戳、插件 i18n）
见 [DESIGN.md](DESIGN.md)；本文只写 Web 侧的 token、组件与写法。

| 层          | 位置                                                         | 职责                                      |
| ----------- | ------------------------------------------------------------ | ----------------------------------------- |
| L1 tokens   | `src/styles/tokens.css` + `src/index.css` 的 `@theme inline` | 唯一的颜色 / 圆角 / 字号 / 间距 / 阴影值  |
| L2 通用组件 | `src/components/ui/**`                                       | CVA variants + `cn()`；可访问性与交互行为 |
| L3 业务代码 | `src/domains/**`、`src/app/**`                               | 组合 L2 + 布局 utilities                  |

## 样式入口

`src/index.css` 只引入 Tailwind 的 theme 与 utilities，**不启用 preflight**：现有
中性色视觉的 body、标题、表单默认样式仍由 `src/styles/base.css` 负责。legacy CSS
统一放在 `@layer legacy`，Tailwind utilities 优先级更高，因此迁移中的组件可以逐步
去掉 legacy class，未迁移页面保持原样。

## 时间线渲染顺序（会话 / Team）

排序是**纯函数**，不要在各组件里各写一套：

1. **历史消息**按 `timestamp`；缺时间戳时沿用前一条（老数据降级，不甩到末尾）。
2. **live 节点**（一条 run 的正文 + 思考 + 工具卡，整块不可拆）用 `max(run 起始 ts,
   触发它的 user 消息 ts + 1)`——`run.started` 早于用户消息落盘，只按 run 起始时间排
   会把本轮输出顶到用户消息上方。
3. **伪 run 组**（`runtime.notice` 用常量 `runtime`、成员/插件事件用域 id）永不终态，
   必须**按 item 各自的事件时间**逐条落位，整组锚在首个事件上会让后续系统消息全部堆在
   最早那个时间点。
4. 尚未命中的兜底只有一条：**仍在 running** 的 run 允许回落到「最后一条用户消息 + 1」；
   已终态 run 不兜底（否则历史轮次的失败/取消卡会被拽到当前轮）。

**失败卡（`run-failure` item / `RunFailureCard`）**：一次失败的 run 在会话流里只出一张卡，
身份是 `run:<runId>:failure`（与工具卡同一张 `StreamCard`，`tone=danger`）：

- **位置**用它自己的终态时刻（`run.failed` 的事件 ts，兜底 `sessions.get` 的
  `completed_at`）：必然落在该 run 最后一个 item 之后，不会因为「缺 ts 排最后」沉到
  整个会话底部；
- **来源两条、事件流优先**：缓冲里还有这个 run 的**任何**分组就以 `run.failed` 的
  `error` / `errorMeta` 为准；没有时（刷新 / 切会话 / 环形缓冲淘汰）用 `sessions.get`
  投影的最近一次 run（`run_id` / `status` / `error` / `completed_at`，**不新增 RPC**）。
  两条共用同一个 item key，所以同 run 恰好一张卡；
- **只有 `failed` 出卡**：`interrupted`（挂起 / Host 中断，可恢复）的续跑入口在运行详情页
  （`runs.resume`），不在时间线上伪装成失败；`completed` / `cancelled` 同样不出卡。

**时间线只有一种卡（`StreamCard`）**：卡头是固定的四槽 —— `title`（发送方 / 作用域 /
状态）、`meta`（耗时 / 条数 / run id）、`summary`（单行 ellipsis 摘要）、chevron；
**有没有 `children` 决定能不能展开**（有 ⇒ `<details>` + chevron + 点击整行 + 原生可访问，
没有 ⇒ 纯行头、不渲染 chevron）。「来自 agent X」卡、环境信息卡（`EnvCard`）、失败卡、
工具卡、排队卡都走这一套，**不要自造第二个卡头，也不要给某张卡单独换肤**；需要单行折叠、
点击看全文的卡必须给 `children`，否则被 ellipsis 吃掉的那段正文永远读不到。环境信息卡的
scope 是卡头标题（与 `来自 agent X` 同级、同一组 class），不是色条或独立底色。

**消息入场与长消息折叠（会话 / Team 共用一份实现）**：样式在
`styles/domains/chat.css`（`.msg-enter` / `.msg-fold*`），行为在
`components/ui/MessageFold.tsx` 与 `components/ui/useEnteringItemKeys.ts`。两页共用同一套
class 与同一个阈值，不要给某一页复制第二份。

- **入场只播给新追加的项**：fade-in + 上移 4px（`--motion-ui`）。判据不是「挂载」而是
  「追加」——会话页只有 live item 播，历史消息不播（历史加载是回填；且 live 落盘后由
  `msg:<absIndex>` 接管同一段正文，两个 key 都播就是同一段话淡入两次）；Team 页由
  `useEnteringItemKeys` 记一次「首屏那一批」，只有之后追加的行播。类名挂上后不再摘
  （半路摘掉会把播到一半的动画掐断）；React 对稳定 key 复用 DOM 节点，所以重渲染不会重播。
- **只有「有背景包裹的气泡」才折叠**：正文超过 `--msg-fold-max-h`（400px，阈值唯一来源）
  就裁到该高度 + 底部 mask 渐隐，气泡内中下侧给一个纯文字按钮（`展开全文 / 收起`，带
  `aria-expanded`）。折叠只改显示：DOM 里始终是全文，复制按钮走 `message.content` /
  `item.text` 原文，手工选中也是同一份文本。**流式中的消息不折**（正文还在长，折起来会
  反复折/展）。
  判定口径：**气泡显示是否用底色包裹 = 折；纯正文不折**。折的只有：会话页实时用户气泡
  `UserBubble` 与历史用户气泡（`Transcript.tsx`，都挂在 `.msg-bubble` 上）、团队页
  `.team-message-bubble`（人发与 agent 回复都有底色）。**不折**：助手正文
  （`AssistantText` 的 `msg-assistant > div.msg-text`，无底色）、`AgentMessageCard` 的
  展开体（卡片有底色，但它是「卡片」不是气泡，两级结构已由 `StreamCard` 的
  「单行摘要 + chevron」提供）、历史助手正文。无底正文没有底色锚点，裁一刀读者看不出那是
  被收起的一段话。
- **`prefers-reduced-motion` 下直接显示**：没有位移、没有淡入。
- **助手正文只有一个容器**：`AssistantText`（`msg-assistant > div.markdown.msg-text`，
  `domains/chat/StreamItems.tsx`）。主时间线的 `run-text`、子 agent 面板的正文与收字尾巴
  都走它，入场就收在它里面 —— 不要再手写第二份 `msg-assistant > div.msg-text`
  （流式与落盘各写一份就会在 run 结束那一刻换容器 / 重排）。**它不挂折叠**（无底色），
  见上一条口径。

```css
@layer theme, base, legacy, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@import "./styles/tokens.css" layer(legacy);
```

不要改成 `@import "tailwindcss"`——那会引入 preflight 并改变既有视觉。

## 待批（ask_user 汇集）

`ask_user` 的待答请求有三条展示面，数据同源（`useInteractionStore` 的 pending ask），
互不替代，不要在某一面里重复实现另一面的职责：

1. **会话**：Composer 槽位的 `AskCard`（原同步等待语义不变），会话栏头部「待批」按钮带当前会话计数；
2. **团队**：`TeamPendingBar`（成员会话的请求）；
3. **本页（`#/pending`，「待批」）**：所有来源的总汇集，按 agent（无则会话、再退 run）聚簇，
   同簇勾选后「一起提交」= 一次用户动作，每条 ask 各一次 `ask.respond`（同一批带同一个
   `batch_id`，gateway 合并成**一条** user 消息 + **一次** run；见
   `domains/pending/usePendingBatch.ts` 与 `docs/architecture/tools.md`）。
   应答不新建 run：等待中的 `ask_user` 拿到结果后原 run 继续（见 `domains/pending/usePendingBatch.ts`）。
   挂起的 ask（headless / 超时挂起，记录带 `suspended`）没有原地等待者：那一轮 run 已以
   `interrupted` 收口，网关在应答落定后自己发起一次 resume（**同一 run id，不新建 run**）；
   续跑没成立时只记录答案，恢复走 `runs.resume` / `vessel --resume-run`（ADR-082 Errata）。

问题正文是文本：markdown 图片语法只有同源路径 / `data:image/*` 会渲染成图片
（CSP 是 `img-src 'self' data:`），其余与裸链接一样降级成链接。权限通道
（`tool.permission`）仍走自己的卡片，不汇入本页。

## UI 选择状态持久化（刷新 / 切回来回到上次打开的那一个）

只记「上次打开的是哪一个」，只用 `sessionStorage`（UI 选择状态不进 `localStorage`、
不进 URL query、不写日志），失败一律不阻塞（隐私模式 / SSR / 配额满 → 退化为
「没有记录」）。key 与读写都收在纯模块里，不要在组件里直接摸 `sessionStorage`：

| 选择面 | 记录模块 | key | 值 | 写入 / 读取 / 清除 |
| --- | --- | --- | --- | --- |
| 会话（`#/chat/<sessionId>`） | `domains/chat/session-selection.ts` | `vessel.chat.lastSession.v1.default` | `session_id` | 选中即写（`useChatSessions`）；无路由 id 时恢复（`decideSessionRestore`）；会话被删（`not_found`）/ 记录失效时清 |
| 团队（`#/teams/<nodeKey>/<teamId>`） | `domains/team/team-selection.ts` | `vessel.team.lastTeam.v1.<nodeKey>` | `team_id` | 路由进入详情即写（`useTeamsView`）；`#/teams` 列表页无 `teamId` 时恢复（`decideTeamRestore`）；归档 / `not_found` / 不在已加载列表时清 |

口径：

1. **URL 权威**：路由里已经有 id（会话 id / `teamId`）时一律不覆盖，恢复只补「没有 id」
   时的默认值；两者冲突时 URL 赢。
2. **记录身份是 id**：`session_id` / `team_id`，不是名字——改名、同名都不影响；团队记录
   带 `nodeKey` 槽位，多节点同一份 `sessionStorage` 不会串。
3. **列表未就绪不判失效**：列表请求失败 / 还没回来时保留记录（`wait`），别把「查不到」
   当成「被删了」。
4. **只记一个**：团队同一时刻只有一个被打开，写入时清掉别的 node 槽位；侧栏 / 抽屉 /
   成员栏展开态不落存储（刷新按默认关闭）。

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
| `CountBadge`                                                                     | `packages/plugin-ui/src/CountBadge.tsx` | 纯数字徽标（`count` / `max` 默认 99 / `label` / `tone`: `muted` / `accent`）；`count <= 0` 渲染 `null`；默认 muted —— 计数是元信息，不抢主题色 |
| `SearchInput`                                                                    | `components/ui/SearchInput.tsx`      | `value` + `onChange(value)` + `placeholder` + `ariaLabel`；容器可用 `className` 追加布局                                                  |
| `cn`                                                                             | `components/ui/cn.ts`                | `clsx` + `tailwind-merge`；从 `components/ui` 导出                                                                                        |
| `ModalShell` / `useModalA11y`                                                    | `components/Modal.tsx`               | 初始焦点、Tab 圈、Esc、关闭后归还焦点、body 滚动锁引用计数；`size`: `sm` / `md` / `lg`                                                    |
| `ConfirmDialog`                                                                  | `components/ConfirmDialog.tsx`       | 破坏性动作确认；初始焦点在取消；`danger` / `busy` / `confirmDisabled`                                                                     |
| `PageHeader`                                                                     | `components/PageHeader.tsx`          | 仅实体详情页（`EntityHeader` 场景）的 `h1` + tenant；列表页改用 `PageScaffold`；动作位置见 [DESIGN.md](DESIGN.md)                                                                              |
| `StatusChip` / `StatusGlyph` / `statusMeta`                                      | `components/StatusChip.tsx`          | 字形 + 文本 + 语义色；颜色只是增强                                                                                                        |
| `MessageBar`                                                                     | `components/MessageBar.tsx`          | AppBar 中心唯一提示轨；`items: { id, tone, text, actions?, onDismiss? }[]`；容器 `role=status` + `aria-live=polite`，错误 chip `role=alert`；actions 常显、可 Tab |
| `EmptyState` / `LoadingState` / `ErrorState` / `NotEnabledState` / `StaleNotice` | `components/States.tsx`              | 空 / 加载 / 错误（含 Retry）/ 未启用（不提供重试）/ 陈旧数据                                                                              |
| `ActionMenu`                                                                     | `components/ActionMenu.tsx`          | 行级 `⋯`；`aria-haspopup`、方向键 / Esc / 点外关闭                                                                                        |
| `CopyButton`                                                                     | `components/CopyButton.tsx`          | 复制文本，经 Toast 反馈                                                                                                                   |
| `SegmentedTabs`                                                                  | `components/Tabs.tsx`                | `role=tablist`；左右方向键切换                                                                                                            |
| `Tooltip` / `IconButton`                                                         | `components/Tooltip.tsx`             | 300ms 延迟、portal 定位、Esc 关闭；`IconButton` 必须带 `aria-label`                                                                       |
| `AutoGrowTextarea`                                                               | `components/ui/AutoGrowTextarea.tsx` | 自增高输入框                                                                                                                              |
| `ComposerAttachments`                                                            | `packages/plugin-ui/src/ComposerAttachments.tsx` | 输入框顶部引用区：受控 `items` + `onRemove`；空数组不渲染（不占高）；文件 / 文档 / `@提及` 共用同一套 chip；`kind` 是装饰短标记、`note` 进 sr-only |
| `ComposerToolbar`                                                                | `packages/plugin-ui/src/ComposerToolbar.tsx` | 输入框底部工具栏：`role="toolbar"`；左侧扩展槽（`actions` + `children`），右侧 `meta`（上下文用量）+ `primary`（发送） |
| `ComposerContextMeter`                                                           | `packages/plugin-ui/src/ComposerContextMeter.tsx` | 上下文用量指示：默认是比例圆环（`used` / `max`，18px，≥70% 变警告色、≥90% 变危险色并加粗描边）；比例与数字只进原生 `title` + `aria-label`（如「59% / 592K of 1M」，取整百分比 + 紧凑 token 数）；`max` 未知不画圆环、只显示紧凑已用值（`592K`）；用量未知由宿主不渲染；纯展示、不可点击、无动画 |
| `Section`                                                                        | `components/ui/Section.tsx`          | 结构面板（等价旧 `.panel`）；`title` / `description` / `actions`；`titleAs`: `h2` / `h3`；forwardRef 到 `section`                          |
| `Field`                                                                          | `components/ui/Field.tsx`            | 表单字段容器；`label` / `htmlFor` / `hint` / `error` / `required`；error 带 `role=alert`                                                  |
| `Input` / `Textarea`                                                             | `components/ui/Field.tsx`            | 原生控件 + `invalid`；sunken + inset + focus ring；forwardRef                                                                                                                                              |
| `Select`                                                                         | `components/ui/Field.tsx`            | 自定义 listbox（`role=combobox` 触发器 + portal 弹层）；`value` / `onChange(event.target.value)` / `<option>` children 写法不变；方向键 / Home / End / Enter / Space / Esc / Tab / 点外关闭，焦点留在触发器 |
| `KeyValueList`                                                                   | `components/ui/KeyValueList.tsx`     | 两列 `dl` 网格（等价旧 `.diag-list`）；`items: { label, value }[]`，value 自动断行                                                      |
| `Stat`                                                                           | `components/ui/Stat.tsx`             | 指标块；`label` / `value` / `hint`                                                                                                                                                                        |
| `DataTable`                                                                      | `components/ui/DataTable.tsx`        | 语义化表格；`columns`（`hide: 'wide' \| 'compact'`）/ `rows` / `rowKey` / `activeKey` / `stickyHeader`（默认 false，仅限自身有滚动容器的表格）；不做排序、分页、虚拟化                         |
| `PageScaffold`                                                                   | `packages/plugin-ui/src/Page.tsx`    | 宿主与插件页的唯一标准骨架（title + subtitle + content）；Web `PageFrame` 是其路由级滚动容器包装；头部约束见 [DESIGN.md](DESIGN.md)                                                   |
| `TableToolbar`                                                                   | `packages/plugin-ui/src/TableToolbar.tsx` | 表格控件容器：`role="toolbar"`；位置与收纳内容见 [DESIGN.md](DESIGN.md)                                                          |

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

### MessageBar / Toast API

- 唯一位置：AppBar 中心 `MessageBar`（`components/MessageBar.tsx`）。toast、构建过期、
  连接 / 鉴权 / 断线、其他会话的 pending 摘要都进这一条横向可滚动的轨道；不新增全局
  遮罩、固定 toast、顶部 / 底部 banner，也不为失效交互恢复独立占位。
- `ToastProvider` 只提供 API 与状态，不渲染：`useToast` 负责推送，`useToastFeed`
  暴露 `{ items, dismiss }`，由 `AppShell` 组合进 `MessageBar`。
- 只在用户主动操作的成功 / 失败、连接失败、交互失效时使用；后台轮询与静默刷新不 toast。
- `ToastProvider` 对相同 `kind + message` 去重；最多同时 3 条；`success` / `info` 4s、`error` 5s
  自动消失，每条也可手动关闭。
- `MessageBar` 容器 `role="status"` + `aria-live="polite"`；错误 chip `role="alert"`；
  actions 常显且可 Tab，文本截断时用 `title` 保留全文。
- 失效交互在 hydration 后按 tenant + request id 集合只提示一次，重连不重复弹；
  详情只在 Observe → Attention 查看，Chat 内不再有失效卡片或本地忽略入口。

### notify / inbox

- `agent.message.queued` 是唯一的收件箱投递事件（`delivery: input | wake | quiet`）：
  列在 `state/events.ts` 的 `CHAT_HIDDEN_EVENT_TYPES`，聊天时间线不渲染原始 JSON 卡；
  唤醒 / 只落 inbox 都不产生 run，也不改变对话内容。旧名 `agent.message.notified`
  仍留在该集合里，只为历史行不落成原始 JSON 卡。
- 收件箱计数口径：`unread` = 可读（unread 且非 held）；`pending` = held ∩ unread；
  `messages[]` 同时含可读与 held，`held` 为布尔。`read` 只看 / 消费 non-held，
  `delete` 只删 non-held。
- 正文只经模型侧 `inbox` 工具读取（`list` / `read` / `delete` / `insert`）；Web 当前
  不为收件箱另建面板。若将来展示摘要，held 必须走 `pending`，不能用 `unread` 代替；
  通知事件只带 `delivery` / `message_id` / `from` / `to` / `conversation_id` / `wake`，
  不带正文。

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
7. **提示统一走 MessageBar**：所有 transient message / banner / interaction summary
   统一经 AppBar 中心 `MessageBar`；禁止新增 fixed toast / banner / 右下角浮层 /
   自建通知区域。`ToastProvider` 只提供 API，不渲染。

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
   | 1199 | `team.css:218`（`.team-chat-body.has-members` 成员栏 272→240px） | 否 | 这是成员栏宽度降档，不是抽屉切换；1023 才切抽屉（`team.css:243`）。折到 1023 会让 1024–1199 提前失去常驻成员栏。 |
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
