# 贡献指南（CONTRIBUTING）

> 面向人类贡献者。AI 代理请先读 [CLAUDE.md](CLAUDE.md)。

## 开发环境

- 运行时：Bun（`bun install` 装依赖）。
- 仓库为 monorepo（bun workspaces）：`packages/{core,config,tui}` + `plugins/`。
- 动手前按 [CLAUDE.md §2](CLAUDE.md) 阅读顺序通读 `docs/` 和 `processes/`。

## 分支与提交

- 从 `main` 切特性分支：`feat/<scope>-<short>`、`fix/<scope>-<short>`、`docs/<short>`。
- 提交格式：`<type>(<scope>): <subject>`，type 用 feat/fix/docs/refactor/test/chore。
- 一个 PR 一个关注点。

## PR 流程

1. 自查 [PR 模板检查清单](.github/PULL_REQUEST_TEMPLATE.md)。
2. CI（lint+typecheck+test+build）须全绿；四项为 required check（ADR-014）。
3. 改 core 必须先有 ADR（ADR-012）；新增能力按 [CLAUDE.md §5](CLAUDE.md) 决策树分类。
4. 至少一名审阅者 approve（可以是 AI Agent 架构审查）。
5. **合并门禁**：见 [docs/specs/GIT-WORKFLOW.md](docs/specs/GIT-WORKFLOW.md) —— AI Agent 合并前必须对照全部 `docs/specs/` 文档逐条检查架构合规性；禁止合并后修复。"

## 工程规范

- Lint/Format：Biome（ADR-013），`bun run lint`。
- 类型：TS strict，`bun run typecheck`。
- 测试：`bun test`，每模块配单测。
- 依赖：core 不依赖 tui/config/plugins；不引入 LangChain；重依赖只进插件包。
- 详见 [CLAUDE.md §4](CLAUDE.md) 工程规范与 §6 红线。

## 文档同步

公开行为或边界变化时，同步更新 `docs/`（SPEC/ADR/ROADMAP/PLUGINS）与 `CLAUDE.md`。文档只写已实现；规划项标 `[plan]`（反幻觉纪律）。

## 发布

- Release 工作流延后到 Phase 1（有可发布物时）：tag 触发，出 Bun 单二进制 + GitHub Release。
- npm 包发布延后。

## 安全

发现安全漏洞见 [SECURITY.md](SECURITY.md)，勿开公开 issue。
