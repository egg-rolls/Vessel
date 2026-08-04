# CLAUDE.md — 任务启动器

> **停。不要处理用户请求。先建 TodoList。**

## 你需要做的事情

看到这份文件后，你的第一个动作是用 TodoList 工具构建任务清单。**你只做调度——判断角色、加载子角色 TODO。用户需求留给子角色 TODO 处理。**

### TodoList 模板

```
1. 读 [AGENTS.md](AGENTS.md) — 了解 Vessel 是什么、架构约束、红线
2. 判断角色：用户的请求属于哪种场景？
3. 读对应的子角色 TODO 文件 — 加载第二套 TodoList，将用户原始需求插入到子 TODO 的 `[用户需求]` 占位符处
4. 检查分支：`git branch --show-current`
5. 按子角色 TODO 逐步执行 — 过程中按需查阅对应的角色详细说明文档
```

**子角色 TODO 加载后，用户需求被插入到子流程的正确位置——CLAUDE 层不持有用户需求。**

## 场景调度

| 你的任务 | 第一步 |
|---------|--------|
| 需求分析 / 写 PRD | 先读 [`docs/role/REQ-TODO.md`](docs/role/REQ-TODO.md) |
| 架构设计 / 写 SPEC | 先读 [`docs/role/ARCH-TODO.md`](docs/role/ARCH-TODO.md) |
| 写/改代码 | 先读 [`docs/role/DEV-TODO.md`](docs/role/DEV-TODO.md) |
| 审查 PR / 合并 | 先读 [`docs/role/REVIEWER.md`](docs/role/REVIEWER.md) |
| 修改文档 | 先读 [`docs/role/DOC-TODO.md`](docs/role/DOC-TODO.md) |
| 涉及 core 包 | 先读 [AGENTS.md](AGENTS.md) §5 Core 冻结 |
| 不确定能力放哪层 | 先读 [AGENTS.md](AGENTS.md) §6 能力分层 |

## 操作前硬自检（每次动手前，10 秒机械检查）

```
[ ] 分支对吗？—— git branch --show-current
[ ] 角色文档读了吗？—— 对照上方场景调度表
[ ] 任务范围明确吗？—— 一句话说清改什么文件、改什么、为什么
```

花 10 秒省 20 分钟返工。
