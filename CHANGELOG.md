# Changelog

> 本文件是 O(1) 当前态：**只保留当前版本的变更摘要**。
> 所有历史版本在 [`docs/versions/`](docs/versions/INDEX.md) 中按版本一文件保存，
> 索引见 [`docs/versions/INDEX.md`](docs/versions/INDEX.md)，当前版本见
> [`docs/versions/CURRENT.md`](docs/versions/CURRENT.md)。
>
> 变更记录遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 0.x 阶段：breaking 变更走 minor，新功能走 minor，修复走 patch。
> 管理规则见 [`docs/DOC-MANAGEMENT.md`](docs/DOC-MANAGEMENT.md)。

## [0.30.0] - 2026-10-31

> 0.30.0（基于 0.29.0，未发布）：Web 产物自愈、Tasks 面退场、诊断页补齐、Web 大文件拆分。
> 完整记录见 [`docs/versions/0.30.0.md`](docs/versions/0.30.0.md)。未 tag、未 publish。

### Added

- **Web 产物自愈**：gateway 启动发现 `dist` 落后于 `src` 时不阻塞，后台重建；bundle 指纹与
  `dist/build.json` 的 `builtAt` 比对，已开页面提示刷新；无法判断时保持静默。
- **诊断页**：补 runtime / MCP / plugins / config sources；`health.get` 透传 `wait_reason`；
  复用既有 RPC，不新增方法。

### Changed

- **删除 Tasks 面（breaking）**：Web Tasks 页与 `tasks.list` / `tasks.get` RPC、
  `AgentTaskEntry`、`AgentRegistryEntry.delegate`、`state/tasks` 一并退场。
- **Web 大文件拆分**：10 个 >500 行逻辑文件按域拆为容器 + hooks/子视图，导入路径与导出面不变；
  最大逻辑文件降至 550 行（i18n 除外）。

### Fixed

- 已结束 run 的时长不再增长；去掉重复 tenant chip。
- 未启用的飞书 / MCP 渠道显示为「未启用」，不再画成加载失败。
- Observe / Runs / Settings / Integrations 切 tab 重置滚动。
- `hello.features` 只在 default tenant 实际有渠道时含 `feishu`。

## [0.29.0] - 2026-10-30

> 0.29.0（基于 0.28.0，未发布）：prompt cache 的计量、命中率与压缩修复。完整记录见
> [`docs/versions/0.29.0.md`](docs/versions/0.29.0.md)。未 tag、未 publish。

### Fixed

- **缓存开启后压缩不触发**：Anthropic 的 `input_tokens` 不含缓存读写，压缩判断却拿它
  当真实上下文规模，于是只剩残差 —— 100k 会话可能只报 5k，偏差正好等于命中量。
  压缩永不触发，只能靠 provider 400 后的溢出重试，第二次直接抛错。

### Added

- **`prompt_tokens` 语义统一**：所有 provider 统一为「含缓存的全部输入」；Anthropic 由
  adapter 补上两个缓存字段，OpenAI 只提取 `cached_tokens`，DeepSeek 折叠拆分字段。
  不报告缓存时字段缺省（`undefined`），不是 0。
- **缓存计数贯通**：`UsageStats` / 事件 / session / checkpoint / **resume** 都带缓存数。
- **命中率展示**：`metrics.get` 聚合两个计数；Web Observe 与 TUI `/status` 显示
  「输入占比」与「前缀健康度」。比率在展示层派生，不进快照。

### Changed

- `inputTokensLimit` 会更早触发（限额吃含缓存的 `prompt_tokens`）—— 语义统一的必然结果。
- 跨版本 resume 按新口径整体读入历史 `prompt_tokens`，长跑 run 可能一跳顶到限额。

### Not building

- 不做计费 / 价格表（ADR-005）。`totalCostLimit` 保持恒 0，是设计选择不是缺陷。
- 不建模最小可缓存阈值；不做 warmup 单列（聚合量上不可还原）。

## [0.28.0] - 2026-10-29

> 0.28.0（基于 0.27.0，未发布）：Team 即工作区，会话即临时 agent。完整记录见
> [`docs/versions/0.28.0.md`](docs/versions/0.28.0.md)。未 tag、未 publish。

### Removed

- **`single` role**：`AgentRole` 收敛为 `member | temporary`，`main` 是普通成员。
  存量快照读取时降级为 `member`。
- **一 agent 多 body**：一个 agent 恰好一具 live body（`body_id ≡ session_id`），
  rotate 窗口内允许两具。快照格式不变，存量多 body 取 primary、其余进 `body_history`。
- **`maxLiveBodies` / `bodyIdleTtlHours`**：换成 agent 级 `agent.temporaryTtlHours`（默认 2h）。

### Added

- **Team 即工作区**：打开目录即得到对应 Team；撞 slug 加后缀且绝不合并；
  headless 同一 data root 至多一个合成 Team。
- **会话即 agent**：Web / TUI 新会话建临时 agent，三入口同走 `runs.start → admit`。
- **临时 agent 回收与复活**：到期从 roster 移除但保留 body 记录，复活可接回原会话。
- **role 感知上下文策略**：临时 agent 不自动压缩、到线只提示；策略可在活体上热切换。

### Fixed

- `waitForConnectedRun` 事件兜底从不启用（本地 member run 无 durable checkpoint），
  并修掉同 prompt 并发时误收他人终态。
- 本地 REPL 绕过准入，会话不属于任何 agent —— 改走 `admit`。
- 飞书渠道在真实装配下起不来（`AgentService` 早于 wiring 构造）、成员名含冒号非法、
  TTL 回收后不能复活。
- `slugifyWorkspace` 缺 `realpath` 与 NFC 归一。

## [0.27.0] - 2026-10-28

> 0.27.0（基于 0.26.2，未发布）：架构级重写——把三套并行执行事实收敛成一套统一
> agent/body 模型，并删除全部自动化测试。完整记录见
> [`docs/versions/0.27.0.md`](docs/versions/0.27.0.md)。未 tag、未 publish。

### Removed

- **三套并行执行事实**：`RunEngine`（serve run 账本）、`RuntimeHost` /
  `InProcessRuntimeHost`（core 执行壳）、owner/member 执行二分
  （`agent-owner-injection.ts` / `owner-runtime-facade.ts` / `runtime-factory.ts`）。
  同一件事不再有三套入口、串行语义与生命周期事件。
- **`agent.turn.*` / `agent.reply.posted` 事件**：`run.*` 是唯一执行生命周期。
- **全部自动化测试**：483 个文件 / 96,662 行，连同 17 个 `package.json` 的 `bun test`
  脚本与 CI 11 处调用。门禁改为 `typecheck` + `biome ci` + `scripts/check-*.ts` 静态断言，
  运行时正确性靠一条端到端烟测。
- **Team `default_principal` / `handoff_path` 字段**：改结构化 policy 控件。

### Added

- **统一 agent/body 模型**（ADR-097）：所有 agent（含 `main`）只经
  `AgentService.admit` 准入；`body_id ≡ session_id`，一个 agent 可多 body
  （≤ 20 live / 空闲 TTL 24h），同 body 串行、跨 body 并发；每 body 独立
  runtime / context / 历史 / runStore。
- **按段数寻址**：1 段本机 agent / 2 段本机 Team / 3 段跨节点；来源行是可回信的
  `<from location="principal@node:team" />`。
- **保留 principal 词典**：`human` / `system` 不能当成员名或 id。
- **Web Tailwind L1/L2/L3 分层** + L2 `components/ui` + zustand domain stores。
- **确定性 `docs-find` + `check-docs` 结构门禁**。

## [0.26.2] - 2026-10-24

> 0.26.2（基于 0.26.1，未发布）：补齐 Web 样式缺口。未 tag、未 publish。

### Fixed

- **`<select>` 原生浮层**：`option` 使用 `--surface-raised` / `--ink` 配色，
  暗色主题下下拉列表不再回到系统默认样式。
- **无 CSS 的 className**：审计出 25 个 TSX 使用但 CSS 未定义的类；
  补齐真实缺口（`ask-answer-required`、`attention-cell`、`attention-kind`、
  `diag-errors`、`display-setting-row`），删除 3 个已由 `ModalShell size` 取代的
  弹窗宽度类，其余 17 个确认为语义钩子并保留。
- **旧 token 失效**：`team.css` / `attention.css` 仍引用已删除的
  `--surface-2` / `--surface-3` / `--text` / `--text-list` / `--radius` /
  `--shadow` / `--accent-line`，浏览器会丢弃这些声明；统一替换为现行 tokens
  （`--hover-tint` / `--surface-sunken` / `--text-sm` / `--radius-md` /
  `--elev-2` / `--line-strong` / `--ink`）。

### Not building

- 不做视觉重设计；不改组件结构。
