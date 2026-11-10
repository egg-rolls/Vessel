# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**0.50 开发线（2026-11-09，merged）** — 已并入 `main @ c3113dcc`；manifest 已 bump 到
`0.50.0`；未 tag、未 publish。版本号以根 `package.json` 为唯一来源。

## 已合入（现态）

- **Platform Gateway / Node API 已拆分**：Gateway 8642（平台入口、UI 宿主、`platform.*`
  只读 RPC），Node API 8644（公司 runtime/数据）；平台 token 与 per-node token 分离；
  `vessel gateway` / `vessel node` CLI。
- **多本地 Node（G3）**：每个 Node 独立子进程，各自 dataDir/config/token；`nodes.json`
  registry；`platform.nodes.credentials({node_id?})`；`gateway nodes list|add|remove`。
- **Hub 是独立 Platform 服务**：独立进程、仅 node→hub、Hub 持 token broker；旧
  hub→node / 节点入站 / `auth.*` / `hub pair` 已删除。0.50 起 `gateway start` 在
  `hub.auto_start`（默认 true）时自动拉起本地 Hub，已有实例 adopt；Web Hub 页回环自动连接 8643。
- **tenant 抽象已移除（T0–T5）**：一个 node = 一家公司；无 tenant 选择/隔离维度；
  根布局 `<dataDir>/**`；写意图锁为 `src/data-lock.ts`，错误码 `data_locked`；
  `tenant.json` 只读持久化单 id；`AgentVisibility='tenant'` 作为正交可见性保留。
- **本地 Node CORS**：平台 spawn 的本地 Node 自动放行平台 Origin（内部
  `VESSEL_PLATFORM_ORIGINS`），Web 不再因 `forbidden_origin` 连不上 Node。
- **Team**：默认 Team 锚点统一为 `<dataDir>/default`（TUI/gateway 共用）；成员列表
  是右侧常驻栏（≤1023px 抽屉）+ 顶部搜索，入口在 Team 卡 `⋯` 的「查看 / 收起成员列表」；
  页头不再有刷新按钮（刷新走卡片菜单）；Team 列表宽度可拖拽（220–420，持久化）。
- **Web 外壳**：DataTable 可排序列（透明表头、激活箭头主题色）；暗色表头/内容底色
  互换；AppBar 去掉 Vessel 字标、路由改用字标样式。
- **信息层级（Web）**：系统 / 内部事件默认关闭，唯一开关是 config 的
  `ui.showInternalEvents`（`verbosity: debug` 按既有「或」语义一并放开）；会话里的
  `vessel:*` 运行期上下文消息跟随同一个键，不再写浏览器 localStorage。默认只显式
  展示正文、思考、工具调用与错误 / 权限交互；`run.checkpoint`、`runtime.notice`、
  hook 与上下文生命周期通知归为内部事件。
- **Web 消息流**：历史消息与实时事件按权威时间戳合并成一条时间线（不再把 live 组
  整块追加在末尾）；单 run 事件裁剪保留 `run.started` 等锚点，长 run 运行中可见；
  历史窗口触顶静默前插一页并保持滚动锚点（会话与 Team 一致）。
- **时间线顺序不变量**：一条 run 的节点不得排在触发它的那条 user 消息之前
  （`run.started` 早于 user 消息落盘，只按 run 起始时间排会把本轮输出顶到消息上方）；
  伪 run 组（`session` / `runtime` 等常量 run_id）按 item 各自的事件时间落位，
  不再整组锚在首个事件上。
- **A2A 消息**：投给成员的 user 消息带 `Message.name = agent:<alias>`（人类/系统不带），
  Web 渲染成可折叠的「来自 agent X」卡片；老消息无该标记时仍按普通气泡渲染。
- **AI 内容**：默认系统提示词完全由用户掌握；未配置 `agent.systemPrompt` 时只注入
  Self Card，不注入内置文本。
- **开发期清库**：`vessel dev reset [--yes] [--dry-run] [--json]`。
- **0.48 插件扩展面同线合入**：manifest HTTP/CLI/WS 扩展点、外部 `expose`、catalog
  declared/effective 两视图；插件面只注册在 Node API，平台 `/plugins/*` 404。

## 未实现 / 下一步

- **G4 分布式 Node / G5 清理**未排期；`gateway reload` 不重载 registry。
- **Workspace 插件独立包未实现**；Workspace = 公司数据目录仍是 target；当前 workspace 仍是 Team 目录键。
- **T5 残留 71 行**（`tenant_id`=60 / text=11；keep=34 / defer-2=15 / defer-3=22），
  见 `docs/dev/reports/0.49/tenant-id-residual.tsv`；defer-2/3 的清理需独立兼容迁移。
- **浏览器 14 条目视走查**未做（`docs/dev/reports/0.49/e2e-verify.md` §6）。
- **0.50 已知限制**：Hub 自动连接只认缺省 8643；Team 成员搜索只覆盖已加载窗口；
  存量 cwd Team 不自动删除/迁移；暗色表格互换仅在暗色生效。Chat 历史走
  `sessions.get` 的 `message_limit` / `before` 分页（首屏 50 条）；Team 走
  `teams.get` 的 `before` 游标（首屏 100 条，`messages_has_more` 驱动翻页，
  超出 64 MiB 回扫窗口时提示一次后停止）。事件订阅按路由收敛到当前会话 / Team / Runs。
  Chat 的 `hideInput` 去重只比对「已加载窗口内是否存在内容完全相同的 user 消息」：
  同一句话在窗口里出现过两次时该轮 live 气泡会被误隐藏；该轮 user 消息尚未进入窗口时
  气泡改由 live 卡渲染、位置跟随 live 卡。影响面仅限那一轮用户气泡，不动正文/工具卡/排序。
- **待手测**：`config.set` 写后热应用（0.50 新增 `src/config-write-apply.ts`）需要
  新代码在跑的 gateway 才能测「写后立即 `config.get`」的收敛延迟；实现侧已单测
  单飞行 / 上界 / 失败只 warn / 去重，真实 gateway 的 5 次 `set→get` 中位延迟待重启后补测。
- tag / publish 待 1 收口裁决。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)
- 版本记录：[0.50.0](0.50.0.md)、[0.49.0](0.49.0.md)、[0.48.0](0.48.0.md)
