---
adr: 14
title: CI 用 GitHub Actions，required checks = lint+typecheck+test+build
status: accepted
date: null
---

## ADR-014：CI 用 GitHub Actions，required checks = lint+typecheck+test+build

- **上下文**：需自动化质量门禁，防回归与红线违反。
- **决策**：GitHub Actions；每个 PR/push 跑 lint(biome)+typecheck(tsc)+test(bun test)+build(bun build)；四项设为 GitHub branch protection required check。
- **备选**：仅本地 hooks（无强制）/ 其他 CI 平台。
- **后果**：质量门禁强制；需维护 workflow。release 工作流延后到 Phase 1（有可发布物时）。
- **关联**：`.github/workflows/ci.yml`；[ROADMAP.md](ROADMAP.md) Phase 0。
