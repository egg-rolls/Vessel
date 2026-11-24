# VSCode 式设置重构设计（q-settings）

- 状态：设计中（骨架 commit，后续增量扩充）
- 分支：`design/q-settings`（纯设计，不改代码）
- 产出：本文件；实施由 main 另行派单
- 协同：q-kanban / q-skills（插件设置域声明方，见 §10）

## 0. 用户裁定（必须贯彻）

| # | 裁定 | 本设计落点 |
|---|------|-----------|
| ① | 设置重构为 VSCode 式**弹窗**设置项（非现样式） | §3 SettingsDialog |
| ② | 设置可检索；插件可自定义设置域（搜索/配置） | §3.3 搜索 + §4 贡献契约 |
| ③ | 左侧菜单栏的「视觉效果」移进设置，作为设置的一部分 | §5 视觉分区 |
| ④ | 设计实验室移到「视觉」分区 | §5.2 view 型设置项 |
| ⑤ | 设置入口移到右上角，替换 gateway 在线图标（gateway 状态左侧栏已有，不重复） | §3.1 入口 |

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

- `ModalShell`（`components/Modal.tsx`）：portal / 焦点圈 / Esc / body 滚动锁 / sm|md|lg 宽度。
- `CommandPalette`（⌘K）+ `palette-items.ts`：已有「查看配置」动作项。
- `shortcuts.ts`：只占用 ⌘K / `/` / Esc → **Ctrl/Cmd+, 空闲**，可作设置快捷键（VSCode 同款）。
- ui 组件：Section / SearchInput / SegmentedTabs / Badge / DataTable / JsonView / ToastProvider。
- 乐观 overlay  store：`uiStore.displayPending`（按 key+值确认清除）。

## 2. 总体架构（待扩充：图 + 注册表 + 三层 scope）

## 3. 设置 UI 设计（待扩充：入口/线框/搜索/分类树/渲染/层级/写路径/深链）

## 4. 插件设置域贡献契约（待扩充：spec/wire/归一化/写 RPC/生效/示例）

## 5. 「视觉」分区（待扩充：吸收视觉效果页 + 设计实验室 + 导航偏好）

## 6. 分区结构（待扩充：完整分类树）

## 7. 存储 / 迁移 / 默认值（待扩充）

## 8. 实施计划（待扩充：切片 S1–S6，文件级）

## 9. 风险与开放问题（待扩充）

## 10. 与 q-kanban / q-skills 协同（待扩充：声明示例 + 边界）