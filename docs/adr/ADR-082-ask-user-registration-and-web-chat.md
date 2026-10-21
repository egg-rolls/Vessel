---
adr: 82
title: ask_user 注册策略与 Web 聊天渲染/可见性
status: accepted
date: 2026-10-21
related: [29, 36, 62, 72, 74, 79, 80]
tags: [ask-user, tools, gateway, cli, web, rendering, visibility, i18n]
---

## ADR-082：ask_user 注册策略与 Web 聊天渲染/可见性

- **上下文**：0.13 及以前 `ask_user` 只在「实际进入 REPL 且 stdin 是 TTY」时注册，gateway / serve 的 Web 客户端没有提问工具；`--serve` 在 0.12 成为前台别名后仍出现在 `--help`，与 `vessel gateway start` 形成两条入口。Web 的提问仍是全局 `AskModal`，与 0.13 的内联权限不一致；工具调用只有启发式卡片，思考内容与正文混排，流式 token 每 50ms 触发整棵树重渲染；`ui.verbosity` / `ui.errorLevel` 已进入配置但 Web 未消费。

- **决策**：
  1. **注册矩阵**：`ask_user` 在交互 REPL（TTY）与 `gateway start` / `--serve`（serve 有 Web 应答方）注册；`--run` / headless / 管道不注册。`ui.askUser: false`（YAML `ui.ask_user`）按入口和 tenant 关闭；显式 `true` 也不能让无客户端的 headless 入口注册。
  2. **配置与命令**：`UiConfig.askUser?: boolean`，validator 只接受布尔；`vessel config set ui.askUser <true|false>` 写用户配置（原子写、`0600`、保留其它键）。未配置时保持入口默认，不写默认值。
  3. **`--serve` 弃用**：从 `--help` 移除；解析保留为隐藏兼容别名，启动时向 stderr 打印弃用提示，行为仍走同一前台装配管线。新入口统一为 `vessel gateway start`。
  4. **Web 内联提问**：删除全局 `AskModal`，`AskCard` 内联在所属 `RunCard`，与权限卡同一生命周期。提交继续走既有 `ask.respond`，不新增 RPC；提交中禁用全部按钮，其他端应答 / 过期 / run 终态由 `ConnectionProvider` 移除请求并收起卡片。跨 session 顶部条同时汇总权限与提问。
  5. **Web 工具卡**：单行 header + 输入 / 输出 / 变更 / 错误分区；20 行或 8KB 折叠预览，200KB 分段加载，提供复制按钮；失败卡自动展开并复用 `tool.call.failed` 的 `errorMeta`。
  6. **Web 思考气泡**：`reasoning_delta` 合并为独立可折叠块，记录起止时间；12 行上限，流式时展开、结束后折叠；与正文严格分离。
  7. **流式性能**：`EventGroupCache` 只把新增条目并入对应 run，并只重建受影响的 `RunGroup`；`RunCard` 使用 `memo` 与稳定回调；渲染组上限 200；滚动跟随节流 100ms。截断、reset、gap 或可见性设置变化时整表重建。
  8. **信息层级**：Web 从 `config.get` 的 `ui` 读取。`minimal` 只保留正文、失败工具与 run 终态；`normal`（默认）保留 L1 + 折叠 L2；`debug` 等同 `showInternalEvents: true` 并显示 L3 原始事件。`showInternalEvents` 与 `debug` 取“或”；`errorLevel: all` 放开 internal / process 级错误。缺失或非法值回退 `normal` / `false` / `user`。
  9. **i18n**：新增 Web 文案同时加入 zh-CN 与 en 两份 catalog；未收录 key 仍回退中文，但不得当作已本地化。

- **冻结契约**：
  - 注册矩阵固定：交互 REPL 或 gateway/serve = 注册；headless / `--run` / 管道 = 不注册；`ui.askUser: false` 一律关闭。
  - `ask.respond` 的参数 / 返回形状不变；提问过期仍按事件时间 `event.ts + 120s`，不引入权限的无限等待语义。
  - `ui.verbosity` 取值与 Web 映射固定；`minimal` 不隐藏失败工具与 run 终态，`debug` 才显示 L3。
  - 卡片收起条件固定：其他端应答、过期、run 终态、`ask.respond` 返回错误。
  - `--serve` 仅保留兼容，不再出现在 help；弃用提示写 stderr，不污染 stdout / JSON。

- **非目标**：不在 headless / `--run` 注册 `ask_user`；不改变提问 120s 有效期，也不把权限的持久化记录套用到提问；不新增提问 RPC；不做列表虚拟化（只用 200 组上限）；不改变工具卡之外的 Markdown 渲染契约；不把 `--serve` 立即删除。

- **验证**：`src/__tests__/headless.test.ts`、`config-set-command.test.ts`、`packages/config/__tests__/ui-config.test.ts`、`apps/web/tests/permission-inline.test.tsx`、`run-card.test.tsx`、`tool-cards.test.ts`、`visibility.test.ts`、`group-cache.test.ts`；`bun run typecheck`、`bunx @biomejs/biome ci .`、`bun run scripts/check-docs.ts`。

- **关联**：ADR-029（交互暂停事件流）、ADR-036（Gateway 协议）、ADR-062（TUI i18n）、ADR-072（UI 设置与 Web i18n）、ADR-074（gateway 生命周期）、ADR-079（权限内联与持久化）、ADR-080（可见性配置）；`packages/config/src/types.ts`、`src/bootstrap.ts`、`src/tenant-runtime-factory.ts`、`src/cli.ts`、`apps/web/src/domains/chat/AskCard.tsx`、`ToolCard.tsx`、`RunCard.tsx`、`apps/web/src/state/visibility.ts`、`apps/web/src/state/group-cache.ts`。
