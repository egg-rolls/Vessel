# Processes

> 标准化工作流程文档。与代码/技术文档分离。
> 面向人类贡献者和 AI Agent。

## 目录

| 文件 | 内容 | 给谁看 |
|------|------|--------|
| [development-workflow.md](development-workflow.md) | 标准开发流程（从任务到合并） | 所有人 |
| [review-checklist.md](review-checklist.md) | AI + 人工审查清单 | Reviewer / AI Agent |
| [release-process.md](release-process.md) | 发布流程 | 维护者 |
| [task-assignment.md](task-assignment.md) | 当前任务分工（经常更新） | 团队成员 |

## 与 docs/ 的关系

```
docs/         → 技术文档（WHAT + WHY + HOW）
  specs/      → 项目规格
  guides/     → 开发指南
  api/        → API 参考

processes/    → 工作流程（HOW WE WORK）
  ↑ 与代码分开，不混入技术文档
```

## 更新原则

- `task-assignment.md` 随任务进度持续更新
- 其余文件修改需团队共识
- AI Agent 应阅读本目录全部文件后再执行合并操作
