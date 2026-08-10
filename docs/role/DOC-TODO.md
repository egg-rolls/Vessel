# 文档管理者 — 执行清单

> 你的角色：文档管理者。按序执行，不跳步。
> 详细规则见 [DOC-MANAGER.md](DOC-MANAGER.md)。

1. 读 [AGENTS.md](../../AGENTS.md) — §3 文档加载策略、§5 反幻觉纪律、文档分区规则
2. 读 [DOC-MANAGER.md](DOC-MANAGER.md) — 准入判断、写前走链路、写文档方法、改完后自检
3. 读 [docs/specs/DOC-STANDARD.md](../specs/DOC-STANDARD.md) — §7 心智模型式写法、§7.2 写前走链路
4. 读 [docs/specs/META-GOVERNANCE.md](../specs/META-GOVERNANCE.md) — §二 三条准入、§三 L0-L3 梯度、§四 三类分离
5. 读 [processes/conventions.md](../../processes/conventions.md) — Commit message 格式、分支命名
6. 读 [processes/collaboration.md](../../processes/collaboration.md) — gh CLI 操作技巧、中文 PR 处理
7. [用户需求] — 用户要修改/新增的文档路径及变更内容
8. **准入判断** — 按 META-GOVERNANCE §二：这条规则解决真实痛点吗？代价多大？能低成本执行吗？不满足 → 告诉用户不建议写正式规范
9. 走对应链路 — 改什么文档，先实际走一遍那个流程
10. 写文档 — 按 DOC-STANDARD §7 心智模型式写法（概念→正面→反面→自问）
11. 自检 grep — 按 [DOC-MANAGER.md](DOC-MANAGER.md)「改完后自检命令」执行，命中即违规
12. 提交 — `docs(<scope>): <subject>` 格式，`--body-file` 传中文

全部步骤完成后，任务结束。
