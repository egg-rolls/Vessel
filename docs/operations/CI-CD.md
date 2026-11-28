---
title: CI / CD 手册
kind: current
triggers: [CI, CD, 持续集成, 持续交付, 发布流水线, 工作流, workflow, release.yml, 质量门禁, lint, typecheck, build, 烟测, 端到端, 干跑, 本地校验]
paths: [package.json, .github/workflows/**, .github/actions/quality/action.yml, scripts/version.ts, scripts/latest-json.ts, src/cli/commands/cli-update.ts, src/update/**]
---

# CI / CD 手册

> 维护者：`gov`。分支模型与发布规则见 [FILE-MANAGEMENT.md](../FILE-MANAGEMENT.md)；发布操作步骤见 [RELEASE.md](RELEASE.md)。
> 当前版本线 `2.x`，发布由 **tag `v*`** 触发；当前版本以 [docs/versions/CURRENT.md](../versions/CURRENT.md) 为准。
> **不发布独立二进制**（ADR-006 继续有效）。**仓库没有 gate / test / probe**（宪法第三、四条）：
> 只有 `bun run build`、`apps/web` 产物构建与手工 CLI 端到端冒烟；`check-*` / `release-dry-run` / `smoke-install`
> 脚本均已按宪法删除，别再按旧口径查找或调用。

## 1. CI：已移除，本地检查是唯一权威

- `.github/workflows/ci.yml` 已删除（2026-11：agent 直接提交范式下失败噪声远大于收益，真正拦住问题的是本地门禁；追溯从 git 历史取：`git log --all -- .github/workflows/ci.yml`）。`.github/actions/quality` **保留**——`release.yml` 的发布前校验仍在用它。
- 现存三个 workflow：`release.yml`（tag → CD，§2）、`version-check.yml`（main push → `bun run scripts/version.ts --check`，manifest 一致性 + CHANGELOG 门禁）、`sync-labels.yml`（PR 标签同步）。
- **发布链路不依赖 CI**：`release.yml` 在 tag 时自己跑一遍 `quality`，「发布前一定验过」这条保证没有丢。

### 1.1 本地检查

| 步骤 | 命令 | 拦什么 |
|---|---|---|
| 构建 | `bun run build`（= `scripts/build.ts`：`typecheck` + `biome ci .`） | 类型（根 + `examples/` + `apps/web`）/ lint / import 顺序；每步显式判返回码并扫输出错误证据，任一不过即非 0 退出 |
| Web 产物 | `cd apps/web && npm ci && npm run build` | 前端产物可构建；`apps/web` 不在根 workspaces，依赖单独装；根 tarball `files` 含 `apps/web/dist`，发布打包前必须先构建 |
| 运行时行为 | `VESSEL_MOCK=1 bun run src/cli.ts --run "hello"` | 手工端到端冒烟；行为变更**没有自动回归**，合并前人工验证并给 `file:line` 证据，「构建绿」≠ 行为正确 |

- 架构硬边界（依赖方向、i18n 对齐、RPC 方法表、事件可见性、时间线不变量…）**没有脚本断言**，改为评审项：改到相关路径时按对应架构页逐条人工核对，并在回报里写清核对了哪几条。
- 两条不变量仍人工守：诊断只走 Logger / stderr，不 `console.log` 到 stdout；新增用户可见文案同时改 zh-CN / en 两份 catalog。

### 1.2 提交纪律与提示词前缀审计

- `main` 是发布基线：**禁止**把没跑过 `bun run build` 的改动 push 到 `main`；分支上的提交可以随便推（不触发任何 CI）；PR 没有 required checks，把关靠人 + 构建输出。
- 改到 hook / system 注入路径时人工过一遍：`HookResult` 的 `additionalContext:` 只允许 `packages/core/src/types/hook.ts`、`packages/core/src/runtime/hook-runner.ts`、`packages/core/src/runtime/execution-unit.ts` 的旧字段兼容层；`ctx.systemPrompt =` 赋值不允许任何例外。

### 1.3 发布前校验与人工验收

- `release-dry-run.ts` / `smoke-install.ts` 已按宪法删除，`release.yml` 对应死步骤已移除：tarball 内容 / 包名 / 内部版本 / 安装解析改为**发布前人工核对**，清单见 [RELEASE.md](RELEASE.md) §2.1 / §2.2。
- `version-check.yml`：main push（无 tag）自动跑 `version.ts --check`，不靠人记得。
- 人工验收项（没有任何自动断言，改到相关路径时按对应架构页验证并给证据）：配置与首启（`ProviderConfigError` / YAML 错误脱敏）、关闭与 interrupt（`gateway.stop()` 幂等 / 有界停服 / 固定关闭顺序 / interrupt 原因）、gateway 生命周期（PID 原子写 / stale 判定 / `0600` / 三平台服务）、热重载（`gateway.reload` 只承诺 plugins 扫描缓存与 `serve.allowed_origins`，其余 `requires_restart`；改范围同步更新 ADR-075）、自更新（§3）、CLI 样式（`src/cli/output.ts`，`--json` 无 ANSI）、权限生命周期（默认无限等待 / abort / 显式正数 `timeoutMs` / `interactions-<id>.json` `0600`）、Web 内联权限卡、状态栏按显示列计算、插件生命周期（`init` 失败隔离 / `dispose` 逆序）、canonical RPC `result_schema` 漂移（改 canonical 方法同步 [gateway-rpc.md](../architecture/gateway-rpc.md)）、trace（`includeStreamChunks` 默认关 / `0600`）。

## 2. Release（`.github/workflows/release.yml`）

- 触发：`push` tag `v*`（稳定版与预发布）；同一 tag 的发布不可取消（`concurrency.cancel-in-progress: false`）。
- 步骤固定顺序 `verify → quality → publish-npm → github-release`：
  1. `verify`：tag 必须在 `main` 上（`git merge-base --is-ancestor`）；从 tag 提取版本；`version.ts --check <version>`（所有可发布包版本一致 + `CHANGELOG.md` 含 `## [<version>]`）；Node 22 + `apps/web` 的 `npm ci` / `npm run build`。**任一步失败即停止，`publish-npm` 不会执行。**
  2. `quality`：复用 `.github/actions/quality`，发布前再验一次。
  3. `publish-npm`：独立 checkout，先 Node 22 + `apps/web` 构建；**先全部可发布子包**（core → permission → config → agent → serve → tui → plugins，清单以各 workspace 非 `private` 的 `package.json` 为准），**最后根 `vessel-agent`**（依赖全部子包精确版本；根 `name` 不是 `vessel-agent` 时 fail-fast）；`npm publish --provenance --access public`（OIDC）；稳定版 dist-tag `latest`，预发布（tag 含 `-`）`beta`；已存在版本跳过，便于部分失败后重跑。
  4. `github-release`：`bun run scripts/latest-json.ts` 生成 `latest.json`；创建 GitHub Release（自动 notes；tag 含 `-` 标记 prerelease）。
- **不做**：不构建 `bun build --compile` 二进制、不产出 `SHA256SUMS`、不做二进制自更新；重启二进制方案需先解决插件目录解析并写新 ADR。
- 失败处理：不自动重试；`verify` / `quality` 失败 = 什么都没发布，修复后重新打 tag；npm 部分成功不回滚，重跑跳过已发布版本；`github-release` 失败补发 Release 或发下一个 patch；已发布 tag 不删除、不移动；任何情况不 force-push `main` / `release/*`。

`latest.json` 形状（`assets` 固定空对象；后续若恢复二进制按平台填 `{url, sha256}`）：

```json
{ "version": "<version>", "channel": "latest", "released_at": "<ISO8601>", "assets": {} }
```

## 3. 用户侧 CD / 自动更新

`vessel update [--check] [--yes] [--channel latest|beta] [--json]` 按安装形态自更新；版本源是根 `package.json`（`--version` 同源）；**不下载二进制、不替换可执行文件**（CLI 契约见 [cli-wiring.md](../architecture/cli-wiring.md#update)）。

| 安装形态 | 更新方式 |
|---|---|
| npm 全局 | `npm i -g vessel-agent@latest`（默认确认，`--yes` 跳过）；bin 仍是 `vessel` |
| bun 全局 | `bun add -g vessel-agent@latest` |
| 源码 / 开发 | 只提示 `git pull && bun install`，不自动改 git 工作区 |
| 独立二进制 | **不提供**（ADR-006） |

- `--check` 只检查与提示；不带 `--check` 才执行或提示自更新。非 TTY 且无 `--yes` 返回 1；安装失败返回 1；`--json` 带形态、命令、退出码与末尾输出。退出码：`0` 成功（含已最新）/ `1` 网络/清单失败 / `2` 通道或参数错误。
- `VESSEL_INSTALL_FORM=npm|bun|dev` 显式覆盖形态检测（CI / 非常规布局）；成功后提示重启当前进程。
- 清单源：稳定通道 `<source>/releases/latest/download/latest.json`；预发布通道经 GitHub releases API 选最新 `prerelease` 的 `latest.json` 资产（`--channel beta` 或 `VESSEL_CHANNEL=beta`）。默认源 `https://github.com/egg-rolls/Vessel`，可用 `VESSEL_UPDATE_SOURCE` 或 `update.source` 覆盖（直连 `.json` 或仓库基址）。
- 后台检查：仅交互 TTY、非 mock、`update.autoCheck !== false`、未设 `VESSEL_NO_UPDATE_CHECK`；24h 节流，缓存 `~/.vessel/update-check.json`；1.5s 超时；失败静默不影响启动。有新版本发布 `update.available`（`{current, latest, channel, installHint}`，`run_id: 'system'`；发布前延迟 300ms 给 Ink 订阅者挂载），TUI 只渲染一行提示。断网 / 404 / JSON 解析失败 / 版本不合法静默跳过。

## 4. 分支保护与权限

canonical 见 [FILE-MANAGEMENT.md](../FILE-MANAGEMENT.md) §7.1：`main` 由 1 本地 squash 后直接 push，不 force-push，PR 可选（用户明确要求时），CI 异步不阻塞；`release/*` 只有 1 可合并；`<version>-<role>` 只有该角色 N 可写；tag `v*` 只有 1 / CI 可创建，禁止删除已发布 tag。

## 5. Secrets

| 名称 | 用途 | 使用位置 |
|---|---|---|
| `NPM_TOKEN` | npm 发布（automation token） | `publish-npm` |
| `GITHUB_TOKEN` | GitHub Release | `github-release` |
| `id-token: write` | npm provenance（OIDC，无 secret） | `publish-npm` |

任何 Key 不得写入仓库；本地开发用 `.env`（已忽略）。