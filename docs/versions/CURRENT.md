# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**0.30.0（2026-10-31）** — 未 tag、未 publish。版本号以根 `package.json` 为唯一来源；
manifest 与 `CHANGELOG.md` 一致。

## 已合入

- **Web 产物自愈**：gateway 启动时发现 `apps/web/dist` 落后于 `apps/web/src` 不阻塞启动，
  在后台重建；bundle 内指纹与 `dist/build.json` 的 `builtAt` 比对，已打开的页面显示刷新提示。
  无法判断（旧产物 / fetch 失败 / vite dev）时保持静默。
- **Tasks 面退场（breaking）**：删除 Web Tasks 页与 `tasks.list` / `tasks.get`，
  连同 `AgentTaskEntry`、`AgentRegistryEntry.delegate`、`state/tasks`。
- **诊断页**：Observe 补 runtime / MCP / plugins / config sources；`health.get` 透传
  `wait_reason`；删掉 `agent.run.failed` / `plugin.error` 两个死过滤项；复用既有 RPC。
- **Web 大文件拆分**：10 个 >500 行逻辑文件（7846 行）按域拆成容器 + 同目录 hooks/子视图，
  导入路径与导出面不变；全 web 最大逻辑文件降至 550 行（i18n 文案表除外）。
- **Web 修复**：已结束 run 时长不再增长、去重复 tenant chip、未启用渠道显示为未启用、
  四个视图切 tab 重置滚动、`feishu` 能力位按 default tenant 实际解析。
- **门禁**：每切片 `typecheck` + `biome ci` + web tsc + web build + mock 烟测；
  收口另有 `check-*` 与 `version --check`。仓库无自动化测试套件。

## 下一步

- **浏览器人工回归尚未执行**：聊天流式滚动 / 切 session、Runs 切换翻页、trace 分页、
  member body 历史、命令面板 / banner、断线重连与切 tenant。
- 剩余 536–550 行文件不在本轮范围：`AttentionPanel` / `TeamsView` / `TeamChat` / `TenantsView`。
- 诊断页仍缺 `doctor --deep` 的 config / provider / data_dir / session / plugins / mcp /
  serve_port / attach / feishu_credentials 覆盖；无诊断聚合端点、无多节点入口、事件无翻页。
- hub ↔ federation 身份联动挂起（`PLAN-0.28-hub-federation-identity.md`）。
- 计费与价格表：ADR-005 禁止内置价格，若要做需用户提供价格表。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 当前版本变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)
