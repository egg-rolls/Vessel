# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**0.32.0（2026-10-31）** — 未 tag、未 publish。版本号以根 `package.json` 为唯一来源；
manifest 与 `CHANGELOG.md` 一致。

## 已合入

- **持久化收件箱**：按 `agent_id` 存储，`atomicWrite`/单写者，上限可配置
  `agent.inbox_max_messages`（默认 200）；消息有稳定 id、summary、important。
- **模型驱动读取**：`inbox` 工具 `list` / `read`；模型自己决定条数与 id，不自动注入正文；
  未读只发一条 notice，新消息到达才再提示。
- **rotate 顺序**：启动嘱托 → 旧队列 → rotate 期间新入队；写前日志；retire 清理旧 pending
  notice / 权限请求 / hook，避免串味。
- **紧急打断**：`agents.send` 可选 `{interrupt, message_id, important}`，取消当前 run
  （reason `interrupt`）并优先投递指定 inbox 消息；只读 `vessel agent inbox` 与
  `vessel agent send --interrupt` CLI。
- **压缩可恢复**：压缩应用后发 `message.compaction`，缓存丢失可从事件日志重建摘要与历史。
- **可观测**：TUI / Web 把 pressure / compacted / rotating / rotated 渲染为 notice；
  `agents.tree` 输出真实 `context_used`（`context_max` 仅在 pressure 后填）。
- **去重与可见性**：member limit warning 只投一次；startup/delivery/inbox 失败发开放事件。
- **门禁**：零测试文件；一次性探针 + typecheck / biome / web tsc / web build / mock smoke。

## 下一步

- 0.32 已收口；下一轮候选：
  - headless ask 异步队列（建议单独开「人类通道」周期）。
  - 压缩前清旧工具输出、结构化摘要模板（行业做法，未纳入本周期）。
  - 剩余 536–550 行 Web 文件、诊断页 `doctor --deep` 覆盖、计费价格表等顺延项。
- 已知边界：读取即 consumed（at-most-once，失败不回滚）；rotate 窗口合成 run_id 不可查；
  `inbox` 工具恒 allow；打断期间 rotate 被拒绝；`important` 只做标记。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 当前版本变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)
