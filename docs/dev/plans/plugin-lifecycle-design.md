# 插件热加载 / 重启生命周期设计（q-plugin-lifecycle）

- 分支：`design/q-plugin-lifecycle`（基于 `redblue-dev` @ 036e8c11，含 q-plugin-version 去内置引擎门禁）。
- 性质：**只调研 + 设计，零代码改动**。所有行号以本工作区提交时为准。
- 用户问题：插件有的 0.1.0 有的其他版本，大部分需重启才能开启/关闭，这样好吗？
  用户感觉很多插件可独立版本 + 热关闭热加载；若不行，建议内置插件跟踪 vessel 版本 + 设为不能热加载关闭。

## 0. 结论速览

1. **现状比用户感知好，但 UI 在撒谎**：纯工具类插件（basic-tools / recall / web-tools / media）的
   开启/关闭**今天就是热的**（config-watch → tools applier 旁路装配 → 活体宿主增删工具，
   plugin-default-on 切片已实证 `tools: +2 / -1`）；child 体验插件（marketplace / usage）的
   启停与 UI 资产更新**也是热的**（manager.reload + iframe/embed 哈希热替换）。
   真正必须重启的是：hook / guardrail / provider 类注册面（宿主**没有注销 API**）、
   in-process 插件的**代码更新**（ESM 模块缓存）、child 插件的 **settings**（spawn 期 env 注入）。
2. **「重启后生效」badge 是硬编码模式属性，不是真实状态**（design-audit O5）：
   `restartRequired = mode === 'in-process'`（catalog.ts:169）——所有 in-process 插件**恒显示**
   「重启后生效」，哪怕热应用已经生效；child 插件**恒不显示**，哪怕 settings 真的需要重启。
   同时面板 `enabled` 是启动快照（cli.ts:1472 硬编码 true），热 disable / 热装载都不跟。
   **用户「大部分需重启」的感知很大程度上是这个假 badge 造成的。**
3. **版本双轨且已漂移**：包版本（pkg.version，全仓 0.56.1）与清单版本（vessel.version，
   0.1.0 / 0.2.0）是两条线；UI 对 child 显示清单版本、对 in-process 显示包版本 → 混排。
   引擎已 2.0.0 而插件包停在 0.56.1——`scripts/version.ts` 本应同 bump 全部 manifest，
   2.0.0 收口时漏跑了插件目录。**用户「内置跟踪 vessel 版本」的建议方向正确，机制已在，执行漂移。**
4. **不建议「内置一律设为不能热加载关闭」**：一刀切会把已经热的工具类插件也降级成重启，
   方向反了。正确做法是 **per-capability 生命周期声明 + badge 如实反映 + 补齐注销 API**，
   让「能热的真热、不能热的诚实说重启」。设计方案见 §6。

---

## 1. 现状：两种执行形态 × 三条生效链路

### 1.1 执行形态（plugin-loader.ts）

| 形态 | 判据 | 运行位置 | 例子 |
| --- | --- | --- | --- |
| **in-process 能力插件** | package.json 无 `vessel.entry`（或无 vessel 字段） | 宿主进程内 `import()` + `install(host)` | basic-tools、skills、web-tools、media、guardrail-pii |
| **child 体验插件** | `vessel.entry` + `vessel.contributes` 同时存在（plugin-loader.ts:448-487） | 宿主 spawn 的子进程（NDJSON RPC + 静态 UI + 事件管道） | marketplace、usage |

- 发现：启动扫描一次并缓存（plugin-loader.ts:15 头注、:606-609 `list()`）；
  `refresh()` / `rescan()`（:592-603）可丢缓存重扫，**不重启进程**。
  扫描根优先级 project > user > repo > node_modules（:107-112、:707-727）。
- in-process 加载 = 普通动态 `import(href)`（:361-371）。**ESM 模块表按 URL 缓存**：
  同一入口第二次 import 拿到同一模块实例；bun 1.3.9 连「解析失败」都缓存
  （:326-328 注释）。→ **磁盘上的代码更新，进程不重启就拿不到**（这是物理约束，不是设计选择）。
- 默认导出是工厂的插件（`FACTORY_PLUGINS`：mcp-client / evals / feishu / engine-client，
  plugin-loader.ts:51-56）由 bootstrap 按专用配置构造，不走通用装载。
- provider 类（anthropic / openai）走 provider 专用装配（`getProviders()`，:622-628），
  不进会话工具面。
- 选择层是**覆盖层语义**（0.56.1 用户裁定，plugin-selection.ts 头注）：默认集 = 全部已安装
  in-process 能力插件；`plugins[]` 条目只覆盖（`enabled:false` 排除 / 列入 = 显式启用 /
  未列入 = 走默认）。`vessel plugin enable|disable` 只写目标单条（plugin-config.ts:80-117）。

### 1.2 三条生效链路（今天实际接线的）

**链路 A：config-watch → gateway.reload 热应用**（用户改 config.yaml / config.set 写回）

```
fs.watch(config.yaml) 300ms 去抖（config-watch.ts:106-233）
  → loadConfig 校验（valid 才应用，失败只发 notice）
  → reloadRunner.reloadWithSummaries(['config','log','permission','tools','mcp'])（cli.ts:1407-1433）
      tools applier（cli.ts:1185-1243）：
        旁路 MemoryPluginHost 重新装配目标工具集（hot-apply-assembly.ts:120-155 assemblePluginTools）
        → applyTools 差量增/删/刷新真实宿主（hot-apply-appliers.ts:202-303，失败逆序回滚）
        → tools-engine 重接线 + pushRegistry（cli.ts:1209-1237）
        → agent.service.refreshTools（成员工具面轮边界刷新，cli.ts:1241）
```

- **只同步 ToolDefinition**。旁路装配里插件注册的 hook / guardrail / provider 留在旁路宿主上，
  **不会**同步到真实宿主（§2 根因 R-A）。
- 插件安装配置变化（定义不变行为变，如 basic-tools cwd）由 `targetKey` 识别 → 管辖工具整体刷新
  （hot-apply-appliers.ts:118-126、cli.ts:1202-1204）。
- `gateway.reload` 的 `plugins` scope **只丢扫描缓存**，不装载任何东西
  （gateway-reload-wiring.ts:200-206；ADR-075 决策 2）。
  config scope 的 `RESTART_FIELDS` = agent / tls / token / port（gateway-reload-wiring.ts:100-113）；
  provider/models 缺省模型走 `applyProviderModel` 热应用分支（:219-243），federation 有 S7 热应用。

**链路 B：plugin-watch → plugins.reload**（插件目录 / 用户 config 变更）

```
startPluginWatch（plugin-watch.ts:56-114；接线在 cli.ts:1010-1021，
                  plugin-watch.ts:7「当前未接线」头注已过时）
  → pluginsReload = reloadVesselConfig + loader.rescan + manager.reload（cli.ts:997-1007）
      createPluginReloader（plugin-host-assembly.ts:295-315）：
        child descriptor 用 liveConfig 重建 → manager.reload 差量（下）
        in-process 指纹（name@version:dir，:280-286）变化 → restart_required=true，不谎报已重载
  → manager.reload（manager.ts:941-1070，child-only）：
      新增 → inactive（懒激活）；指纹变 → deactivate + 替换 + 原 active 立即重激活；
      删除 → deactivate + 注销 RPC / 静态挂载；
      指纹没变但 embed bundle 内容变 → 只重算 hash/trust，不重启子进程（:1010-1017）
  → onChanged → gateway broadcastPluginChanged（gateway.ts:2495-2504、3260-3273）
  → web 对账 plugins.list（usePluginContributions.ts:5、60）→ embed 哈希热替换 / iframe refresh（§5）
```

- `descriptorFingerprint`（manager.ts:699-712）= entry / uiDir / **version** / contributes /
  permissions / **enabled** / builtin / uiEmbed / trustUi。**不含 settings、不含代码内容哈希**。
  → child 启停（enabled 进指纹）热生效；child **代码更新须 bump version** 才触发重激活
  （marketplace update 流程正是这么做的）；child **settings 变化不触发任何重启**。
- `broadcastPluginChanged` 的生产触发点只有两个：`plugins.reload` RPC 与 `plugins.config.set`
  （gateway.ts:2478-2504）。**链路 A 的 tools applier 成功后不广播 plugin.changed**；
  用户 config 变更恰好也被 plugin-watch 盯着（默认 configPaths = [getUserConfigPath()]，
  plugin-watch.ts:59）才间接补上广播——node 专属 config / 项目 vessel.yaml 路径不在其列，
  覆盖有洞（§3 根因 R3）。

**链路 C：启动装配**（重启才走的路）

```
bootstrap：选择 → loader.load → installWithConfig(真实宿主)（plugin-config.ts:40-47）
  → registerInProcessPluginEntries（plugin-host-assembly.ts:246-269）登记 RPC/贡献面，
    enabled 按当时 config 算一次（cli.ts:979 → inProcessPluginRows，:948 声明后不再更新）
  → createPluginHostManager（child descriptor，enabled 按 liveConfig；
    settingsFor 钉死启动 bundle config，cli.ts:967-976「C4：不回退 liveConfig」）
  → activateStartupPlugins：只预激活 onStartup/* 的 child；onPage/onCommand 懒激活
    （plugin-host-assembly.ts:317-366；内置 child 全是 onPage/onCommand，无 onStartup）
```

### 1.3 宿主注销能力现状（热卸载的物理边界）

`MemoryPluginHost`（packages/core/src/runtime/plugin-host.ts）：

| 注册面 | 注册 API | 注销 API |
| --- | --- | --- |
| tool | registerTool | **unregisterTool（:398，唯一）** |
| hook | registerHook（:212） | **无** |
| guardrail | registerGuardrail（:195） | **无** |
| provider | registerProvider（:183） | **无** |

`Plugin.dispose()` 存在（types/plugin.ts:36-37），但只在 `ExecutionUnit.dispose()`（body  teardown）
按逆安装顺序调用；**热应用路径从不调 dispose**（全仓 grep 无生产调用点）。
`PluginHostManager.enable()/disable()`（manager.ts:1131-1168）对 in-process 有完整的热翻
enabled + 注销/重注册 RPC 实现，但**全仓没有任何生产调用方**（无对应 RPC、config 热应用也不调）——
机制在，线没接。

---

## 2. 逐插件热 / 重启能力矩阵（任务①）

图例：✅ 热生效 ｜ ⚠️ 半热（部分注册面生效、部分残留/缺失）｜ ❌ 需重启 ｜ — 不适用。
「启停」指 config `plugins[].enabled` 翻转后经链路 A/B 的实际效果；「代码更新」指插件磁盘代码变化；
「settings」指 `plugins[].config` 变化。

### 2.1 in-process 能力插件

| 插件 | 注册面（file:line） | 热启用 | 热停用 | 代码更新 | settings | 根因 |
| --- | --- | --- | --- | --- | --- | --- |
| basic-tools | 工具集（index.ts:3242-3252） | ✅ | ✅ | ❌ | ✅ 热刷新 | 纯工具面，tools applier 全覆盖；cwd 等走 targetKey 整体刷新（cli.ts:1202） |
| recall | 工具（index.ts:137-143） | ✅ | ✅ | ❌ | ✅ | 同上 |
| web-tools | 工具（index.ts:639-644） | ✅ | ✅ | ❌ | ✅ | 同上；后端选择在 install 期读 config，targetKey 刷新即换 |
| media | 工具（index.ts:86-107） | ✅ | ✅ | ❌ | ✅ | 同上；install 期 CLI 探测决定 action enum，刷新即重探 |
| doc-subscription | 工具 + 2 个 BeforeLlm hook（index.ts:93-95） | ⚠️ 工具进、hook 缺 | ⚠️ 工具剥、hook 残留 | ❌ | ⚠️ | **R-A**：hook 无注销 API，旁路装配不同步 hook |
| skills | 工具 + RPC + watcher/store（index.ts:111-130；rpc :132-140） | ⚠️ | ⚠️ | ❌ | ❌「install 期钉死，生效语义=重启」（index.ts:98 注释） | **R-A/R-B/R-C**：RPC 登记不随 config 翻（manager.inProcess 无人翻）；旁路 re-install 重跑单例 install → service 被替换、旧 watcher 不 dispose（泄漏） |
| guardrail-pii | guardrail + pii_reveal 工具（index.ts:246-265） | ⚠️ **危险**：工具进、脱敏 guardrail 不生效 | ⚠️ 工具剥、脱敏仍跑 | ❌ | ❌ | R-A；安全面半热比不热更糟（模型以为有脱敏其实没有 / 以为关了其实还在） |
| redact-secrets | 2 个 guardrail，无工具（index.ts:116-137） | ❌ | ❌ | ❌ | ❌ | R-A：无工具可差量，guardrail 启动注册后永驻 |
| tool-policy | guardrail（index.ts:169-176） | ❌ | ❌ | ❌ | ❌ | 同上 |
| hook-logging | hooks（index.ts:278-281） | ❌ | ❌ | ❌ | — | R-A；另受 VESSEL_DEBUG 启动门控（plugin-selection.ts 头注） |
| anthropic / openai | registerProvider（anthropic index.ts:47-49；openai :58-61） | ❌ | ❌ | ❌ | ❌ | **R-D**：provider 专用装配只在启动；provider 实例已构造进 runtime。注意区分：`provider.model` 缺省模型热应用（applyProviderModel）是另一回事，已热 |
| model-registry | RPC-only，install(){} 空（index.ts:268-270） | ❌ RPC 面 | ❌ RPC 面 | ❌ | ✅ models/credentials 写盘 + config-watch 热应用（index.ts:10-11「已保存，下一具 body/run 生效」） | R-B：RPC 登记/注销只在启动与无人调用的 manager.enable/disable |
| mcp-client（工厂） | MCP 工具（server 连接注册） | ✅ per-server | ✅ per-server | ❌ | ✅ reconnect | mcp applier 热 enable/disable/reconnect（hot-apply-appliers.ts:329-407）；**新增 server 须重启**（:401-405 明确报 `requires restart (not loaded)`） |
| feishu（工厂） | 渠道成员 / 队列，无会话工具 | ❌ | ❌ | ❌ | ❌ | **R-E**：`feishu.enabled !== true` 不 import 不构造（feishu-wiring.ts:4）；渠道 start 还要 `--feishu`（:8）；启动期一次性接线 |
| evals（工厂） | 库 + runner，不进会话工具面（eval-wiring.ts:4-5） | ❌ | ❌ | ❌ | ❌ | R-E 同形；影响小（eval 命令面，非会话能力） |
| engine-client（工厂） | 装配层基础设施（bootstrap 恒构造，plugin-default-on-notes.md §2.2） | — | — | ❌ | — | 不是用户语义的插件开关；现态恒在 |

### 2.2 child 体验插件

| 插件 | 形态 | 热启用 | 热停用 | 代码更新 | settings | UI 资产更新 | 根因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| marketplace | child（vessel.entry，package.json:49） | ✅ | ✅ | ✅ bump version 触发 | ❌ 需重启 gateway | ✅ 哈希热替换 | 启停：set-enabled 写 config（DECISION-045，index.ts:234-246）→ plugin-watch → manager.reload（enabled 进指纹）。settings：spawn 期 `VESSEL_PLUGIN_CONFIG` env 注入（child.ts:162）+ `settingsFor` 钉死启动 config（cli.ts:967-976）→ 改 settings 连子进程重激活都拿不到新值，**必须重启 gateway** |
| usage | child（package.json:48；worker 线程在子进程内，worker.ts 头注） | ✅ | ✅ | ✅ 同上 | ❌ 同上 | ✅ | 同 marketplace；子进程重启时 worker 随之重建 |

### 2.3 第三方插件

| 形态 | 安装 | 卸载 | 更新 | 启停 | 根因 |
| --- | --- | --- | --- | --- | --- |
| child（marketplace 安装） | ✅ 热（plugins.reload → added → 懒激活） | ✅ 热（removed → deactivate + 注销） | ✅ 热（version bump → 指纹变 → 重激活） | ✅ | manager.reload 全链 + marketplace update 流程 |
| in-process（.tgz / 手放目录） | ❌ restart_required | ❌ | ❌ | ⚠️ 工具面热、其余同 §2.1 | inProcessFingerprint 变化只报 restart_required（plugin-host-assembly.ts:280-315）；ESM 缓存；无注销 API |

### 2.4 根因汇总

- **R-A 宿主只有工具注销面**：hook / guardrail / provider 注册后不可摘（plugin-host.ts:183/195/212
  只有 register，:398 只有 unregisterTool）；tools applier 的旁路装配只回传 ToolDefinition
  （hot-apply-assembly.ts:154 `return { tools: host.listTools(), names }`）。
  → 一切非工具注册面的启停都是半热或不热。
- **R-B in-process 登记态与 config 脱钩**：`manager.inProcess` 的 enabled 只在启动登记时算一次
  （manager.ts:723-733「与进程同寿命」）；`enable()/disable()` 有热翻实现但零生产调用方；
  config 热应用（链路 A）与 plugins.reload（链路 B）都不触碰它。→ RPC / 贡献面 / 面板 enabled 全不跟。
- **R-C 旁路装配重跑单例 install**：`loader.load()` 返回模块级单例（如 skills 的
  `skillsPlugin = createSkillsPlugin()`，index.ts:143-145），assemblePluginTools 对同一实例再次
  `installWithConfig`（hot-apply-assembly.ts:149-151）→ 内部 service / watcher 被重建而旧的不 dispose
  （热路径无 dispose 调用，§1.3）。副作用型插件（skills watcher、doc-subscription store）每热应用一次泄漏一份。
- **R-D provider 启动期构造**：provider 工厂进 runtime 后不可替换（provider-factory 启动装配）；
  新增 provider 插件目录明确 restart（gateway-reload-wiring.ts:96-99 注释）。
- **R-E 工厂插件启动期接线**：feishu / evals 按启动 config 构造一次（feishu-wiring.ts:4-8、
  eval-wiring.ts:4-9），无重构造入口。
- **R-F ESM 模块缓存**：代码更新物理上须重启（in-process）或 bump version 触发子进程重激活（child）。
  bun 连解析失败都缓存（plugin-loader.ts:326-328），「失败后补依赖再重试」也不行。
- **R-G child settings 双重钉死**：spawn 期 env 注入（child.ts:128-165，env 不可变）+
  settingsFor 读启动 bundle config（cli.ts:967-976）+ 指纹不含 settings（manager.ts:699-712）
  → 三层都挡住 settings 热生效。`plugins.config.set` 对 child 诚实返回 `restartRequired: true`
  （methods/config.ts:745），但「restart」实际指**重启 gateway**，不是重载插件（重载也拿不到新 settings）。

---

## 3. UI badge 现状（任务②，design-audit O5 验证）

面板：`apps/web/src/domains/settings/CapabilitiesView.tsx` plugins tab（「生效方式」列 :273-282，
badge 文案 `capabilities.restartRequired` = 「重启后生效」，zh-CN.ts:1856）；
marketplace InstalledTable 同款 badge（InstalledTable.tsx:104-106，「重启后生效」i18n.ts:232）。
数据源：`plugins.catalog`（methods/config.ts:613-627）← `buildPluginCatalog`（catalog.ts:123-180）。

**O5 成立，且是三重根因叠加：**

1. **R1 enabled = 启动快照**。catalog 的 `enabled: entry.enabled`（catalog.ts:167）来自
   `pluginEntries()`（cli.ts:1504-1507）：
   - `bundlePluginEntries()`：已装载 bundle 插件 **enabled 硬编码 true**（cli.ts:1472）；
     `inProcessPluginRows` 在启动登记时算一次（cli.ts:948、979），之后永不更新；
     显式 disabled 补行读的是 **gatewayBundle.config（启动 config）**而非 liveConfig（cli.ts:1482）；
     发现但未装载行按启动 config 的工厂门控标注（cli.ts:1492-1501）。
   - 本地 RPC 同形（bootstrap.ts:2101 `plugins.map(... enabled: true)`）。
   - 对照：**child 行是活的**（pluginRuntimeEntries ← manager.statuses()，cli.ts:1442-1467）。
   → 热 disable 一个 in-process 插件：工具真被剥了（链路 A），面板仍显示「已启用」；
   热装载一个启动时 disabled 的插件：工具真进了，面板仍显示「已禁用」。
2. **R2 restartRequired = 模式硬编码**。`restartRequired: descriptor.mode === 'in-process'`
   （catalog.ts:169，注释 :74-75 自认「in-process 插件切换后需要重启 gateway 才真正卸载」）。
   这是**静态模式属性**，不是「有待生效变更」的状态：
   - 所有 in-process 插件恒挂「重启后生效」——包括纯工具类、热应用已经生效的（**假阳性**，
     用户「大部分需重启」感知的直接来源）；
   - child 插件恒不挂——包括 settings 真的需要重启 gateway 的（**假阴性**）；
   - `plugins.reload` 返回的 `restart_required`（in-process 指纹变化，真信号）没有任何 UI 消费。
3. **R3 广播覆盖有洞**。`plugin.changed` 只从 `plugins.reload` / `plugins.config.set` 发出
   （gateway.ts:2478-2504）；链路 A tools applier 成功不直接广播。用户 config 变更靠
   plugin-watch 间接补（§1.2 链路 B），但 node 专属 config / 项目 vessel.yaml 不在其监听根
   （plugin-watch.ts:46-59 只盯 project/user 插件根 + 用户 config）→ 这些路径热应用后面板连
   对账机会都没有。且即使对账，R1 的快照数据依然是错的。

**结论**：UI 态与实际生命周期不符不是单点 bug，是「读面快照 + badge 硬编码 + 广播缺口」三层。
修复方案见 §6.2。

---

## 4. 插件版本现状（任务③）

### 4.1 三条版本线

| 版本线 | 位置 | 现值 | 语义 |
| --- | --- | --- | --- |
| 引擎版本 | 根 package.json | **2.0.0** | vessel 本体 |
| 包版本 pkg.version | plugins/*/*/package.json | **全部 0.56.1** | 发布收口时由 scripts/version.ts 统一 bump（MANIFEST_PATTERNS 含 `plugins/*/*/package.json`，version.ts:30-34） |
| 清单版本 vessel.version | package.json 的 vessel 块 | skills/marketplace/usage/model-registry **0.1.0**；web-tools **0.2.0** | 插件自身契约版本；child 的 reload 指纹用它（manager.ts:704）；marketplace 更新比对用它 |

另有第三份手写副本：Plugin 实例的 `version`（如 skills index.ts:108 `version: '0.1.0'`），
与清单版本靠人肉同步。

### 4.2 UI 混排的根源

catalog / plugins.list 的 version 取 `descriptor.version`，而 loader 两条分支取值不同：

- child 分支：`version: manifest.version`（plugin-loader.ts:478）→ marketplace / usage 显示 **0.1.0**；
- in-process 分支：`version: pkg.version`（plugin-loader.ts:501）→ 其余全部显示 **0.56.1**
  （**含有 capabilityManifest 的 skills / web-tools / model-registry**——清单里的 0.1.0 / 0.2.0
  在面板上根本不出现）。

→ 用户看到的「有的 0.1.0 有的其他版本」= 两条取值分支混排，不是插件真的各自独立演进。

### 4.3 引擎门禁现状（q-plugin-version 刚落地）

- `engines.vessel` 门禁**只对外部插件**（external: true）：必填且必须覆盖当前引擎版本，
  否则 fail-closed（plugin-manifest.ts:1429-1435、:372-374 注释）。
- 内置 / 自研（repo 源）**恒兼容**：engines 可选、声明了只做形状校验（2026-11-25 用户裁定，
  e09858fc）；5 个内置 manifest 的 engines 已删（skills / marketplace / usage / model-registry / web-tools）。
- 第三方保护保留：marketplace install / registry 的 engines 检查不动。
- **漂移事实**：引擎 2.0.0 而插件包 0.56.1——version.ts 的机制就是「内置跟踪 vessel 版本」，
  但 2.0.0 收口没跑它（或跑了没含插件）。`--check` 模式（version.ts:9）本可拦住这种漂移。
  内置恒兼容裁定后，版本漂移不再造成加载失败，但**面板版本显示失真**依旧。

---

## 5. 热加载机制细节：iframe / embed 资产如何更新（任务④）

**结论先行：UI 资产（iframe HTML / embed 模块 / CSS / chunk）今天就是热替换的，不需要重启。**
需要重启的从来不是「web 资产」，而是 §2 矩阵里的后端注册面与 settings。

### 5.1 服务端缓存策略（static.ts:88-110）

| 资产 | Cache-Control | 理由 |
| --- | --- | --- |
| iframe HTML（`/plugins/<id>/<entry>`） | `no-cache` + PLUGIN_CSP | 每次协商，磁盘换了立刻可见 |
| embed 入口 / CSS（`/plugins/<id>/ui/<path>`） | `no-cache` | 入口必须带 `?v=<hash>` 加载，双保险 |
| 其余（带哈希文件名的 chunk） | `public, max-age=31536000, immutable` | 内容变 → 文件名变，旧缓存自然失效 |

### 5.2 哈希从哪来、怎么到浏览器

1. manager 在 descriptor 加载 / reload 时计算 embed bundle 的 trust + hash
   （manager.ts:1533 附近 `embedStateFor` / `refreshEmbedState`）；
   **descriptor 指纹没变但 bundle 内容变了 → 只重算 hash，不重启子进程**（manager.ts:1010-1017，
   plugin-embed 契约 §8 热更新）。
2. hash 经 `plugins.list` 的 `ui_bundle_hash` 字段下发（methods/config.ts:573-575）；
   `plugin.changed` 广播同一快照（gateway.ts:3241-3251）。
3. web 对账（usePluginContributions.ts:60）→ 两条渲染档各自热替换：
   - **embedded 档**（PluginEmbed.tsx:64-100）：hash 变化 → 旧模块 `dispose()` + host 订阅回收
     → `import(url + '?v=' + 新hash)` 拿新模块实例（embed-loader.ts:46-48）→ ErrorBoundary
     key = id:hash:attempt 变化重挂载。旧 ESM 模块无法从浏览器模块表卸载，泄漏有限次可接受
     （embed-loader.ts:62-70 注释）。CSS 用 `<link href=...?v=hash>` 注入，哈希变即换（PluginEmbed.tsx:103-115）。
   - **isolated 档**（PluginFrame.tsx）：iframe src 变化由父级重挂载；src 未变时
     `plugin.changed` → postMessage `vessel.plugin.refresh` 让页面自行重取数据
     （PluginFrame.tsx:165-197）+ 200ms 去抖重推 catalog。HTML no-cache → 重挂载即新资产。

### 5.3 对「iframe 资产热替换可行性」的回答

可行且**已实现**。剩余缺口只有两个，都不在资产层：
- child **后端代码**更新：指纹不含代码内容哈希，磁盘改代码不 bump version → 子进程不重启
  （§1.2 链路 B）。marketplace 更新流程靠 version bump 绕过；手改代码的开发场景须重启 gateway。
- child **settings**：R-G 三层钉死，重启 gateway 才生效。---

## 6. 设计方案

原则：**能热的真热，不能热的诚实说重启；显示态与生效态同源。**
不采纳「内置一律不能热加载关闭」的一刀切（§6.6）。全部字段 additive，旧客户端零破坏。

### 6.1 manifest 生命周期声明（per-capability，宿主推导为主、声明为辅）

**为什么不做一个二元 `lifecycle: 'hot' | 'restart'`**：现状矩阵（§2）里同一插件的不同能力
生命周期不同（skills 工具热 / RPC 不跟 / settings 重启；child 启停热 / settings 重启）。
二元声明必然在某一面撒谎。推荐 per-capability：

```jsonc
// package.json → vessel 块（additive，可选；与 scaffold 设计 §6.4 defaultEnabled 为 sibling 字段）
"lifecycle": {
  "toggle":   "hot" | "restart",   // enabled 翻转（含其全部注册面）
  "settings": "hot" | "restart",   // plugins[].config 变化
  "code":     "hot" | "restart"    // 磁盘代码更新；in-process 宿主强制 restart（ESM 物理约束）
}
```

**真源是宿主推导，不是插件自报**（第三方插件可能谎报 hot）：

1. **install 期注册面审计**：旁路装配（assemblePluginTools 的 MemoryPluginHost）包一层记录器，
   记下该插件 install 注册了哪些面（tool / hook / guardrail / provider / rpc / 副作用）。
   推导规则（对应 §2.4 根因）：
   - 纯 tool（±rpc）→ `toggle: hot`（P1 后含 hook/guardrail，见 §6.3）；
   - hook / guardrail / provider / 启动期副作用（watcher、渠道）→ `toggle: restart`（P1 前）；
   - child → `toggle: hot`（进程边界是天然隔离单元，manager.reload 已全链）；
     `settings: restart`（R-G，P2 后转 hot）；
   - in-process → `code: restart` 恒成立（R-F）；child → `code: hot`（version bump 触发）。
2. **manifest 声明只允许比推导更保守**：声明 restart 而推导 hot → 采纳声明（插件作者知道
   宿主看不见的副作用）；声明 hot 而推导 restart → warn 一次 + 生效值取 restart（fail-honest）。
3. 推导结果进 catalog 新字段 `lifecycle`（§6.2），UI 与 CLI `plugin list` 共用同一份。

### 6.2 修 O5：badge 如实反映 + 热加载态实时跟踪

三层修复对应 §3 三重根因，可独立增量落地：

**R1 修复（enabled 读面活口径 + 读写联动）**

- 读面：`bundlePluginEntries()`（cli.ts:1470-1503）与 bootstrap.ts:2101 的 enabled 不再硬编码
  true / 读启动 config，统一改调共享判定 `pluginEntryEnabled(liveConfig.plugins, id)`
  （plugin-config.ts:119-128，CLI / 宿主装配已共用，消灭第三份口径）。
- **只做读面会制造新不一致**（面板显示关、RPC 面还开着）。因此配套读写联动：
  config 热应用链（链路 A）在 tools applier 之后增加一步「in-process 登记态同步」——
  按 liveConfig 对每个已登记 in-process 插件调 `manager.enable(id)` / `manager.disable(id)`
  （manager.ts:1131-1168，**现成实现、零生产调用方**，R-B 就此接线）：
  disable → 翻 enabled + 注销 RPC + 贡献面收口；enable → 翻回 + 重注册 RPC。
  读面随后直接读 manager 状态（child 行今天就是这么做的，cli.ts:1442-1467），双轨同口径。
- 效果：热 disable → 工具剥 + RPC 注销 + 面板显示关 + 导航页消失，**四面一致**。

**R2 修复（restartRequired 改 pending 语义）**

- catalog 新增 `pendingRestart: boolean`（additive；旧 `restartRequired` 字段保留一个版本期
  作兼容别名，CHANGELOG 登记语义变更）：
  `pendingRestart = 存在「期望态 ≠ 已生效态」且该面 lifecycle 为 restart 的差异`。
  差异来源（全部已有计算，只差汇聚）：
  - in-process 指纹变化（createPluginReloader 的 restart_required，plugin-host-assembly.ts:300-313）；
  - child settings 变化（liveConfig vs settingsFor 启动快照，R-G）；
  - lifecycle profile 为 restart 的插件的 enabled 变化（P1 前的 hook/guardrail/provider 类）；
  - RESTART_FIELDS（agent/tls/token/port，gateway-reload-wiring.ts:100-113，属 config 域，
    面板已有 config 重启提示的沿用其口径）。
- badge 语义（CapabilitiesView「生效方式」列 + marketplace InstalledTable 同款）：
  - `pendingRestart: true` → warn badge「重启后生效」（真阳性）；
  - lifecycle 全 hot 且无 pending → 不挂 badge（或 neutral「即时生效」）；
  - **模式信息留在 mode 列**（已有），不再用 restart 列复述模式。
- `plugins.reload` 返回的 `restart_required`（真信号）接入同一 pending 汇聚，不再无 UI 消费。

**R3 修复（广播补洞）**

- tools applier / 登记态同步成功后触发 `broadcastPluginChanged`（gateway.ts:3260-3273 已有函数，
  经 reload runner 注入触发点，与 plugins.reload / plugins.config.set 同一出口）。
- 统一不变量：**任何插件生效态变化 → 必有一次 plugin.changed**；web 对账（usePluginContributions）
  随即拿到 R1 修复后的活数据。node 专属 config / 项目 vessel.yaml 路径不再依赖 plugin-watch 间接补。

### 6.3 热卸载补齐（P1：注销 API + dispose 热路径 + 旁路新实例）

目标：把 ⚠️/❌ 的 in-process 插件升级为真热，消除 R-A / R-C。

1. **core 宿主补对称注销面**：`unregisterHook(name)` / `unregisterGuardrail(name)` /
   `unregisterProvider(name)`（与 unregisterTool 同形；hook/guardrail 已有 name 字段可作键）。
   这是纯 additive API，不动既有注册语义。
2. **热应用从「工具差量」扩为「注册面差量」**：旁路装配审计（§6.1）产出目标注册面全集，
   applyTools 推广为 applyRegistrations：tool / hook / guardrail 各按名差量增删，
   失败逆序回滚（沿用 applyTools 的回滚骨架，hot-apply-appliers.ts:245-264）。
   provider 面**不进热差量**（R-D 结构性，保持 restart 声明）。
3. **dispose 进热路径**：插件被热移除时调其 `Plugin.dispose()`（types/plugin.ts:36-37，
   best-effort 吞错，与 ExecutionUnit.dispose 同语义）；skills watcher / doc-subscription store
   由此真正释放。
4. **旁路装配改新实例，杜绝单例 re-install**（R-C）：旁路用 cache-busted import
   （`import(href + '?bypass=' + seq)`）拿新模块实例，真实宿主的实例不被旁路触碰。
   模块表泄漏有限次可接受——与浏览器 embed 热更新同一权衡（plugin-embed 契约 §8，
   embed-loader.ts:68 注释已接受该权衡）。热启用时真实宿主同样换新实例（旧实例 dispose）。
   长期方向：插件导出工厂（scaffold 设计已往此走），工厂化后旁路零泄漏。
5. **P1 前的过渡安全闸（all-or-nothing）**：lifecycle profile 为 restart 的插件，
   tools applier **跳过其工具差量**（保持启动态 + pendingRestart badge），不再制造
   「pii_reveal 工具进了但脱敏 guardrail 没生效」的危险半态（§2.1 guardrail-pii 行）。
   这是相对今天的行为变化（今天会半热剥离），CHANGELOG 登记 + 金丝雀回归。

### 6.4 内置插件版本策略（用户建议的采纳与修正）

**采纳「内置跟踪 vessel 版本」，保留「独立 version」给第三方与契约语义：**

| 对象 | pkg.version | vessel.version（manifest） | 门禁 |
| --- | --- | --- | --- |
| 内置插件（repo 源） | **= 引擎版本**，发布收口由 version.ts 统一 bump | **同步 bump = 引擎版本**（写模式扩展：version.ts 目前只写 pkg.version，不写 vessel 块） | 恒兼容（已裁定，e09858fc） |
| 第三方插件 | 独立 | 独立（marketplace 更新比对 / child reload 指纹的真源） | engines.vessel 必填且须覆盖引擎（保留） |
| plugin-sdk | 独立契约版本线（version.ts:36-44 已豁免） | — | runtime.sdk range |

- **漂移修复**：引擎 2.0.0 / 插件 0.56.1 的既成漂移，在下次发布收口跑 version.ts 写模式回填；
  本设计切片不动版本号（发布权归发布切片）。防再发：build / CI 门禁加 `version.ts --check`
  （机制已在，version.ts:9），内置 pkg / vessel / 引擎三者不一致即红。
- **UI 混排消除**：内置 vessel.version 跟踪引擎后，loader 两条取值分支（child 取 manifest.version、
  in-process 取 pkg.version）自然同源，面板内置行统一显示引擎版本；第三方行显示自身版本。
  无需改 loader 取值逻辑（改显示口径是治标，版本同源是治本）。
- **手写第三份副本清理**：Plugin 实例的 `version`（skills index.ts:108 等）改为读清单 /
  package.json，或删字段（catalog 不消费它），消灭人肉同步。
- 为什么不采纳「内置 manifest 版本保持 0.1.0 独立」：内置与引擎同仓同发布，独立版本线
  没有演进事实支撑（0.1.0 从未 bump 过），只制造显示混排与指纹语义混乱；独立版本的价值
  在第三方生态（marketplace 更新、engines 兼容），那里完整保留。

### 6.5 升级路线图（哪些可升级为热加载）

| 阶段 | 内容 | 升级为热的对象 | 风险 |
| --- | --- | --- | --- |
| **P0 显示诚实**（纯读面 + 广播，零行为风险） | §6.2 R1 读面活口径 + R2 pending badge + R3 广播补洞；R1 的 manager.enable/disable 联动若嫌行为面大，可拆到 P0.5 | 面板如实：工具类插件显示「即时生效」，restart 类只在真有 pending 时挂 badge | 低；用户会看到状态「翻转」（实为纠错），金丝雀登记 |
| **P1 注册面补齐** | §6.3 注销 API + dispose 热路径 + 旁路新实例 + all-or-nothing 过渡闸 | doc-subscription / skills / guardrail-pii / redact-secrets / tool-policy / hook-logging 启停转真热 | 中；core API additive，热差量回滚骨架复用 |
| **P2 child settings 热应用** | settingsFor 改读 liveConfig（拆 cli.ts:967-976 的 C4 钉死）+ settings 哈希进 reload 指纹（或 settings 变更显式触发 deactivate+reactivate）；plugins.config.set 对 child 返回后自动触发 plugins.reload | marketplace / usage settings 转热（子进程重激活，非 gateway 重启）；「重启后生效」badge 对 child settings 摘除 | 中；子进程重启有秒级窗口，懒激活兜底 |
| **P3 代码热更新**（可选） | child 已支持（version bump）；in-process 用 P1 的 cache-busted import + 指纹触发即可做，但模块表泄漏随更新次数增长 | 建议仅 dev 模式（VESSEL_DEBUG）开放 in-process 代码热更；生产保持 restart 诚实声明 | 高；不做也可接受 |
| 不做 | provider / feishu / evals 工厂重构造 | 保持 restart（R-D/R-E 结构性；feishu 渠道 stop/start 理论可行，成本高收益低） | — |

**iframe 资产热替换可行性**（任务④的直接回答）：已实现且全链验证（§5），无需升级；
P2 解决的是 child 后端 settings，不是资产层。

### 6.6 对用户问题的直接回答

1. **「大部分需重启才能开启/关闭，这样好吗？」**——不好，但现状没有感知的那么差：
   工具类与 child 启停今天就是热的；「大部分需重启」的感知主要来自假 badge（O5/R2）
   与半热残留（R-A）。先修显示（P0），再补机制（P1/P2），重启面会收缩到
   provider / 工厂类 / in-process 代码更新这些**结构性合理**的角落。
2. **「很多插件可独立版本 + 热关闭热加载」**——方向成立：热关闭热加载按 per-capability
   落地（§6.1/6.3/6.5）；独立版本保留给第三方（§6.4）。
3. **「若不行，内置跟踪 vessel 版本 + 设为不能热加载关闭」**——前半采纳（§6.4，机制已在、
   修漂移）；后半**不采纳一刀切**：把已经热的工具类插件降级成重启是方向反了，
   且「不能热」应由宿主推导 + 诚实 badge 表达，而不是写死禁止。内置中真正不能热的
   （provider / hook / guardrail 类，P1 前）会在面板如实挂「重启后生效」，用户建议的
   合理内核（别假装能热）由 fail-honest 推导规则（§6.1）满足。

---

## 7. 风险与备选

- **行为变化面**（实施切片须登记 CHANGELOG + 金丝雀）：
  - P0：面板 enabled 从启动快照变活口径（纠错性翻转）；restart badge 从恒挂变 pending。
  - P0.5/R1 联动：in-process RPC / 贡献面随 config 热启停（今天不跟）——导航页会随热 disable 消失，
    这是期望语义，但属可见行为变化。
  - P1 过渡闸：restart 类插件工具不再半热剥离（相对今天是行为收缩，安全方向）。
- **模块表泄漏**：cache-busted import 每次热应用泄漏一份模块（有界、进程重启清零）；
  与浏览器 embed 已接受的权衡同形。备选是插件全面 child 化 / engine-pool 隔离——
  那是更大架构（ADR-106 方向），不在本设计范围。
- **备选方案对比**：
  - (a) 一刀切内置禁热（用户备选）：否——降级已热能力，且把显示问题当机制问题治。
  - (b) 只修 badge 不补机制（P0 单独成切片）：可行且推荐先行——诚实的「重启后生效」
    本身已消除大部分用户困惑；P1/P2 按收益排期。
  - (c) 全插件 child 化：热卸载天然成立，但工具调用走 IPC 的延迟与改造面过大，否。
- **宪法约束**：本切片零代码改动、零测试/探针；实施切片的验证计划（canary 回归项）
  由实施者另立，本文不代跑。

## 8. 锚点索引

| 主题 | 位置 |
| --- | --- |
| 执行形态判据 / 扫描缓存 / ESM 缓存 | src/plugin/plugin-loader.ts:15、103-104、448-487、592-609、326-328、361-371 |
| 版本取值双分支 | src/plugin/plugin-loader.ts:478（child=manifest.version）、:501（in-process=pkg.version） |
| 覆盖层选择语义 | src/plugin/plugin-selection.ts 头注；src/plugin/plugin-config.ts:119-128 |
| 链路 A config-watch | src/config/config-watch.ts:106-233；src/cli.ts:1407-1433 |
| tools applier / 旁路装配 | src/cli.ts:1185-1243；src/config/hot-apply-assembly.ts:120-155；src/config/hot-apply-appliers.ts:202-303 |
| 链路 B plugin-watch / reloader | src/plugin/plugin-watch.ts:46-59；src/cli.ts:997-1021；src/plugin/plugin-host-assembly.ts:280-315 |
| manager.reload / 指纹 / embed 热刷新 | packages/serve/src/plugin-host/manager.ts:699-712、941-1070、1010-1017 |
| manager 热启停（零调用方）/ in-process 登记 | packages/serve/src/plugin-host/manager.ts:1131-1168、1197-1241、723-733 |
| 宿主注销面缺口 | packages/core/src/runtime/plugin-host.ts:183、195、212、398；packages/core/src/types/plugin.ts:36-37 |
| O5 读面快照 | src/cli.ts:948、979、1470-1503（:1472 硬编码 true、:1482 启动 config）；src/runtime/bootstrap.ts:2101 |
| O5 badge 硬编码 | packages/serve/src/plugin-host/catalog.ts:74-75、169；apps/web/src/domains/settings/CapabilitiesView.tsx:273-282；plugins/marketplace/marketplace/web-src/components/InstalledTable.tsx:104-106 |
| O5 广播触发点 | packages/serve/src/gateway.ts:2478-2504、3260-3273 |
| gateway.reload scope / RESTART_FIELDS | src/gateway/gateway-reload-wiring.ts:96-113、157、200-206；docs/adr/ADR-075-gateway-reload-scope.md |
| child settings 钉死 | src/cli.ts:967-976；packages/serve/src/plugin-host/child.ts:128-165；packages/serve/src/gateway/methods/config.ts:745 |
| iframe/embed 缓存与热替换 | packages/serve/src/plugin-host/static.ts:88-110；apps/web/src/domains/plugins/embed-loader.ts:46-48、62-70；apps/web/src/domains/plugins/PluginEmbed.tsx:64-115；apps/web/src/domains/plugins/PluginFrame.tsx:165-197；docs/architecture/plugin-embed.md §8 |
| 版本机制 / 门禁 | scripts/version.ts:9、30-44；src/plugin/plugin-manifest.ts:293-323、1429-1435；e09858fc（内置恒兼容裁定） |
| 工厂插件启动接线 | src/plugin/feishu-wiring.ts:4-8；src/plugin/eval-wiring.ts:4-9；src/plugin/mcp-wiring.ts:1-10；src/plugin/plugin-loader.ts:51-56 |
| 各插件注册面 | 见 §2 矩阵逐行 file:line |
| 前置调研 | docs/dev/plans/plugin-default-on-notes.md（覆盖层语义 + 面板显示链）；docs/dev/plans/plugin-scaffold-design.md §6.4（defaultEnabled 未落地）；docs/architecture/plugins.md、plugin-registry.md |