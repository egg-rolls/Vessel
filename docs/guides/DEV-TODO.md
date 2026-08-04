# 开发者 — 执行清单

> 你的角色：开发者。按序执行，不跳步。
> 详细规则见 [DEVELOPER.md](DEVELOPER.md) + [collaboration.md](../../processes/collaboration.md)。

1. 读 [AGENTS.md](../../AGENTS.md) — 项目红线、能力分层、Core 冻结
2. 读 [DEVELOPER.md](DEVELOPER.md) + [collaboration.md](../../processes/collaboration.md) — 硬规则、PR 模板、DoD、worktree 流程
3. 认领前检查 — 技术可行性异议（与 Core/ADR 冲突 → Issue 下留言，不编码）+ WIP ≤ 2（超 2 个活跃任务 → 先完成一个）
4. 认领 Issue — 留言占坑 → `git worktree add ../vessel-issue-<N> -b feat/<slug>` → 独立 `bun install` → 开 Draft PR
5. 开发 — 硬规则：`as` ≤ 3/函数 ≤ 50 行/else-if ≤ 5 分支/模式重复 ≤ 3。违反任一 → reviewer 必问
6. 自测 + PR — `bun run lint && bun run typecheck && bun test` 全绿 → PR body 四段（改动摘要/验证方式/关联 Issue/涉及文件）→ DoD 七条全满足 → diff ≤ 500 行
7. 审查 + 合并 — 至少 1 人审批 → CI 全绿 → 无冲突 → 合并后清理 worktree

全部步骤完成后，任务结束。
