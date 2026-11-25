# q-ti5-manifest ② build 门禁报告（ISSUE-TI5-1）

日期：2026-11-25 · 分支 fix/q-ti5-manifest · 修复 HEAD bbf61719

## 门禁结果：通过

- 命令：`set -o pipefail; bun run build 2>&1 | tee build.log; echo EXIT=$?`（worktree 根，WSL → Windows bun，本机既定工作流）
- **EXIT=0**（pipefail 兜底实证；build.ts 自身双重判据：每步 rc + 输出错误证据扫描）
- 日志：`C:\Users\Lirui\.vessel\data\tool-output\a71eb810-e7a4-431a-87db-3821f8d1d28c\bash-async\bash-async-69376e9f.log`（484946 B）；worktree 根 `build.log`（484939 B，gitignore 不入库）
- 本仓无 bundle 步骤（ADR-006），📦 即 build.ts 全步骤通过标记。

## 步骤实证（build.log 摘录，去 ANSI）

1. `1️⃣ Type check（root + examples + apps/web）`：`tsc --noEmit && tsc -p examples --noEmit && bun run --cwd apps/web typecheck` → **✅ 通过**（log L5）；全日志 `error TS` 计数 = **0**。
2. `2️⃣ Lint（biome ci .）`：`Checked 1344 files in 407ms. No fixes applied.` → **Found 25 warnings / 42 infos，0 errors** → **✅ Lint（biome ci .） 通过**（log L692 内嵌）。
3. `📦 Build complete!`（log L702 内嵌；build.ts 只在全部步骤通过后打印）。

## 警告归属核实

- 25 warnings / 42 infos 与既有基线（q-kanban-proxy 门禁报告，25/42）**完全一致** → 全存量，零新增。
- 本次唯一改动文件 `plugins/context/thinking-intensity/package.json` 在 lint 输出中**零出现**（grep 'thinking-intensity' build.log 无命中）。
- 警告分布均为存量文件：context-notice.ts(12)、archive-notice.ts(10)、cleared-tool-result.ts(8)、vault.ts(5)、request-sequence.ts(5)、cli.ts(4)、ssrf.ts(4) 等。

## 修复内容（commit ① bbf61719，单文件 15+/15-）

`plugins/context/thinking-intensity/package.json`：vessel.contributes.i18n en/zh-CN 两块 5 个大写键纯机械重命名为 snake_case 小写（值文案不动），同步 settings titleKey/descriptionKey 引用：

| 旧键（违 `^[a-z0-9][a-z0-9._-]*$`） | 新键 |
| --- | --- |
| thinking-intensity.settings.defaultLevel | thinking-intensity.settings.default_level |
| thinking-intensity.settings.defaultLevel.desc | thinking-intensity.settings.default_level.desc |
| thinking-intensity.settings.budgetLow | thinking-intensity.settings.budget_low |
| thinking-intensity.settings.budgetMedium | thinking-intensity.settings.budget_medium |
| thinking-intensity.settings.budgetHigh | thinking-intensity.settings.budget_high |

settings 引用同步：default_level 的 titleKey/descriptionKey（2 处）+ budget_low/budget_medium/budget_high 的 titleKey（3 处）。其余键（enabled/experimental/level.*/toolbar.label）已小写不动。

## 修复后校验实证

- **键模式**：bun 脚本遍历 i18n en/zh-CN 共 **30 键全匹配** `^[a-z0-9][a-z0-9._-]*$`（bad=0）；settings 全部 titleKey/descriptionKey 在 en 块存在（无悬空，settings_refs_ok=true）。
- **grep 零残留**：`grep -rn -E 'defaultLevel|budgetLow|budgetMedium|budgetHigh' plugins/ apps/ packages/ src/`（排除 node_modules）唯一命中 `plugins/context/thinking-intensity/src/state.ts:60` 的 `defaultLevel` 为 **TS 局部变量名**（非 i18n 键，不涉模式）；apps/web 无硬编码（web UI 从 manifest 动态读 titleKey）。
- CHANGELOG.md / docs/versions/2.1.0.md / docs/dev/plans/post-restart-continuation.md 中的大写键为**历史缺陷登记文本**（描述本 bug 本身），docs/dev/plans/thinking-intensity-plugin-design.md 为旧前缀 `thinking.settings.*` 历史设计稿——均非运行时引用，不改。

## 过程记录

- worktree 自 redblue-dev 建分支；根 `bun install`（482 packages）+ `apps/web bun install`（86 packages）均 exit 0 后跑门禁，一次通过（30s）。
- 零测试/零探针（宪法）；未触碰生产 checkout / ~/.vessel；只提交 fix/q-ti5-manifest 不合并（main 合）。

## 提交链

- bbf61719 ①修复（单文件 15+/15-：i18n 5 键 snake_case 化 + settings 引用同步）
- 本文件 ②门禁报告

## 后续（main 执行）

合并 fix/q-ti5-manifest → canary 同步 → node restart 加载 thinking-intensity（plugin_manifest_invalid 消除）→ plugins.list/catalog 现身 + get_state/plugins.config.set 可达 → lifecycle/webui 续验 B1。