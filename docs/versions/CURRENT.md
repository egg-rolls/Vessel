# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**0.27.0（2026-10-28）** — 开发中，未 tag、未 publish。版本号以根 `package.json` 为唯一来源；
manifest 已 bump（19 个 `package.json` + `CHANGELOG.md` 一致），未 tag、未 publish。

## 已合入

- **统一 agent/body 模型**（ADR-097）：所有 agent（含 `main`）只经 `AgentService.admit` 准入；
  `body_id ≡ session_id`，一个 agent 可多 body（每 agent ≤ 20 live，空闲 TTL 24h），
  同 body 串行、跨 body 并发；每 body 独立 runtime / context / 历史 / runStore；
  `run.*` 是唯一执行生命周期。三套并行事实（`RunEngine`、`RuntimeHost`、owner/member
  执行二分）已删除。
- **按段数寻址**：1 段本机 agent / 2 段本机 Team / 3 段跨节点；来源行是可回信的
  `<from location="principal@node:team" />`，本机也写满三段。`human` / `system` 是保留
  principal，不能当成员名或 id；人类 principal 与 `main` 已拆开（`defaultOwner` 只表示
  临时成员归属）。
- **蜂群增长**：`create` peer / `hire` contractor，每 Team ≤ 20（`team_full`），
  `teams.spawnFrozen` 冻结增长，成员 close peer 经人类审批；重名复用返回 `reused: true`。
- **canonical RPC 方法表 59**，含 `permissions.setToolPolicy` 与 `teams.spawnFrozen`。
- **Web**：Tailwind L1/L2/L3 分层 + `components/ui` 通用层 + zustand domain stores +
  `check-web-styles` 门禁。
- **文档**：`docs/architecture/` 20 个模块（≤100 行）+ INDEX、`docs/agents/` 7 篇路径告诫、
  `AGENTS.md` 84 行；`check-docs` 与 `docs-find` 是结构门禁。
- **门禁**：`typecheck` + `biome ci` + `scripts/check-*.ts`；仓库无自动化测试套件，
  运行时正确性靠 `VESSEL_MOCK=1 bun run src/cli.ts --run "hello"`。

## 下一步

- rotate 的 Web UI；远程 agent 生命周期（跨节点 spawn / close / rotate）仍未开放。
- hub ↔ federation 身份联动挂起。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 当前版本变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)
- 管理规则：[../DOC-MANAGEMENT.md](../DOC-MANAGEMENT.md)
