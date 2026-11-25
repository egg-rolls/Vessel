# 重启后继续完成计划（2026-11-25 盘点）

> 用户指示：盘点未完成项，生产重启后继续。本文件随晋升入 main，供重启后 main 新体续作。
> 基线：main=v2.0.0（fb44a979）；redblue-dev=2.1.0 收口预备；晋升候 DR15-1 修复闭环 + cli 复验终裁信号。
> 真相源：docs/dev/kanban/board.json（用户裁定不自动归档：完成标「已合并待验收」留板，用户打勾才移 archive.json）。

## 0. 重启前必须闭环（唯一阻塞晋升项）

- **q-dr15-exit**（DR15-1 优雅退出修复，实施中）：根因 = gateway.stop 内 `await server.stop(true)`（gateway.ts:4722）Bun 1.3.9/Windows 残余活跃连接挂起永不 settle。
  - A：server.stop(true) 5s 有界 race + best-effort（平台同款同修）+ 永久 `node.shutdown.step` 步骤日志。
  - B：等死段 postQuiesceTimeoutMs=30s force 兜底 + stop.forced 审计持久化（reason=quiesce_exit_timeout，补 O7）；候 run 段不限时（裁定 #5）不动。
  - 流程：修复合 redblue-dev → 通报 lead HEAD+变更面+日志键名 → cli 复验（门禁：drain.done→新启动 ~20s 秒退 + 无 stop.forced + continuation + 步骤日志 + 兜底 30s + live>0 重置 + 14⑤⑥ + CLI/orchestrator 两路径 + --timeout/--force 零变化）→ PASS → DR15-1 CLOSED → 晋升 2.1.0 → 用户优雅重启生产。

## 1. 重启即加载（2.1.0 批次，已实施）

- 第四轮（金丝雀已验闭环）：kanban-view / kanban-proxy / graceful-selfrestart / empty-state / plugin-ui-layer / hydration-anon / drag-reference / card-robust / skills-style / plugin-version / inbox-actions 等（23 merges）。
- 第五轮四面搭晋升（批次 B 正式验收候启动）：thinking-plugin / swr-refresh / context-fix / plugin-lifecycle-impl。

## 2. 重启后优先继续

### 2a. 合并两就绪线 + 第五轮验收
- **q-permission-pending**（批次 A，permission 审批卡汇集待批页，已实施验收 4 commits）→ 晋升后合 redblue-dev → 金丝雀耦合回归（hydration-anon 共享入口，测试员 cardrobust 卡面 + skillsstyle 待批页 UI 续话）。
- **q-kanban-visual**（批次 C，看板视觉规范化 + plugin-ui Pager additive + skills 替换，已实施验收 4 commits）→ 晋升后合 → 像素验收（与 18/20/21 skills-style 封存面耦合，测试员 skillsstyle 复用）。
- 第五轮批次 B 四面正式验收。
- 观察项：O7 审计持久化（DR15-1 B 部分补）/ O8 zombie run 穿 sweep 未对账 + stop 采样器 store 视图误显 run 数（建议 sweep 孤儿对账 + 采样器 live/zombie 标注）/ plugin_manifest_invalid thinking-intensity（i18n key defaultLevel 大写 L 违模式）。

### 2b. 待办缺陷（非阻塞，候排期派单）
- **q-plugin-config-read**（晋升后缺陷，优先）：服务端 PluginListMetadata 无 config 字段（manager.ts pluginListMetadata 不装）→ 设置 UI 插件键恒显默认 placeholder，写入值不可见；修复 = 服务端补装配。另注：node config.set not_found（issue-2 族）/ curated radio name 碰撞（低 severity）。
- **q-fleet-isolation**：interop/子进程继承宿主 VESSEL_DATA_DIR=生产，env 覆盖 --user-config 的 data_dir → CLI 身份/锁探测落生产；修复方向 = 显式 --user-config 时其 data_dir 优先于继承 env，或舰队统一 launch 入口净化 env。
- **q-sidecar-sync**：新命名会话侧车仍 Untitled（真相源正确，UI 不受影响）+ listRich .info.json 文件戳缓存 legacy 旧侧车未失效；侧车失效判据或一次性迁移收口。
- **g1-proxy-node**：proxy 模式额外节点 health/attention 直连 401（q-modes 留档缺口，需设计决策）。

### 2c. 待用户裁定才实施（设计/调研已就绪）
- **拓扑 C**（q-canary-topology，调研 0f7af59e）：推荐 C 混合零代码（canary=external node auto_start:false 注册进生产 nodes.json，进程自起自停，单 Web 入口 8642，数据零迁移，三段地址不变）；B 托管三死穴（版本隔离失效/env 全继承 auto-approve 泄漏/无独立 restart）。
- **CLI 拓扑扩展**（q-cli-topology，设计 8134f232）：两层命令面 + 停止时序 + 优雅不限时 + force 审计 + 升级阶梯；P1 命令面/P2 优雅递归/P3 清理；docker images/volumes/up/down 扩展候裁。
- **skills-discovery 实施**（q-skills-discovery，设计 64eac4c4 876 行）：三源适配器 + 七步安装管线 + 安装≠信任 + 7 additive RPC + UI 双 tab；候批准分期 P3a/b/c。
- **design-adjudication 三份**：config-delegation D2 旁门治理（触碰 2026-11-16 config.yaml denylist 裁定）/ thinking-intensity Q1-Q5 / plugin-scaffold（实施授权）。
- **conventional commits 自动版本脚本**（个人侧 scripts vs vessel release）。
- **生产根 7 历史遗留金丝雀文件清理**。
- **P4 TUI 上下文口径另单**。

## 维护约定
- 每合并/派单更新 board.json + commit（git -c gc.auto=0）。
- 一任务一 worktree，main 合并后清理；实施 agent 跑 build 门禁，main 不跑；行为验证归用户/金丝雀。
- 破坏性 restart 协议 A：canary 由 main 执行 + paste stop.forced 审计；生产重启由用户执行（main 身在生产 gateway）。