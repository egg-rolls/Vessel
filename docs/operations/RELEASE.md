# 发布手册

> 适用版本线：`0.x`。发布由 **tag `v*`** 触发，不由分支名触发。
> 维护者：`gov`；最终发布决定权在 1。
> **0.1.0 / 0.2 / 0.3.0 / 0.4.0 均未发布**；不发布二进制（ADR-006 继续有效）；只发 npm 库包 + GitHub Release。
> **0.5 / 0.11 / 0.12 / 0.13 只做发布干跑**：不 tag、不 push tag、不 `npm publish`、不合并 `main`；
> 发布仍等 1.0.0 之后。
> **0.10 发布前置**：除发布干跑外，新增安装解析 smoke（16 个子包 + 根 tarball）；
> **必须先构建 Web 控制台**（`apps/web` 的 `npm ci` + `npm run build`）——`dist/` 被
> `.gitignore` 忽略，根 tarball 的 `files` 虽然包含 `apps/web/dist`，不构建就会发出缺少
> Web 控制台的根包。smoke 会断言根 tarball 含 `apps/web/dist/index.html`。
> **0.11 包 scope**：16 个可发布子包为 **`@vessel-agent/*`**（6 个库包 + 10 个插件包）；`apps/web` 是 private，不发布。
> 根 CLI 的发布名仍是 **`vessel-agent`**（bin 仍是 `vessel`），必须在 16 个子包之后发布。
> 发布账号需要对 `vessel-agent` npm 组织有写权限。

## 1. 版本语义

- 采用 SemVer：`MAJOR.MINOR.PATCH`。
- alpha 阶段（`0.x`）：breaking 变更 → minor（`0.1` → `0.2`）；新功能 → minor；修复 → patch。
- 预发布：`v0.5.0-beta.1`，npm dist-tag 用 `beta`；稳定版用 `latest`。

## 2. 发布前置条件

- [ ] 目标改动已合并到 `release/<major>.<minor>`。
- [ ] `bun test` / `bun run typecheck` / `bunx @biomejs/biome ci .` 全绿。
- [ ] `cd apps/web && npm ci && npm run build` 成功，且 `apps/web/dist/index.html` 存在。
      这一步必须早于 `release-dry-run` / `smoke-install`：`dist/` 被 `.gitignore` 忽略，
      不构建时根 tarball 会缺少 Web 控制台（smoke 会直接失败）。
- [ ] `CHANGELOG.md` 已更新（Unreleased → `## [<version>] - YYYY-MM-DD`）；0.2 未发布，其条目已并入 `## [0.3.0]`。
- [ ] 根 `package.json` 与所有可发布 workspace `package.json` 版本一致：根包 + **16 个可发布子包**
      （`@vessel-agent/core`、`@vessel-agent/permission`、`@vessel-agent/config`、`@vessel-agent/agent`、
      `@vessel-agent/serve`、`@vessel-agent/tui`
      + 10 个插件包：`basic-tools`、`mcp-client`、`evals`、`feishu`、`hook-logging`、
      `provider-anthropic`、`provider-openai`、`guardrail-pii`、`redact-secrets`、`tool-policy`）。
- [ ] 根包 `package.json` 的 `name` 为 **`vessel-agent`**（bin 仍是 `vessel`）。
- [ ] 16 个可发布子包的 `name` 以 **`@vessel-agent/`** 开头，包间依赖均为 `@vessel-agent/*` 的精确版本；不得残留旧 `@vessel` scope（历史 ADR / CHANGELOG 除外）。
- [ ] `release/*` 已合并到 `main`，且 `main` CI 绿。
- [ ] 仓库 Secrets 已配置 `NPM_TOKEN`。
- [ ] 发布干跑通过：`bun run scripts/release-dry-run.ts`（见 §2.1）。
- [ ] 安装解析 smoke 通过：`bun run scripts/smoke-install.ts`（见 §2.2；仅 POSIX）。

## 2.1 发布干跑（0.5 起）

0.5 不执行 §4 的真实发布步骤，只运行干跑脚本（0.10 另加安装解析 smoke，见 §2.2）：

```bash
bun run scripts/release-dry-run.ts
```

- **目标版本 = 当时的根 `package.json` 版本**：R2 为 `0.4.0`，0.5 收口 bump 后为
  `0.5.0`；脚本不硬编码版本。
- 枚举所有非 `private` workspace 包；文件清单用 `npm pack --dry-run --json`，
  tarball manifest 用实际 `bun pm pack` 到 OS 临时目录后解析；结束后清理。
  临时文件不进入仓库，也不上传 CI artifact。
- 检查项：
  1. 包版本与根版本一致；
  2. tarball manifest 的任何依赖字段不含 `workspace:*` / `file:`；
  3. `@vessel-agent/*` 内部依赖的精确版本等于根版本；
  4. 必填字段 `name` / `version` / `main` 或 `exports` / `types`；
  5. tarball 不含 `.env`、密钥、数据库、日志、覆盖率/测试产物；
  6. `CHANGELOG.md` 含 `## [<根版本>]`。
- 退出码：`0` 通过；`1` 检查失败；`2` 用法/根配置错误。
- **不做**：不创建 tag、不 push、不调用 `npm publish`、不合并 `main`、不上传 artifact。

**收口顺序（DECISION-009 §12.3）**：

1. 六轨合入 `release/0.5`，qa 能力门禁通过；
2. **1 运行 `scripts/version.ts` 写模式 → 全部 manifest 升到 0.5.0**；
3. **ext 在 bump 之后用普通 `bun install` 刷新 `bun.lock`（不要 `--frozen-lockfile`）**，
   确保 lock 记录 0.5.0；
4. gov 写 `CHANGELOG.md` 的 `## [0.5.0]`；
5. 复跑 `version --check`、`release-dry-run`、三件套与 qa 最终门禁；
6. 仍然**不 tag、不 push、不 publish、不合并 `main`**。

若干跑报 `internal_dependency_version`，说明 `bun.lock` 与 manifest 版本不一致
（`bun pm pack` 会按 lock 改写 `workspace:*`）；由 ext 在 bump 后刷新 lock，不要改干跑脚本绕过。

## 2.2 安装解析 smoke（0.10，发布前置）

干跑只检查 tarball 内容；smoke 进一步验证「发布后的包能被 npm 装上并运行」：

```bash
bun run scripts/smoke-install.ts          # POSIX / CI
bun run scripts/smoke-install.ts --force  # Windows 上强制尝试（默认跳过）
```

- **前置**：`apps/web/dist/index.html` 必须存在（先 `cd apps/web && npm ci && npm run build`）。
  脚本在打包根包前检查该文件，并断言根 tarball 的文件清单包含
  `apps/web/dist/index.html`；缺失时 smoke 失败（exit 1），不会静默发出缺 Web 的包。
- 对全部 16 个可发布子包与根包执行 `npm pack` 到 OS 临时目录。
- 临时工程写入与 `overrides` 完全一致的 `file:` 依赖，`npm install --no-save`
  根 tarball + 16 个子包；根包对 `@vessel-agent/*` 的精确版本依赖全部指向本地 tarball，
  因此**不需要这些版本已经发布到 npm**。
- 运行 `vessel --version`（等于根版本）与 `VESSEL_MOCK=1 vessel --tools`
  （断言 `bash` / `read` / `edit`），不需要 API Key。
- 任一检查失败返回非 0；结束后清理临时目录（`--keep` 可保留）。
- Windows 默认跳过（npm `.cmd` bin shim 与 `file:` override 语义未验证），
  只在 ubuntu / CI 作为门禁；`--force` 仅供本地排查。
- **不做**：不创建 tag、不 push、不 `npm publish`、不上传 artifact。

发布顺序在 `.github/workflows/release.yml` 中固定为：
**先 16 个子包**（core → permission → config → agent → serve → tui → plugins），
**最后根 `vessel-agent`**（它依赖前 16 个包的精确版本）。

## 2.3 0.12 运行形态与发布前确认

0.12 引入 gateway 生命周期与包级自更新，发布前需要额外确认：

- **gateway 入口**：常驻统一为 `vessel gateway start --daemon`；`--serve` 是前台别名。发布说明不得再教用户自行 `nohup` / `&`。PID 文件 `<dataDir>/gateway.pid` 与日志 `<dataDir>/logs/gateway.log` 均为 `0600`。
- **服务注册**：`vessel gateway install-service` 只注册当前平台的用户级服务（systemd user / LaunchAgent / Windows 登录计划任务）；发布说明需注明不提供 root 服务，daemon 自身不做崩溃重启，常驻交给服务管理器。
- **热重载边界**：`gateway.reload` 只承诺 plugins 扫描缓存与 `serve.allowed_origins`；其它配置字段返回 `requires_restart`。release notes 不得把“reload 成功”写成“所有配置已生效”。
- **自更新**：`vessel update` 只对 npm / bun 全局安装执行 `npm i -g vessel-agent@latest` / `bun add -g vessel-agent@latest`；源码 / 开发模式只提示，非 TTY 必须 `--yes`。不提供二进制替换（ADR-006）。
- **CLI 样式**：人类可读输出走 `src/ui-style.ts`，`--json` 与数据行无 ANSI；CI 日志与管道不依赖颜色。
- **0.11.1 并入**：0.11.1 不单独发布，权限 TTL / 超时、`ui.showReasoning` 与 `agent.cwd` 的修复只出现在 0.12.0 的 CHANGELOG，不要创建 `0.11.1` tag。
- **版本线**：0.12.0 仍未 tag / `npm publish` / 合并 `main`；版本号与 `bun.lock` 由 1 在收口时统一写入。

## 2.4 0.13 状态栏与权限生命周期发布前确认

0.13 改变权限交互与 TUI 布局，发布说明与验收需要额外确认：

- **权限等待默认不超时**：release notes 不得再写「权限弹窗 120s 过期」或「超时自动失败」。权限一直等待应答 / 取消 / abort；只有宿主显式配置正数 `timeoutMs` 才超时。`ask_user` 仍是全局弹窗，继续按 `event.ts + 120s` 计算有效期。
- **持久化文件**：gateway 在 `<dataDir>/interactions-<tenant>.json` 写 `pending` / `answered` / `orphaned`（`0600` 原子写）。发布说明可写“重启后旧请求标记为已结束 / 迟到应答返回 `run_ended`”，不得写“跨重启恢复 pending 并继续应答”。
- **Web 内联权限**：权限卡片在 run 卡片内，跨 session 用顶部待处理条；`ask_user` 仍是全局弹窗。release notes 不得宣称所有交互都已内联。
- **状态栏**：`Ctrl+T` / `Ctrl+G` / `Ctrl+R` 与新下栏在 release notes 中列出；`ui.statusBars`（YAML `status_bars`）可持久化显隐，`VESSEL_STATUS_BARS` 只作启动初值。终端 `<40` 列不显示下栏、`<18` 行默认隐藏。
- **0.12.1 并入**：0.12.1 不单独发布，斜杠提示 72 列上限移除、`computeDialogWidth = cols-4`、`InlineAutocomplete` resize、品牌色 `#c2a273` 与 `/exit` Goodbye 只出现在 0.13.0 的 CHANGELOG，不要创建 `0.12.1` tag。
- **版本线**：0.13.0 仍未 tag / `npm publish` / 合并 `main`；版本号与 `bun.lock` 由 1 在收口时统一写入。

## 3. 版本脚本

```bash
# 只校验（日常/CI）
bun run scripts/version.ts --check 0.5.0

# 写入根、packages/*、plugins/*/*、apps/web 的版本（发布收口时由 1 执行）
bun run scripts/version.ts 0.5.0

# 预演，不落盘
bun run scripts/version.ts 0.5.0 --dry-run
```

规则：

- `--check` 同时校验所有可发布包版本一致，以及 `CHANGELOG.md` 含 `## [<version>]`。
- 根 `package.json` 的 `version`（0.3.0 起已加入）与所有 workspace 包一起校验；`--version` 也从这里读取。
- 写模式会机械改写各包 `package.json`，**只由 1 在发布收口执行**；日常开发不运行写模式。
- 脚本不做 git 操作（commit / tag 仍手工执行）。

## 4. 发布步骤

```bash
# 1. 切到 main 并确认干净
git switch main
git pull --ff-only
git status --short

# 2. 构建 Web 控制台（根 tarball 的 files 含 apps/web/dist）
cd apps/web && npm ci && npm run build && cd ../..

# 3. 统一版本（示例：0.5.0）
bun run scripts/version.ts 0.5.0

# 4. 更新 CHANGELOG.md（把 Unreleased 改成 ## [0.5.0] - YYYY-MM-DD）
# 5. 提交版本提交（中文/复杂 message 用 -F 文件，避免 shell 编码问题）
git add package.json packages/*/package.json plugins/*/*/package.json apps/web/package.json CHANGELOG.md
git commit -F <personal>/docs/tmp/release-msg.txt

# 6. 打 annotated tag 并推送
git tag -a v0.5.0 -m "v0.5.0"
git push origin main
git push origin v0.5.0
```

推送 tag 后由 `.github/workflows/release.yml` 自动完成：

1. `verify`：校验 tag 在 `main` 上、版本一致、CHANGELOG 有该版本；
   先执行 Node 22 + `apps/web` 的 `npm ci` / `npm run build`，再运行
   `scripts/release-dry-run.ts` 与 `scripts/smoke-install.ts`。
   **任一步失败即停止，不会进入 publish。**
2. 复跑 quality。
3. `npm publish`：`publish-npm` 是独立 checkout，会再次构建 Web 控制台；
   **先 16 个子包**
   （core → permission → config → agent → serve → tui → plugins），
   **最后根 `vessel-agent`**（`--provenance --access public`，稳定版 `latest` / 预发布 `beta`）。
   根包名不是 `vessel-agent` 时 workflow fail-fast。
4. 创建 GitHub Release：自动 notes + `latest.json`（`assets: {}`）。
5. **不构建二进制、不产出 sha256**。

发布顺序：`verify → quality → publish-npm（16 个子包 → 根 vessel-agent）→ github-release`。

发布后用户侧：`vessel update --check` 读取 `latest.json`，只提示版本与安装命令；0.5.0 不做下载/自替换。

## 5. 预发布

```bash
git tag -a v0.5.0-beta.1 -m "v0.5.0-beta.1"
git push origin v0.5.0-beta.1
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
- npm 回滚：`npm dist-tag add @vessel-agent/core@<last-good> latest`，再发 patch 修复。
- GitHub Release：不删除旧 tag；如有需要，把旧版本重新标记为 latest 资产，再发 patch。
- 0.5.0 无二进制，不涉及二进制回滚。

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
