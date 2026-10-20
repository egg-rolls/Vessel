---
adr: 71
title: 分发：vessel-agent 根包、子包 files 与安装解析 smoke
status: accepted
date: 2026-10-20
related: [6, 50, 66]
tags: [distribution, packaging, npm, release, ci]
---

## ADR-071：分发：vessel-agent 根包、子包 files 与安装解析 smoke

- **上下文**：0.x 一直从源码运行，发布只做干跑。根包名与 npm 分发名不一致（仓库名 Vessel、计划名 `vessel-agent`），子包没有 `files` / `license` / `repository` / `engines`，根包 `files` 可能把 `node_modules` 或测试文件打进 tarball。发布干跑只检查“包内有哪些文件”，不能回答“发布后的 tarball 能不能被 npm 真正装上并运行”。一旦发布，18 个子包与根包的依赖解析顺序、bin 名与元数据都会成为用户侧问题。

- **决策**：
  1. **根包发布名 `vessel-agent`，bin 仍是 `vessel`**。根 `package.json` 的 `name` 为 `vessel-agent`；`release.yml` 在发布前校验该名称，不符即 fail-fast。
  2. **子包必须有发布元数据**。18 个可发布子包统一带 `files: ["src"]`、`license`、`repository`、`engines`；只发源码，不发测试 / 构建产物。
  3. **根包 files 收敛**。根 `files` 包含 `src` / `packages` / `plugins` / `skills` / `apps/web/dist` / `README.md` / `LICENSE`，排除 `**/node_modules/**`、`__tests__` 与 `*.test.ts(x)`。
  4. **安装解析 smoke**。`scripts/smoke-install.ts` 对 18 个子包 + 根 tarball 执行 `npm pack`，在临时工程里用本地 `file:` `overrides` 把每个 `@vessel/*` 指向本地 tarball，再安装根 tarball，运行 `vessel --version` 与 `VESSEL_MOCK=1 vessel --tools` 并断言输出。不访问尚未发布的版本，不 tag、不 publish、不 push、不上传 artifact。
  5. **CI 与发布门禁**。CI 新增 `install-smoke` job（仅 PR + `release/**` push，ubuntu + Node 22）；`release.yml` 的 `verify` 在发布干跑之后跑安装 smoke，任一步失败则不进入 `publish-npm`。
  6. **发布顺序固定**。先发布 18 个子包：`core → permission → config → serve → tui → plugins`（5 个库包 + 13 个插件包），最后发布根包 `vessel-agent`；已存在的版本跳过，便于部分失败后重跑。

- **备选**：(a) 继续用仓库名发布——与 `vessel` bin 不一致，且会占用错误 scope；(b) 子包不带 `files`——tarball 会包含测试与无用文件；(c) 只靠发布干跑——无法发现 `file:` / 依赖解析 / bin shim 问题；(d) 在 Windows 也跑安装 smoke——npm `.cmd` bin shim 与 `file:` override 路径语义未验证，先显式跳过；(e) 一次性发布全部包并自动重试——部分失败会留下不可回滚的已发布版本。均不取。

- **后果**：发布前能验证“装得上、跑得起来”，而不只是“文件在包里”。安装 smoke 只在 POSIX / Node 22 运行，Windows 默认跳过并返回 0（`--force` 可强制尝试）；这不代表 Windows 安装已验收。根包依赖子包的精确版本，因此必须先发子包、最后发根包；重跑时已发布版本会被跳过。本周期仍未 tag / publish / 合并 `main`，README 中 `npm i -g vessel-agent` 仍标注“未发布”。

- **关联**：ADR-006（npx 分发、不做单二进制）、ADR-050（YAML 主配置与密钥分层）、ADR-066（结果 schema 与 CI 校验）；`package.json`、`packages/*/package.json`、`plugins/*/*/package.json`、`scripts/smoke-install.ts`、`scripts/release-dry-run.ts`、`.github/workflows/{ci,release}.yml`。
