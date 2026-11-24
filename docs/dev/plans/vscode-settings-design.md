# VSCode 式设置重构设计（q-settings）

- 状态：设计完成（待 main 评审；开放问题见 §9.2）
- 分支：`design/q-settings`（纯设计，不改代码）
- 产出：本文件；实施由 main 另行派单
- 协同：q-kanban / q-skills（插件设置域声明方，见 §10）

## 0. 用户裁定（必须贯彻）

| # | 裁定 | 本设计落点 | 满足切片 |
|---|------|-----------|----------|
| ① | 设置重构为 VSCode 式**弹窗**设置项（非现样式） | §3 SettingsDialog | S1（+S5 工作区） |
| ② | 设置可检索；插件可自定义设置域（搜索/配置） | §3.3 搜索 + §4 贡献契约 | S1 搜索 / S3+S4 插件域 |
| ③ | 左侧菜单栏的「视觉效果」移进设置，作为设置的一部分 | §5 视觉分区 | S2 |
| ④ | 设计实验室移到「视觉」分区 | §5.2 view 型设置项 | S2 |
| ⑤ | 设置入口移到右上角，替换 gateway 在线图标（gateway 状态左侧栏已有，不重复） | §3.1 入口 | S1 |

## 1. 现状调研（事实锚点）

### 1.1 设置 UI 与路由（三页分立）

- `#/settings` → `SettingsView` → `ConfigView`：只读「解析后配置」——JSON 视图 + 扁平键值表（可搜索）+ 来源表。不可编辑。
  （`apps/web/src/domains/settings/SettingsView.tsx` / `ConfigView.tsx`）
- `#/visual` → `VisualPage` = `AppearanceView`（主题/语言/动效，localStorage）+ `DisplaySettingsView`（白名单键开关，走 `config.set`）。
  （`apps/web/src/domains/settings/NavPages.tsx` / `AppearanceView.tsx` / `DisplaySettingsView.tsx`）
- `#/designLab` → `DesignLabView`：token 自动枚举 + `*.preview.tsx` 自动发现样例；不连 gateway。
  （`apps/web/src/domains/design/DesignLabView.tsx` / `preview-registry.ts`）
- 左侧栏 `settings` 分组含三个导航点：`settings` / `visual` / `designLab`（`apps/web/src/app/nav.ts` NAV_GROUPS）。
- 旧深链别名已存在：`#/settings?tab=appearance|display` → `visual`（`router.ts` parseRoute）。

### 1.2 存储与写路径（两层）

- **服务端 vessel.yaml**（user / project 两份）：`config.get` 读脱敏快照；`config.set` 写，
  白名单三层一致：serve 方法层 `SETTABLE_KEYS`（`packages/serve/src/gateway/methods/config.ts`）→
  asm 写面 `isSettableConfigKey`（`src/ui-settings.ts`）→ `setUserConfigValue` 原子写 0600。
  写后经文件监听热应用（debounce 300ms），Web 侧用「乐观 overlay + 轮询确认」消化快照延迟
  （`DisplaySettingsView` WRITE_CONFIRM_ATTEMPTS=8 / 250ms）。
- **浏览器 localStorage**：`vessel.theme`（`state/theme.ts`，0.52 起 `storeTheme` 是 DOM 主题唯一写者）、
  `vessel.ui.language`（i18n）、`vessel.nav.collapsed` / `vessel.nav.collapsed-groups`（导航偏好）。
- 可写键清单（今天）：`ui.verbosity / showInternalEvents / showArchived / errorLevel / askUser /
  showReasoning / expandCards / statusBars / language`、`observability.showProcessErrors`、
  `observability.log.level / color / format / time`、`agent.cwd`。
  前端白名单常量 `DISPLAY_SETTINGS`（`apps/web/src/state/display-settings.ts`）。

### 1.3 插件贡献机制（关键发现：settings 声明已存在，只差 UI 面）

- manifest `contributes` 已有：`i18n / navGroups / pages / panels / toolbar / commands / rpc / events /
  settings / http`（`packages/serve/src/plugin-host/types.ts` PluginManifestContributions）。
- **`contributes.settings` 已是 `Record<key, {type, description?, default?}>`**，但今天只用于
  过滤/校验 `plugins[].config`（`manager.ts` filterSettings + typeMatches），**不透出到 Web**。
  真实用例：`plugins/marketplace/marketplace/package.json`（registry_url / proxy / install_scope /
  allow_prerelease…）、`plugins/tools/web-tools/package.json`（backend / key_env / api_timeout_ms…）。
- Web 消费链：`plugins.list`（含 `contributions` + E10 `config` 快照）→ `plugin.changed` 广播 →
  `buildPluginInventory` 纯函数归一化（`apps/web/src/domains/plugins/plugin-contributions.ts`，
  白名单校验、非法项丢弃、i18n 走 pluginT 插件私有字典）。
- 插件配置持久化先例：`setPluginEnabled`（`src/plugin-config.ts`）——`withConfigLock` +
  `readUserConfigRoot` + 只改目标键 + `writeUserConfigRoot`，保留其它键。**设置写路径照此新增。**
- child 插件 settings 经 `VESSEL_PLUGIN_CONFIG` env 在 spawn 时注入（`plugin-host/child.ts`）——
  运行中改配置不热生效，需重载（`plugins.reload` 已存在，write 权限）。

### 1.4 顶栏与左侧栏状态

- AppBar 右侧现有：LanguageToggle → 命令面板按钮（⌘K）→ **gateway 连接状态按钮**（圆点+文案，
  点击跳 gateway 页）→ AccountMenu（头像浮层内含「设置」项，今天跳 `#/settings`）。
  （`apps/web/src/app/AppBar.tsx` L101–118）
- gateway 在线状态左侧栏**已有**：`useNavStatus` / `nav-status.ts` 四档语义
  （accent/amber/danger/muted），gateway 点色 = WebSocket 连接状态，与顶栏按钮同源。→ 裁定⑤成立。

### 1.5 可复用基础设施

- `ModalShell`（portal/焦点圈/Esc/滚动锁/sm|md|lg）+ ui 组件（Section / SearchInput / SegmentedTabs / Badge / JsonView / Toast）。
- `CommandPalette`（⌘K）已有「查看配置」动作项；`shortcuts.ts` 只占 ⌘K / `/` / Esc → **Ctrl/Cmd+, 空闲**（VSCode 同款）。
- 乐观 overlay store：`uiStore.displayPending`（按 key+值确认清除）。

## 2. 总体架构

### 2.1 架构图

```
┌──────────────────────────────────────────────────────────────┐
│                    SettingsDialog（弹窗）                      │
│    搜索框 ─ 分类树 ─ 设置项列表 ─ 用户/工作区/浏览器 tab          │
└─────────────▲────────────────────────────▲───────────────────┘
              │ 读（统一 SettingDef）        │ 写（按 scope 分流）
┌─────────────┴──────────────┐  ┌──────────┴─────────────────────────┐
│ settings-registry（新）     │  │ user/project → config.set（现有）    │
│ 核心定义 + 插件域归一化合并   │  │ local → 既有 storage 函数（唯一写者） │
└──▲──────────────▲──────────┘  │ 插件键 → plugins.config.set（新）    │
   │              │             └──▲───────────▲───────────▲─────────┘
┌──┴─────────┐ ┌──┴─────────────┐   │           │           │
│ 核心设置定义 │ │ 插件设置域       │ ┌─┴──────┐ ┌─┴───────┐ ┌─┴──────────┐
│ DISPLAY_   │ │ buildPlugin-   │ │gateway │ │asm 写面  │ │localStorage│
│ SETTINGS   │ │ Inventory 扩展  │ │方法层   │ │ui-settings│ │theme/locale│
│ 收敛+本地偏好│ │ (settings[])  │ │白名单   │ │plugin-   │ │nav 偏好     │
└────────────┘ └──▲─────────────┘ └─▲──────┘ │config(新)│ └────────────┘
                  │                 │        └─▲────────┘
       plugins.list / plugin.changed│          │
                  └────────┬────────┴──────────┘
                  ┌────────┴──────────────────────┐
                  │ vessel.yaml（user / project）  │
                  │ + manifest contributes.settings│
                  │  （已有，扩展 UI 元数据）        │
                  └───────────────────────────────┘
```

### 2.2 设置注册表（单一事实源）

新增纯 TS 模块 `apps/web/src/state/settings-registry.ts`：

```ts
export type SettingScope = 'user' | 'project' | 'local';
export type SettingType = 'boolean' | 'enum' | 'string' | 'number' | 'object' | 'array' | 'view';

export interface SettingDef {
  /** 点分键：核心 = config 键（ui.showReasoning）；本地 = local.<id>；插件 = <pluginId>.<key> */
  id: string;
  scope: SettingScope;
  type: SettingType;
  /** 宿主 i18n key（核心）；插件项由 pluginT 解析后直接给 title 文本 */
  titleKey?: string;
  title?: string;
  descriptionKey?: string;
  description?: string;
  /** 额外搜索词（中英别名、旧称） */
  keywords?: readonly string[];
  category: string;            // §6 分类 id
  common?: boolean;            // true → 进「常用」
  order?: number;
  options?: readonly string[]; // enum 可选值
  default?: string | boolean | number;
  source: 'core' | `plugin:${string}`;
  /** view 型：渲染自定义子视图而非控件（设计实验室 / 连接摘要 / 高级 JSON） */
  view?: 'designLab' | 'connection' | 'advancedConfig';
  /** 只读（环境变量覆盖 / 旧 gateway 无写面 / map 型键） */
  readOnly?: boolean;
}
```

- 核心定义 = 现 `DISPLAY_SETTINGS` 全量 + 本地偏好（主题/语言/动效/导航）+ 三个 view 项。
  `DISPLAY_SETTINGS` 改为**从注册表派生**（保留导出，`DisplaySettingsView` 等旧消费方零改动过渡）。
- 插件域 = `buildPluginInventory` 新增 `settings: PluginSettingsDomain[]`（§4.3），
  注册表 merge 时按 `plugin:<id>` 前缀隔离，核心键与插件键永不冲突（插件 id 不含点分前缀歧义：
  插件设置展示键固定 `<pluginId>.<key>`，核心键白名单不含插件 id 段）。
- 注册表是**纯数据 + 纯函数**（可静态渲染断言，延续 DisplaySettingsFields 的做法），不 import React。

### 2.3 三层 scope（VSCode 用户/工作区层级的 vessel 映射）

| scope | 存储 | 写路径 | 语义 |
|-------|------|--------|------|
| `user` | `~/.vessel/config.yaml` | `config.set`（现有） | 全局默认，跨项目 |
| `project` | `<project>/vessel.yaml` | `config.set` + additive `scope` 参数（S5） | 工作区覆盖，优先于 user |
| `local` | 浏览器 localStorage | 既有 storage 函数（storeTheme / setLocale / writeNavPreference） | 仅本浏览器：主题、导航折叠等呈现偏好 |

- 生效优先级：`project > user > 内置默认`（服务端解析已是此序，`config.sources` 可查每键来源）；
  `local` 不参与服务端解析，纯前端呈现层。
- 每个设置项声明**唯一归属 scope**（不做 VSCode 式「同一键两层都可写」的全量双写）：
  服务端键归 user/project，呈现偏好归 local。理由：避免 theme 这类键出现「服务端一份、浏览器一份」
  的双真相（0.52 主题自愈 bug 的教训）。例外 `ui.language`：服务端键（agent 侧也消费），
  写入成功后同步 `setLocale`（沿用 DisplaySettingsView 现有行为）。
- 弹窗顶部 tab：**用户 | 工作区 | 浏览器**。工作区 tab 在 S5 落地前置灰并提示「即将支持」；
  浏览器 tab 只列 local 项。tab 切换 = 过滤注册表 + 换写路径，搜索与分类树结构不变。

## 3. 设置 UI 设计（VSCode 式弹窗）

### 3.1 入口（裁定⑤）

| 入口 | 行为 |
|------|------|
| **AppBar 右上角齿轮按钮**（替换 gateway 状态按钮，L101–114 整段移除） | 打开 SettingsDialog；tooltip「设置 (Ctrl+,)」；compact 模式只留图标 |
| 快捷键 `Ctrl/Cmd+,` | 开/关弹窗（shortcuts.ts 新增判定；输入框聚焦时不拦截） |
| AccountMenu「设置」项 | 由 `navigate({domain:'settings'})` 改为打开弹窗 |
| 命令面板 | 「打开设置」动作项 + 设置键检索（S6：palette 输入命中设置键 → 打开弹窗并聚焦该项） |
| 移动端 BottomNav「更多→设置」 | 打开同一弹窗（compact 布局，§3.2） |
| 旧路由 `#/settings` `#/visual` `#/designLab` | 解析为「打开弹窗 + 定位」的深链别名（§3.8），不再渲染整页 |

- gateway 在线状态**只留左侧栏**（nav-status 四档点色 + 版本 + tooltip，证据同源）；
  顶栏不再重复。断连兜底：既有 StaleNotice / MessageBar 全局提示不受影响（风险 R2）。
- 左侧栏 `settings` 分组三个导航点（settings/visual/designLab）**全部移除**（裁定③④⑤合并结果）；
  `NAV_GROUPS` 删掉 settings 组，`DOMAINS` 保留 id 供路由别名与图标复用。

### 3.2 弹窗布局线框

基于 `ModalShell`，新增尺寸 `xl`（`min(1080px, 94vw)`，高 `min(86dvh, var(--modal-max-h))`），
不新增颜色 token，全部复用现有 ui 组件。

```
┌──────────────────────────────────────────────────────────────────────┐
│ 设置                                                            [×]  │
│ [ 用户 | 工作区 | 浏览器 ]                                             │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ ⌕ 搜索设置…                              [@modified ▾] [清除筛选] │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ┌───────────────┬──────────────────────────────────────────────────┐ │
│ │ 常用           │  视觉 › 主题                                      │ │
│ │ 视觉           │  ┌────────────────────────────────────────────┐  │ │
│ │ 显示与可见性    │  │ ▎主题                          [本地] [↺]  │  │ │
│ │ 日志           │  │ 界面配色跟随系统或固定亮/暗。                  │  │ │
│ │ 连接           │  │ local.theme                                 │  │ │
│ │ 高级           │  │ ( system | light | dark )  ← SegmentedTabs  │  │ │
│ │ ───────────    │  └────────────────────────────────────────────┘  │ │
│ │ 扩展           │  ▎= 已修改指示条（VSCode 同款，accent 色）          │ │
│ │  ▸ 任务看板     │  [↺] = 恢复默认（hover 显现）                     │ │
│ │  ▸ Skills      │  [本地]/[用户]/[工作区] = scope badge              │ │
│ │  ▸ Marketplace │  键路径小字 mono，点击复制（CopyButton 复用）       │ │
│ │  ▸ Web Tools   │                                                  │ │
│ └───────────────┴──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

- 左树右列表，各自独立滚动；分类标题在右侧列表内作为锚点（点树 = 滚动定位 + 高亮）。
- **compact（<宽阈值，沿用 max-compact 断点）**：单列；分类树收成顶部横向 chips（可横滑），
  搜索框常驻；设置项卡片全宽。弹窗占满 `100dvw × 100dvh`（移动端全屏 sheet 形态）。
- 空态：无搜索命中 → 「没有匹配的设置」+ 清除筛选按钮；插件域为空 → 扩展组不渲染。

### 3.3 搜索（裁定②）

- 匹配域：`title`（当前 locale 解析后文本）+ `description` + `id` 键路径 + `keywords` +
  enum 选项文案。大小写不敏感；中文按子串；多词空格分词取 AND。
- 命中行为：右侧列表只渲染命中项（保留所属分类标题）；左树只留有命中的分类并显示计数徽章；
  命中文字 `<mark>` 高亮（复用现有 mark 样式，无新 token）。
- 筛选 token（VSCode `@` 语法子集）：
  - `@modified`：只显示值 ≠ 默认值的项（本地项对比 storage，服务端项对比 config 快照 + default）；
  - `@plugin:<id>`：只看某插件域；`@local` / `@user` / `@project`：按 scope。
  - 搜索框右侧筛选按钮提供这些 token 的菜单化入口（不必记语法）。
- 索引：注册表 merge 后一次性构建 `Map<id, 搜索文本>`，useMemo 缓存；插件域上限 64 项/插件
  （§4.3），总量可控，无需防抖以外的优化（输入防抖 150ms）。
- 键盘：↑/↓ 在命中项间移动焦点，Enter 聚焦该项控件，Esc 先清搜索再关弹窗（两级）。

### 3.4 分类树

- 数据 = 注册表 category 去重 + 固定排序（§6）；插件域动态追加在「扩展」组下，
  标题 = pluginT 解析的插件名（回退 manifest name → id），图标复用 PLUGIN_NAV_ICONS 白名单。
- 树节点：名称 + 命中计数（搜索态）；「常用」是 curated 视图（`common: true` 过滤），不是独立分类。
- 折叠态持久化：`vessel.settings.tree.collapsed`（local，新增键，纳入注册表 local 项）。

### 3.5 设置项渲染

| type | 控件 | 复用 |
|------|------|------|
| boolean | checkbox（VSCode 式勾选框；不用 toggle，保持与现 Display 页一致） | 现 fieldset 样式 |
| enum | radio 组（≤4 选项）/ select（>4） | SegmentedTabs / 原生 select |
| string | 文本输入（blur 或 Enter 提交） | SearchInput 样式变体 |
| number | 数字输入 + min/max（spec 扩展，S4） | 同上 |
| object / array | **v1 只读 JSON 视图**（JsonView），提示「在 vessel.yaml 中编辑」 | JsonView |
| view | 自定义子视图（§5.2 设计实验室 / 连接摘要 / 高级配置） | 懒加载 |

- 每项结构：标题行（title + scope badge + 修改指示条 + ↺ 恢复默认）→ description →
  键路径（mono 小字）→ 控件 → 附加提示（环境变量覆盖 / 需重载生效 / 只读原因）。
- 修改指示：值 ≠ default 时左侧竖条（accent）；`@modified` 据此过滤。
- 恢复默认：写入 default 值（`config.set` 无 delete 语义，见 R8）；local 项 = 移除存储键回内置默认。
- 只读态：断连 / 写面未注入（not_found）/ 环境变量覆盖（logEnvOverrides 现有机制）/
  旧 gateway 无插件写 RPC → 控件禁用 + 原因文案，刷新按钮给一次复位（沿用 DisplaySettingsView 教训）。

### 3.6 写路径与乐观确认（泛化现有机制）

- `uiStore.displayPending` 泛化为 `settingsPending`（同形：按 key+值确认清除；保留旧名导出过渡）。
- 核心服务端键：`client.setConfigValue(key, value)` → 轮询 `reloadConfigAsync` 确认
  （8 次 × 250ms，覆盖热应用 debounce；常量原样搬进通用 writer）。
- 插件键：`plugins.config.set`（§4.4）→ 确认源 = `plugins.list[].config`（plugin.changed
  广播或轮询 plugins.list），同一 overlay/确认机制，不另造一套。
- local 键：同步写 storage（storeTheme / setLocale / writeNavPreference 等既有唯一写者），
  无确认窗口；写失败（隐私模式/配额）沿用「本会话内生效」降级。
- 失败语义沿用现状：只有写 RPC 失败才算保存失败（清本次 overlay 回服务端值）；
  确认超时 → 明确 toast「已写入但未确认」，不静默。
- 弹窗关闭不丢未确认写入：overlay 在 uiStore（全局），重开弹窗仍显示 pending 态。

### 3.7 弹窗状态管理

- 新增 `settingsDialogStore`（zustand，与 uiStore 同层）：`{ open, focusKey?, query?, scopeTab }`。
- 打开来源（齿轮/快捷键/菜单/深链）统一走 `openSettings({ focusKey?, query? })`；
  深链解析在 router 层完成（§3.8），弹窗组件只消费 store。
- 弹窗挂载时拉 `config.get` + `plugins.list`（复用 useConfigStoreApi / usePluginContributions，
  不新建数据通道）；加载态 = 骨架列表；断连 = StaleNotice + 本地项仍可编辑。

### 3.8 深链与路由别名

- `#/settings` → 打开弹窗（默认常用分类）；`#/settings?focus=<key>` → 定位并高亮某项；
  `#/settings?q=<text>` → 带搜索词打开。
- `#/visual`、`#/settings?tab=appearance|display` → 打开弹窗定位「视觉」分类；
  `#/designLab` → 打开弹窗定位设计实验室 view 项（§5.2）。
- `#/settings?tab=connection` → gateway 页（现别名保留）；`?tab=capabilities` → capabilities 页（保留）。
- 实现：parseRoute 把这些路由解析为 `{ domain:'chat' }` + 一次性 side-effect 队列
  （或新增 `{ domain:'settings'; focusKey?; query? }` 路由型，由 ShellOverlays 消费后打开弹窗并
  replace 回 chat）——**推荐后者**：保持「路由 = 可分享状态」，弹窗打开态可深链、可后退关闭。
- formatRoute 往返一致（现有 invariant）；旧链接永不 404。

## 4. 插件设置域贡献契约（裁定②）

### 4.1 manifest `contributes.settings` spec 扩展（additive，向后兼容）

现状 `{type, description?, default?}` 继续合法（marketplace / web-tools 零改动）。扩展字段全部可选
（下例为字段全集展示，实际声明按 type 取舍；标题解析优先级 titleKey → title → key）：

```jsonc
// package.json → vessel.contributes.settings
{
  "board_path": {
    "type": "string",                  // 已有：string|number|integer|boolean|object|array
    "title": "看板文件路径",            // 新：可见标题（titleKey 缺省时用）
    "titleKey": "kanban.settings.boardPath",  // 新：插件私有 i18n key（优先于 title）
    "description": "board.json 的仓库相对路径", // 已有
    "descriptionKey": "kanban.settings.boardPath.desc", // 新
    "default": "docs/dev/kanban/board.json",   // 已有
    "enum": ["a", "b"],                // 新：仅 type=string；渲染 select/radio
    "keywords": ["kanban", "看板", "board"],   // 新：额外搜索词
    "order": 10,                       // 新：域内排序
    "minimum": 1000, "maximum": 60000  // 新：仅 number/integer（clamp 提示）
  }
}
```

- **不引入 JSON Schema 全集**：v1 只支持上述扁平 spec（与 filterSettings/typeMatches 现有校验同层），
  object/array 仍只读。嵌套 schema 是过度设计（红蓝复盘教训）。
- 键名规则沿用现状：插件私有扁平键（snake_case 惯例），**不带插件前缀**（前缀由宿主拼）。
- 校验失败语义与现有贡献点一致：**单项丢弃 + 告警**，不整域丢弃、不拒载插件
  （type 非法 → 丢该项；enum 含非 string → 丢 enum 保留项；default 类型不符 → 忽略 default）。

### 4.2 wire：`plugins.list` contributions.settings（additive）

- `PluginRenderContributions`（serve types.ts）新增 `settings?: Record<string, PluginSettingSpec>`
  （loader 已校验的 spec 原样透传，同 i18n 的处理方式）。
- `plugins.list` result_schema 的 contributions.properties 增加 `settings: {type:'object'}`；
  `plugin.changed` 广播同形（mergePluginList 已统一两条路径，零额外逻辑）。
- 旧 gateway 不返回 → Web 归一化得空数组 → 扩展组不渲染（additive 优雅降级，同 toolbar 先例）。
- 值快照复用 E10 `plugins.list[].config`（已有），**不新增读 RPC**。

### 4.3 Web 归一化（plugin-contributions.ts 扩展）

```ts
export interface PluginSettingsDomain {
  pluginId: string;
  pluginName: string;          // pluginT 解析后的显示名
  items: PluginSettingItem[];  // 已校验、已排序
}
export interface PluginSettingItem {
  key: string;                 // 插件私有键
  id: string;                  // `${pluginId}.${key}`（注册表/搜索/深链用）
  type: 'string'|'number'|'integer'|'boolean'|'object'|'array';
  title: string;               // pluginT(titleKey) → title → key
  description?: string;
  enum?: string[];
  default?: unknown;
  keywords?: string[];
  order: number;
  minimum?: number; maximum?: number;
}
```

- 校验规则（延续现有 normalizer 风格）：key `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/` 且禁
  `__proto__/constructor/prototype`；type 白名单；enum ≤32 项、每项 ≤64 字符；
  title/description ≤200 字符；keywords ≤16 个；**每插件 ≤64 项**（超出截断 + 告警）。
- `buildPluginInventory` 增加 `settings: PluginSettingsDomain[]`；只收 enabled 插件（同 pages）。
- i18n 走 pluginT 插件私有字典（不合并宿主 catalog，E9 规则不变）。

### 4.4 写 RPC：`plugins.config.set`（新增，write 权限）

```
请求  { plugin: string, key: string, value: string|number|boolean }
响应  { ok: true, plugin, key, value, restartRequired: boolean }
错误  invalid_params（键未声明/类型不符/enum 越界）
      not_found（插件不存在 / 写面未注入）
      forbidden（非 default tenant，同 config.set）
```

- serve 方法层：按 manifest `contributes.settings` 校验（复用 typeMatches + enum 扩展），
  未声明键拒绝（与 filterSettings 同语义，但写路径**报错**而非静默丢弃）。
- asm 写面：`src/plugin-config.ts` 新增 `setPluginConfigValue(name, key, value, {configPath})`，
  照 `setPluginEnabled` 先例：withConfigLock → readUserConfigRoot → 只改
  `plugins[name].config[key]` → writeUserConfigRoot（保留其它键/其它插件）。
- 写成功后广播 `plugin.changed`（config 快照变了）；`restartRequired` 由 manager 判定
  （child 模式 = true：settings 经 env 注入，spawn 后不可变）。
- 安全：值不落日志明文（沿用 config 脱敏口径）；secret 类键（如 key_env）只存变量名不存值
  （web-tools 现有约定，spec 不新增 secret 类型，文档提示即可）。

### 4.5 生效语义（不谎报热应用）

- in-process 插件：写后下一次装配/热应用读到新 config（config 文件监听已有）；UI 提示「已保存」。
- child 插件：`restartRequired: true` → 设置项下方出现提示条「重载插件后生效」+ [重载] 按钮
  （调 `plugins.reload`，write 权限，已有）。**v1 不做运行中 settings 推送**（child 协议无此通道，
  新增通知是二期，见 §9 开放问题）。
- 弹窗内重载结果 toast 复用 plugins.reload 现有错误形状（errors[] 逐项展示）。

### 4.6 示例域（真实 + 协同）

- **marketplace（已存在，零改动即受益）**：registry_url / proxy / install_scope /
  project_root / allow_prerelease → 扩展组「Marketplace」5 项可编辑。
- **web-tools（已存在）**：backend / base_url / key_env / api_timeout_ms / max_bytes…
  → 扩展组「Web Tools」；number 项带 clamp 提示。
- **kanban（q-kanban 注册，§10）**：board_path 等。
- **skills（q-skills 注册，§10）**：skills 目录/加载策略等。

## 5. 「视觉」分区（裁定③④）

### 5.1 吸收左侧「视觉效果」页

- 现 `VisualPage`（AppearanceView + DisplaySettingsView）整体拆进注册表：
  - 主题（local.theme，enum system/light/dark）→ 视觉分类，common；
  - 界面语言（ui.language，服务端 enum）→ 视觉分类，common；写后 setLocale 同步（现有行为）；
  - 动效（说明项：跟随系统 reduced-motion，无开关）→ 视觉分类，readOnly 说明行；
  - DisplaySettingsView 的显示键 → 「显示与可见性」分类；日志键 → 「日志」分类（§6）。
- `AppearanceView` / `DisplaySettingsView` / `VisualPage` 组件在 S6 收敛删除
  （过渡期保留导出供旧路由别名渲染，S1–S5 期间旧页仍可用 = 双轨不回归）。
- 主题写入**必须经 storeTheme**（0.52 唯一写者 invariant），注册表 local writer 只是转调，
  绝不直接写 DOM / localStorage。

### 5.2 设计实验室 = view 型设置项

- 注册表项 `{ id:'local.designLab', type:'view', view:'designLab', category:'visual' }`。
- 渲染：视觉分类内一个可折叠区块「设计实验室」，展开时**懒加载**现 DesignLabView 内容
  （TokenSection + PreviewSection；preview 的 import.meta.glob 机制原样保留，不进首屏 chunk）。
- 弹窗内空间有限：区块默认折叠，标题行带「展开」；展开后内部独立滚动区（max-h 60dvh），
  token 搜索框（TokenSection 自带）可用。
- 需要全屏时：区块头部 [全屏打开] → 嵌套 ModalShell（lg）承载同一内容（滚动锁引用计数已支持嵌套）。
- `#/designLab` 深链 = 打开设置弹窗 + 定位视觉分类 + 自动展开该区块。
- 设计实验室**不连 gateway** 的性质不变：纯静态样例，弹窗断连时仍可用。

### 5.3 导航偏好入设置

- 侧栏默认折叠（vessel.nav.collapsed）→ 视觉分类「导航」子组，boolean，local；
  写入走 writeNavPreference，AppShell 现有消费不变。
- 分组折叠状态（vessel.nav.collapsed-groups）→ 同子组 readOnly 展示 + [全部展开] 重置按钮。
- 左侧栏自身的折叠按钮保留（即时操作），设置项是「默认值/持久态」的可见入口——两者写同一存储键，
  无第二真相。

## 6. 分区结构（完整分类树）

```
设置弹窗
├── 常用            common:true 的 curated 视图（主题/语言/verbosity/askUser/showReasoning…）
├── 视觉 visual
│   ├── 主题                    local.theme          enum system|light|dark   [common]
│   ├── 界面语言                ui.language          enum zh-CN|en            [common]
│   ├── 动效                    （说明行：跟随系统 reduced-motion，无开关）
│   ├── 导航
│   │   ├── 侧栏默认折叠        local.nav.collapsed  boolean
│   │   └── 分组折叠状态        local.nav.groups     readOnly + [全部展开]
│   └── 设计实验室              local.designLab      view（§5.2，懒加载）
├── 显示与可见性 display
│   ├── ui.verbosity            enum minimal|normal|debug        [common]
│   ├── ui.showInternalEvents   boolean
│   ├── ui.showArchived         boolean
│   ├── ui.errorLevel           enum user|all
│   ├── ui.askUser              boolean                            [common]
│   ├── ui.showReasoning        boolean                            [common]
│   ├── ui.expandCards          boolean
│   ├── ui.statusBars           enum top|bottom|both|none
│   └── observability.showProcessErrors  boolean
├── 日志 logs
│   ├── observability.log.level / color / format / time   enum（环境变量覆盖时只读+提示）
│   └── observability.log.modules                         readOnly map 展示
├── 连接 connection        view：连接状态/节点/版本只读摘要 + [打开 Gateway 页]
├── 高级 advancedConfig    view：现 ConfigView（脱敏 JSON + 键值表 + 来源表），只读
└── 扩展 extensions        （动态：enabled 且声明 settings 的插件，按 order/名称排序）
    ├── 任务看板 plugin:kanban       （q-kanban 声明，§10）
    ├── Skills plugin:skills         （q-skills 声明，§10）
    ├── Marketplace plugin:marketplace（已存在：registry_url/proxy/install_scope/…）
    └── Web Tools plugin:web-tools   （已存在：backend/key_env/api_timeout_ms/…）
```

- 分类 id / 排序 / 标题 i18n key 在注册表常量固定；插件域只能追加到「扩展」下，
  **不能注入核心分类**（与 navGroups 核心 key 不可覆盖同一安全口径）。
- 「常用」不是分类而是过滤视图：项的 `common:true` 标记，curated 清单随注册表维护。
- 连接/高级两个 view 项保证旧 ConfigView 与 gateway 入口的能力不丢（只读诊断面保留）。

## 7. 存储 / 迁移 / 默认值

### 7.1 scope 归属表

| 键 | scope | 存储 | 备注 |
|----|-------|------|------|
| ui.* / observability.* / agent.cwd | user（S5 后 project 可覆盖） | vessel.yaml | 白名单键不变 |
| local.theme | local | vessel.theme | 键名不变；storeTheme 唯一写者 |
| local.nav.collapsed / local.nav.groups | local | vessel.nav.collapsed / -groups | 键名不变 |
| local.settings.tree / local.settings.tab | local | vessel.settings.tree.collapsed / vessel.settings.tab | 新增（弹窗自身偏好） |
| <pluginId>.<key> | user | vessel.yaml plugins[].config | 经 plugins.config.set |
| ui.language | user | vessel.yaml | 写成功后 setLocale 同步本地（现有行为） |

### 7.2 迁移（零数据迁移）

- **服务端键与 localStorage 键全部原名保留**：无数据搬迁、无 schema 版本升级。
  重构只动「渲染与入口」，不动存储事实。
- 路由迁移：`#/settings|visual|designLab` 变深链别名（§3.8），旧链接永不 404；
  `?tab=connection|capabilities` 别名保留。
- 常量收敛：`DISPLAY_SETTINGS` 改从注册表派生（保留导出）；S6 删除
  AppearanceView / DisplaySettingsView / VisualPage / 旧 SettingsView 整页（ConfigView 移入高级 view）。
- i18n：新增 `settings.item.<id>.title|desc`、`settings.category.*`、`settings.dialog.*`；旧 `settings.display.field.*` / `appearance.*` 双轨期保留，S6 清理。
- 双轨期（S1–S5）：旧 `#/visual` 整页仍可用（别名先指向旧页，S2 起指向弹窗），任何切片失败可独立回退，不出现「设置改不了」的中间态。

### 7.3 默认值与重置

- 注册表每项声明 default（服务端键默认值以 `packages/config/src/types.ts` UiConfig 注释为准：
  showReasoning=false、showInternalEvents=false、showArchived=false、verbosity=normal…）。
- 插件项 default 来自 manifest spec（已有字段）；缺省 default 的项不显示 ↺（无默认可回）。
- 重置 = 写 default 值（config.set 无 delete；与 VSCode「移除覆盖」语义差异见 R8）；
  local 项重置 = 移除存储键（回内置默认，如 theme 回 dark）。
- `@modified` 判定：服务端项对比 config 快照值 vs default；local 项对比存储值 vs 内置默认。

## 8. 实施计划（切片 S1–S6，文件级；实施由 main 派单）

| 切片 | 内容 | 主要文件 | 门禁 |
|------|------|----------|------|
| **S1** 注册表+弹窗骨架+入口 | 核心 user/local 项渲染、搜索、分类树、常用视图；齿轮替换 gateway 按钮；Ctrl+,；AccountMenu/palette 改打开弹窗；settings 弹窗路由型+深链 | 新 `state/settings-registry.ts` `state/settings-search.ts` `stores/settingsDialogStore.ts` `domains/settings/dialog/{SettingsDialog,CategoryTree,SettingRow,SettingsSearchBar}.tsx`；改 `AppBar.tsx` `shortcuts.ts` `AccountMenu.tsx` `palette-items.ts` `router.ts` `ShellOverlays.tsx` `nav.ts` `BottomNav.tsx` `Modal.tsx`(xl) `uiStore.ts`(settingsPending) i18n | bun run build exit 0 |
| **S2** 视觉分区 | 主题/语言/动效/导航偏好入注册表；设计实验室 view 项（懒加载+嵌套全屏）；左栏移除 visual/designLab 点；`#/visual` `#/designLab` 别名指向弹窗 | 新 `dialog/DesignLabSection.tsx`；改 `nav.ts` `router.ts` `ShellRouteView.tsx` `BottomNav.tsx`；`domains/design/*` 原样复用 | 同上 |
| **S3** 插件域读侧 | serve spec 透传 + wire schema；Web 归一化 + 注册表 merge；扩展组只读渲染 | `plugin-host/types.ts` `gateway/methods/config.ts`(result_schema) `plugin-host/manager.ts`(contributionsFor)；web `gateway/types/protocol.ts` `plugin-contributions.ts` `usePluginContributions.ts` `settings-registry.ts` | 同上 |
| **S4** 插件域写侧 | `plugins.config.set` 方法 + `setPluginConfigValue` 写面 + 装配注入 + client；乐观确认；restartRequired 提示+重载按钮 | `gateway/methods/config.ts` `src/plugin-config.ts` 装配注入点；web `gateway/client.ts` `dialog/SettingRow.tsx` | 同上 |
| **S5** 工作区层级 | config.set additive `scope` 参数；project 写面（setUserConfigValue 的 configPath 选项已支持）；工作区 tab 启用 | `gateway/methods/config.ts` `src/gateway-config-control.ts` `src/ui-settings.ts`；web tab 过滤 | 同上 |
| **S6** 收敛 | DISPLAY_SETTINGS 派生；旧页组件删除；palette 设置键检索；i18n 清理；docs 同步（WEB-UI.md / specs 定稿） | `state/display-settings.ts` 旧 settings 组件删除 `palette-items.ts` i18n docs | 同上 + doc-sync 复核 |

- 依赖：S3/S4 是 q-kanban / q-skills 设置域**可编辑**的前置；其 manifest 声明（additive）可先行合入。
- 宪法约束：零测试/探针/临时进程；每切片仅 `bun run build` 门禁；不碰主 checkout；只提交实施分支。
- 每切片独立 commit + 独立可回退；S1 合入即满足裁定①⑤，S2 满足③④，S3/S4 满足②。

## 9. 风险与开放问题

### 9.1 风险表

| # | 风险 | 缓解 |
|---|------|------|
| R1 | 移动端弹窗空间不足 | compact 单列 + 分类 chips + 全屏 sheet（§3.2） |
| R2 | compact 下左栏是抽屉，gateway 状态不再常驻可见 | 用户裁定不重复；断连有 StaleNotice/MessageBar 全局兜底 + AccountMenu 节点信息 |
| R3 | ui.language 服务端/本地双写分裂 | 单写者规则：config.set 成功 → setLocale；LanguageToggle 与设置项共用该路径 |
| R4 | child 插件改配置不热生效 | restartRequired 显式提示 + 重载按钮；不谎报热应用（§4.5） |
| R5 | 可写键白名单三层漂移（serve/asm/web） | 注册表 = Web 单一事实源；服务端白名单仍是权威；新增键必须同改 serve methods/config.ts + src/ui-settings.ts（同步义务写入 specs） |
| R6 | 插件多时搜索卡顿 | 每插件 ≤64 项上限 + memo 索引 + 150ms 防抖 |
| R7 | 深链聚焦时数据未就绪 | focusKey 入 store 队列，config/plugins 就绪后 scrollIntoView + 高亮衰减 |
| R8 | config.set 无 delete，重置≠VSCode 移除覆盖 | v1 重置=写默认值（文档明示差异）；config.unset 列二期（Q4） |
| R9 | 旧 gateway 无 settings 透传/写 RPC | additive 降级：域不渲染 / 只读+原因文案（同 toolbar 先例） |
| R10 | 主题唯一写者 invariant（0.52）被破坏 | local writer 只转调 storeTheme，绝不直接写 DOM/localStorage |
| R11 | 设计实验室嵌套全屏时两层 useModalA11y 都监听 document Esc，可能一次关两层 | 嵌套层 Esc 事件 stopPropagation + 焦点圈只扫最上层容器；实施 S2 时以静态渲染断言覆盖 |
| R12 | 弹窗打开态入路由后，浏览器后退语义变化 | 后退 = 关弹窗（replace 回 chat），与命令面板/抽屉的 overlay 路由先例一致 |

### 9.2 开放问题（main 裁决）

- **Q1** 左栏 settings 分组整体移除（含 settings 导航点）：按裁定⑤「入口移到右上角」执行，
  移动端保留 More→设置。若 main 认为桌面左栏仍需保留一个设置点，S1 只删 visual/designLab 两点。
- **Q2** 工作区 tab 分期（S5）：契约现在设计完整，实现后置；若要求 v1 全量，S5 提前到 S2 之后。
- **Q3** child 插件运行中 settings 推送通道（child 协议新增通知）：二期；v1 显式重载。
- **Q4** `config.unset`（移除覆盖键，VSCode 完整语义）：二期；v1 重置=写默认值。

## 10. 与 q-kanban / q-skills 协同

### 10.1 边界（谁做什么）

- **q-settings（本设计）**：设置弹窗 UI、搜索、注册表、`plugins.config.set` 写路径、
  contributions.settings 透传与归一化。即「设置域的基础设施」。
- **q-kanban / q-skills**：只在各自 manifest 声明 `contributes.settings` + 私有 i18n 字典，
  并在插件代码里消费自己的 config（in-process 走 install config；child 走 VESSEL_PLUGIN_CONFIG）。
  **不自建设置 UI**——声明即出现在设置弹窗「扩展」组，可检索可编辑（S3/S4 合入后）。

### 10.2 q-kanban 声明示例（对齐其任务书「路径设置」）

```jsonc
// plugins/…/kanban/package.json → vessel.contributes
{
  "settings": {
    "board_path": {
      "type": "string",
      "titleKey": "kanban.settings.boardPath",
      "descriptionKey": "kanban.settings.boardPath.desc",
      "default": "docs/dev/kanban/board.json",
      "keywords": ["kanban", "看板", "board", "任务"]
    }
  },
  "i18n": {
    "zh-CN": {
      "kanban.settings.boardPath": "看板文件路径",
      "kanban.settings.boardPath.desc": "board.json 的仓库相对路径；文件由 main 维护，插件只读展示。"
    },
    "en": { "kanban.settings.boardPath": "Board file path", "kanban.settings.boardPath.desc": "Repo-relative path of board.json; maintained by main, plugin renders read-only." }
  }
}
```

- board.json 只读弹窗展示不变（main 维护）；board_path 设置只决定「读哪个文件」。
- S4 合入前，board_path 仍可经 vessel.yaml `plugins[].config` 手改（现有 filterSettings 路径），
  声明先行合入零回归（旧 Web 忽略 settings 字段）。

### 10.3 q-skills 声明示例（键名以 q-skills 设计为准，此处只约束形状）

```jsonc
{
  "settings": {
    "skills_dirs": { "type": "array", "titleKey": "skills.settings.dirs",
                     "descriptionKey": "skills.settings.dirs.desc" },
    "auto_load":   { "type": "boolean", "default": true,
                     "titleKey": "skills.settings.autoLoad" }
  }
}
```

- array 型 v1 只读 JSON 展示（§3.5）：q-skills 若需可编辑目录列表，用「多个 string 键」或
  等二期 object/array 编辑；**不要**为绕过只读而私设 UI。
- i18n key 命名约定：`<pluginId>.settings.<key>[.desc]`；字典只 en / zh-CN（E9 规则）。

### 10.4 时序

1. q-kanban / q-skills 的 manifest 声明 + 插件消费逻辑：随时可合（additive，不依赖本设计实施）。
2. q-settings S3（读侧）合入 → 设置弹窗出现其设置域（只读）。
3. q-settings S4（写侧）合入 → 可编辑 + 重载生效提示。
4. 三方文档互指：本文件 §4 为契约权威；q-kanban / q-skills 设计文档引用本节，不复制契约正文。