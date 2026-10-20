# CI / CD 手册

> 维护者：`gov`。分支模型与发布规则见 [FILE-MANAGEMENT.md](../FILE-MANAGEMENT.md)。
> 当前开发线：0.10.0（基线 `release/0.10.0`；目标是根包与可发布包版本均为 `0.10.0`，bump 由 1 在集成线统一写入；bump 前根 `package.json` 仍为上一版本，本分支的 `version --check` 在版本 bump 前可能失败）。
> 0.1.0 / 0.2 / 0.3.0 / 0.4.0 均未发布；0.5 / 0.6 / 0.7 / 0.7.1 / 0.8.0 / 0.8.1 / 0.8.2 / 0.8.3 / 0.8.4 / 0.8.5 / 0.8.6 / 0.8.7 / 0.9.0 / 0.10.0 只做发布干跑。0.10 起发布前置增加安装解析 smoke。**不发布独立二进制**（ADR-006 继续有效）。

## 1. CI（`.github/workflows/ci.yml`）

### 触发

- `pull_request` → `main`、`release/**`
- `push` → `main`、`release/**`
- `workflow_dispatch`

同一 ref 的旧 run 自动取消：`concurrency.group = ci-<workflow>-<ref>`，`cancel-in-progress: true`。

### Job

| Job | Runner | 内容 |
|---|---|---|
| `quality` | ubuntu-latest | 复用 `.github/actions/quality`：`bun install --frozen-lockfile` → Node 22 + `apps/web` `npm ci` → `bun run lint` → `bun run typecheck` → `bun test`（`VESSEL_VALIDATE_RESULTS=1`）→ `bun run build` |
| `cross-platform` | matrix：ubuntu / windows / macos | `bun install --frozen-lockfile` → Node 22 + `apps/web` `npm ci` → `bun run typecheck` → `bun test`（`VESSEL_VALIDATE_RESULTS=1`）；**PR 只跑 ubuntu**，`main` / `release/**` 跑全矩阵 |
| `web` | ubuntu-latest | `apps/web`：`npm ci` → `npm run build`（Node 22，npm cache） |
| `architecture` | ubuntu-latest | `scripts/check-deps.ts` → `scripts/smoke-subpaths.ts` → `scripts/check-docs.ts` → `scripts/check-rpc-methods.ts` → `scripts/version.ts --check` |
| `offline-integration` | ubuntu-latest | MCP / gateway + 0.4/0.5 能力：`bun test plugins/mcp/client` → `bun test packages/serve` → `bun test plugins/workflow/engine` → `bun test plugins/evals/harness` → `bun test plugins/im/feishu` → `bun test packages/core` → `scripts/check-config-sources.ts` → `scripts/check-trace.ts`；MCP 用本地 mock server，TLS 用本地自签证书，workflow / evals / feishu / config / trace 均用 mock 或临时目录，**不依赖外网** |
| `multi-node` | ubuntu-latest | 0.6 跨节点专项（**非 required**）：remote transport / registry / team routing / 事件回灌测试；不启动真实多机，使用本地两个 gateway |
| `tls-ca` | ubuntu-latest | 0.6 TLS/CA 专项（**非 required**）：`packages/serve` TLS/remote 测试 + `connect-e2e-0.6` / `rpc-remote-0.6`；使用仓库内自签 fixture |
| `frontend-cors` | ubuntu-latest | 0.6 独立前端专项（**非 required**）：`gateway.origin` / `gateway.ws-tenant` + `apps/web/tests/gatewayUrl.test.ts` |
| `release-dry-run` | ubuntu-latest | **仅 PR + `release/**` push**：`bun run scripts/release-dry-run.ts`；打包到 OS 临时目录，**不上传、不 publish、不 tag** |
| `install-smoke` | ubuntu-latest | **仅 PR + `release/**` push**：Node 22 + `bun run scripts/smoke-install.ts`；`npm pack` 18 个子包 + 根 tarball，用本地 `overrides` 安装后运行 `vessel --version` / `vessel --tools`（mock，无 Key）；**不上传、不 publish、不 tag**；Windows 默认跳过 |
| `examples` | ubuntu-latest | `bunx tsc -p examples/tsconfig.json --noEmit` → `bun run demo`（关闭上轮 typecheck 盲区） |
| `smoke` | ubuntu-latest | 仅 `main` / `release/**` push：`--version`、`--tools`、headless 文本、stdin、`@file`、`/help`、`/exit`（除 `--version` 外均带 `VESSEL_MOCK=1`） |

### 通用规则

- Bun 安装缓存：`actions/cache` + `~/.bun/install/cache`，key 取 `bun.lock` 哈希。
- **`bun test` 覆盖 `apps/web/tests`**：`apps/web` 不在根 `workspaces`（根只有 `packages/*`、`plugins/*/*`），`bun install` 不会安装 `react` 等前端依赖。因此凡是要跑根 `bun test` 的 job（`quality`、`cross-platform` 的 ubuntu / windows / macos）必须在该步之前执行 `actions/setup-node@v4`（Node 22，npm cache 取 `apps/web/package-lock.json`）+ `apps/web` 下的 `npm ci`；否则 `apps/web/tests` 会因 `Cannot find package 'react'` 计为 error。`web` job 自己的 `npm ci` 在独立 job 中，不与其他 job 共享 `node_modules`。
- 三件套任一红 → 禁止合并。
- 不在 CI 中写入任何真实 API Key；mock 模式覆盖全部冒烟路径。
- 分支保护 required checks：`Quality Checks`、`Web Build`、`Examples`、`Cross Platform (ubuntu-latest)`；0.5 建议把 `Architecture`、`Offline Integration` 与 `Release Dry Run` 也设为 required（由 1 / 仓库管理员在 GitHub 设置）。
- 0.6 的 `multi-node` / `tls-ca` / `frontend-cors` 只在 ubuntu 跑，**不设 required**；Windows 仍在 `cross-platform` 中跑单机全量 `bun test`。
- 0.6 专项 job 复用仓库内自签证书 fixture 与本地临时端口，不依赖外网或真实第二台机器；真实两机 / 浏览器信任仍需人工验收（见 [REMOTE.md](REMOTE.md)）。
- **结果校验（0.9）**：`quality`（composite action 的 Test step）与 `cross-platform` 的 `Run tests` 都设置 `env: VESSEL_VALIDATE_RESULTS: "1"`。运行时该开关默认关闭；CI 固定开启，让 canonical RPC 的 `result_schema` 与实现同步。校验失败表现为 `rpc.result_invalid` 事件与 `internal` 错误（details 仅 `method` / `path`），先修结果形状，不要靠关闭开关绕过。

### 1.1 0.6.1 修复轮门禁

0.6.1 是对标修复轮，不新增 CI job，把定向回归并入现有 job：

| Job | 新增覆盖 |
|---|---|
| `quality` | 全量 `bun test` 已覆盖新增回归；三件套任一红禁止合并 |
| `architecture` | `check-rpc-methods` 必须与 `docs/ARCHITECTURE.md` 的 `sessions.search` 同步 |
| `offline-integration` | 会话租户隔离（`src/__tests__/session-factory.test.ts`、`packages/core/__tests__/session-backend.test.ts`）、durable tenant/role（`packages/serve/__tests__/gateway.durable.test.ts`）、team REST 角色（`packages/serve/__tests__/team.auth.test.ts`）、CLI flags（`src/__tests__/cli-args.test.ts`）、插件目录/配置（`src/__tests__/plugin-loader.test.ts`、`src/__tests__/plugin-selection.test.ts`）、上下文与取消（`packages/core/__tests__/context-manager.test.ts`、`packages/core/__tests__/guardrail-replacement.test.ts`） |
| `multi-node` | 双向 / 网状节点的事件回声抑制 |
| `web` | Web Markdown、`sessions.search` 与工具卡事件（`apps/web/tests`） |

- 0.6.1 不 bump 版本；`version --check` 仍以 `0.5.0` 为准。
- 修复轮的 P0 验收（显式 `session.storagePath` 多 tenant 隔离、durable 跨 tenant 越权）必须由上述定向测试守；只跑 mock 不算通过。

### 1.2 发布干跑 job（0.5）

- 触发：`pull_request` + `release/**` push；不覆盖 `main` push。
- 命令：`bun run scripts/release-dry-run.ts`（详细检查项与退出码见
  [RELEASE.md §2.1](RELEASE.md)）。
- 目标版本 = 根 `package.json` 版本：`0.9.0` → `0.10.0`（bump 由 1 在集成线统一写入；bump 前 job 仍按上一版本校验）；收口是否再升版由 1 决定。
- 打包到 runner 的 OS 临时目录并在结束后清理；**不上传 artifact、不登录 npm、
  不创建 tag、不发布**。
- 若报 `internal_dependency_version`，说明 `bun.lock` 与 manifest 版本不一致；
  由 ext 在 1 bump 之后用普通 `bun install` 刷新 lock（不要 `--frozen-lockfile`）。

### 1.2.1 安装解析 smoke job（0.10）

- 触发：与 `release-dry-run` 相同（`pull_request` + `release/**` push）。
- 命令：`bun run scripts/smoke-install.ts`（详见 [RELEASE.md §2.2](RELEASE.md)）。
- 覆盖：18 个可发布包 + 根 tarball 的 `npm pack`、本地 `file:` `overrides`
  安装解析、`vessel --version`、`VESSEL_MOCK=1 vessel --tools`。
- 运行在 ubuntu + Node 22（`npm`）；Windows 跳过（`.cmd` bin shim 未验证），
  不作为 `cross-platform` 的一部分。
- 只写 OS 临时目录；**不上传 artifact、不登录 npm、不创建 tag、不发布**。
- 失败即 PR 红；不设 required 时仍应视为发布前必须人工确认的门禁。

### 1.3 0.9 Wave 2B2B 门禁

- **结果校验固定开启**：`quality` 复用的 `.github/actions/quality` 的 Test step 与 `cross-platform` 的 `Run tests` 都带 `VESSEL_VALIDATE_RESULTS=1`；37 个 canonical 方法的 `result_schema` 与实现漂移会让对应 job 失败。运行时默认不校验，因此本地复跑相关测试时需要自己设置该变量。
- **插件生命周期**：插件卸载 / 释放相关测试覆盖 `init` 失败隔离、`dispose` 逆序、幂等与安装回滚；不要在测试里依赖插件释放顺序之外的全局状态。
- **去重键**：跨节点测试覆盖 `incarnation` 代际变化、seq 回退与旧对端（缺 `incarnation` 按 `-`）；去重集合不跨进程持久化，测试不得断言重启后仍去重。
- 全量测试在 Windows 与 POSIX（Docker）上均以同一 env 跑；Windows 的 `cross-platform` 与 ubuntu 的 `quality` 结果不一致时按环境差异排查，不要先关校验。

### 1.4 0.10 发版硬化门禁

- **安装解析 smoke**：`install-smoke` job 与 `release.yml` 的 `verify` 都执行 `scripts/smoke-install.ts`；改 18 个子包或根包 manifest 的 `files` / 依赖版本后必须本地跑一次。失败时先看 `npm pack` 内容与 `file:` overrides 解析，不要靠放宽断言绕过。
- **配置与首启**：`src/__tests__/config-hardening-0.10.test.ts` 覆盖未知 provider 无 `base_url` 的 `ProviderConfigError`、legacy provider 优先级与 deprecation、YAML 错误与来源脱敏；改 `packages/config` 或 `src/provider-factory.ts` 后定向复跑。
- **日志不污染 stdout**：`packages/core/__tests__/runtime-logging.test.ts`、`src/__tests__/runtime-0.10.test.ts` 守卫 Logger 级别 / 脱敏、`process.error` / `shutdown.failed`。任何诊断输出都必须写 stderr；headless / `--json` 的输出断言失败时先查 `console.log`。
- **关闭与 interrupt**：`packages/serve/__tests__/gateway.shutdown.test.ts`、`src/__tests__/shutdown-sequence-0.10.test.ts` 覆盖 `gateway.stop()` 幂等、5s drain、固定关闭顺序与不重复 drain；`packages/core/__tests__/runtime-overflow-interrupt.test.ts` 覆盖 interrupt 原因与 400 overflow 重试。
- **trace 与打包**：`packages/config/__tests__/trace-0.10.test.ts` 覆盖 `includeStreamChunks` 默认关闭与 trace 文件 `0600`；发布前用 `release-dry-run` + `smoke-install` 双门禁。
- **CLI i18n**：`src/__tests__/i18n-0.10.test.ts` 校验 zh-CN / en key 集合一致；新增用户可见文案必须同时改两份 catalog。
- 全量测试在 Windows 与 POSIX（Docker）上以同一 env 跑；平台差异先按环境排查，不要先关校验。

## 2. Release（`.github/workflows/release.yml`）

### 触发

- `push` tag `v*`（稳定版与预发布）。
- 同一 tag 的发布不可取消：`concurrency.cancel-in-progress: false`。

### 步骤（0.5.0：无二进制）

1. `verify`
   - tag 必须在 `main` 上：`git merge-base --is-ancestor "$GITHUB_SHA" origin/main`。
   - 从 tag 提取版本（去掉 `v`）。
   - `bun run scripts/version.ts --check <version>`：所有可发布包版本一致，且 `CHANGELOG.md` 含 `## [<version>]`。
   - `bun run scripts/release-dry-run.ts`：tarball 内容 / 版本 / 禁止文件检查。
   - `bun run scripts/smoke-install.ts`：18 个子包 + 根 tarball 的安装解析与运行 smoke。
   - **任一步失败即停止，`publish-npm` 不会执行。**
2. `quality`：复用 `.github/actions/quality`，发布前再验一次。
3. `publish-npm`
   - **先发布 18 个子包**，顺序固定：`core` → `permission` → `config` → `serve` → `tui` → `plugins`
     （5 个库包 + 13 个插件包，含 `@vessel/team` 与 `@vessel/mcp-client`）。
   - **最后发布根 CLI `vessel-agent`**（依赖前 18 个包的精确版本；bin 仍是 `vessel`）。
     根 `package.json` 的 `name` 不是 `vessel-agent` 时 fail-fast。
   - 稳定版 dist-tag `latest`；预发布（tag 含 `-`）dist-tag `beta`。
   - `npm publish --provenance --access public`（OIDC provenance）。
   - 已存在的版本跳过，便于部分失败后重跑。
4. `github-release`
   - `bun run scripts/latest-json.ts` 生成 `latest.json`（0.5.0 的 `assets` 为空对象）。
   - 创建 GitHub Release：自动 notes；tag 含 `-` 时标记 prerelease。

### 不做（0.5.0）

- 不构建 `bun build --compile` 二进制，不产出 `SHA256SUMS`，不做二进制自更新。
- 后续若重启二进制方案，需先解决插件目录解析并写新 ADR。

### 失败处理

- 不自动重试。
- `verify` / `quality` 失败：什么都没发布，修复后重新打 tag。
- `publish-npm` 部分成功：已发布版本不回滚；修版本后发下一个 patch。重跑时已发布版本会被跳过。
- `github-release` 失败：npm 可能已发布；补发 Release 或直接发下一个 patch。
- 已发布 tag 不删除、不移动。

### `latest.json` 格式

```json
{
  "version": "0.5.0",
  "channel": "latest",
  "released_at": "2026-10-17T00:00:00Z",
  "assets": {}
}
```

- `channel`：稳定版 `latest`，预发布 `beta`。
- 0.5.0 的 `assets` 固定为空。后续若恢复二进制，按平台填 `{ "url": "...", "sha256": "..." }`。

## 3. 用户侧 CD / 自动更新

> 0.3.0 已实现 **check-only** 客户端：`vessel update [--check] [--channel latest|beta] [--json] [--force]`。
> **不下载、不校验、不自替换**。版本源是根 `package.json`（`--version` 同源）。

| 安装方式 | 更新方式 |
|---|---|
| npm / bun 全局安装 | `vessel update` 提示 `bun add -g vessel-agent@<v>`（或 `npm i -g vessel-agent@<v>`）；bin 仍是 `vessel`，由用户执行 |
| 独立二进制 | **不提供**（ADR-006 继续有效）；后续再评估 |
| 源码运行 | `vessel update --check` 只提示新版本，不自动改 git 工作区 |

行为：

- 退出码：`0` 成功（含已最新）；`1` 网络/清单失败；`2` 通道或参数错误。
- 稳定通道：`<source>/releases/latest/download/latest.json`。
- 预发布通道：GitHub releases API 选最新 `prerelease` 的 `latest.json` 资产；`--channel beta` 或 `VESSEL_CHANNEL=beta`。
- 清单源：默认 `https://github.com/egg-rolls/Vessel`；可用 `VESSEL_UPDATE_SOURCE` 或 `update.source` 覆盖（直连 `.json` 或仓库基址，便于测试/镜像）。
- 后台检查：仅交互 TTY、非 mock、`update.autoCheck !== false`、未设 `VESSEL_NO_UPDATE_CHECK`；24h 节流，缓存 `~/.vessel/update-check.json`；1.5s 超时；失败静默，不影响启动。
- 有新版本时发布开放事件 `update.available`：`{ current, latest, channel, installHint }`，`run_id: 'system'`；发布前延迟 300ms 给 Ink 订阅者挂载；TUI 只渲染一行提示。
- 断网、404、JSON 解析失败、版本不合法：静默跳过。
- **不自动执行破坏性更新**；0.5.0 无下载/校验/自替换代码。

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
