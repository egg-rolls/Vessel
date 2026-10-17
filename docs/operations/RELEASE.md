# 发布手册

> 适用版本线：`0.x`。发布由 **tag `v*`** 触发，不由分支名触发。
> 维护者：`gov`；最终发布决定权在 1。

## 1. 版本语义

- 采用 SemVer：`MAJOR.MINOR.PATCH`。
- alpha 阶段（`0.x`）：breaking 变更 → minor（`0.1` → `0.2`）；新功能 → minor；修复 → patch。
- 预发布：`v0.2.0-beta.1`，npm dist-tag 用 `beta`；稳定版用 `latest`。

## 2. 发布前置条件

- [ ] 目标改动已合并到 `release/<major>.<minor>`。
- [ ] `bun test` / `bun run typecheck` / `bunx @biomejs/biome ci .` 全绿。
- [ ] `cd apps/web && npm ci && npm run build` 成功。
- [ ] `CHANGELOG.md` 已更新（Conventional Commits 汇总）。
- [ ] 根 `package.json` 与所有 workspace `package.json` 版本一致。
- [ ] `release/*` 已合并到 `main`，且 `main` CI 绿。

## 3. 发布步骤

```bash
# 1. 切到 main 并确认干净
git switch main
git pull --ff-only
git status --short

# 2. 统一版本（示例：0.1.0）
#    修改根与所有 packages/*/package.json、plugins/*/*/package.json
bun run scripts/version.ts 0.1.0   # 若脚本尚未实现，手工改并跑校验

# 3. 更新 CHANGELOG.md（保留最新在上）
# 4. 提交版本提交
git add -A
git commit -F <personal>/docs/tmp/release-msg.txt

# 5. 打 annotated tag 并推送
git tag -a v0.1.0 -m "v0.1.0"
git push origin main
git push origin v0.1.0
```

推送 tag 后由 `.github/workflows/release.yml` 自动完成：

1. 校验 tag 在 `main` 上、版本一致。
2. 复跑 quality。
3. `npm publish`（`--provenance --access public`）。
4. `bun build --compile` 产出 win / linux / mac 二进制。
5. 创建 GitHub Release + `latest.json` + sha256。

## 4. 预发布

```bash
git tag -a v0.2.0-beta.1 -m "v0.2.0-beta.1"
git push origin v0.2.0-beta.1
```

- npm dist-tag：`beta`。
- 用户侧：`vessel update --channel beta` 或 `VESSEL_CHANNEL=beta`。

## 5. 热修复

```bash
git switch -c hotfix/<slug> main
# 修复 + 测试
git commit -F <personal>/docs/tmp/hotfix-msg.txt
# 1 合并到 main 与 release/0.1
git tag -a v0.1.1 -m "v0.1.1"
git push origin main v0.1.1
```

## 6. 回滚

- **不删除、不移动已发布 tag。**
- 代码回退：在 `main` 上 revert 问题提交，发新的 patch 版本。
- npm 回滚：`npm dist-tag add @vessel/core@<last-good> latest`，再发 patch 修复。
- 二进制回滚：在 GitHub Release 中把旧版本标为 latest 资产，并更新 `latest.json`。

## 7. 发布失败处理

- workflow 失败：修复问题 → 删除**未发布成功**的本地/远端 tag 只在确认 npm 未发布时进行；否则直接发下一个 patch。
- 任何情况下都不 force-push `main` / `release/*`。

## 8. 后续演进（Phase 2）

包可发布、发布频率上升后，引入 **Changesets** 或 **Release Please**：

- 自动生成版本 PR / changelog；
- 多包版本联动；
- 与当前 tag 触发方式兼容（工具最终仍产出 `v*` tag）。
