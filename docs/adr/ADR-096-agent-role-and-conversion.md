---
adr: 96
title: Agent 持久化 role 与临时/成员转换
status: accepted
date: 2026-10-26
related: [88, 91, 95]
---

## ADR-096：Agent 持久化 role 与临时/成员转换

- **上下文**：成员身份此前由 `owner` 隐式推断：`owner===id` 是 root owner、`owner` 缺省是 peer、
  其他 owner 是 contractor。Web/TUI 同时出现“成员 / 外包”，难以区分“roster 成员”与
  “归属类型”；root owner 又容易被误解为“Team 的根”。用户要求：把 root owner 命名为
  single；成员/临时可互转；转换直接生效并在 notice 中告知模型，不要求新 Body。
- **决策**：
  1. **持久化 `role: 'single' | 'member' | 'temporary'`**。`owner` 在 v3 总是存在：
     single/member 为 self，temporary 为雇佣者；`parent` 仅 temporary 默认等于 owner。
  2. **快照 v3**：`AGENT_SNAPSHOT_VERSION = 3`；读取兼容 v1/v2。v2 推断：
     `owner===id` → single，`owner` 缺省 → member，其他 owner → temporary；
     single/member 的 owner 补齐为 id。首次写 v3 前备份 `.v2.bak`（v1 保留 `.v1.bak`）。
  3. **创建**：`kind:'peer'` → member，`kind:'contractor'` → temporary；无 kind 的旧请求
     仍按 temporary。`agent` 工具 `create` → member，`hire` → temporary。
  4. **转换**：扩展 canonical `agents.update` 的 `role` / `team_id`。member 需要 Team；
     temporary 的 owner = 转换者；single 清空 Team。human/owner transport 可转任意可见成员；
     team-scoped token 只能转本队，不能转 single 或换 Team。Team 绑定决定 single ↔ member：
     加入 Team 自动变 member，显式转 single 才离开 Team；temporary 绑定 Team 仍是 temporary。
  5. **notice-only**：转换改记录 + roster + snapshot；向成员上下文追加 `vessel:notice`
     （`identity changed: old → new; owner=...; team=...`），不启动 turn、不改 system 前缀、
     不要求 rotate。Self Card 保持冻结。
  6. **UI**：single / 成员 / 临时；Team roster 只显示 member + temporary，member 在前。
- **备选**：(a) 继续用 owner 隐式推断——无法支持 owner=self 的成员与 single 区分，且转换边界
  容易混淆；(b) 转换要求 rotate——用户明确拒绝，且会丢上下文；(c) 转换触发 system revision——
  会让整段提示词缓存失效。均不取。
- **后果**：所有 `owner===undefined` / `owner===id` 判定改为按 `role`；旧二进制不能读 v3，
  只能靠 `.v1.bak` / `.v2.bak` 回滚；team-scoped token 的转换需要在 serve 层做 team 归属校验。
- **关联**：ADR-088（agent 包边界）、ADR-091（Body/presence）、ADR-095（peer/contractor）。

## Errata（0.27 统一 agent/body）

> 2026-10-26，只追加。上文正文保留当时结论；与 0.27 实现不一致处以本条为准，
> 当前模型见 [ADR-097](ADR-097-unified-agent-body-model.md)。

- 快照版本是 **v4**：`AGENT_SNAPSHOT_VERSION = 4`；读取兼容 v1–v3。
- v3 → v4 迁移：`current_body` 变成唯一 live body + primary，旧 `body_history` 迁入 `bodies[]`
  （已退役）；`bodies[]` 是唯一真相，旧字段只作兼容视图，旧数据可读、不回写。
- `role` 语义（`single` / `member` / `temporary`）与 v3 的推断规则不变；本条只改快照版本与 Body
  字段，不改变 role 决策。
