---
title: 文档、角色与发布
kind: advisory
triggers: [docs, doc management, frontmatter, release, publish, tag, version check, changelog, ci, pr, roles, worktree, 发布, 版本, 变更日志, 角色, 工作区, 干跑, 元信息]
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
- **不写死读数**：handoff / 文档写命令而不是值；确需写值时带 `sha` + 时间戳。

## 角色与路径

- 每个角色只写自己的独占路径；跨路径改动先协商。
- 已删除目录：`docs/specs/`、`docs/role/`、`docs/api/`、`docs/guides/`、`processes/`、`legacy/`；不要再链接。
- 共享/个人分工、分支与 PR 流程见 [FILE-MANAGEMENT.md](../FILE-MANAGEMENT.md)。

## 检查与冒烟

- 改完代码：`bun run build`（= `typecheck` + `bunx @biomejs/biome ci .`）必须过。仓库无 gate / test / probe
  （宪法第三、四条）；运行时正确性只靠手工端到端冒烟 `VESSEL_MOCK=1 bun run src/cli.ts --run "hello"`。
- 发版检查点：`bun run scripts/version.ts --check`（版本一致性 + CHANGELOG）。
- 纯文档改动**没有自动检查**（`check-docs` 已按宪法删除）：靠评审按
  [DOC-MANAGEMENT.md](../DOC-MANAGEMENT.md) 守行数 / frontmatter / 链接 / INDEX；不跑全量 typecheck / 构建。
- **职责边界**：biome 只看代码与配置，markdown 不在任何格式化工具里。`**/*.md` 已在 `biome.json` 的
  `files.includes` 里显式排除，理由是 **防止将来 biome 升级（2.6.x 起 Markdown 进入 formatter）时行为漂移**。
- 本地无 `node_modules` 时 `bunx <pkg>` 会拉最新版；`git archive` 副本没有 `.git`，`vcs.useIgnoreFile`
  失效——先按 [AGENTS.md](../../AGENTS.md) 的锁版本规则准备环境，再判红绿。
- 规则→门禁、两级不变量、文档即 prompt、tree-sha 可追溯等工程规则 canonical 见
  [AGENTS.md](../../AGENTS.md)「文件与目录 / 怎么跑与门禁」；本文件只写文档侧落点。

## 发布与 CI

- 发布纪律（1.0 前只干跑、不 tag/publish/merge main/force-push、PR only）见 AGENTS 硬规则。
- 操作步骤与包形态（包名、发布顺序、`smoke-install`、`version.ts` 写模式）见 [RELEASE.md](../operations/RELEASE.md)；CI 见 [CI-CD.md](../operations/CI-CD.md)。
- tag `v*` 只有 1 打。

## docs/agents 元规则

- 本目录每篇 ≤60 行，frontmatter 必填 `title/kind: advisory/triggers/paths/applies_to`；`INDEX.md` ≤60 行。
- 规则正文只在唯一 owner：硬安全规则在 AGENTS，契约在 architecture，操作步骤在 operations；advisory 只写领域细节并链接。
