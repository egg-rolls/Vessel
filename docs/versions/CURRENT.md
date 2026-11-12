# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**0.51 开发线（2026-11-12，进行中）** — 基线 `main @ 8f9940ee`；manifest `0.51.0`；
未 tag、未 publish（tag 等 1.0.0）；版本号以根 `package.json` 为唯一来源。**0.50.0 已收口**，
变更见 [0.50.0](0.50.0.md)。

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
- **事件可见性三档（Web）**：`apps/web/src/state/event-visibility.ts` 是**唯一分类表**
  （`content` / `internal` / `observe`），判据从「不在黑名单 ⇒ 可见」翻成「只有
  `content` 恒可见」；**未登记的类型 ⇒ 按 `internal` 折叠**，渲染成一条「未知事件类型 ·
  已折叠」notice（展开是原始载荷），**绝不落裸 JSON 卡**。`agent.retired` → `internal`
  + typed notice（`reason` / `body_id` / `epoch` 直接取自事件 data，不加跨包 DTO）；
  `agent.reply.stale` → `content` + typed notice；`agent.rotate.approved|denied`、
  插件与渠道事件 → `observe`（聊天永不出现）。失败类不得进 `observe`。门禁
  `bun run check:event-visibility`：未分类 / 表腐烂 / 事件名非字面量 / 渲染 fixture
  （含影子对拍）/ 团队日志双链 / 文档 marker 对拍。
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
- **0.50 收口（事件可见性）**：两张黑名单 → 三档白名单（`content`/`internal`/`observe`，
  114 条），未登记类型折叠成 notice；门禁 `check:event-visibility`（含影子对拍）。
- **0.50 收口（时间线）**：`LiveItemStore` 物化 item（渲染不再读事件缓冲）+ `ClaimLedger`
  认领账本 + 交棒释放；删 `coalesceDelta` / `truncatedSince` / `group-cache.ts`；缓冲裁剪
  不再让屏上内容消失（顺便根治「结尾正文重复」）。
- **0.50 收口（回放）**：固定 1 MiB → 按「最新一轮地板」动态（实测 4 个真实会话覆盖率
  47%→100%），门禁 `check:replay-budget`。
- **0.50 收口（等待消息）**：inbox 条目加 `session_id`/`refs`；待处理条带改读盘（删时间线
  排队卡）；`agents.recall`；启动即扫恢复孤儿输入（重启不再丢排队消息）；修 `runs.cancel`
  后 `queuedRuns` 永不清导致 agent 不被 wake 的僵尸 bug。
- **0.50 收口（上下文用量）**：`sessions.get.context_usage`（尾窗派生 + 水位缓存）；
  `llm.request` 落盘 `context_max`；用量环随比例连续变色（60–80 转琥珀、80–90 转危险），
  `plugin-ui` 补 `--amber` 三主题档。
- **0.50 收口（模型可见性）**：`prompt.system_context` 事件（hash 去重）+ 会话页「模型上下文」
  可展开卡 + `sessions.get.system_context`（刷新/重启后仍可见）；`llm.request` 发布副本带
  `model`，删掉「从 Self Card 抠 model」的死代码。
- **0.50 收口（`ask` 工具）**：`ask_user` → `ask` + 重写描述（任何需要人说一句的场景），
  读侧双认旧名；`ui.askUser` / `ask:answer` / `ask.user.*` 未动。
- **0.50 收口（用量插件）**：数据源从 trace 增量追读换到会话日志 + 持久化索引 + worker 线程
  聚合 + 取消硬截断（「全部时间」不再采样）；`logs` 加 `days`/`since-until` 半开区间 +
  游标分页 + 默认 7 天。
- **0.50 收口（设计实验室）**：token 运行时枚举 + `*.preview.tsx` 自动发现 + 变体表运行时化
  （加 token/组件/变体都只改一处）；颜色 token 固定左亮右暗。
- **0.50 收口（导航）**：四档状态色统一（accent/amber/danger/muted，删 ok/warn）；插件宿主
  `inactive` 不再误判为断开；Hub 打开即自动探测。
- **0.50 收口（构建/DX）**：`gateway start` 就地自修复 dist；拆 react-vendor/plugin-ui chunk
  （无 500kB 警告）；种子 `appendMany`（0.81s→0.008s）；`listRich` mtime 缓存（19.3ms→1.95ms）；
  移除 GitHub CI（`bun run gates` 成唯一门禁，`release.yml` 的 CD 保留）；输入框整块
  `cursor: text`；思考卡复制/时间改 hover+键盘聚焦显示。

## 未实现 / 下一步

- **0.51 待办**：`vessel prune`（默认 dry-run、`--yes`、走 data-lock exclusive、有 running
  run 拒绝）；TUI 答 async ask；设计实验室两个缺口（`CHIP_TONES` / `COMPOSER_ICON_TONES` 的
  preview、`EntityHeader` 运行时表）；工具卡交棒（需 `duration_ms`）；位置认领；
  `sessions.search` 读侧投影缓存；`[refs]` 尾注 action 收窄；用量 43% unpriced。
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
- tag / publish 等 **1.0.0**（用户决定：0.x 一律不 tag、不 publish）。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)
- 版本记录：[0.50.0](0.50.0.md)、[0.49.0](0.49.0.md)、[0.48.0](0.48.0.md)
