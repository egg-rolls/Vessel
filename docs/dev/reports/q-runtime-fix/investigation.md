# q-runtime-fix 调查注记（金丝雀 issue-0 / issue-1 / issue-2）

来源：`fleets/canary-data/reports/canary-e2e-report.md` §5。分支 `fix/q-runtime-fix`。
宪法：零测试/探针/临时进程；行为验证归用户（金丝雀复验）；唯一门禁 `bun run build`。

## issue-0 — 显式 plugins[] 热应用剥离活体工具 + 引擎/成员面不同步

### 链路锚点（config reload → plugin registry → 成员 tool surface）
1. 选择语义：`src/plugin/plugin-selection.ts` `resolvePluginSelection`。
   `configured !== undefined`（含空数组）⇒ 只加载显式列出的项，**不回退默认集**。
   这是 0.7.1 文档化的完整 opt-in 契约（显式列表＝信任边界），bootstrap / `--tools` / 热应用共用。
2. 热应用入口：`src/cli.ts` reload appliers `tools`（约 1138–1192）。
   `applyTools`（`src/config/hot-apply-appliers.ts`）按 `assemblePluginTools`→`resolvePluginSelection`
   算目标集，对活体 `ctx.pluginHost` 增删工具；随后 `syncBasicToolsEngineWiring` /
   `syncCallbackToolsEngineWiring`（`src/tools-engine/wiring.ts`）对移除项 `unwireTool`，
   再 `result.toolsEngine.client.pushRegistry()` **立即**把引擎注册表推到新集。
3. 成员面：`result.agent.service.refreshTools(host.listTools())`
   → `packages/agent/src/runtime.ts` `refreshTools`：running body 只置 `toolsRefreshPending`+`pendingTools`，
   **延迟到轮边界** `finishRun`→`applyToolsToEntry` 才换面（ADR-054：run 中途换面会扰动在途工具调用/前缀缓存）。

### 根因（两个叠加）
- **A 语义**：显式 `plugins:[web-tools]` 被当完整 opt-in 列表 ⇒ 热应用从活体剥离其余 7 个内置工具。
- **B 不同步窗口**：引擎注册表立即生效，而 running 成员的工具面（广告给 LLM 的 tools[]）延迟到轮边界。
  成员执行走引擎：成员面是 spawn/refresh 期的**浅拷贝**（`restrictPermissions` 返回 `{...tool}`），
  拷贝捕获的是当时的 forward handler；`unwireTool` 只还原**原 def** 的 handler，拷贝仍 forward 到引擎。
  引擎 `pushRegistry` 已把被剥离工具从注册表移除 ⇒ 模型仍被广告 bash，调用却 `engine_tool_not_registered`。
  owner 侧不受此窗口影响：owner 执行是活体 `getTool`（miss 即稳定 `tool_not_found`，且有 notice 卡解释，
  见 `execution-unit.ts` `appendToolSurfaceNotice` / `ensureToolPin`）；成员面在轮边界前连 notice 卡都不触发。

### 修法（取任务书括号分支：保留 opt-in 语义 + 同步引擎/成员面，消除窗口）
不改 `resolvePluginSelection` 的完整 opt-in 契约（那是文档化信任边界，全局改会破坏 bootstrap/--tools/安全语义）。
改为让**引擎注册表在窗口期保持「活体成员面仍广告的工具」可执行**（超集语义），移除延迟到轮边界与成员面刷新对齐：
- `ToolLedger.push` 增 retain 集：`remove = lastPushed − current − retain`；`lastPushed = current ∪ (lastPushed ∩ retain)`。
- `EngineClient.setRegistryRetain(names)`：持久 retain，所有 push 路径（cli/bootstrap/mcp）自动 honoring。
- 成员执行面新增 port：`runningToolNames()`（running body 当前广告的工具名并集）与
  `setToolsRefreshListener(cb)`（`finishRun` 应用 pending 刷新后回调）。
- cli `tools` applier：push 前 `retain = runningToolNames()`；注册轮边界监听器，重算 retain、收缩时 push 冲刷移除。
- 文档警示：web-tools `always_register` 说明 + plugin-selection 头注显著注明「显式 plugins[] 是完整 opt-in 列表」。
- 已知边界（注记遗留）：引擎 crash/respawn 发生在 retain 窗口内时，被剥离且已 unwire 的工具无法重推（恢复路径本就降级）。

## issue-1 — 工具输出落盘进生产根 ~/.vessel（隔离缺口）

### 锚点
- `packages/core/src/runtime/tool-result-gate.ts` `toolOutputRoot()`（282–299）：
  ALS scope(toolOutputDir/dataDir) → env `VESSEL_TOOL_OUTPUT_DIR` → env `VESSEL_DATA_DIR` → **硬编码 `~/.vessel/data/tool-output`**。
- 同步落盘 `writeToolOutput` 与异步 bash 日志 `asyncLogDir`（`plugins/tools/basic-tools/src/index.ts:1366`）共用此根。
- node 自身 dataDir：`src/data/data-paths.ts` `resolveDataDir(config)`＝`config.dataDir ?? env.VESSEL_DATA_DIR ?? 默认`。
- engine child 已有桥：`bootstrap.ts:1265` `settings:{dataDir, toolOutputDir: toolOutputRoot()}` →
  `src/tools-engine/entry.ts:62–67` 在 child 内 `process.env.VESSEL_DATA_DIR=dataDir`。

### 根因
canary 的 `data_dir` 来自**配置文件**（canary-data），host 进程 env 无 `VESSEL_DATA_DIR`。
host 的 `toolOutputRoot()` 落到硬编码 `~/.vessel`；且 `settings.toolOutputDir = toolOutputRoot()`（host 错根）
又被传给 child（entry 优先 `VESSEL_TOOL_OUTPUT_DIR`）⇒ host 与 child 双双写进生产根。
异步 bash 是 exec=callback，在 **host 进程**跑 `asyncLogDir`，正是报告症状。

### 修法
在 node 启动解析出 dataDir 后（`bootstrap.ts:1028–1031` 之后）把**本 node 解析后的 dataDir** 桥接进
`process.env.VESSEL_DATA_DIR`（与 entry.ts 对 child 的做法同源）。host `toolOutputRoot()` 即落 `<dataDir>/tool-output`，
并经 `settings.toolOutputDir` 传给 child，host/child 一致。默认根（config/env 均缺省）取值不变，零回归。

## issue-2 — node 本地 RPC 无 config.set 写端口（两线共有）
顺手评估，若对 issue-0/1 修复无必要则注记遗留（见完成报告）。

---

## 修复落地与门禁（完成补记）

### 提交（分支 fix/q-runtime-fix）
- `23f4dd75` docs：调查注记（本文件）。
- `894217d1` fix(tools)：issue-0 引擎注册表与成员工具面热应用同步。
- `1bce7a64` fix(runtime)：issue-1 工具输出落本 node dataDir。

### 门禁（唯一门禁 `bun run build` = typecheck + lint；日志个人侧 docs/dev/tmp/q-runtime-fix/gates.log）
- issue-0：exit 0（Type check ✅ + Lint ✅）。首轮 lint 曾报 1 error＝新增 cli.ts 长 if 超 100 列的
  **格式化**差异（biome vcs 模式只查改动文件，故基线不报）；按 biome 折行后通过。22 warnings 全为
  基线既有（cli.ts/pii/archive-notice 等的 noNonNullAssertion/useTemplate，不致命），未触碰。
- issue-1：exit 0（Type check ✅ + Lint ✅）。

### issue-0 修法要点（保留 opt-in 语义 + 同步引擎/成员面）
- 不改 `resolvePluginSelection` 的完整 opt-in 契约（文档化信任边界）。
- `ToolLedger.push` retain 超集：`remove = lastPushed − current − retain`；retain 名保留在 lastPushed。
- `EngineClient.setRegistryRetain`：持久 retain，所有 push 路径（cli/bootstrap 重连/mcp）自动 honoring。
- 成员执行面 `runningToolNames()`（running body 广告工具名并集）+ `setToolsRefreshListener()`
  （finishRun 应用 pending 刷新后回调）；cli tools applier push 前设 retain，轮边界监听器重算并冲刷移除。
- 窗口期引擎保持「活体成员面仍广告的工具」可执行；轮边界引擎注册表与成员面同刻收敛。
- 文档警示：plugin-selection 头注 + web-tools always_register 提示「plugins[] 是完整 opt-in 清单」。

### issue-1 修法要点
- bootstrap 解析 dataDir 后 `process.env.VESSEL_DATA_DIR = dataDir`（与 entry.ts 对 child 同源）。
- host toolOutputRoot() 落 `<dataDir>/tool-output`，并经 settings.toolOutputDir 传 child；默认根零回归。

### issue-2 评估（遗留，不在本次最小修范围）
`config.set` 写端口现状：gateway RPC 有（`src/gateway/gateway-config-control.ts`，仅 default tenant）；
CLI 有 `vessel config set`（标量白名单 ui.*/observability.*/agent.cwd，不含 plugins）。**node 本地 RPC 无
config.set**。plugins[] 等结构改动当前只能编辑 vessel.yaml 由 config-watch 热应用（金丝雀验收即此路径）。
给 node 本地 RPC 增 config.set 属新写端口（校验+热应用接线+权限），与 issue-0/1 的最小修无关，注记遗留。

### 已知边界（注记）
- issue-0：引擎 crash/respawn 恰发生在 retain 窗口内时，被剥离且已 unwire 的工具无法随重连重推
  （恢复路径本就降级、在途调用已断）；常规热应用窗口已完全消除。
- issue-0：完整 opt-in 语义保留——只列 web-tools 仍会排除其余内置工具，但现在剥离在轮边界原子生效
  且有 notice/文档警示，不再产生「被广告却执行不了」的窗口；要保留内置工具须一并列入或走默认集。

### 行为验证归用户（金丝雀复验要点）
- issue-0：running 成员期间热应用 `plugins:[web-tools]`，模型广告的工具应仍可执行至轮边界；轮边界后
  成员面与引擎注册表一致收缩，无 engine_tool_not_registered 窗口。
- issue-1：data_dir=canary-data 的 node，异步 bash 日志与同步截断落盘应落 canary-data/tool-output，
  不再写生产 ~/.vessel/data/tool-output。
