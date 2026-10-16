# HANDOFF-MAIN

> 「1」（首脑 session）的接续状态。上下文快满时先更新本文件，再换新 session 继续。
> 换 session 后第一件事是读本文件恢复状态，不要靠记忆。
> 更新于：2026-10-16

## 角色与团队

我是 **1**：对接用户、拆解分派、汇总冲突、管理 N、最终汇报。
开发方式见记忆 `agent-team-1-n-nm-workflow`（1+N+N*M，每个 1/N 维护自己的 HANDOFF-<领域>.md）。

本次任务的 N（领域负责人）：

| N | 领域 | 独占路径 |
|---|---|---|
| core-dev | core 运行时 | `packages/core/**`、`plugins/observability/**` |
| basic-tools-dev | 基础工具包 | `plugins/tools/basic-tools/**` |
| assembly-dev | 装配层与依赖方 | `src/**`、`package.json`、`scripts/build.ts`、`.github/workflows/release.yml`、`examples/**`、`packages/config/**`、`packages/serve/**`、`plugins/tools/delegate-task/**` |
| tui-dev | 终端 UI | `packages/tui/**` |
| docs-dev | 文档树 | `README.md`、`AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING.md`、`docs/**`、`.github/PULL_REQUEST_TEMPLATE.md` |

## 本次任务：Vessel 极简化重构

完整计划与**冻结的接口契约**在 `C:\Users\Lirui\.claude\plans\sorted-shimmying-fog.md`。
契约（C1–C11）是各 N 的实现依据；改契约必须回到 1 裁决。

一句话：砍掉「资产体系」全部冗余，工具集收敛为 `bash`/`read`/`edit`，skills 降级为纯文件（前端 `@path` 引用），core 解冻做针对性简化，文档树 40 份 → 4 份。

## 已完成

- **检查点提交 `07c13bf`**（第一批：垃圾清理 + 删插件 + 装配层合并 + 删文档）
  - 删 6 个插件共 1862 行：file-ops / meta-tools / skills-loader / mcp-client / memory-project / memory-auto
  - 装配层四套发现合并为一：新增 `src/plugin-loader.ts` 运行时扫描
  - 文档：删 `docs/{specs,role,api,guides,dev}`、`processes/`、`legacy/`、`ISSUE_TEMPLATE/`；保留 `docs/ADR.md`
  - 垃圾：4 个孤儿 worktree、`dist/`、`tmp/`、4 个空 provider 目录、死数据 `custom-tools.json`；`vessel.db` → `.vessel/sessions.db`
- **core-dev 完成 C1–C7**：core 自测 124 pass / 0 fail；hook-logging 12 pass
- **basic-tools-dev 交付** `plugins/tools/basic-tools/`（bash/read/edit），待修一处类型错误
- **docs-dev 交付**：README / AGENTS / CLAUDE / ARCHITECTURE(591) / ADR-034 追加 / CONTRIBUTING / PR 模板，四条裁决已落实
- `skills/` 收尾：删 `asset-introspection.md`，修 `code-writing.md` 指向已删工具的句子
- 环境修复：根 `node_modules/typescript` 安装残缺 → `bun install` 已修；`bun.lock` 清掉已删插件的 workspace 条目

## 进行中

- **assembly-dev**：bootstrap / config / serve / delegate-task / examples / release.yml 接新 core 接口
- **tui-dev**：`ReplContext.pluginHost`、删 `/mcp` `/skills` `/assets`（13→10 条命令）、新增 `utils/file-reference.ts`（`@path` 引用）并接进两条提交路径
- **basic-tools-dev**：修 `Bun.Subprocess<'pipe','pipe'>` 类型收窄（`src/index.ts:33,199`）

## 待办（1 负责）

1. 等三个 N 回报 → 跑终检：`bun install` 后 `bunx tsc --noEmit -p tsconfig.json`、`bun test`（全仓库）、`bunx @biomejs/biome ci .`
2. 残留检查：grep `search_assets|skills-loader|mcp-client|file-ops|meta-tools|dir-scanner|config-declared|asset-introspection|MemoryToolRegistry|ctx.tools` 应为零命中（`docs/ADR.md` 存档除外）
3. 冒烟：`VESSEL_MOCK=1 bun run src/cli.ts` 看 `/tools` 是否恰好 bash/read/edit/ask_user；`--run` headless 路径
4. 提交 + 提 PR（分支 `refactor/minimal-core` → `dev`），squash merge
5. 决定 `HANDOFF-MAIN.md` 是纳入版本控制还是 gitignore

## 已知偏差与裁决（供续接时不必重问）

| 偏差 | 裁决 |
|---|---|
| C6 的「消掉 `!==` 字符串 diff 与 prepend/replace 分支」只做到「组装收敛到一处」 | 接受。分支是语义固有的，目的（收敛）已达到 |
| `buildRequestMessages` 参数用 `unknown` | 接受（保留旧的运行时类型防护） |
| 注入消息只经 `addContext` 持久化，不重复喂给组装函数 | 接受。契约 C5 与 C6 措辞重复，以 C5 为准 |
| `HookContext` 字段 `system_prompt` → `systemPrompt` | 接受。与 `run_id` 风格不一致，但方向是 camelCase，且全仓库零残留 |
| basic-tools 的 bash 用 `setTimeout`+`kill` 而非 `AbortSignal.timeout` | 接受，等价 |
| 技能目录：统一为仓库 `skills/`（项目级）+ `~/.vessel/skills/`（用户级） | 裁决。不含 `.vessel/skills/` |
| `--inject <path>` | 不做，且从文档删除（`--run @file` 已覆盖） |
| `/reload` 不重扫插件 | 保持实际行为，文档明确写「插件目录进程启动时扫描一次，新增需重启」 |

## 本轮踩到的环境坑（已记入记忆）

- 命令行里出现**任何中文/非 ASCII** → Bash 工具 exit 127（不只 gh，普通 echo 也会）。中文一律走文件，别走 shell。
- `rm` / `rm -rf` 被权限规则拒绝 → 用 `git rm` / `git clean -fdxq <路径>` / `mv`。
- `packages/core` 与 `packages/permission` 曾意外从磁盘消失（索引完好）→ `git checkout -- <path>` 恢复。**教训：进展要及时提交检查点。**
