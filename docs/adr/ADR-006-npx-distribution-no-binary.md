---
adr: 6
title: 分发走 npx，弃单二进制
status: accepted
date: null
related: [1, 28, 30]
---

## ADR-006：分发走 npx，弃单二进制

- **上下文**：无基础用户跑 Python 应用门槛高；单二进制分发限制多——插件/工具被编译进二进制，无法运行时加载用户工具与外部扩展，违背"用户加工具运行时发现"的开放模型（对比 Claude Code / hermes 的 npx/包分发路线）。
- **决策**：分发走 `npx vessel`（有 Node/Bun 者）。**抛弃 `bun build --compile` 单二进制**——单二进制把能力锁进内核，限制插件生态与运行时工具发现（ADR-028/030 的开放模型）。
- **后果**：分发依赖 Node/Bun 环境；插件/工具可运行时加载（用户放 `~/.vessel/tools/` 即注册）；需维护 npm 发布流水线。单二进制不再作为分发形态。
- **关联**：legacy/LESSONS 教训13；ADR-001、ADR-028。
