---
adr: 1
title: 实现语言用 TypeScript
status: accepted
date: null
related: [6]
---

## ADR-001：实现语言用 TypeScript

- **上下文**：旧项目用 Python，对无基础用户分发门槛高（装解释器/venv/PyInstaller 打包大且慢）。同类 CLI agent（Claude Code/Cline/Continue）多为 TS。
- **决策**：用 TypeScript；运行时 Bun；分发 `npx vessel`（弃单二进制，见 ADR-006）。
- **备选**：Python（分发痛点未解；遗产非代码故无迁移优势）、Go（单二进制最优但 AI/TUI 生态弱）、Rust（曲线陡、小团队不划算）。
- **后果**：团队需学 TS；但 TUI(Ink)/MCP/插件生态最佳，前后端同构。代价可接受。
- **关联**：legacy/LESSONS 教训13。
