# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**0.25.0（2026-10-24）** — 开发中，未 tag、未 publish。版本号以根 `package.json` 为唯一来源。

## 已合入

- **单一 RPC 契约**：canonical `agents.create` / `agents.update` / `agents.close`
  与 `teams.create` / `teams.update` / `teams.archive` 统一为批量契约，方法表 54。
- **Web 易用性**：Agents → Teams → Nodes 编排顺序、Hub / Gateway 状态页、
  对象页 CRUD、列表搜索与语言切换。
- **节点显示名**：`node.json` 的 `name` additive 暴露；`node_id` 仍是唯一寻址键。
- **默认能力开启**：`agent` / `durable` / `evals` / `federation` / `hub.autoStart`
  默认 true，均可显式 `false` 关闭。
- **本地 hub**：gateway 在 `<dataDir>/hub` 启动同进程目录服务，只监听回环。

## 下一步

- owner 端点收口到与 canonical `agents.*` 相同的契约；远程 agent 生命周期仍未开放。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 当前版本变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)
- 管理规则：[../DOC-MANAGEMENT.md](../DOC-MANAGEMENT.md)
