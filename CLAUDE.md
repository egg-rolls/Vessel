# CLAUDE.md — 任务启动器

> **停。不要处理用户请求。先建 TodoList。**

## 你需要做的事情

看到这份文件后，你的第一个动作是用 TodoList 工具构建任务清单。最后一项才是用户请求。

### TodoList 模板

```
1. 读 [AGENTS.md](AGENTS.md) — 了解 Vessel 是什么、架构约束、红线
2. 判断角色：用户的请求属于哪种场景？
3. 读角色文档：
   - 写/改代码 → [docs/guides/DEVELOPER.md](docs/guides/DEVELOPER.md)
   - 审查/合并 → [docs/guides/REVIEWER.md](docs/guides/REVIEWER.md)
   - 修改文档 → [docs/guides/DOC-MANAGER.md](docs/guides/DOC-MANAGER.md)
4. 检查分支：`git branch --show-current`
5. 按角色文档的必读清单读取场景相关文档
6. 执行用户任务
```

**用户的任务**放在最后一项。完成前 5 项后才开始处理用户请求。

## 场景调度

| 你的任务 | 第一步 |
|---------|--------|
| 写/改代码 | 先读 [`docs/guides/DEVELOPER.md`](docs/guides/DEVELOPER.md) |
| 审查 PR / 合并 | 先读 [`docs/guides/REVIEWER.md`](docs/guides/REVIEWER.md) |
| 修改文档 | 先读 [`docs/guides/DOC-MANAGER.md`](docs/guides/DOC-MANAGER.md) |
| 涉及 core 包 | 先读 [AGENTS.md](AGENTS.md) §5 Core 冻结 |
| 不确定能力放哪层 | 先读 [AGENTS.md](AGENTS.md) §6 能力分层 |

## 操作前硬自检（每次动手前，10 秒机械检查）

```
[ ] 分支对吗？—— git branch --show-current
[ ] 角色文档读了吗？—— 对照上方场景调度表
[ ] 任务范围明确吗？—— 一句话说清改什么文件、改什么、为什么
```

花 10 秒省 20 分钟返工。
