# 迁移指南（sqlite / file-v1 → file-v2）

> 适用版本：0.5+。维护者：`gov`。
> 迁移命令默认 dry-run；源只读；`--apply` 才写。检测到 legacy 数据时只提示，
> **不自动迁移**。架构事实见 [0.5.0](../versions/0.5.0.md) 与
> [ADR-046](../adr/ADR-046-file-first-storage.md)。

## 1. 支持的方向

| 源 | 目标 | 说明 |
|---|---|---|
| `sqlite` | `file-v2` | 旧 `sessions.db` / 显式 sqlite 后端 |
| `file-v1` | `file-v2` | 旧 `sessions/` + `runs/` 目录布局 |

`file-v2` 即 0.5 的根布局（0.49 T5 起只支持 `<dataDir>/**`）：

```text
<dataDir>/
  sessions/<session_id>.json
  runs/<run_id>.json
  events/<run_id>.jsonl
  tenant.json                  # 可选：持久化单 id；fresh dataDir 不创建
```

迁移只搬运 session 快照与 run checkpoint；**不迁移旧的 trace/事件**（旧版本没有统一 trace 格式）。需要保留的证据请在迁移前自行备份。

> 0.49 T5 已删除 tenant 布局层：本命令只做 0.5 存储格式迁移（`sqlite|file-v1 → file-v2`），不是 tenant 布局迁移。`<dataDir>/tenants/**` 非空或存在非空 `.t2-migrating-*` 时，任何入口启动即 fail-fast（`non_root_layout`，错误含路径 / 条目数 / 字节数）；本命令不读、不迁、不移、不删这些数据，需先自行归档。

## 2. 命令

```bash
# 预览（默认 dry-run）
vessel migrate --from sqlite --to file-v2

# 真正写入
vessel migrate --from sqlite --to file-v2 --apply

# 指定源路径
vessel migrate --from file-v1 --to file-v2 \
  --source /path/to/old/sessions --apply

# 机器可读
vessel migrate --from sqlite --to file-v2 --json
```

| 参数 | 说明 |
|---|---|
| `--from sqlite\|file-v1` | 必填 |
| `--to file-v2` | 必填；0.5 只支持 `file-v2` |
| `--apply` | 省略时为 dry-run，只统计不写 |
| `--source <path>` | 源路径；缺省见 §3 |
| `--json` | 输出结构化计数 |

退出码：`0` 成功（含 dry-run）；`1` IO/锁/源错误；`2` 用法错误。

## 3. 默认源路径

| 源 | 默认 |
|---|---|
| `sqlite` | 配置 `session.storage_path`（当 `session.backend: sqlite`）否则 `./.vessel/sessions.db` |
| `file-v1` | 配置 `session.storage_path`（当 `session.backend: file`）否则 `./.vessel/sessions`；runs 缺省 `~/.vessel/runs` |

目标 `data_dir` 由配置 / `VESSEL_DATA_DIR` / 缺省 `~/.vessel/data` 解析；数据直接写入该根目录（没有 `tenants/<id>` 层）。

## 4. 行为保证

- **dry-run 默认**：只读源并输出 `found / migrated / skipped / invalid` 计数。
- **源只读**：不创建、修改或删除源文件/源库。
- **写前加锁**：`--apply` 前获取 data-dir 写意图锁（`<dataDir>/.lock`，`src/data-lock.ts`）；锁冲突返回 `data_locked`。
- **dry-run 不加锁**：预览只读、不创建锁文件。
- **幂等**：目标已存在同 `session_id` / `run_id` → `skipped`，不覆盖。
- **保留字段**：`started_at` / `updated_at` / `status` / `messages` / `usage`。
- **无 tenant_id 输出**：`--json` 的 `MigrateResult` 不含 `tenant_id`；SQLite / session schema 列仍保留（defer-3，不随本命令改写）。
- **原子写**：目标文件走 core `atomicWrite`（temp + rename）。

## 5. 推荐流程

1. **备份**源数据；确认磁盘空间足够（文件后端会复制数据）。
2. `vessel config path` 确认 `data_dir` 是根布局位置。
3. 跑一次 dry-run，核对 `found` 与 `invalid`；`invalid` 非 0 时先看源数据是否损坏。
4. `--apply` 写入；记录输出计数。
5. **回读验证**：
   - TUI 会话列表确认 session 可见；
   - 对关键 run 执行 `runs.get` 或 resume，确认消息与状态完整。
6. 确认无误后再考虑停用旧目录；**不要**在验证前删除源。

## 6. 旧目录与 sqlite

- `./.vessel/sessions.db`、`./.vessel/sessions/`、`~/.vessel/runs` 不会被自动删除。
- 检测到 legacy 数据时，CLI 只提示执行 `vessel migrate`；不会静默切换。
- 显式 `session.backend: sqlite` 继续可用，不强制迁移。
- 0.5 缺省 `session.backend: file`、`durable.path = <dataDir>/runs`；新数据直接写根布局。
- **旧 tenant 树不迁移**：`<dataDir>/tenants/**` 非空会 fail-fast（`non_root_layout`）；0.49 不提供 tenant → 根布局的自动迁移命令，需先归档或自行搬运。

## 7. 回滚

迁移不会修改源，所以回滚主要是把配置切回旧后端：

```yaml
session:
  backend: sqlite
  storage_path: /path/to/sessions.db
```

或对 file-v1 指回旧目录。目标根目录可以保留；若要清理，先确认没有新数据写入（停止 gateway、释放 data-dir 写锁），再手工删除。迁移命令本身不提供 `--purge`。

## 8. 常见问题

| 现象 | 处理 |
|---|---|
| `source_not_found` | 用 `--source` 指向真实路径；确认 `session.storage_path` |
| `invalid_source` | 源不是预期的 sqlite 表/file-v1 布局；先备份并用 dry-run 查看计数 |
| `data_locked` | 停止占用该 dataDir 的写意图进程，或改用 `--connect` 路径；不要删除活跃锁 |
| `non_root_layout` | 存在非空 `tenants/**` 或 `.t2-migrating-*`；先归档旧数据，再在根布局启动 |
| `invalid` > 0 | 单条记录 JSON/字段损坏；源保持只读，修好源后重跑（幂等） |
| 迁移后列表为空 | 检查 `data_dir` 是否为根布局位置；确认目标目录下 `sessions/` / `runs/` |
