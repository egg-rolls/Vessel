---
adr: 107
title: 装配层声明式 feature 收集器（AssemblyFeature）与 plugin 机制边界
status: accepted
date: 2026-11-28
related: [3, 4, 34, 37, 99]
tags: [assembly, bootstrap, declarative, deps, harness, boundary]
---

## ADR-107：装配层声明式 feature 收集器（AssemblyFeature）与 plugin 机制边界

- **上下文**：`src/runtime/bootstrap.ts`（3092 行）与 `src/cli.ts` 是 `startGateway` 的
  两个调用方，各自手写一份 `GatewayOptions` deps。实证（probe-bootstrap-declarative-report
  §1/§2，HEAD f5b35f50）：
  1. **冲突结构性必然**：2026-11-27 一天两次 merge（80768dbc / fa748552）撞同一 20 行区
     （localDispatcher opts 尾部 restart/kanban/stageAttachment 相邻插入）；batch8
     peer-cadence×health-sub 是第三例（main 手解）。11-10 起 33 个非 merge 提交中 18 个撞
     imports 块、≈12 个撞 opts/plugins() 带。
  2. **「忘接一路」bug 两次复发**：R-1（fbf8a99a）/R-6（2e3194cc）都是 feature 只接 cli
     网络面、忘 bootstrap 本地面 → vessel op=rpc not_found。双调用方手写 opts 的结构性必然。
  3. **双份 plugins() 已漂移**：cli 读 liveConfig 有显式 disabled 补行；bootstrap 读启动
     config 没有，且跳过 child 行、未传 pluginCatalog（本地 plugins.list 看不到
     marketplace/usage、catalog 恒空）。
  4. **核心洞察**：`createLocalRpcDispatcher` 就是 `startGateway({localOnly:true})`
     （packages/serve/src/local.ts:35-48）——两表面共用同一方法表，分裂只在调用方 opts。
     `GatewayOptions` ~65 个可选字段每个都是宿主贡献点；缺的不是新注册机制，是收集器。

- **决策**：
  1. **装配层声明式收集器**：新增 `src/assembly/`（装配层，非 core），定义
     `AssemblyFeature { id, requires?, phase, register(ctx) → FeatureRegistration }`。
     每个宿主原生 feature 声明自己的贡献；装配层收集合并成**一份** deps，两个调用方
     （cli 网络面 / bootstrap 本地面）消费同一份收集结果——「忘接一路」结构上不可能。
     `FeatureRegistration` 四面：`dispatcher?: Partial<GatewayOptions>`（RPC deps）、
     `hotApply?`（收编 cli reloadAppliers 第二集中注册区）、`result?`（BootstrapResult
     透传字段）、`shutdown?`（有序退出步）。
  2. **注册表形态 = 显式 import 清单**（`src/assembly/features.ts`，一行一 feature，
     按 id 字典序）。拒目录扫描（顺序不确定/打包 glob/类型检查弱）与装饰器自注册
     （隐式顺序/tree-shake 摇掉/ADR-004 反对的装饰器心智回潮）。冲突面收敛目标：
     新 feature = 新文件 + 清单一行；既有 feature 改 deps 主干零改动。
  3. **phase 硬闸 + requires 拓扑**：`host`（早于 startOwner，注册在 tenant 共享
     bundle.pluginHost）→ startOwner → `dispatcher`（晚于 agent 装配）→ `surface`。
     保 ADR-003/004 的 spawn 快照不变式（父宿主工具列表在 startOwner 前定格）。
     phase 内按 requires 拓扑排序，环 = fail-closed。**不做运行期 DI 容器**（装配是
     一次性同步过程）。
  4. **deps 值必须惰性**：handler 一律闭包读活引用（liveConfig/{current}/LateRef/
     可变对象原地改），禁止 register 时定格活值——本仓晚绑定纪律（vessel-meta/
     kanbanDeps/restart 包装）的接口化。opts 对象仍一次构造（serve 接口不变）。
  5. **键冲突 fail-closed**：两 feature 贡献同一 GatewayOptions 键 → 启动报错点名双方
     （与插件 http 路由冲突同口径）。
  6. **边界红线（与 ADR-004/099 划界，本 ADR 的核心）**：
     - 收集器**只收编宿主原生 harness 接线面**（GatewayOptions RPC deps / hotApply /
       result 透传 / shutdown 步）。这是 ADR-099 决策 2 已承认的「harness 层宿主贡献点，
       由宿主收集与路由」——收集器是宿主收集**自己的**贡献点，不是扩展机制。
     - **能力注册（tool/provider/guardrail/hook）一律仍经 `Plugin.install(host)`**，
       包括宿主原生能力（agent/vessel/ask-user 工具、refs-notice/runtime-notice hook）。
       AssemblyFeature 可以编排 install 的**时机**（phase 闸），但注册 API 不变、
       不新增第二套能力注册入口。ADR-004「内置能力也走同机制」逐字保留。
     - **插件永不进 feature 清单**：21 个插件继续走 loader/manifest/install 单一路径
       （ADR-099 决策 1）。feature ≠ plugin：AssemblyFeature 无清单、无发现、无信任
       模型、无安装生命周期，是编译期静态装配声明，不是运行期扩展。
     - **收集器不在 core**：住在 src/assembly（CLI 装配层），core 不新增接口、不感知
       feature/收集器这些词（ADR-099 决策 2 同款措辞）。禁止的「core 第二套构造期
       注册表（ModuleHost/ModuleRegistry）」红线不触碰。
  7. **脊柱永不进收集器**：config 加载/dataDir 卫生/engine 构造/bundle 构造/vessel/
     agent 注册与 startOwner 先后/shutdown 依赖序——顺序承重代码留主干显式书写
     （拆分后 ~700-900 行）。声明式层只收编「扁平、可交换、每 feature 一份」的 deps 收集区。
  8. **P0 共享工厂先行独立**：`createPluginSurface`（src/plugin/plugin-surface.ts，
     抽 cli.ts 1615-1750，两表面同源 entries()/catalog()）是「两表面同源」的第一个
     实例，已批立项实施（q-bootstrap-p0-surface），不依赖收集器；收集器（P2）落地时
     plugins/pluginCatalog 数据源改由共享工厂提供，自然纳入。

- **备选**：
  - (a) 维持双调用方手写 opts——冲突与「忘接一路」bug 已被三次实证为结构性必然，不取。
  - (b) 目录扫描/装饰器自注册——顺序不确定、tree-shake 不友好、装饰器心智回潮，不取。
  - (c) 运行期 DI 容器——~15 个 feature 规模下过度设计，装配是一次性同步过程，不取。
  - (d) 把收集器放 core 作 ModuleRegistry——ADR-034/037/099 明令禁止的第二套构造期
    注册表，不取。
  - (e) 把插件迁进 feature 清单统一装配——破坏单一 plugin 加载/清单/生命周期
    （ADR-099 决策 1），且插件信任模型/热应用语义与静态装配完全不同，不取。
  - (f) serve 侧兜底自动补 child 行/catalog——打破「装配层拥有清单」契约边界
    （config.ts:558-562），且 catalog 原料（lifecycle/surfaces/pendingRestart）serve
    补不全，不取（设计稿 §5.4）。

- **后果**：
  - 新 feature 接入成本从「触碰 3-5 个集中区」降为「自己的文件 + 清单一行」；
    H1-H5 五个冲突热点被拆分 + 收集器消灭。
  - 两表面消费同一份 deps，R-1/R-6 类 bug 结构上不可能；双份 plugins() 漂移被
    共享工厂消灭。
  - 代价：~200 行收集器 + 每 feature 50-150 行文件；P2 回归面需全量启动路径验证
    （REPL/headless/serve/node/connect）；第一批只迁 kanban/jobs/restart/attachments
    四个曾造成事故的 feature，用真实事故模式验证。
  - 文档同步：assembly.md / cli-wiring.md 增补收集器章节；cli-conventions.md 的
    strangler 先例记录引用本 ADR。

- **与 ADR-003 / 004 / 034 / 037 / 099 的关系**：
  - **澄清作用域，不 supersede**。ADR-099 已把「唯一扩展机制」的作用域从「贡献面」
    纠正为「加载/清单/生命周期」，并承认 harness 层宿主贡献点由宿主收集路由——
    本 ADR 是该原则在**装配层 deps 接线面**的具体化：收集器收集的是宿主自己的
    harness 贡献点（GatewayOptions 字段），与插件贡献面（pages/commands/settings/
    rpc/events/panels）同属「宿主收集」范畴，不是第二套扩展机制。
  - ADR-004「tool/provider/guardrail/hook 经 Plugin.install(host) 注册、内置能力
    也走同机制」逐字保留：收集器不新增能力注册 API，只编排时机。
  - ADR-003「插件不进 runtime 构造函数」继续有效：收集器住装配层（bootstrap/cli），
    core runtime 构造函数不感知。
  - ADR-034/037「禁止 core ModuleHost/ModuleRegistry」继续有效：收集器不在 core、
    不注册扩展、无运行期生命周期，与被禁的构造期注册表性质不同。

- **实施分期**（设计稿 §6，用户已批 Wave1）：P0 共享工厂（实施中）→ P1 纯机械拆分
  （9 批 strangler）→ P2 收集器（本 ADR 批准后；先迁 kanban/jobs/restart/attachments）
  → P3 按需评估 cli 其余手写段。

- **关联**：[ADR-003](ADR-003-no-plugin-in-runtime-constructor.md) ·
  [ADR-004](ADR-004-plugin-pluginhost-extension.md) ·
  [ADR-099](ADR-099-plugin-contribution-surfaces-and-trust.md) ·
  设计稿 `docs/dev/reports/architecture-block-bootstrap-design.md` §3/§4/§5/§6（外层仓）·
  探针报告 `docs/dev/reports/probe-bootstrap-declarative-report.md`（外层仓）。

*status: accepted —— lead-architecture 起草，main 评审 PASS（2026-11-28：ADR-099 L24-25 宿主收集路由/ADR-004 L11-12 内置同机制引文核实，边界论证成立；澄清作用域不 supersede）。落点代码仓 docs/adr/（治理文档随代码跟踪，001-106 同例；非外层仓 dev 报告）。assembly.md/cli-wiring.md 同步 lead-architecture Wave1 实施。*