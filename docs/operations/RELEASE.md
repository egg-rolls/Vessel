# 发布手册

> 适用版本线：`0.x`。发布由 **tag `v*`** 触发，不由分支名触发。
> 维护者：`gov`；最终发布决定权在 1。
> **0.1.0 / 0.2 / 0.3.0 均未发布**；不发布二进制（ADR-006 继续有效）；只发 npm 库包 + GitHub Release。

## 1. 版本语义

- 采用 SemVer：`MAJOR.MINOR.PATCH`。
- alpha 阶段（`0.x`）：breaking 变更 → minor（`0.1` → `0.2`）；新功能 → minor；修复 → patch。
- 预发布：`v0.4.0-beta.1`，npm dist-tag 用 `beta`；稳定版用 `latest`。

## 2. 发布前置条件

- [ ] 目标改动已合并到 `release/<major>.<minor>`。
- [ ] `bun test` / `bun run typecheck` / `bunx @biomejs/biome ci .` 全绿。
- [ ] `cd apps/web && npm ci && npm run build` 成功。
- [ ] `CHANGELOG.md` 已更新（Unreleased → `## [<version>] - YYYY-MM-DD`）；0.2 未发布，其条目已并入 `## [0.3.0]`。
- [ ] 根 `package.json` 与所有可发布 workspace `package.json` 版本一致（`@vessel/*` 与 10 个插件包，含 `@vessel/mcp-client`）。
- [ ] `release/*` 已合并到 `main`，且 `main` CI 绿。
- [ ] 仓库 Secrets 已配置 `NPM_TOKEN`。

## 3. 版本脚本

```bash
# 只校验（日常/CI）
bun run scripts/version.ts --check 0.3.0

# 写入根、packages/*、plugins/*/*、apps/web 的版本（发布收口时由 1 执行）
bun run scripts/version.ts 0.3.0

# 预演，不落盘
bun run scripts/version.ts 0.3.0 --dry-run
```

规则：

- `--check` 同时校验所有可发布包版本一致，以及 `CHANGELOG.md` 含 `## [<version>]`。
- 根 `package.json` 的 `version`（0.3.0 已加入）与所有 workspace 包一起校验；`--version` 也从这里读取。
- 写模式会机械改写各包 `package.json`，**只由 1 在发布收口执行**；日常开发不运行写模式。
- 脚本不做 git 操作（commit / tag 仍手工执行）。

## 4. 发布步骤

```bash
# 1. 切到 main 并确认干净
git switch main
git pull --ff-only
git status --short

# 2. 统一版本（示例：0.3.0）
bun run scripts/version.ts 0.3.0

# 3. 更新 CHANGELOG.md（把 Unreleased 改成 ## [0.3.0] - YYYY-MM-DD）
# 4. 提交版本提交（中文/复杂 message 用 -F 文件，避免 shell 编码问题）
git add package.json packages/*/package.json plugins/*/*/package.json apps/web/package.json CHANGELOG.md
git commit -F <personal>/docs/tmp/release-msg.txt

# 5. 打 annotated tag 并推送
git tag -a v0.3.0 -m "v0.3.0"
git push origin main
git push origin v0.3.0
```

推送 tag 后由 `.github/workflows/release.yml` 自动完成：

1. 校验 tag 在 `main` 上、版本一致、CHANGELOG 有该版本。
2. 复跑 quality。
3. `npm publish` 所有公开包（`--provenance --access public`，稳定版 `latest` / 预发布 `beta`）。
4. 创建 GitHub Release：自动 notes + `latest.json`（`assets: {}`）。
5. **不构建二进制、不产出 sha256**。

发布顺序：`verify → quality → publish-npm → github-release`。

发布后用户侧：`vessel update --check` 读取 `latest.json`，只提示版本与安装命令；0.3.0 不做下载/自替换。

## 5. 预发布

```bash
git tag -a v0.4.0-beta.1 -m "v0.4.0-beta.1"
git push origin v0.4.0-beta.1
```

- npm dist-tag：`beta`。
- GitHub Release 标记为 prerelease。
- 用户侧：`vessel update --channel beta` 或 `VESSEL_CHANNEL=beta`（客户端待实现）。

## 6. 热修复

```bash
git switch -c hotfix/<slug> main
# 修复 + 测试
git commit -F <personal>/docs/tmp/hotfix-msg.txt
# 1 合并到 main 与 release/0.1
git tag -a v0.3.1 -m "v0.3.1"
git push origin main v0.3.1
```

## 7. 回滚

- **不删除、不移动已发布 tag。**
- 代码回退：在 `main` 上 revert 问题提交，发新的 patch 版本。
- npm 回滚：`npm dist-tag add @vessel/core@<last-good> latest`，再发 patch 修复。
- GitHub Release：不删除旧 tag；如有需要，把旧版本重新标记为 latest 资产，再发 patch。
- 0.3.0 无二进制，不涉及二进制回滚。

## 8. 发布失败处理

- workflow 失败：不自动重试。
- `verify` / `quality` 失败：什么都没发布；修复后重新打 tag。
- npm 部分成功：已发布版本不回滚；重跑时已发布版本会被跳过；否则直接发下一个 patch。
- `github-release` 失败：npm 可能已发布；补发 Release 或发下一个 patch。
- 任何情况下都不 force-push `main` / `release/*`。

## 9. 后续演进（Phase 2）

包可发布、发布频率上升后，引入 **Changesets** 或 **Release Please**：

- 自动生成版本 PR / changelog；
- 多包版本联动；
- 与当前 tag 触发方式兼容（工具最终仍产出 `v*` tag）。
