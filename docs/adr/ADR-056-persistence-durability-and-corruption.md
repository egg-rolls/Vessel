---
adr: 56
title: 持久化耐久性与损坏检测
status: accepted
date: 2026-10-19
related: [40, 46, 49]
tags: [storage, durability, corruption, files]
---

## ADR-056：持久化耐久性与损坏检测

- **上下文**：0.5 起 session 快照与 run checkpoint 采用“同目录 temp + rename”原子写，但 temp 文件在 rename 前从未 fsync；机器掉电时可能留下“目标文件存在但内容未落盘”的状态。另一方面，读取路径把“文件存在但不可读 / JSON 损坏”与“文件不存在”混为一谈：`FileSessionBackend.load()` 静默返回 `null`，下一次 save 会覆盖原文件；tenant 模式下的 `FileRunStore.delete()` 也可能把损坏文件当成可删除。`deleteSessionData` 的冲突检查只取第一页（200 条），超过一页的 `running` / `interrupted` run 可能被漏判，随后被删除。

- **决策**：
  1. **`atomicWrite` 默认 durable**。新增 `AtomicWriteOptions.durable`（缺省 `true`）：temp 文件以 `open` + `writeFile` + `fsync` 写入，关闭后再 `rename`，最后尽力 `fsync` 父目录。文件 fsync 或关闭失败 → 清理 temp 并抛 `AtomicWriteError`，**绝不 rename**；目录 fsync 在 Windows 等平台常不可用（`EPERM` / `EISDIR` / `EBADF`），失败一律忽略。`durable: false` 保留 0.5 的旧行为，供临时文件与测试使用。
  2. **Session 损坏检测**。`FileSessionBackend.load()` 只在主路径 `ENOENT` 时才尝试 legacy 路径；文件存在但读取失败（非 ENOENT）或 JSON 解析失败 → 抛 `SessionCorruptError`（`code: 'session_corrupt'`，带 `path` 与 `cause`）。主路径存在（包括属于其它 tenant）即不再回退 legacy。
  3. **损坏文件不可被静默删除**。`FileSessionBackend.delete()` 一律先 `load()`：文件不存在或属于其它 tenant → no-op；损坏 → `SessionCorruptError` 向上传播，**不 unlink**。tenant 模式的 `FileRunStore.load()` 同样把非 ENOENT 读取错误、JSON 解析失败与非法 checkpoint 形状视为损坏并抛错；`delete()` 不再吞掉该错误。非 tenant 的 `FileRunStore` 保持 0.3 的宽松语义（损坏 → `null`）。
  4. **列表降级**。`FileSessionBackend.listRich()` 逐个加载，单个文件抛 `SessionCorruptError` 时只跳过该项并继续，不让整张列表失败；直接 `load()` 仍然抛错，保证损坏文件不会被后续 save 覆盖。
  5. **删除冲突检查全量分页**。`deleteSessionData` 以 `limit: 200`、`offset` 递增遍历该 session 的全部 run（页数上限 10,000），收集所有 `running` / `interrupted` 后才决定是否抛 `SessionDeleteConflictError`。为此 `RunStore.list` 增加可选 `offset`（缺省 0，作用于排序、过滤之后的切片）；`limit` 语义不变。
  6. **兼容性**：`RunStore` 接口只增加可选参数；`MemoryRunStore` / `FileRunStore` / SQLite 实现保持签名兼容。新增的 `SessionCorruptError` 从根入口与 `@vessel/core/session` 导出。默认 durable 改变的是持久性而非可观察内容；`durable: false` 可精确恢复旧行为。非 tenant 的 run 读取语义不变。

- **备选**：(a) 只在调用方显式要求时 fsync——默认路径仍会在掉电时丢数据，且调用方很难判断哪些写需要耐久性；不取。(b) 损坏时返回 `null` 并依赖备份——下一次 save 会覆盖唯一副本，数据恢复窗口被关闭；不取。(c) 删除时先尝试解析，失败则按“不存在”处理——会把归属未知的文件删掉；不取。(d) 冲突检查只查 `running` 状态——`interrupted` 同样可 resume，仍会被删除；不取。

- **后果**：每次 session / checkpoint 写入多一次文件 fsync（目录 fsync 在 Windows 上通常被跳过），写入延迟上升、掉电后的可见性更可控。损坏从“静默丢失”变为“显式错误”：`load` / `delete` 的调用方需要处理 `SessionCorruptError`，列表视图则降级跳过。全量分页让删除冲突检查的成本从固定 200 条变为 O(runs)，换掉“活动 run 被漏判后删除”的正确性风险。该加固不提供损坏自动修复、备份或 fsync 失败重试。

- **关联**：ADR-040（durable run / checkpoint）、ADR-046（文件优先存储）、ADR-049（多租户隔离）；`packages/core/src/session/atomic-write.ts`、`file-backend.ts`、`run-store.ts`、`delete-session.ts`、`types/run-store.ts`。
