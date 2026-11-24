# 默认视觉契约（showInternalEvents 缺省 false）

状态：定稿（用户裁决③，设置重构 S1–S6 收尾）。适用：所有舰队（生产 / 金丝雀 / 开发）。
关联：`docs/dev/plans/vscode-settings-design.md`（§7.3 默认值与重置）、
`docs/WEB-UI.md`「设置（VSCode 式弹窗）」章节。

## 契约条款

1. **系统 / 内部消息默认隐藏。** `ui.showInternalEvents`（yaml `ui.show_internal_events`）
   的契约缺省是 `false`——**生产 8642 的默认视觉为基线**：事件流只保留正文、工具调用、
   错误与权限 / ask 卡片；运行提示、hook / LLM 上下文等系统消息（含会话里的 vessel:*
   上下文消息）默认不显示。
2. **各舰队继承此默认。** 舰队配置无需显式声明该键；未配置时消费方按 false 渲染 / 判定。
   缺省值在以下位置 codify（同值同源，改一处必须同步其余）：
   - `packages/config/src/types.ts` `UiConfig.showInternalEvents` 注释（默认 false）；
   - Web 注册表核心键表 `CORE_SETTING_SPECS`（`default:'false'` + `fallback:'false'`，
     `apps/web/src/state/settings-registry.ts`）——`@modified` 判定与恢复默认都以此为基线；
   - 派生兼容层 `DISPLAY_SETTINGS`（`apps/web/src/state/display-settings.ts`）的
     fallback 由注册表反向派生，不另立清单。
   `verbosity=debug` 是额外显示系统消息的诊断例外路径，不改变本键缺省。
3. **金丝雀 `show_internal_events: true` 只是验收临时 override。** 它是验收期为观察
   内部事件而做的显式覆盖（user / project 层），不是契约缺省；验收结束应移除，
   不得据此反推「缺省应为 true」。
4. **设置入口常驻右上角。** AppBar 右上角齿轮（`Ctrl/Cmd+,`）打开设置弹窗；
   `ui.showInternalEvents` 在「常用」curated 视图与「显示与可见性」分类，随时可拨
   （写路径 `config.set`，热应用）。入口不因默认隐藏而移除，也不收进二级菜单。

## 边界与非目标

- 本契约只管显示层可见性的**缺省值**，不改变事件的产生 / 落盘：内部事件照常产生与
  记录，只是默认不渲染。
- `ui.showArchived`（已归档 / 已停用默认隐藏）是同层同写路径的独立键（0.51 裁定），
  其缺省契约不在本文展开。
- 缺省值变更 = 契约变更，须用户裁决；实施侧不得静默翻转 default / fallback。
- 行为验证归用户（宪法：零测试 / 探针）；本文档只声明契约，不引入运行时断言。
