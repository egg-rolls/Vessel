---
adr: 13
title: Linter/Formatter 用 Biome
status: accepted
date: null
---

## ADR-013：Linter/Formatter 用 Biome

- **上下文**：TS monorepo 需统一 lint+format 质量门禁。备选 Biome vs ESLint+Prettier。
- **决策**：用 Biome（lint+format 一体，Rust 实现，Bun 原生友好）。
- **备选**：ESLint+Prettier（生态/规则更丰富，但双工具配置繁琐、慢，需 typescript-eslint）。
- **后果**：速度快、配置极简、TS 原生；规则生态不如 ESLint，但推荐规则集足够 MVP。CI 跑 `bun run lint`（biome ci）。
- **关联**：[CLAUDE.md](../../CLAUDE.md) §9；`.github/workflows/ci.yml`。
