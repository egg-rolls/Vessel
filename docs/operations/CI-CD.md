---
title: CI / CD 手册
kind: current
triggers: [CI, CD, 持续集成, 持续交付, 发布流水线, 工作流, workflow, release.yml, 质量门禁, 静态断言, lint, typecheck, build, 烟测, 端到端, 干跑, 本地校验]
paths: [docs/operations/CI-CD.md]
---

# CI / CD 手册

> 维护者：`gov`。分支模型与发布规则见 [FILE-MANAGEMENT.md](../FILE-MANAGEMENT.md)。
> 当前开发线与版本以 [docs/versions/CURRENT.md](../versions/CURRENT.md) 为准。
> 1.0 前只做发布干跑；**不发布独立二进制**（ADR-006 继续有效）。
> **仓库没有 gate / test / probe**（宪法第三、四条）：只有 `bun run build`（typecheck + biome ci）、
> `apps/web` 构建与手工 CLI 端到端冒烟。`scripts/check-*.ts` 已于 2026-11-16 全部删除，
> `release-dry-run` / `smoke-install` 两个脚本同样不在仓库里了 —— 别再按旧口径查找或调用。

## 1. CI：**已移除**（2026-11）

`.github/workflows/ci.yml` 已删除；`.github/actions/quality` **保留** —— `release.yml` 的发布前校验仍在用它。

### 1.1 为什么移除

在「agent 直接提交」的开发范式下，CI 的失败噪声远大于收益：它按 PR / 推送触发、每次失败都发邮件，
而真正拦住问题的从来是**本地门禁**（0.50 收口期间 CI 报的错没有一条影响功能或产物）。
**发布链路不依赖 CI**：`release.yml` 在 tag 时自己跑一遍 `quality`，所以「发布前一定验过」这条保证没有丢。

保留的两个 workflow：`release.yml`（tag → CD）、`sync-labels.yml`（PR 标签同步）。

### 1.2 本地检查（唯一权威）

**仓库里没有 gate / test / probe 脚本**（宪法第三、四条：2026-11-16 删掉了 83 个 `scripts/check-*.ts`，
`bun run gates` 这个脚本条目也已不存在）。现在只有两类检查：

| 步骤 | 命令 | 拦什么 |
|---|---|---|
| 构建（含格式 / 类型） | `bun run build`（= `bun run typecheck` + `bunx @biomejs/biome ci .`） | 格式 / import 顺序 / lint / 跨包类型（含 `examples/`） |
| Web 前端 | `cd apps/web && bun run build` | 产物可构建；**`apps/web` 的跨包类型错误只有它报**（根 typecheck 不覆盖它，且它不在根 workspaces 里，需先 `bun install` / `npm ci`） |

架构硬边界（依赖方向、i18n 对齐、RPC 方法表、事件可见性、时间线不变量…）**不再有脚本断言**，
改为评审项：改到相关路径时由人按对应架构页逐条核对，并在回报里写清核对了哪几条。

### 1.3 提交纪律

`main` 是发布基线：**禁止**把没跑过 `bun run build` 的改动 push 到 `main`。分支上的提交可以随便推（不触发任何 CI）。
PR 没有 required checks，把关靠人 + 构建输出 + verifier 线程的读数。

### 1.4 提示词前缀的审计口径

没有脚本了，改到 hook / system 注入路径时人工过一遍：

- 报告 `HookResult` 构造/返回的 `additionalContext:`（system 注入）与 `ctx.systemPrompt =` 赋值。
- 前者只允许 `packages/core/src/types/hook.ts`、`packages/core/src/runtime/hook-runner.ts`、
  `packages/core/src/runtime/execution-unit.ts` 的旧字段兼容层；后者不允许任何例外。

### 1.5 历史记录（2026-11 移除前的 ci.yml，仅供追溯）

被删掉的 job：`quality`（复用 `./.github/actions/quality`）、`cross-platform`（ubuntu / windows / macos 矩阵）、
`web`、`architecture`、`offline-integration`、`tls-ca` / `frontend-cors`（**占位 job**，只做 install、不含断言）、
`release-dry-run`、`install-smoke`。要恢复时从 git 历史取：
`git log --all -- .github/workflows/ci.yml`；但请先算清「噪声 vs 收益」这笔账。

以下为移除前的原文，保留以便追溯：

#### 触发（历史，已不运行）

- `pull_request` → `main`、`release/**`
- `push` → `main`、`release/**`
- `workflow_dispatch`

同一 ref 的旧 run 自动取消：`concurrency.group = ci-<workflow>-<ref>`，`cancel-in-progress: true`。

#### Job（历史，已不运行）

| Job | Runner | 内容 |
|---|---|---|
| `quality` | ubuntu-latest | 复用 `.github/actions/quality`：`bun install --frozen-lockfile` → Node 22 + `apps/web` `npm ci` → `bun run lint` → `bun run typecheck` → `bun run build`（无 Test step） |
| `cross-platform` | matrix：ubuntu / windows / macos | `bun install --frozen-lockfile` → Node 22 + `apps/web` `npm ci` → `bun run typecheck`；**PR 只跑 ubuntu**，`main` / `release/**` 跑全矩阵 |
| `web` | ubuntu-latest | `apps/web`：`npm ci` → `npm run build`（Node 22，npm cache） |
| `architecture` | ubuntu-latest | `scripts/check-deps.ts` → `scripts/smoke-subpaths.ts` → `scripts/check-docs.ts` → `scripts/check-web-styles.ts` → `scripts/check-i18n.ts` → `scripts/check-rpc-methods.ts` → `scripts/version.ts --check` |
| `offline-integration` | ubuntu-latest | `scripts/check-config-sources.ts` → `scripts/check-trace.ts`；config / trace 均用 mock 或临时目录，**不依赖外网** |
| `tls-ca` | ubuntu-latest | **占位 job**（非 required）：只做 `bun install --frozen-lockfile`，不含 TLS/CA 断言。保留 job 名以免改动 branch protection 语义；TLS/CA 行为只能人工验收 |
| `frontend-cors` | ubuntu-latest | **占位 job**（非 required）：只做 `bun install --frozen-lockfile`，不含 CORS 断言。同上，保留 job 名；CORS 行为只能人工验收 |
| `release-dry-run` | ubuntu-latest | **仅 PR + `release/**` push**：`bun run scripts/release-dry-run.ts`；打包到 OS 临时目录，**不上传、不 publish、不 tag** |
| `install-smoke` | ubuntu-latest | **仅 PR + `release/**` push**：Node 22 + `apps/web` 的 `npm ci` / `npm run build`，再 `bun run scripts/smoke-install.ts`；`npm pack` 全部可发布子包 + 根 tarball，用本地 `overrides` 安装后运行 `vessel --version` / `vessel --tools`（mock，无 Key），并断言根 tarball 含 `apps/web/dist/index.html`；**不上传、不 publish、不 tag**；Windows 默认跳过 |
| `examples` | ubuntu-latest | `bunx tsc -p examples/tsconfig.json --noEmit` → `bun run demo`（关闭上轮 typecheck 盲区） |
| `smoke` | ubuntu-latest | 仅 `main` / `release/**` push：`--version`、`--tools`、headless 文本、stdin、`@file`、`/help`、`/exit`（除 `--version` 外均带 `VESSEL_MOCK=1`） |

### 通用规则

- Bun 安装缓存：`actions/cache` + `~/.bun/install/cache`，key 取 `bun.lock` 哈希。
- **`apps/web` 不在根 `workspaces`**（根只有 `packages/*`、`plugins/*/*`），`bun install` 不会安装 `react` 等前端依赖。凡是要 build / typecheck 前端的 job（`quality`、`cross-platform`、`install-smoke`）必须先执行 `actions/setup-node`（Node 22，npm cache 取 `apps/web/package-lock.json`）+ `apps/web` 下的 `npm ci`；`web` job 自己的 `npm ci` 在独立 job 中，不与其他 job 共享 `node_modules`。
- 门禁任一红 → 禁止合并。
- 工程规则（门禁分级 / 钉版本、两级不变量、产物与反例断言、tree-sha 可追溯）canonical 见
  [AGENTS.md](../../AGENTS.md)「怎么跑与门禁」；本节只记 CI 侧落点。
- 不在 CI 中写入任何真实 API Key；mock 模式覆盖全部冒烟路径。
- 分支保护 required checks：`Quality Checks`、`Web Build`、`Examples`、`Cross Platform (ubuntu-latest)`；0.5 建议把 `Architecture`、`Offline Integration` 与 `Release Dry Run` 也设为 required（由 1 / 仓库管理员在 GitHub 设置）。
- `tls-ca` / `frontend-cors` 是占位 job，只做依赖安装、不设 required。TLS / CORS 的真实行为（证书信任、跨源访问）**没有自动断言**，只能人工验收（见 [REMOTE.md](REMOTE.md)）。

### 1.1 检查口径：只有构建与手工冒烟

- **构建**：`bun run build`（= `typecheck` + `biome ci`）+ `apps/web` 的 `bun run build`。仓库没有测试框架，也不允许有。
- **运行时正确性**：唯一证据是手工 CLI 端到端冒烟（`VESSEL_MOCK=1 bun run src/cli.ts --run "hello"` 等）。
- 行为变更（权限、持久化、远程、Web 交互）**没有自动回归**，合并前必须人工验证并给出 `file:line` 证据；不要因为「构建绿」就认为行为正确。
- 两条不变量仍必须人工守：诊断只走 Logger / stderr，不 `console.log` 到 stdout；新增用户可见文案同时改 zh-CN / en 两份 catalog。

### 1.2 发布前校验（已随脚本删除而失效）

- 原来的 `scripts/release-dry-run.ts` 与 `scripts/smoke-install.ts` **已按宪法删除**：
  tarball 内容 / 包名 / 内部版本 / 安装解析这些检查**不再有自动入口**。
- `.github/workflows/release.yml` 里仍留着调用这两者的两步，tag 时会红；恢复方式只有两种 ——
  把这两步删掉（发布改为人工核对），或由 1 决定重写它们的替代物。**在这之前不要靠 release workflow 判定可发布。**
- 发布前现在必须人工核对的项目见 [RELEASE.md](RELEASE.md) 的发布清单：
  `bun run scripts/version.ts --check`（版本一致性 + CHANGELOG）、`bun run build`、
  `apps/web` 构建产物含 `dist/index.html`、可发布包名与内部依赖恒为 `workspace:*`。

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
- **权限持久化**：gateway 在 `<dataDir>/interactions-<id>.json` 写 `pending` / `answered` / `orphaned`（`<id>` 是内部持久单 id，缺省 `default`，不是 wire 字段）；未知 `requestId` 返回 `not_found`。
- **Web**：权限卡片在 run 卡片内联、跨 session 用顶部待处理条；不得重新引入全局权限遮罩。
- **状态栏**：CJK / emoji 按显示列计算，不用 `.length` 代替。
- **插件生命周期**：`init` 失败隔离、`dispose` 逆序、幂等与安装回滚。
- **结果形状**：canonical RPC 的 `result_schema` 与实现漂移**没有任何自动发现机制**；改 canonical 方法时必须同步 `docs/architecture/gateway-rpc.md`。
- **trace**：`includeStreamChunks` 默认关闭，trace 文件 `0600`；发布前人工核对 tarball 内容与安装解析（原双门禁脚本已按宪法删除）。

架构硬边界（ADR 索引 / 链接 / 文档一致性、样式契约、依赖方向、子路径导出、版本一致性）**没有自动断言**：
2026-11-16 起 `check-*` 脚本已按宪法删除，这些边界改为评审项，改到相关路径时人工核对。

#### 提示词前缀的审计（并入 §1.4）

口径见 §1.4：没有脚本，改到 hook / system 注入路径时人工按那两条规则过一遍。

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
   - **tarball 内容与安装解析：原来的 `release-dry-run` / `smoke-install` 脚本已按宪法删除，
     这两步现在没有执行体** —— 要么由 1 决定重写替代物，要么从 workflow 里删掉、改为人工核对。
   - **任一步失败即停止，`publish-npm` 不会执行。**
2. `quality`：复用 `.github/actions/quality`，发布前再验一次。
3. `publish-npm`
   - 独立 checkout，先执行 Node 22 + `apps/web` 的 `npm ci` / `npm run build`，确保根 tarball 含 Web 控制台。
   - **先发布全部可发布子包**，顺序固定：`core` → `permission` → `config` → `agent` → `serve` → `tui` → `plugins`；具体列表以各 workspace 的 `package.json`（非 `private`）为准。
   - **最后发布根 CLI `vessel-agent`**（依赖全部子包的精确版本；bin 仍是 `vessel`）。
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
