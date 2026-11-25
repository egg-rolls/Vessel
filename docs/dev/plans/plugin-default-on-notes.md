# 插件默认开启（用户裁定）——现状全链调研笔记

任务：q-plugin-default-on 步骤①。用户裁定：**安装的插件默认开启，而不是默认关闭**。
本笔记钉住现状语义、opt-in 名单逐个论证、显式覆盖链、面板显示链，并给出步骤②的实施方案与待裁点。
分支 fix/q-plugin-default-on（基于 redblue-dev）。所有行号以提交时工作区为准。

## 1. 默认集怎么算（唯一真源：plugin-selection.ts）

`resolvePluginSelection(loader, configured, debug, declarative, env)`
（src/plugin/plugin-selection.ts:56）是 bootstrap / 热应用 / CLI / `--tools` 共用的选择层：

- **`plugins:` 缺省（undefined）→ 默认集**（:74-90）= 全部满足以下条件的描述符：
  - `mode === 'in-process'`（child 体验插件由宿主 spawn，不进 in-process 名单）；
  - `category !== 'provider'`（anthropic / openai / model-registry 走 provider 专用装配）；
  - 不在 `FACTORY_PLUGINS`（plugin-loader.ts:51：`mcp-client` / `evals` / `feishu` / `engine-client`，
    默认导出是工厂函数，由 bootstrap 按专用配置构造）；
  - 不在 `OPT_IN_PLUGINS`（plugin-loader.ts:65：**当前只剩 `media` 一个**）；
  - `name !== 'hook-logging'`（调试观测，`VESSEL_DEBUG` 时才追加，:124-126）；
  - `VESSEL_NO_EXTERNAL_PLUGINS=1|true` 时只留 `source === 'repo'`。
  - **外部插件（project / user / node_modules）默认就在默认集里**，启动告警一次
    （warnExternalPluginsOnce）——「默认信任模型」，不是默认关闭。
- **`plugins:` 出现（含空数组）→ 完整 opt-in 清单**（:91-96）：不回退默认集，
  只加载显式条目；`enabled:false` 条目跳过；全 false → 空集，绝不回退「全部」。
  文件头注释（:13-18）明言这是金丝雀 issue-0 陷阱：只想配一个插件而写部分清单，
  会把其余内置插件全部排除（热应用会据此从活体节点剥离工具）。
- 声明式 `guardrails:` / `hooks:` 条目按名追加（本身即显式 opt-in）；
  显式 `plugins[]` 的 `enabled` 是最终裁决（false 不能被声明式条目重新启用，:98-122）。
- 别名归一：config 按旧包短名（plugin-skills）或清单 id（skills）书写都归一到规范名。

消费点（改一处全覆盖）：
- src/runtime/bootstrap.ts:1152（启动告警）；
- src/runtime/tenant-runtime-factory.ts:901（运行时装配）；
- src/config/hot-apply-assembly.ts:129（`assemblePluginTools`，热应用 / `--tools` 同源）；
- src/cli/commands/doctor-command.ts:299；
- src/cli/commands/plugin/plugin-command.ts:197（`plugin list` 的启用标注）。

## 2. opt-in 名单逐个论证

### 2.1 OPT_IN_PLUGINS：只剩 media

plugin-loader.ts:58-76 注释给出的理由：refs-pipeline.md §4 契约要求 media 不进默认集，
「避免给所有用户加工具 schema」。**该文档已不在树内**（docs/dev/plans/refs-pipeline.md 不存在），
理由只剩注释转述。逐条对现状：

- media 现态（plugins/media/media/src/index.ts:79-117）：`view` 恒可用（图片入 blob 池，
  主模型原生视觉，**零外部后端**）；`read`（文本直读）恒可用；PDF/ocr/describe 按 install
  阶段 CLI 探测进 schema 的 action enum。**零后端时已经优雅降级**：warn 一次 + 仍注册
  缩减版工具（:91-99），不崩不刷屏——「未配置优雅 idle」的要求 media 已天然满足。
- 先例：`web-tools` 0.52 时同样 opt-in，0.56 转默认加载（plugin-loader.ts:67-75 逐条论证：
  免费缺省后端 + 缺 key 时工具依然在、调用报 `provider_auth_failed` 点名 env）。
  media 的顾虑（schema 成本）比 web-tools 当时的顾虑（花钱/外发）更弱。
- 关联点：src/data/refs-notice-hook.ts:13 注释依赖「media 是 opt-in，未启用时模型侧根本
  没有这个工具」——翻转后该提示逻辑需复核（工具恒在时 refs 提示的措辞/条件）。
- **结论：media 无结构性保留理由，建议删名转默认**（Set 机制保留为空集，照 scaffold 设计
  §7.2 的清理顺序）。需配置才工作的部分（describe 桥）未配置时明确报错不降级，符合 idle 要求。

### 2.2 FACTORY_PLUGINS（结构性，建议保留，逐个论证报 main 裁）

| 插件 | 现态门控 | 结构性理由 |
| --- | --- | --- |
| feishu | `config.feishu?.enabled === true` 才构造（feishu-wiring.ts:4「默认关闭：不 import、不构造」）；`--feishu` 启动还要 assertFeishuStartable（:60-71：appId/appSecret 必填，缺则 exit 2） | 外部 IM 渠道：需凭证 + 显式开渠道意图；无凭证时「开启」无对象，且渠道会拉外部消息进执行面，默认开有安全面 |
| mcp-client | `mcp_servers` 有 enabled 条目才装配（plugin-command.ts:207） | 无 server 配置时无连接对象；「开启」空转无意义。缺省 idle = 不构造，列表按实际装配标注 |
| evals | `config.evals?.enabled !== false`（缺省算启用，plugin-command.ts:210）；runner 供 eval 命令用 | 已经默认「启用」语义，只是不进会话工具面；无需翻转 |
| engine-client | bootstrap 恒构造（bootstrap.ts:1217），transport 晚绑定 fail-closed；supervisor 仅 toolsEngine 显式 mode 时启动 | 装配层基础设施，不是用户语义的「插件开关」；现态已恒在 |

### 2.3 其它排除项（结构性，建议保留）

- **provider 类**（anthropic / openai / model-registry）：走 provider 注册专用装配，
  不是工具面插件；「默认开启」对它们无意义（由 `provider.name` 选择）。
- **hook-logging**：调试观测插件，`VESSEL_DEBUG` 门控；默认开会话刷屏，保留。
- **child 模式**：不是排除——child 体验插件（usage / marketplace 等）**本来就默认开启**
  （见 §3.2），只是不经 in-process 装载名单。
- 任务书提到的 **federation 插件在本分支不存在**（plugins/ 与 src/plugin/ 均无），
  应是其它切片产物；本切片不处理。

## 3. config 显式覆盖链

### 3.1 in-process：enabled:false 的三层语义

1. `plugins:` 缺省 → 默认集（§1），无显式覆盖；
2. `plugins:` 存在 → 完整清单语义：未列入 = 关；`enabled:false` = 关（最终裁决，
   声明式条目不能复活）；
3. `vessel plugin enable|disable <name>` → `setPluginEnabled`（src/plugin/plugin-config.ts:89-121）：
   只改目标 name 的 enabled；**`plugins:` 不存在时按 `allNames` 物化默认集**
   （plugin-command.ts:350 传 `loader.getAvailablePlugins()`）。

⚠ **发现两处现态缺陷（与翻转直接相关）**：

- **物化名单与运行时默认集漂移**：`getAvailablePlugins()`（plugin-loader.ts:624-633）
  只排除 provider / factory / child，**不排除 media 与 hook-logging**。于是
  `vessel plugin enable X` 在 `plugins:` 缺省时物化出的清单会顺手把 media、hook-logging
  写成 `enabled:true`——CLI 一次 enable 悄悄改变了这两个插件的默认态（media 意外进清单；
  hook-logging 写入 true 但选择层仍按 debug 门控，账实不符）。
- **物化之后新装插件默认关**：`plugins:` 一旦物化就是完整清单，此后 `vessel plugin install`
  装进 ~/.vessel/plugins 的新插件不在清单里 → 静默不加载。**这是「装的插件默认关闭」
  在现实中最主要的触发路径**（用户只要用过一次 enable/disable 或面板开关就进入此态）。

### 3.2 child 体验插件：两套口径不一致

- 宿主装配 `pluginEnabledInConfig`（src/plugin/plugin-host-assembly.ts:56-59）：
  **条目缺省 = true**，即使 `plugins:` 存在但没列它 → 默认开启（符合用户裁定）。
- CLI `plugin list` 的 `pluginEnabledByConfig`（plugin-command.ts:111-115）：
  `plugins:` 存在时**必须显式列入才算启用** → 与宿主实际行为可能相反（宿主加载了，
  CLI 显示 no）。步骤③要对齐的就是这类口径。

### 3.3 配置面（packages/config/src/types.ts:276-287）

`PluginConfig { name, enabled?, config?, expose?, trust_ui? }`；`plugins?: PluginConfig[]`
（:1178）。enabled 缺省 undefined；选择层把 undefined 当启用（显式清单内）或不看（默认集）。
`expose` / `trust_ui` 是外部插件授权面，与启用语义正交（翻转不动它们）。

## 4. manifest defaultEnabled 现状：只有设计，没有实现

- `src/plugin/plugin-manifest.ts` 的 `parsePluginManifest`（:1404-1564）**不解析
  defaultEnabled 字段**（全文件无此键）；manifest 现态字段：id/name/version/engines/
  side/scope/entry/ui/activationEvents/contributes/permissions/dependencies/override。
- 设计在 docs/dev/plans/plugin-scaffold-design.md §6.4（:572-603）：
  `vessel.defaultEnabled`（缺省 true；false = 不进默认集），选择层改读
  `descriptor.capabilityManifest?.defaultEnabled !== false`，OPT_IN_PLUGINS 保留为
  legacy 兜底、media 迁移后删名（§7.2）。**该设计尚未落地（P3 未做）**。
- ⚠ 设计文档 §7.1 给 media 规划的是 `defaultEnabled:false`（维持 opt-in）——
  **用户本次裁定推翻了这一条**：media 应默认开启。若后续 P3 落地，media 的清单应写
  `defaultEnabled:true` 或不写（缺省 true）。本切片不实现 manifest 字段（最小改动：
  直接删 OPT_IN_PLUGINS 里的 media 名，Set 机制保留为空集，与 §7.2 清理顺序一致）。

## 5. 设置/插件面板显示链（步骤③靶点）

数据流：`plugins.list` / `plugins.catalog`（packages/serve/src/gateway/methods/config.ts:545/605）
← `mergePluginList`（:519-539，enabled=false 的行不带 contributions）
← 基础行产地（两处同形）：

- gateway 模式 src/cli.ts:1435-1457 `bundlePluginEntries`：
  已装载 bundle 插件（**enabled 硬编码 true**）+ inProcessPluginRows（provider 类登记行，
  enabled 按 pluginEnabledInConfig）+ **config 里显式 enabled:false 的插件补行**
  + child manager.statuses()。
- 本地 RPC src/runtime/bootstrap.ts:2084-2095：同形（无显式 disabled 补行分支）。
- catalog（packages/serve/src/plugin-host/catalog.ts:123-180）：由 entries × descriptors
  推导；**缺 entry 的已发现插件直接不出现**。

⚠ **显示缺陷（与翻转直接相关）**：已安装但未装载、且 config 里没有显式 disabled 条目的
插件（如缺省态的 media、物化清单后新装的插件）**在面板里完全不可见**——不是显示「关」，
是根本没有行。翻转后这些插件会装载并出现；步骤③还需决定「发现但未装载」的插件是否补行
（enabled:false + status），让面板与 `vessel plugin list`（它列全部发现结果）口径一致。

写路径：面板设置值 → `plugins.config.set`（config.ts:657）→ setPluginConfigValue
（只改 config 键，**不写 enabled**）；启用开关 → config.set / `vessel plugin enable|disable`
→ setPluginEnabled（§3.1 物化问题在此）。

## 6. 步骤②实施方案（建议）与待裁点

### 6.1 无争议部分（两种裁定下都做）

1. **media 删名转默认**：OPT_IN_PLUGINS 清空（Set 机制保留），更新 plugin-loader.ts:58-76
   注释（照 web-tools 0.56 转默认的论证格式）；复核 src/data/refs-notice-hook.ts 的
   opt-in 依赖注释与提示条件；media 零后端已优雅 idle（warn 一次 + 缩减 schema），无需改插件。
2. **结构性排除保留**（§2.2/§2.3 逐个论证，报 main 裁）：provider 类 / FACTORY_PLUGINS /
   hook-logging / child 不经 in-process 名单。
3. **修物化漂移**：`setPluginEnabled` 的 allNames 改用与选择层同一默认集口径
   （排除 media 翻转后已一致，但 hook-logging 仍应排除），或见 6.2 方案 B 直接不物化。
4. **child 口径对齐**：plugin-command.ts 的 pluginEnabledByConfig 改为与
   pluginEnabledInConfig 同语义（条目缺省 = 启用），消除 CLI 与宿主相反显示。

### 6.2 待裁点：`plugins:` 完整清单语义是否翻转（核心决策）

- **方案 A（保守）**：保留「plugins: 出现 = 完整启用清单」。翻转只覆盖缺省态（media 进默认集）。
  代价：物化清单后新装插件仍默认关——用户裁定的主要痛点没有解决；物化逻辑必须保留
  （否则单条 enable 会关掉其它一切）。
- **方案 B（推荐）**：`plugins:` 改为**覆盖层**语义——默认集（全部已安装，含新装）恒为底，
  显式条目只做覆盖：`enabled:false` 排除；列入 = 显式启用（可救回 opt-in/结构性排除项中
  允许救回的）；未列入 = 走默认。`setPluginEnabled` 不再物化全量清单，只写目标单条。
  收益：新装插件不配置即装载（用户裁定原义）；顺带消灭金丝雀 issue-0 陷阱（部分清单
  不再剥离内置工具）。代价：推翻 plugin-selection.ts:13-18 登记的既有契约语义，
  存量「靠部分清单刻意只开少数插件」的配置会多开插件（需 enabled:false 显式关）；
  热应用剥离逻辑、doctor、--tools 同链自动跟随，但金丝雀需重点回归。
- 任务书「显式配置（enabled:false/排除）优先」两种方案都满足；「排除」若指「完整清单
  未列入即排除」则与方案 B 冲突——**此歧义须 main/用户裁**，步骤②动手前先拿裁定。

### 6.3 待验点（步骤③总报告用）

- 新装插件（~/.vessel/plugins 放入包）不写任何配置 → 重启后装载、面板可见可用；
- 显式 `enabled:false` → 仍关（默认集/覆盖层两种模式下都关），面板显示关；
- media 缺省装载：无 CLI 后端时 warn 一次、view/read 可用、不崩不刷屏；
- `vessel plugin enable/disable` 后面板/CLI/宿主三方口径一致；
- 热应用（config watcher / gateway.reload）与启动装配同一口径。

## 7. 锚点索引

| 主题 | 位置 |
| --- | --- |
| 默认集过滤 | src/plugin/plugin-selection.ts:74-96 |
| OPT_IN_PLUGINS（media） | src/plugin/plugin-loader.ts:58-76 |
| FACTORY_PLUGINS | src/plugin/plugin-loader.ts:45-56 |
| getAvailablePlugins（物化名单） | src/plugin/plugin-loader.ts:623-633 |
| setPluginEnabled 物化 | src/plugin/plugin-config.ts:89-121；plugin-command.ts:350 |
| child 启用两套口径 | plugin-host-assembly.ts:56-59 vs plugin-command.ts:111-115 |
| media 优雅降级 | plugins/media/media/src/index.ts:86-115 |
| feishu 门控 | src/plugin/feishu-wiring.ts:4,60-71 |
| defaultEnabled 设计（未实现） | docs/dev/plans/plugin-scaffold-design.md §6.4/§7.1/§7.2 |
| 面板基础行 | src/cli.ts:1435-1457；src/runtime/bootstrap.ts:2084-2095 |
| catalog 缺行即不可见 | packages/serve/src/plugin-host/catalog.ts:132-137 |
| refs 提示的 media 依赖 | src/data/refs-notice-hook.ts:13 |

## 8. 裁定与实施记录（步骤②）

**main 裁定（方案 B 批准）**：plugins: 改覆盖层语义——默认集（全部已安装）恒为底，
显式条目只覆盖（enabled:false 排除 / 列入=启用 / 未列入=走默认）；setPluginEnabled
不再物化全量；media 删 OPT_IN 名转默认；结构性排除保留（§2.2/§2.3 名单获准）；
child 口径对齐 + 面板可见性；旧契约注释更新 + CHANGELOG 口径，存量部分清单行为变化
列金丝雀重点回归项。

实施映射（小步提交）：

| 步 | 内容 | 落点 |
| --- | --- | --- |
| ②-a | 覆盖层语义核心 + media 转默认 | plugin-selection.ts（契约注释重写 + 默认集恒为底 + 覆盖循环）；plugin-loader.ts（OPT_IN_PLUGINS 清空，转默认论证照 web-tools 格式） |
| ②-b | 物化修复 + child 口径对齐 | plugin-config.ts（setPluginEnabled 删 allNames 物化；新增共享判定 pluginEntryEnabled）；plugin-command.ts（enable/disable 只写单条；pluginEnabledByConfig 委托共享判定；install 提示改「默认装载/显式关才需 enable」）；plugin-host-assembly.ts（pluginEnabledInConfig 委托共享判定） |
| ②-c | 注释/文档同步 | refs-notice-hook.ts（media 依赖注释改默认加载，三档逻辑不动——事实驱动）；docs/agents/plugins.md media 节；docs/operations/CONFIG.md 覆盖层语义条；CHANGELOG 0.56.1 破坏性节 + child 口径修复条 |
| ③ | 面板可见性 + 显示一致 + build 总门禁 + 总报告 | cli.ts / bootstrap.ts 基础行补「发现但未装载」行；待验点清单 |

语义要点（实施后）：
- `plugins: []` = 完整默认集（旧语义空集，破坏点已登记 CHANGELOG）。
- 显式 enabled:true 可救回默认集排除项（hook-logging、opt-out 挡下的外部插件）——
  「显式列表即信任」旧契约保留；显式列入的外部插件不计启动告警（旧契约保留）。
- 声明式 guardrails/hooks 与显式条目的裁决关系不变（显式 enabled 最终裁决）。
- 结构性排除不变：provider / FACTORY_PLUGINS / hook-logging（debug）/ child（宿主 spawn）。
- 版本位：breaking→minor 的收口裁定归发布（RELEASE §1），本切片不动版本号。