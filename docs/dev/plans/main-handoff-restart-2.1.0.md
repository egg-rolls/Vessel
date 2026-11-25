# main 交接文档（生产优雅自重启 2.0.0→2.1.0）

> 用户下放重启权力（优雅重启不停机），main 执行 `vessel restart --self` 加载 2.1.0。本文件供重启后新体接续。
> 真相源：docs/dev/kanban/board.json（redblue-dev worktree）+ docs/dev/plans/post-restart-continuation.md。

## 身份与环境
- main，vessel 红蓝开发协调者。生产 node 7181ed6c-5ec2-479e-9400-fcd54b480de5，gateway 8642(web)/8644(federation)。
- 项目 D:\Application\APP\Vessel\Vessel（WSL /mnt/d/Application/APP/Vessel/Vessel）。外层 D:/Application/APP/Vessel 也是 git 仓（用户 docs/scripts，别误落）。
- 生产 config C:\Users\Lirui\.vessel\config.yaml，data_dir C:\Users\Lirui\.vessel\data。
- ★重启原因：晋升 2.1.0 后运行进程仍 2.0.0，旧校验器强制 engines→6 插件 plugin_manifest_invalid 不加载→skills/web_search/web_fetch 工具被移除。重启加载 2.1.0（engines 内置可选）→工具恢复。

## 分支状态
- main=d5c7d3f1（2.1.0，第四轮已晋升，含 DR15-1/DR15-2 优雅退出修复+全部第四轮特性+第五轮四面搭车）。
- redblue-dev=c1227256+（第五轮修复：TI5-2/TI5-3=a31030a5、O-TI2=38e73168、PL5-1=5ccfa964、inbox 审计=c1227256；board/archive 持续更新）。worktree /mnt/d/Application/APP/Vessel/worktrees/redblue-dev。
- canary=6571fb1e（R3 批量修复已同步+restart 加载，2.1.0）。fleets/canary checkout。

## 进行中（候回报）
- ★第五轮 R3 综合验（lead 编排）：webui（B1 toolbar 菜单+多词键热启用+O-TI2 supported:true）+lifecycle（TI5-3 多词键+PL5-1 热应用保 vessel-bridge+guardrail-pii 不回归）。候各 DONE→lead 盘上核实→汇总报 main→第五轮闭环→下次晋升（redblue-dev→main ff-only）。
- ★inbox 修复（用户直接报告+裁定）：
  - q-inbox-fix（707d0fcf，fix/q-inbox-fix）：P0-A 客户端 pendingSends 对账服务端真相（症状①read 后仍显）+P1-A 消费消息可见承接（症状②）+撤回编辑残留/双份路径。
  - q-inbox-agent-view（9c63b5f2，feat/q-inbox-agent-view）：P1-B agent 级收件箱视图（用户裁定 inbox 应 agent 级非会话级，读 agents.inbox{agent_id}展示 main 全量）。
  - 审计 docs/dev/plans/inbox-truth-source-audit.md（13d96ba8）：真相源统一，症状①客户端 pending 第二真相源无消费信号，症状②会话级条带无 agent 面板+消费无承接。
  - 候修复→main 合并→canary 同步→用户验收（inbox 反复提出项留用户验收）。

## 用户裁定/委派（必记）
- ★重启权力下放 main：优雅重启不停机，main 可执行生产 graceful restart（--self 续作）。
- ★inbox 应 agent 级显示，非会话级（P1-B）。
- ★归档政策细化：金丝雀可自验的缺陷修复/微修复/内部改进/调研设计已实施→验证闭环直接归档 archive.json（已归档 13 条）；新功能/新视觉效果/UX/反复提出项（inbox）→留板用户打勾才归档。
- 版本标准 SemVer（major=2 单一真相源 breaking/feature→minor/fix→patch），晋升记 CHANGELOG 语义变更才 bump。
- 能并行尽量并行；hire/create 带 startup_prompt 招即派；agent 间 agent send 不用 ask 打扰用户；复用 agent 续话；SWR 数据刷新；最优一步到位。

## 联络与协议
- lead=canary-qa-lead@7377657b-dfba-4347-809d-5e88460441e0:default（federation，agent send）。
- canary CLI 联络：主 checkout 跑 bun src/cli.ts agent send <id> "<msg>" --connect http://127.0.0.1:8652 --node 7377657b-dfba-4347-809d-5e88460441e0 --user-config D:/Application/APP/Vessel/fleets/canary-config.yaml（VESSEL_NO_EXTERNAL_PLUGINS=1）。
- 破坏性 restart 协议 A：canary 由 main 执行+paste stop.forced 审计给 lead；canary CLI 须 cmd.exe /c "set VESSEL_DATA_DIR=D:\Application\APP\Vessel\fleets\canary-data&& set VESSEL_NO_EXTERNAL_PLUGINS=1&& bun src/cli.ts ..."（双锁避继承生产）。
- 生产 restart 现 main 可执行（user delegated）：bun src/cli.ts restart --self --yes --prompt "<嘱托>" --user-config C:\Users\Lirui\.vessel\config.yaml。

## 待用户裁定/验收
- 待裁设计 7 项：拓扑 C（canary external node 入主 gateway）/CLI 扩展（docker images/volumes/up/down）/skills-discovery 实施/三份设计（config-delegation D2/thinking-intensity/plugin-scaffold）/conventional commits 版本脚本/生产根 7 遗留金丝雀文件清理/P4 TUI 上下文口径。
- 待办缺陷：plugin-config-read（优先）/fleet-isolation/sidecar-sync/g1-proxy-node。
- 新功能用户验收：permission 汇集待批页（批次 A）/kanban 视觉+分页（批次 C）/inbox agent 级视图（P1-B）/thinking-plugin UI/swr-refresh 等。
- 第五轮观察项 O7（审计持久化已部分补）/O8（zombie run sweep+采样器视图）/O9（Bun vendor bug upstream）。

## 运维教训
- bash 用 /mnt/d/；bun 是 Windows interop（D:/参数原生，127.0.0.1 走 Windows 栈）；read/write/edit 用 D:/+subscribe:false。
- git commit/merge 用 -c gc.auto=0（大仓 auto-pack 超时）；worktree remove 常超时→git worktree prune+branch -D。
- worktree build 先 bun install（根+apps/web 独立 lockfile）；merge 冲突多 additive props/资产 hash，保留双方+资产重建。
- 唯一门禁 bun run build（实施 agent 跑，main 不跑）；WSL 退出码谎报用 pipefail+echo EXIT 兜底；本仓无 bundle ADR-006。
- 零测试/探针/临时进程；行为验证归用户/金丝雀；一任务一 worktree 收尾删；增量提交防早退（agent 空回复早退→催单步续作）。
- agent close members 数组被吞→用 CLI bun src/cli.ts agent close <id>。