# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**0.29.0（2026-10-30）** — 未 tag、未 publish。版本号以根 `package.json` 为唯一来源；
manifest 与 `CHANGELOG.md` 一致。

## 已合入

- **prompt cache 计量**：`prompt_tokens` 在所有 provider 上统一为「含缓存的全部输入」
  （U1）。`UsageStats`、事件、session、checkpoint 与 resume 都带
  `cacheReadTokens` / `cacheCreationTokens`；provider 不报告缓存时字段**缺省**而非 0。
- **命中率**：`MetricsSnapshot.llm` 聚合两个缓存计数；Web Observe 与 TUI `/status`、
  run 收尾提示显示「输入占比」与「前缀健康度」两个口径。比率是展示层派生量，不进快照。
- **压缩判断用真实输入规模**：修掉「缓存开启后 `prompt_tokens` 只剩残差、压缩永不触发」
  的缺陷。`token_count` 是已发布字段，其值随之变化。
- **Team 即工作区**：打开目录即得到对应 Team；新会话建临时 agent（不是给 `main` 加 body），
  闲置回收但会话可复活。三入口（本地 TUI / `--connect` / Web）同走 `runs.start → admit`。
- **`AgentRole = 'member' | 'temporary'`**：`single` 已删除，`main` 是普通成员；
  一个 agent 恰好一具 live body（rotate 窗口内允许两具）。
- **寻址**：1 段本机 agent / 2 段本机 Team / 3 段跨节点；来源行是可回信的
  `<from location="principal@node:team" />`。`human` / `system` 是保留 principal。
- **飞书渠道**：晚绑定 `AgentService`，成员名合法化，TTL 回收后下一条消息自动复活。
- **门禁**：`typecheck` + `biome ci` + `scripts/check-*.ts`；仓库无自动化测试套件，
  运行时正确性靠探针与 `VESSEL_MOCK=1 bun run src/cli.ts --run "hello"`。

## 下一步

- rotate 的 Web UI；远程 agent 生命周期（跨节点 spawn / close / rotate）仍未开放。
- hub ↔ federation 身份联动挂起（`PLAN-0.28-hub-federation-identity.md`）。
- 计费与价格表：ADR-005 禁止内置价格，若要做需用户提供价格表（插件或 `pricing:` 配置块）。
- `token` 限额与会话预算的底层口径随 U1 自然变化，但没有单独设计。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 当前版本变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)
- 管理规则：[../DOC-MANAGEMENT.md](../DOC-MANAGEMENT.md)
