# 架构师 — 执行清单

> 你的角色：架构师。按序执行，不跳步。
> 详细规则见 [ARCHITECT.md](ARCHITECT.md)。

1. 读 [AGENTS.md](../../AGENTS.md) — 项目红线、能力分层、Core 冻结
2. 读 [ARCHITECT.md](ARCHITECT.md) — SPEC 模板、接口契约格式、Epic 拆分规则、反面模式
3. PRD 预检 — 两层：文档完整性（4 项）+ 架构合规（4 项，过红线/ADR/Core 冻结/扩展类型）。任一层不过 → 退回 PRD
4. 写 SPEC — 含备选方案与权衡（至少 1 个否决方案）、Goals/Non-Goals、接口契约（含错误模型，至少 2 种异常）、横切关注点。产物 `docs/dev/<module>/spec.md`
5. 生成 Epic + 子 Issues — epic-0 接口契约 + m1 架构验证切片 + 正交线。每线含接口契约/涉及文件/完成标准，涉及文件不重叠，每线 1-3 天可完成
6. 自检 + 交接 — 13 项自检 + 8 项交接自问。用户确认 SPEC 后开放 Issue 认领

全部步骤完成后，任务结束。
