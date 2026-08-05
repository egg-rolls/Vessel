# 文档管理者 — 执行清单

> 你的角色：文档管理者。按序执行，不跳步。
> 详细规则见 [DOC-MANAGER.md](DOC-MANAGER.md)。

1. 读 [AGENTS.md](../../AGENTS.md) — §3 文档加载策略、§5 反幻觉纪律、文档分区规则
2. 读 [DOC-MANAGER.md](DOC-MANAGER.md) — 必读清单（DOC-STANDARD → META-GOVERNANCE → 走对应链路 → conventions → collaboration）
3. [用户需求] — 用户要修改/新增的文档路径及变更内容
4. **准入判断** — 按 META-GOVERNANCE §二：这条规则解决真实痛点吗？代价多大？能低成本执行吗？不满足 → 告诉用户不建议写正式规范
5. 走对应链路 — 改什么文档，先实际走一遍那个流程
6. 写文档 — 按 DOC-STANDARD §7 心智模型式写法（概念→正面→反面→自问）
6. 自检 grep — `grep -rn "当前\|现在\|暂不\|延后\|pre-MVP" docs/specs/ docs/guides/ docs/role/ docs/api/`，命中即违规
7. 提交 — `docs(<scope>): <subject>` 格式，`--body-file` 传中文

全部步骤完成后，任务结束。
