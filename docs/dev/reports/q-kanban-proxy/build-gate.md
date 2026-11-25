# q-kanban-proxy ③ build 门禁报告

日期：2026-11-25 · 分支 fix/q-kanban-proxy · HEAD d4fa28f2

## 门禁结果：通过

- 命令：`bun run build`（worktree 根，WSL → Windows bun 1.3.9，本机既定工作流）
- **BUILD_EXIT=0**（脚本内显式 echo 实证；build.ts 自身双重判据：每步 rc + 输出错误证据扫描）
- 日志：`C:\Users\Lirui\.vessel\data\tool-output\e85de146-e6ea-4a67-9e1b-3beb6405c698\bash-async\bash-async-1d820258.log`（484952 B）

## 步骤实证（日志摘录）

1. `1️⃣ Type check（root + examples + apps/web）`：`tsc --noEmit && tsc -p examples --noEmit && bun run --cwd apps/web typecheck` → **✅ 通过**；全日志 `error TS` 计数 = 0。
2. `2️⃣ Lint（biome ci .）`：Checked 1332 files，**25 warnings / 42 infos，0 errors** → **✅ 通过**。
3. 末尾 `📦 Build complete!`（build.ts 只在全部步骤通过后打印）。

## 警告归属核实

cli.ts:1728/1738/1744/1749 的 `noNonNullAssertion` 警告为**存量**
（`gatewayBundle.timelineLog!.watermark(...)`，HEAD~1 同内容，仅因本次 +9 行位移）；
本次改动文件（proxy-config.ts / methods/config.ts / ui-settings.ts /
gateway-reload-wiring.ts / cli.ts 新增行）无新增警告。

## 过程记录

- 首跑 build 前置检查失败（apps/web 依赖未装，BUILD_EXIT=1）→
  根 `bun install`（482 packages，exit 0）+ `apps/web bun install`（86 packages，exit 0）→ 重跑通过。
- 零测试/探针（宪法）；未触碰生产 checkout / ~/.vessel；只提交本分支。

## 提交链

- e9dd408e ①调研报告（docs/dev/reports/q-kanban-proxy/investigation.md）
- d4fa28f2 ②修复（6 文件 +85/-7：proxy 白名单 kanban + config.set kanban.boardPath + applyKanban 热应用 + CONFIG.md §2.25）
- 本文件 ③门禁报告