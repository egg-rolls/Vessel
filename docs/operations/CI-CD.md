# CI / CD 手册

> 维护者：`gov`。分支模型与发布规则见 [FILE-MANAGEMENT.md](../FILE-MANAGEMENT.md)。
> 当前版本线：0.1.x。**0.1.0 不发布独立二进制**（ADR-006 继续有效）。

## 1. CI（`.github/workflows/ci.yml`）

### 触发

- `pull_request` → `main`、`release/**`
- `push` → `main`、`release/**`
- `workflow_dispatch`

同一 ref 的旧 run 自动取消：`concurrency.group = ci-<workflow>-<ref>`，`cancel-in-progress: true`。

### Job

| Job | Runner | 内容 |
|---|---|---|
| `quality` | ubuntu-latest | 复用 `.github/actions/quality`：`bun install --frozen-lockfile` → `bun run lint` → `bun run typecheck` → `bun test` → `bun run build` |
| `cross-platform` | matrix：ubuntu / windows / macos | `bun install --frozen-lockfile` → `bun run typecheck` → `bun test`；**PR 只跑 ubuntu**，`main` / `release/**` 跑全矩阵 |
| `web` | ubuntu-latest | `apps/web`：`npm ci` → `npm run build`（Node 22，npm cache） |
| `examples` | ubuntu-latest | `bunx tsc -p examples/tsconfig.json --noEmit` → `bun run demo`（关闭上轮 typecheck 盲区） |
| `smoke` | ubuntu-latest | 仅 `main` / `release/**` push：headless 文本、stdin、`@file`、`/help`、`/exit`（全部 `VESSEL_MOCK=1`） |

### 通用规则

- Bun 安装缓存：`actions/cache` + `~/.bun/install/cache`，key 取 `bun.lock` 哈希。
- 三件套任一红 → 禁止合并。
- 不在 CI 中写入任何真实 API Key；mock 模式覆盖全部冒烟路径。
- 分支保护 required checks：`Quality Checks`、`Web Build`、`Examples`、`Cross Platform (ubuntu-latest)`。

## 2. Release（`.github/workflows/release.yml`）

### 触发

- `push` tag `v*`（稳定版与预发布）。
- 同一 tag 的发布不可取消：`concurrency.cancel-in-progress: false`。

### 步骤（0.1.0：无二进制）

1. `verify`
   - tag 必须在 `main` 上：`git merge-base --is-ancestor "$GITHUB_SHA" origin/main`。
   - 从 tag 提取版本（去掉 `v`）。
   - `bun run scripts/version.ts --check <version>`：所有可发布包版本一致，且 `CHANGELOG.md` 含 `## [<version>]`。
2. `quality`：复用 `.github/actions/quality`，发布前再验一次。
3. `publish-npm`
   - 只发布库包与插件包：`@vessel/core`、`@vessel/config`、`@vessel/permission`、`@vessel/tui`、`@vessel/serve` + 7 个插件包。
   - **不发布根 CLI**（`private: true`，无 `bin`）。
   - 稳定版 dist-tag `latest`；预发布（tag 含 `-`）dist-tag `beta`。
   - `npm publish --provenance --access public`（OIDC provenance）。
   - 已存在的版本跳过，便于部分失败后重跑。
4. `github-release`
   - `bun run scripts/latest-json.ts` 生成 `latest.json`（0.1.0 的 `assets` 为空对象）。
   - 创建 GitHub Release：自动 notes；tag 含 `-` 时标记 prerelease。

### 不做（0.1.0）

- 不构建 `bun build --compile` 二进制，不产出 `SHA256SUMS`，不做二进制自更新。
- 0.2 若重启二进制方案，需先解决插件目录解析并写新 ADR。

### 失败处理

- 不自动重试。
- `verify` / `quality` 失败：什么都没发布，修复后重新打 tag。
- `publish-npm` 部分成功：已发布版本不回滚；修版本后发下一个 patch。重跑时已发布版本会被跳过。
- `github-release` 失败：npm 可能已发布；补发 Release 或直接发下一个 patch。
- 已发布 tag 不删除、不移动。

### `latest.json` 格式

```json
{
  "version": "0.1.0",
  "channel": "latest",
  "released_at": "2026-10-17T00:00:00Z",
  "assets": {}
}
```

- `channel`：稳定版 `latest`，预发布 `beta`。
- 0.1.0 的 `assets` 固定为空。0.2 若恢复二进制，按平台填 `{ "url": "...", "sha256": "..." }`。

## 3. 用户侧 CD / 自动更新

> 契约已定；**客户端（`vessel update`）尚未实现**。实现前 README 明确标注。

| 安装方式 | 更新方式 |
|---|---|
| npm / bun 全局安装 | `vessel update` 提示升级命令；用户执行 `npm i -g <pkg>@latest` |
| 独立二进制 | **0.1.0 不提供**（ADR-006 继续有效）；0.2 再评估 |
| 源码运行 | `vessel update --check` 只提示新版本，不自动改 git 工作区 |

行为：

- REPL 启动后台检查（每天最多一次，可配置关闭），只提示、不打断。
- 稳定通道：GitHub `releases/latest` 的 `latest.json`。
- 预发布通道：GitHub API 取最新 prerelease 的 `latest.json`；`--channel beta` 或 `VESSEL_CHANNEL=beta`。
- 断网、404、JSON 解析失败、版本不合法：静默跳过，不影响启动。
- 不自动执行破坏性更新。
- 版本比较使用 CLI 自身版本（`asm` 需提供 `--version` 或从 `package.json` 读取）。

## 4. 分支保护与权限

| 对象 | 规则 |
|---|---|
| `main` | 禁止直接 push；要求 CI 绿；squash merge；只允许 1 合并 |
| `release/*` | 只有 1 可合并 |
| `0.x.y-<role>` | 只有该角色 N 可写 |
| tag `v*` | 只有 1 / CI 可创建；禁止删除已发布 tag |

## 5. Secrets

| 名称 | 用途 | 使用位置 |
|---|---|---|
| `NPM_TOKEN` | npm 发布（automation token） | `publish-npm` |
| `GITHUB_TOKEN` | GitHub Release | `github-release` |
| `id-token: write` | npm provenance（OIDC，无 secret） | `publish-npm` |
| `CODECOV_TOKEN` | 可选，覆盖率上报 | 未启用 |

任何 Key 不得写入仓库；本地开发用 `.env`（已忽略）。
