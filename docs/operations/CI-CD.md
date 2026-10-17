# CI / CD 手册

> 维护者：`gov`。分支模型与发布规则见 [FILE-MANAGEMENT.md](../FILE-MANAGEMENT.md)。

## 1. CI（`.github/workflows/ci.yml`）

### 触发

- `pull_request` → `main`、`release/**`
- `push` → `main`、`release/**`
- `workflow_dispatch`

### Job

| Job | Runner | 内容 |
|---|---|---|
| `quality` | ubuntu-latest | `bun install --frozen-lockfile` → `bun test` → `bun run typecheck` → `bunx @biomejs/biome ci .` → `bun run build` |
| `cross-platform` | matrix：ubuntu / windows / macos | `bun test` + typecheck；PR 只跑 ubuntu，`main` / `release/**` 跑全矩阵 |
| `web` | ubuntu-latest | `cd apps/web && npm ci && npm run build` |
| `examples` | ubuntu-latest | 确保 `examples/**` 在 tsconfig 覆盖内，跑 `bun run examples/demo.ts`（mock） |

### 通用规则

- 同一 ref 的并发 run 自动取消。
- 缓存 Bun install cache 与 npm cache。
- 三件套任一红 → 禁止合并。
- 不在 CI 中写入任何真实 API Key；mock 模式覆盖大部分路径。

## 2. Release（`.github/workflows/release.yml`）

### 触发

- `push` tag `v*`（稳定版与预发布）。

### 步骤

1. 校验 tag 在 `main` 上。
2. 校验 tag 与根及所有 workspace `package.json` 版本一致。
3. 复跑 quality。
4. `npm publish` 公开包：
   - 稳定版 → `latest`；
   - 预发布（tag 含 `-`）→ `beta`；
   - `--provenance --access public`。
5. `bun build --compile` 产出：
   - `vessel-windows-x64.exe`
   - `vessel-linux-x64`
   - `vessel-darwin-x64` / `vessel-darwin-arm64`
6. 创建 GitHub Release：自动 notes、sha256、`latest.json`。
7. 失败不自动重试；修版本后发新 tag。

### `latest.json` 格式

```json
{
  "version": "0.1.0",
  "channel": "latest",
  "released_at": "2026-10-17T00:00:00Z",
  "assets": {
    "windows-x64": { "url": "https://...", "sha256": "..." },
    "linux-x64": { "url": "https://...", "sha256": "..." },
    "darwin-arm64": { "url": "https://...", "sha256": "..." }
  }
}
```

## 3. 用户侧 CD / 自动更新

| 安装方式 | 更新方式 |
|---|---|
| npm / bun 全局安装 | `vessel update` 提示升级命令；用户执行 `npm i -g vessel@latest` |
| 独立二进制 | `vessel update` 下载对应平台资产，校验 sha256 后自替换 |
| 源码运行 | `vessel update --check` 只提示新版本，不自动改 git 工作区 |

行为：

- REPL 启动后台检查（每天最多一次，可配置关闭），只提示、不打断。
- 通道：`latest` / `beta`（`--channel` 或 `VESSEL_CHANNEL`）。
- 断网、404、校验失败：静默跳过，不影响启动。
- 不自动执行破坏性更新；自替换前保留旧二进制为 `.bak`。

## 4. 分支保护与权限

| 对象 | 规则 |
|---|---|
| `main` | 禁止直接 push；要求 CI 绿；squash merge；只允许 1 合并 |
| `release/*` | 只有 1 可合并 |
| `0.x.y-<role>` | 只有该角色 N 可写 |
| tag `v*` | 只有 1 / CI 可创建；禁止删除已发布 tag |

## 5. Secrets

| 名称 | 用途 |
|---|---|
| `NPM_TOKEN` | npm 发布 |
| `GITHUB_TOKEN` | GitHub Release、provenance |
| `CODECOV_TOKEN` | 可选，覆盖率上报 |

任何 Key 不得写入仓库；本地开发用 `.env`（已忽略）。
