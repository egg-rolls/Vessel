---
adr: 46
title: 文件优先存储成为默认后端
status: accepted
date: 2026-10-18
related: [25, 32, 40]
tags: [storage, files, tenancy]
---

## ADR-046：文件优先存储成为默认后端

- **上下文**：0.4 的默认 `session.backend` 是 sqlite；durable run 默认写在 `~/.vessel/runs`。数据库不可直接阅读，也难以按 tenant 分区和审计。0.5 要求默认数据可被人和 AI 直接检查、可原子写、可按 tenant 隔离，同时不能破坏既有 sqlite 用户。
- **决策**：
  1. **默认后端改为文件**：`session.backend` 缺省 `file`；`durable.path` 缺省 `<data_dir>/tenants/<tenant_id>/runs`。显式 `sqlite` 继续可用，不删除、不强制迁移。
  2. **目录布局（冻结）**：`<data_dir>/tenants/<tenant_id>/` 下放 `.lock`、`sessions/<session_id>.json`、`runs/<run_id>.json`、`events/<run_id>.jsonl`、`tenant.json`。`tenant_id` 必须匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`，拒绝路径穿越；缺省 `default`。
  3. **原子写**：session 快照与 run checkpoint 使用同目录 temp + rename；Windows rename 失败重试 3 次。写入失败抛 `AtomicWriteError`，不留半截 JSON。
  4. **单写者**：同一 tenant 目录同一时刻只允许一个进程持有 `.lock`（内容含 pid、started_at、host）。锁存在且非 stale 时返回 `tenant_locked`；stale 判定为 pid 不存在或超过 24 小时。gateway 运行时是唯一写者；CLI/TUI 要么取锁，要么走 gateway RPC（`--connect` 不取锁）。
  5. **事件文件**：`events/<run_id>.jsonl` append-only，一行一个 `RunEvent`；读取时跳过损坏的最后一行，不阻塞前序事件。
  6. **列表边界**：`sessions.list` / `runs.list` 允许 O(N) 目录扫描；0.5 验收上限为单 tenant 5,000 sessions / 20,000 runs，超出应改用 sqlite，不引入需要维护的索引缓存。
  7. **迁移**：`vessel migrate --from sqlite|file-v1 --to file-v2 [--apply] [--tenant <id>]`；默认 dry-run，源只读，`--apply` 才写；以 `session_id` / `run_id` 幂等；保留 `started_at` / `updated_at` / `status` / `messages` / `usage`。检测到 legacy 数据时只提示执行迁移，不自动迁移。
  8. **删除**：`deleteSessionData(sessionId, opts)` 返回 `{ sessions_deleted, runs_deleted, events_deleted }`；该 session 有 `running` / `interrupted` run 时返回 `conflict`，否则删除快照并按 `session_id` 清理对应 `runs/*.json` 与 `events/*.jsonl`。不新增 `SessionBackend` 方法。
- **备选**：(a) 继续默认 sqlite——不可直接审计、tenant 分区成本高；(b) 引入索引缓存/嵌入式 KV——增加维护面，超出 0.5 规模；(c) 自动迁移旧数据——不可逆风险高。均不取。
- **后果**：默认数据可读、可复制、可按 tenant 备份；代价是 O(N) 列表、单写者限制和 Windows rename 重试。0.5 不承诺多进程并发写同一 tenant；跨进程共享 store 的问题留到 0.6 远程方案收敛。sqlite 仍是受支持的后端。
- **关联**：ADR-025（参考实现）、ADR-032（事件回放）、ADR-040（durable run / checkpoint）；DECISION-010 §2.1 / §2.6；Addendum A-4 §11.3 / §11.7。
