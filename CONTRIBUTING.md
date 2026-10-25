# 贡献指南

1. 从 `main` 切分支，一个分支一个关注点。
2. 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)：`feat(core): ...` / `fix(tui): ...` / `docs: ...`。
3. 提交前跑：`bun test`、`bun run typecheck`、`bunx @biomejs/biome ci .` —— 三者必须全过（CI 同样跑这三项 + `bun run build`；另有跨平台、web、examples、mock 冒烟）。
4. 开 PR，填模板，等审查。
5. 合并用 **squash merge**，不直接 push `main`。
6. 发布只由维护者通过 tag `v*` 触发；贡献者不打 tag、不执行 `version.ts` 写模式。流程见 [docs/operations/RELEASE.md](docs/operations/RELEASE.md)。

写代码前先读 [AGENTS.md](AGENTS.md)（红线与分层准入）、[docs/architecture/INDEX.md](docs/architecture/INDEX.md)（架构事实）与 [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md)（路径与文件归属）。

发现安全漏洞见 [SECURITY.md](SECURITY.md)，勿开公开 issue。
