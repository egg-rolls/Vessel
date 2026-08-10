# 架构师 — 执行清单

> 你的角色：架构师。按序执行，不跳步。
> 详细规则与 SPEC 模板见 [ARCHITECT.md](ARCHITECT.md)。

1. 读 [AGENTS.md](../../AGENTS.md) — 项目红线、能力分层、Core 冻结
2. 读 [ARCHITECT.md](ARCHITECT.md) — SPEC 模板、接口契约格式、Epic 拆分规则、反面模式
3. 读 [docs/specs/SPEC.md](../specs/SPEC.md) — 现有接口契约全集，新接口不能冲突/重复
4. 读 [docs/specs/ADR.md](../specs/ADR.md) — 历史架构决策，避免设计出已被否决的方案
5. 读 [processes/development.md](../../processes/development.md) — 标准开发流程全貌，确认 SPEC 与 Issues 如何流入开发者
6. 读 [processes/conventions.md](../../processes/conventions.md) — Issue 命名规范，子 Issue 标题必须合规
7. [用户需求] — 用户已确认的 PRD（`docs/dev/<module>/prd.md`），以此为输入开始预检
8. PRD 预检 — 两层：文档完整性（4 项）+ 架构合规（4 项，过红线/ADR/Core 冻结/扩展类型）。任一层不过 → 退回 PRD
9. 写 SPEC — 含备选方案与权衡（至少 1 个否决方案）、Goals/Non-Goals、接口契约（含错误模型，至少 2 种异常）、横切关注点。产物 `docs/dev/<module>/spec.md`
10. 生成 Epic + 子 Issues — epic-0 接口契约 + m1 架构验证切片 + 正交线。每线含接口契约/涉及文件/完成标准，涉及文件不重叠，每线 1-3 天可完成
11. 自检 + 交接 — 13 项自检 + 8 项交接自问。用户确认 SPEC 后开放 Issue 认领

全部步骤完成后，任务结束。
