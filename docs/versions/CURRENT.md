# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**0.28.0（2026-10-29）** — 未 tag、未 publish。版本号以根 `package.json` 为唯一来源；
manifest 已 bump（19 个 `package.json` + `CHANGELOG.md` 一致）。

## 已合入

- **Team 即工作区**：打开目录即得到对应 Team（workspace 归一化后 slug；非 ASCII basename
  走哈希；撞 slug 加后缀，**绝不合并**）。headless 不与目录绑定，同一 data root 至多一个
  合成 Team。
- **会话即 agent**：Web / TUI 的「新会话」建一个临时 agent 并把首条消息发给它，不再给
  `main` 加 body。三个入口（本地 TUI、`--connect`、Web）走同一条 `runs.start → admit`。
- **`AgentRole = 'member' | 'temporary'`**：`single` 已删除，`main` 是普通成员。
  一个 agent 恰好一具 live body（`body_id ≡ session_id`），rotate 窗口内允许两具。
  快照 v4 读写兼容，存量多 body 取 primary、其余降级进 `body_history`。
- **临时 agent 生命周期**：`agent.temporaryTtlHours`（默认 2h）到期回收 —— 只回收
  `temporary` 且 `present` 的 agent，`member` 永不回收。回收保留 body 记录，复活时
  unretire 并清历史条目，会话接得回来。
- **role 感知上下文策略**：临时 agent 不自动压缩，到线提示用户换会话；自动压缩关闭时
  压力提示取消 0.9 上界（否则提示会永久静默）。两道硬兜底仍生效。策略可在活体上热切换。
- **准入统一**：所有 agent（含 `main`）只经 `AgentService.admit`；`run.*` 是唯一执行
  生命周期；三套并行事实（`RunEngine`、`RuntimeHost`、owner/member 二分）已删除。
- **寻址**：1 段本机 agent / 2 段本机 Team / 3 段跨节点；来源行是可回信的
  `<from location="principal@node:team" />`。`human` / `system` 是保留 principal，
  不能当成员名或 id。
- **飞书渠道**：晚绑定 `AgentService`（渠道先于 wiring 构造），成员名合法化，
  TTL 回收后下一条消息自动复活。
- **门禁**：`typecheck` + `biome ci` + `scripts/check-*.ts`；仓库无自动化测试套件，
  运行时正确性靠 `VESSEL_MOCK=1 bun run src/cli.ts --run "hello"`。

## 下一步

- rotate 的 Web UI；远程 agent 生命周期（跨节点 spawn / close / rotate）仍未开放。
- hub ↔ federation 身份联动挂起（`PLAN-0.28-hub-federation-identity.md`）。
- `--serve` 多 tenant 的渠道启动未接线（当前不启动，无行为变化）。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 当前版本变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)
- 管理规则：[../DOC-MANAGEMENT.md](../DOC-MANAGEMENT.md)
