---
title: 文档、角色与发布门禁
kind: advisory
triggers: [docs, doc management, frontmatter, check-docs, release, ci, pr, roles, worktree]
paths: [docs/**, AGENTS.md, README.md, .github/**, scripts/**]
applies_to: [N, M]
---

# 文档、角色与发布门禁

> 改 `docs/**`、根文档、`.github/**` 或 `scripts/**` 前读这一篇；发布纪律与硬安全规则仍以 [AGENTS.md](../../AGENTS.md) 为准。

## 文档生命周期

- 当前态整文件覆盖写，历史只追加；O(n) 目录必须有 `INDEX.md`。
- 当前态文档禁版本叙事（`## 0.x` / 逐版本“已实现”章节 / “自 0.x 起”）；版本结果进 `docs/versions/<version>.md`，原因进 ADR。
- 超过 300 行或 100 KB 的 current 文档按模块拆分，带 `INDEX.md` + frontmatter；模块 ≤100 行。
- 过程产物（计划、报告、临时脚本）不进共享仓库——规则见 [DOC-MANAGEMENT.md](../DOC-MANAGEMENT.md) 与 [FILE-MANAGEMENT.md](../FILE-MANAGEMENT.md)；本文件不复述。
- 文档只写已实现的能力；引用路径前先确认存在。

## 角色与路径

- 每个角色只写自己的独占路径；跨路径改动先协商。
- 已删除目录：`docs/specs/`、`docs/role/`、`docs/api/`、`docs/guides/`、`processes/`、`legacy/`；不要再链接。
- 共享/个人分工、分支与 PR 流程见 [FILE-MANAGEMENT.md](../FILE-MANAGEMENT.md)。

## 门禁

- 改完代码：`bun test` / `bun run typecheck` / `bunx @biomejs/biome ci .` 三个必须过。
- 收口还要求：`check-deps` / `smoke-subpaths` / `check-docs` / `version --check` / `release-dry-run`。
- 纯文档改动至少跑 `check-docs` 与 `version --check`；不跑全量测试 / 构建。

## 发布与 CI

- 发布纪律（1.0 前只干跑、不 tag/publish/merge main/force-push、PR only）见 AGENTS 硬规则。
- 操作步骤与包形态（包名、发布顺序、`smoke-install`、`version.ts` 写模式）见 [RELEASE.md](../operations/RELEASE.md)；CI 见 [CI-CD.md](../operations/CI-CD.md)。
- tag `v*` 只有 1 打。

## docs/agents 元规则

- 本目录每篇 ≤60 行，frontmatter 必填 `title/kind: advisory/triggers/paths/applies_to`；`INDEX.md` ≤60 行。
- 规则正文只在唯一 owner：硬安全规则在 AGENTS，契约在 architecture，操作步骤在 operations；advisory 只写领域细节并链接。
