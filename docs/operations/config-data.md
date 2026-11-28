---
title: 数据目录、锁与 prune
kind: current
triggers: [data_dir, 数据目录, 写锁, data_locked, session_locked, run_locked, non_root_layout, lease, 租约, prune, auto_prune, 自动回收, dry-run, older-than, 归档, closed, 根布局]
paths: [src/data/data-lock.ts, src/data/prune-wiring.ts, src/data/auto-prune.ts, src/cli/commands/prune-command.ts, src/session/session-lock.ts, src/session/session-lock-runtime.ts]
---

# 数据目录、锁与 prune

> 数据根 / 写锁 / 租约 / 回收的运维手册。根布局与单公司模型见
> [architecture/config.md](../architecture/config.md#config-model)；决策见 ADR-086 / ADR-098。

## 根布局与写意图锁

- 数据直接位于 `<dataDir>/{sessions,runs,events,agents,conversations,teams}/`，没有 `tenants/<id>` 层。
  非空 `<dataDir>/tenants/**` 或 `.t2-migrating-*` → 启动 fail-fast `non_root_layout`（不移动不删除数据）。
- `<dataDir>/tenant.json` 的 `tenant_id` 是唯一持久单 id（缺省 `default`，匹配
  `^[a-z0-9][a-z0-9_-]{0,63}$`）；fresh dataDir 不落盘；损坏/非法 → fail-fast 不静默回退。
- **写意图锁**（`data-lock.ts`）：exclusive `<dataDir>/.lock`，shared `<dataDir>/.members/<pid>-<nonce>.json`；
  锁文件 `{ pid, started_at, host }`；冲突返回 `data_locked`。stale：死 pid、不可解析超 5s、
  跨主机超 24h 自动回收；回收持 `<lock>.reclaim` 守卫（超 10s 可清理）。
- **谁取锁**：只有写意图命令（`migrate --apply`、`trace prune`、`prune --yes`、`eval`、bootstrap 的
  trace prune / session 删除、auto-prune 真删趟）。`--run` / REPL / gateway 启动**不取**写者锁；
  同一 dataDir 第二进程仍可启动（已知限制）。
- **session / run 写锁**：`<dataDir>/.locks/sessions/<sha16(session_id)>.lock` 与
  `.locks/runs/<sha16(run_id)>.lock`（0600）。第二写者得 `conflict`（前缀 `session_locked:` /
  `run_locked:`）；同进程重复获取按引用计数消化。
- **interactions 按实例隔离**：default `<dataDir>/interactions-<id>.json`；命名实例
  `<dataDir>/instances/<instance>/interactions-<id>.json`（见 [config-permission](config-permission.md)）。

## 两级租约（`lease`）

```yaml
lease: { ttl_ms: 30000, renew_ms: 10000 }
```

约束：`ttlMs > renewMs`、`renewMs >= 1000`、`ttlMs >= renewMs + 1000`（正整数毫秒，违反报带键名错误）。
租约文件在 `<dataDir>/.locks/leases/**`；**仅单节点本地**，不做集群共识，不可当分布式锁；
跨节点迁移/接管靠 TTL 过期 + fencing token。续租间隔不超过最近租约剩余 TTL 的 1/3。

## `vessel prune`（状态判据，缺省 dry-run）

```bash
vessel prune [--older-than <dur>] [--dry-run] [--json] [--yes]
```

- 目标集合 = 已归档 team（`archived_at` 非空）下所有 agent ∪ 已停用（`state == 'closed'`）agent。
  **没有归档、没有停用的一律不删**。对每个目标删全部会话（级联：会话壳、事件目录、run 记录与
  jsonl、历史 jsonl）、inbox 与快照记录；归档 team 在 agent 全清完后整目录删掉。
- 输出按五类汇总（team / agent / session / run / trace）；`--json` 同结构。**缺省 dry-run** 只报告
  条数与体积；必须 `--yes` 才真删（`--dry-run` 优先，两个都给也不删）。真删先取 data-dir 写意图锁
  （gateway/node 在跑时直接拒绝，不重试不降级不 partial）；dry-run 与真删读同一份计划。
  `session.backend=sqlite` 时 dry-run 用**只读连接**枚举会话（不建库/表/列）；库不存在或
  不可读时退回保守语义：枚举不出会话 ⇒ 目标 agent 一律留，报告带 note。
- `--older-than <n><ms|s|m|h|d>`（裸数字按天）是**可选叠加**：只清「归档/停用时刻早于阈值」的对象
  （不是会话最后活动时间）；查不到时刻的默认不清。
- 守卫：会话仍有活写者（写锁/租约 live 或不可解析）或还有 running/interrupted 可 resume 的 run
  时不删，连带 agent 记录也留。trace 桶是容量策略（`trace.retention_days` / `max_runs` / `max_bytes`），
  与状态判据正交，是「未归档一律不删」的唯一例外（级联删的 trace 记 `cascade_files`）。
  **不清 conversations / budget 记录**（维度是 conversation_id，反推归属会引入猜测）。

## `auto_prune`（定时自动回收，缺省开）

```yaml
auto_prune:
  enabled: true          # 显式 false 才关
  interval_hours: 24     # 调度间隔；夹取 [1, 168]
  older_than_hours: 168  # 时间叠加（7d，保住 reinstate 复活窗口）；0 = 纯状态判据
  dry_run: false         # true = 永久只报不删；启动后第一趟无论如何都是 dry-run
```

- 判据与删除核心**完全复用** `pruneTenantData`（与 CLI 同源）；调度器只做调度
  （`auto-prune.ts`，复刻 blob GC 形态：首趟 dry-run / unref / in-flight 不叠加 / runOnce / stop）。
- **live resolver**：四键每趟求值活生效；定时器自重排链，热应用同时 `reschedule()` 立即按新
  interval 重排挂起定时器（见 [config-reload](config-reload.md)）。enabled=false 只跳过趟、链不断。
- 锁纪律：真删趟持短程 exclusive data-lock，拿不到 = 本趟跳过（`skipped_pass`）；dry-run 趟不加锁。
- **在线模式经活 registry**（`OnlinePrunePort`）：gateway 存活时 agent 记录摘除走 service
  （registry.remove + flushSnapshot），**绝不直接改快照文件**（整份定时重写会复活已删记录）；
  CLI 离线模式不传 online，行为逐字节不变。
- 每趟报告（含跳过/异常）→ 日志 / `gc.agents` 事件 / noticeBus；四键进 `config.set` 白名单
  （`autoPrune.*`）。

## 排查

| 现象 | 处理 |
|---|---|
| `data_locked` | 另一进程持写意图锁；停掉占用进程，不要删活跃锁，或改用 `--connect` |
| `session_locked` / `run_locked`（conflict） | 另一进程正写同一 session/run；锁在 `<dataDir>/.locks/`，stale 规则见上 |
| `non_root_layout` | 先归档旧 `tenants/**` 数据再启动；命令不迁移不删除 |
| `port_in_use` | 换 `--port` / `--instance`，或停掉占用进程（见 [config-gateway](config-gateway.md)） |