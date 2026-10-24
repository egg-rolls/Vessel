# Changelog

> 本文件是 O(1) 当前态：**只保留当前版本的变更摘要**。
> 所有历史版本在 [`docs/versions/`](docs/versions/INDEX.md) 中按版本一文件保存，
> 索引见 [`docs/versions/INDEX.md`](docs/versions/INDEX.md)，当前版本见
> [`docs/versions/CURRENT.md`](docs/versions/CURRENT.md)。
>
> 变更记录遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 0.x 阶段：breaking 变更走 minor，新功能走 minor，修复走 patch。
> 管理规则见 [`docs/DOC-MANAGEMENT.md`](docs/DOC-MANAGEMENT.md)。

## [0.25.0] - 2026-10-24

> 0.25.0（基于 0.24.1，未发布）：Web 易用性重做与单一 RPC 契约。未 tag、未 publish。

### Added

- **canonical `agents.create|update|close`**（51 → **54**）：批量契约
  `{ agents: [...] }` → `{ results: [...] }`，与输入同序、单条失败隔离；
  `create` 拒绝 team-scoped token，`team_id` 只绑定已存在 Team；
  `update` 改名立即生效，`model` / `system_prompt` 从下一具 Body 生效。
- **节点显示名**：`node.json` 增加 `name`（首次取主机名，`host.node_name` 可覆盖），
  `health.get.node.name` additive 暴露，hub 目录透传；`node_id` 仍是唯一寻址键。
- **Web 对象页 CRUD**：Nodes（搜索 / 添加弹窗含终端命令 / 浏览器连接 / 移除警示）、
  Teams（创建弹窗 / 编辑页 / 归档警示 / 搜索）、Agents（创建 / 编辑 / 关闭 / 搜索）。
- **导航与状态**：编排组顺序 Agents → Teams → Nodes；底部 Status 组（Hub、Gateway）
  带状态点与版本；新增 Gateway 状态页；顶栏搜索框左侧语言切换。
- **共享组件文档** `docs/WEB-UI.md` 与统一的列表 / 卡片 / 搜索 / 状态样式。

### Changed

- Hub 页只保留 hub 自身状态与版本；配对 / join 命令与 Web 连接管理移入 Nodes。
- i18n：Agents=智能体、Teams=团队、Nodes=节点、Hub=面板核心、Gateway=网关。
- 节点列表不再展示 UUID（详情最多一处），同名节点显示去重为 `-1` / `-2`。
- Settings 的额外节点连接管理移除（主 gateway 连接仍在 Settings）。
