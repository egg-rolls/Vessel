# CI / CD 手册

> 维护者：`gov`。分支模型与发布规则见 [FILE-MANAGEMENT.md](../FILE-MANAGEMENT.md)。
> 当前开发线：0.19（集成分支 `0.19-integration`；manifest 版本由 1 在收口时统一写入，未 tag / 未 publish / 未合并 `main`）。
> 0.1.0 / 0.2 / 0.3.0 / 0.4.0 均未发布；0.5 ~ 0.19 各版本只做发布干跑。0.10 起发布前置增加安装解析 smoke；0.11 起子包使用 `@vessel-agent/*` scope。**不发布独立二进制**（ADR-006 继续有效）。
> **仓库没有自动化测试套件**：CI 只跑 `bun run lint` / `bun run typecheck` / `bun run build`、`scripts/check-*.ts` 静态断言与 `main` / `release/**` push 后的 CLI 端到端烟测。测试运行命令与 `"test"` script 已从仓库和 workflow 中移除，不要再按旧口径查找或调用。

## 1. CI（`.github/workflows/ci.yml`）

### 触发

- `pull_request` → `main`、`release/**`
- `push` → `main`、`release/**`
- `workflow_dispatch`

同一 ref 的旧 run 自动取消：`concurrency.group = ci-<workflow>-<ref>`，`cancel-in-progress: true`。

### Job

| Job | Runner | 内容 |
|---|---|---|
| `quality` | ubuntu-latest | 复用 `.github/actions/quality`：`bun install --frozen-lockfile` → Node 22 + `apps/web` `npm ci` → `bun run lint` → `bun run typecheck` → `bun run build`（无 Test step） |
| `cross-platform` | matrix：ubuntu / windows / macos | `bun install --frozen-lockfile` → Node 22 + `apps/web` `npm ci` → `bun run typecheck`；**PR 只跑 ubuntu**，`main` / `release/**` 跑全矩阵 |
| `web` | ubuntu-latest | `apps/web`：`npm ci` → `npm run build`（Node 22，npm cache） |
| `architecture` | ubuntu-latest | `scripts/check-deps.ts` → `scripts/smoke-subpaths.ts` → `scripts/check-docs.ts` → `scripts/check-web-styles.ts` → `scripts/check-rpc-methods.ts` → `scripts/version.ts --check` |
| `offline-integration` | ubuntu-latest | `scripts/check-config-sources.ts` → `scripts/check-trace.ts`；config / trace 均用 mock 或临时目录，**不依赖外网** |
| `tls-ca` | ubuntu-latest | **占位 job**（非 required）：只做 `bun install --frozen-lockfile`，不含 TLS/CA 断言。保留 job 名以免改动 branch protection 语义；TLS/CA 行为只能人工验收 |
| `frontend-cors` | ubuntu-latest | **占位 job**（非 required）：只做 `bun install --frozen-lockfile`，不含 CORS 断言。同上，保留 job 名；CORS 行为只能人工验收 |
| `release-dry-run` | ubuntu-latest | **仅 PR + `release/**` push**：`bun run scripts/release-dry-run.ts`；打包到 OS 临时目录，**不上传、不 publish、不 tag** |
| `install-smoke` | ubuntu-latest | **仅 PR + `release/**` push**：Node 22 + `apps/web` 的 `npm ci` / `npm run build`，再 `bun run scripts/smoke-install.ts`；`npm pack` 17 个子包 + 根 tarball，用本地 `overrides` 安装后运行 `vessel --version` / `vessel --tools`（mock，无 Key），并断言根 tarball 含 `apps/web/dist/index.html`；**不上传、不 publish、不 tag**；Windows 默认跳过 |
| `examples` | ubuntu-latest | `bunx tsc -p examples/tsconfig.json --noEmit` → `bun run demo`（关闭上轮 typecheck 盲区） |
| `smoke` | ubuntu-latest | 仅 `main` / `release/**` push：`--version`、`--tools`、headless 文本、stdin、`@file`、`/help`、`/exit`（除 `--version` 外均带 `VESSEL_MOCK=1`） |

### 通用规则

- Bun 安装缓存：`actions/cache` + `~/.bun/install/cache`，key 取 `bun.lock` 哈希。
- **`apps/web` 不在根 `workspaces`**（根只有 `packages/*`、`plugins/*/*`），`bun install` 不会安装 `react` 等前端依赖。凡是要 build / typecheck 前端的 job（`quality`、`cross-platform`、`install-smoke`）必须先执行 `actions/setup-node`（Node 22，npm cache 取 `apps/web/package-lock.json`）+ `apps/web` 下的 `npm ci`；`web` job 自己的 `npm ci` 在独立 job 中，不与其他 job 共享 `node_modules`。
- 门禁任一红 → 禁止合并。
- 不在 CI 中写入任何真实 API Key；mock 模式覆盖全部冒烟路径。
- 分支保护 required checks：`Quality Checks`、`Web Build`、`Examples`、`Cross Platform (ubuntu-latest)`；0.5 建议把 `Architecture`、`Offline Integration` 与 `Release Dry Run` 也设为 required（由 1 / 仓库管理员在 GitHub 设置）。
- `tls-ca` / `frontend-cors` 是占位 job，只做依赖安装、不设 required。TLS / CORS 的真实行为（证书信任、跨源访问）**没有自动断言**，只能人工验收（见 [REMOTE.md](REMOTE.md)）。

### 1.1 门禁口径：只有静态检查与烟测

- **代码门禁**：`bun run typecheck` + `bunx @biomejs/biome ci .`（+ CI 里的 `bun run build`）。仓库没有测试框架，不存在可用的测试门禁。
- **结构门禁**：`check-deps` / `smoke-subpaths` / `check-docs` / `check-web-styles` / `check-rpc-methods` / `check-config-sources` / `check-trace` / `version --check` / `release-dry-run`。这些是脚本断言，守架构硬边界，不是测试套件。
- **运行时正确性**：唯一自动证据是 `smoke` job 的 CLI 端到端路径（`VESSEL_MOCK=1 bun run src/cli.ts --run "hello"` 等），只在 `main` / `release/**` push 后跑。PR 不跑运行时行为。
- 行为变更（权限、持久化、远程、Web 交互）**没有自动回归**，合并前必须人工验证并给出 `file:line` 证据；不要因为「CI 绿」就认为行为正确。
- 两条不变量仍必须人工守：诊断只走 Logger / stderr，不 `console.log` 到 stdout；新增用户可见文案同时改 zh-CN / en 两份 catalog。

### 1.2 发布干跑 job（0.5）

- 触发：`pull_request` + `release/**` push；不覆盖 `main` push。
- 命令：`bun run scripts/release-dry-run.ts`（详细检查项与退出码见
  [RELEASE.md §2.1](RELEASE.md)）。
- 目标版本 = 根 `package.json` 版本：`0.10.0` → `0.11.0`（manifest 由 1 在收口时统一 bump；文档不维护版本副本）。
- 0.11 起可发布子包名为 `@vessel-agent/*`（workflow 移除后为 16 个）；`release-dry-run` 会校验包名与内部精确版本。
- 打包到 runner 的 OS 临时目录并在结束后清理；**不上传 artifact、不登录 npm、
  不创建 tag、不发布**。
- 若报 `internal_dependency_version`，说明 `bun.lock` 与 manifest 版本不一致；
  由 ext 在 1 bump 之后用普通 `bun install` 刷新 lock（不要 `--frozen-lockfile`）。

### 1.2.1 安装解析 smoke job（0.10）

- 触发：与 `release-dry-run` 相同（`pull_request` + `release/**` push）。
- 命令：`bun run scripts/smoke-install.ts`（详见 [RELEASE.md §2.2](RELEASE.md)）。
- 覆盖：全部可发布包 + 根 tarball 的 `npm pack`、本地 `file:` `overrides`
  安装解析、`vessel --version`、`VESSEL_MOCK=1 vessel --tools`，以及根 tarball
  必须包含 `apps/web/dist/index.html`。
- **前置构建**：`dist/` 被 `.gitignore` 忽略，job 必须先执行 Node 22 +
  `apps/web` 的 `npm ci` / `npm run build`；未构建时 smoke 失败（exit 1）。
- 运行在 ubuntu + Node 22（`npm`）；Windows 跳过（`.cmd` bin shim 未验证），
  不作为 `cross-platform` 的一部分。
- 只写 OS 临时目录；**不上传 artifact、不登录 npm、不创建 tag、不发布**。
- CI 异步；失败不阻塞 push，发布前人工确认。

### 1.3 人工验收清单（没有自动化回归）

以下不变量没有任何自动化断言，改到相关路径时必须人工验证并在回报中给出 `file:line` 证据：

- **配置与首启**：未知 provider 无 `base_url` 必须报 `ProviderConfigError`；legacy provider 优先级与 deprecation；YAML 错误与来源脱敏。
- **诊断**：只走 Logger / stderr，不 `console.log` 到 stdout；`process.error` / `shutdown.failed` 必须发出。
- **关闭与 interrupt**：`gateway.stop()` 幂等、5s drain、固定关闭顺序、不重复 drain；interrupt 原因与 400 overflow 重试。
- **gateway 生命周期**：参数解析、PID 原子写 / stale 判定（`<dataDir>/gateway.pid` 与日志 `0600`）、三平台服务定义与 daemon 启停；**不得**在 CI 里真的注册服务或修改开发机。
- **热重载**：`gateway.reload` 只承诺 plugins 扫描缓存与 `serve.allowed_origins`，其余字段返回 `requires_restart`；改范围必须同时更新 ADR-075。
- **自更新**：`vessel update` 只按 argv 决定形态，非 TTY 缺 `--yes` 返回 1；不在 CI 执行真实全局安装。
- **CLI 样式**：人类可读输出走 `src/ui-style.ts`，TTY / `NO_COLOR` / `TERM=dumb` 有纯文本回退，`--json` 不带 ANSI。
- **权限生命周期**：默认无限等待、abort → `PermissionAbortedError`、显式正数 `timeoutMs` → `PermissionTimeoutError`、`deadline_at` 条件写入、重复应答幂等 / `conflict`、run 终态 `orphaned` / `run_ended`、POSIX `0600`。
- **权限持久化**：gateway 在 `<dataDir>/interactions-<tenant>.json` 写 `pending` / `answered` / `orphaned`；未知 `requestId` 返回 `not_found`。
- **Web**：权限卡片在 run 卡片内联、跨 session 用顶部待处理条；不得重新引入全局权限遮罩。
- **状态栏**：CJK / emoji 按显示列计算，不用 `.length` 代替。
- **插件生命周期**：`init` 失败隔离、`dispose` 逆序、幂等与安装回滚。
- **结果形状**：canonical RPC 的 `result_schema` 与实现漂移不再由 CI 自动发现；改 canonical 方法时必须同步 `docs/architecture/gateway-rpc.md`。`check-rpc-methods` 只守方法名表，不守结果形状。
- **trace**：`includeStreamChunks` 默认关闭，trace 文件 `0600`；发布前用 `release-dry-run` + `smoke-install` 双门禁。

结构门禁本身仍有自动断言：`check-docs`（ADR 索引 / 链接 / 文档一致性）、`check-web-styles`、`check-deps`（依赖方向）、`smoke-subpaths`（子路径导出）、`version --check`（版本与 CHANGELOG 一致）。

### 1.4 提示词前缀静态审计（收口手动门禁）

- 命令：`bun run check:prompt-prefix`（`scripts/check-prompt-prefix.ts`）。
- 范围：`packages/`、`plugins/`、`src/` 下的非测试 `.ts` / `.tsx` 源码；跳过 `__tests__`、`*.test.ts`、`node_modules`、`dist`。
- 规则：报告 HookResult 构造/返回 `additionalContext:`（system 注入）与 `ctx.systemPrompt =` / `context.systemPrompt =` 赋值。前者只允许 `packages/core/src/types/hook.ts`、`packages/core/src/runtime/hook-runner.ts`、`packages/core/src/runtime/agent-runtime.ts` 的旧字段兼容层；后者不允许任何例外。
- 输出 `path:line: <pattern>`；有命中 exit 1，无命中 exit 0。当前为手动门禁，尚未接入 `.github/workflows/ci.yml`；改 hook 或 system 注入路径后本地跑一次。

## 2. Release（`.github/workflows/release.yml`）

### 触发

- `push` tag `v*`（稳定版与预发布）。
- 同一 tag 的发布不可取消：`concurrency.cancel-in-progress: false`。

### 步骤（0.5.0：无二进制）

1. `verify`
   - tag 必须在 `main` 上：`git merge-base --is-ancestor "$GITHUB_SHA" origin/main`。
   - 从 tag 提取版本（去掉 `v`）。
   - `bun run scripts/version.ts --check <version>`：所有可发布包版本一致，且 `CHANGELOG.md` 含 `## [<version>]`。
   - Node 22 + `apps/web` 的 `npm ci` / `npm run build`：根 tarball 的 `files` 含 `apps/web/dist`，而 `dist/` 被忽略，必须先构建。
   - `bun run scripts/release-dry-run.ts`：tarball 内容 / 版本 / 禁止文件检查。
   - `bun run scripts/smoke-install.ts`：17 个子包 + 根 tarball 的安装解析与运行 smoke，并断言根 tarball 含 `apps/web/dist/index.html`。
   - **任一步失败即停止，`publish-npm` 不会执行。**
2. `quality`：复用 `.github/actions/quality`，发布前再验一次。
3. `publish-npm`
   - 独立 checkout，先执行 Node 22 + `apps/web` 的 `npm ci` / `npm run build`，确保根 tarball 含 Web 控制台。
   - **先发布 17 个子包**，顺序固定：`core` → `permission` → `config` → `agent` → `serve` → `tui` → `plugins`
     （6 个库包 + 11 个插件包，含 `@vessel-agent/agent` 与 `@vessel-agent/mcp-client`；`@vessel-agent/team` 已在 0.17 删除，workflow 插件已在 0.18 删除）。
   - **最后发布根 CLI `vessel-agent`**（依赖前 17 个包的精确版本；bin 仍是 `vessel`）。
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

> 0.12 起 `vessel update` 支持**按安装形态自更新**：`vessel update [--check] [--yes] [--channel latest|beta] [--json]`。
> 版本源是根 `package.json`（`--version` 同源）；不下载二进制、不替换可执行文件。

| 安装方式 | 更新方式 |
|---|---|
| npm 全局安装 | `vessel update` 执行 `npm i -g vessel-agent@latest`（默认确认，`--yes` 跳过）；bin 仍是 `vessel` |
| bun 全局安装 | `vessel update` 执行 `bun add -g vessel-agent@latest` |
| 源码 / 开发模式 | 只提示 `git pull && bun install`，不自动改 git 工作区 |
| 独立二进制 | **不提供**（ADR-006 继续有效）；后续再评估 |

- `--check` 保持只检查与提示，行为与 0.3 一致；不带 `--check` 才执行或提示自更新。
- 非 TTY 且无 `--yes` 返回 1，避免脚本无确认地安装全局包；安装失败返回 1，`--json` 带形态、命令、退出码与末尾输出。
- 成功后提示重启当前进程；`VESSEL_INSTALL_FORM=npm|bun|dev` 可显式覆盖形态检测（CI / 非常规布局）。

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
| `main` | 1 本地 squash 后直接 push；不 force-push；PR 可选（用户要求时）；CI 异步不阻塞 |
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
