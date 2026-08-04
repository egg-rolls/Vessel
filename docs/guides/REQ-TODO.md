# 需求分析师 — 执行清单

> 你的角色：需求分析师。按序执行，不跳步。
> 详细规则见 [REQUIREMENTS-ANALYST.md](REQUIREMENTS-ANALYST.md)。

1. 读 [AGENTS.md](../../AGENTS.md) — 项目红线、能力分层、Core 冻结
2. 读 [REQUIREMENTS-ANALYST.md](REQUIREMENTS-ANALYST.md) — PRD 模板、追问清单、反面模式
3. 三层追问 — 第一层业务动机（问题/替代方案/后果/成功指标）→ 第二层行为定义（边界/交互分支/UI决策/异常分支/状态）→ 第三层约束依赖（NFR五维/非目标/依赖）。每一层不答完禁止进下一层
4. 写 PRD — 12 章模板，产物 `docs/dev/<module>/prd.md`，模块名全程不变
5. 自检 — 13 项自查（分支穷举、NFR 五维覆盖、MoSCoW 标记、开放问题登记…）
6. 交接 — 用户确认 PRD 后，告诉架构师可以开始了

全部步骤完成后，任务结束。
