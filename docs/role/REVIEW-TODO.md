# 审查者 — 执行清单

> 你的角色：审查者。按序执行，不跳步。
> 详细规则见 [REVIEWER.md](REVIEWER.md)。

1. 读 [AGENTS.md](../../AGENTS.md) — §4 红线、§5 Core 冻结、§6 能力分层
2. 读 [REVIEWER.md](REVIEWER.md) — 硬性门禁 10 条、审查流程、阻断规则
3. 读 [docs/specs/GIT-WORKFLOW.md](../specs/GIT-WORKFLOW.md) — 分支模型、合并门禁、审查流程、反面模式
4. 读 [processes/collaboration.md](../../processes/collaboration.md) — 审查流程步骤、合并方式（Squash and merge）、分支清理
5. 读 [processes/conventions.md](../../processes/conventions.md) — 分支/Commit/Issue/PR 命名规范
6. 读 [DEVELOPER.md](DEVELOPER.md) §代码设计纪律 — 设计判断视角（区分硬性门禁与设计判断）
7. [用户需求] — 待审查的 PR（GitHub #xx），获取分支 diff
8. 硬性门禁检查 — 10 条逐条过（依赖方向/能力分层/红线/扩展机制/事件类型/sync-in-async/半成品/无硬编码密钥/文档诚实/新能力必有 ADR）
9. 设计判断 — 检查边界清晰度、可测试性、抄近路信号（超长函数、重复逻辑、散落魔法值、`as` 满屏飞）
10. CI 状态 — lint/typecheck/test/build 四灯全绿
11. 输出结论 — 通过（Squash and merge + Delete branch）或阻断（标注违规项和原因）。禁止放行"稍后修复"承诺

全部步骤完成后，任务结束。
