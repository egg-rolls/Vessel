---
title: 插件开发脚手架自动化设计 —— vessel plugin create + 约定优于配置
kind: draft
triggers:
  [
    plugin scaffold,
    plugin create,
    脚手架,
    样板,
    boilerplate,
    manifest,
    自动注册,
    约定优于配置,
    插件模板,
    plugin template,
    registerInProcessPlugin,
    plugin-loader,
    plugin-config,
    contributes,
    settings 贡献,
    UI embed,
  ]
paths:
  [
    src/cli/commands/plugin/plugin-command.ts,
    src/cli/commands/plugin/plugin-cli-command.ts,
    src/cli/args.ts,
    src/plugin/plugin-loader.ts,
    src/plugin/plugin-manifest.ts,
    src/plugin/plugin-selection.ts,
    src/plugin/plugin-config.ts,
    src/plugin/plugin-host-assembly.ts,
    src/runtime/tenant-runtime-factory.ts,
    src/runtime/model-registry-wiring.ts,
    packages/plugin-sdk/src/index.ts,
    packages/plugin-ui,
    docs/agents/plugins.md,
  ]
created: 2026-11-24
---

# 插件开发脚手架自动化设计（design/q-plugin-scaffold）

> 状态：**设计稿，未实现**。本分支只产出文档，不改代码；落地时按 §10 分期另开实现分支。
> 上位约束：[plugins（advisory）](../../agents/plugins.md)、[plugins（architecture）](../../architecture/plugins.md)、
> [plugin-embed 契约](../../architecture/plugin-embed.md)、AGENTS.md 硬安全规则与宪法（零 gate / 零测试 / 零探针）。
> 先例对齐：q-skills-impl（`docs/dev/plans/skills-plugin-design.md`）、q-media-view（`docs/dev/reports/q-media-view/investigation.md`）、
> q-settings（`docs/dev/plans/vscode-settings-design.md`）。

**问题陈述**（用户原话归纳）：插件开发相对代码本身有大量注册操作——manifest 撰写、RPC 声明、
settings 贡献、UI embed 接线、装配层特判——阻力大。本设计回答两件事：

1. **脚手架**：`vessel plugin create <name> [--type capability|ui|tool]` 一条命令生成全部样板，
   照现有插件先例（web-tools / model-registry / skills / media）；
2. **约定优于配置**：把「必须手写且处处重复」的注册声明降为「缺省可推导」，
   把「装配层按插件名硬编码」的知识迁回 manifest 声明，同时**不削弱 fail-closed 门禁、
   不新增第二套扩展机制、不违反零测试宪法**。

## 目录

1. [调研结论（设计的事实基础）](#1-调研结论设计的事实基础)
2. [目标与非目标](#2-目标与非目标)
3. [自动化裁决清单](#3-自动化裁决清单)
4. [脚手架 CLI：vessel plugin create](#4-脚手架-clivessel-plugin-create)
5. [模板结构](#5-模板结构)
6. [约定优于配置：运行时 additive 机制](#6-约定优于配置运行时-additive-机制)
7. [现有插件迁移路径](#7-现有插件迁移路径)
8. [与先例对齐](#8-与先例对齐)
9. [风险与开放问题](#9-风险与开放问题)
10. [分期实施计划](#10-分期实施计划)
- [附录 A：注册链路时序](#附录-a注册链路时序)
- [附录 B：manifest 前后对比](#附录-bmanifest-前后对比)

## 1. 调研结论（设计的事实基础）

以下全部来自本工作树源码（分支基点 `723fb673`，0.56.1），每条给出落点。

### 1.1 一套机制、两种形态、三条登记路径

唯一扩展机制是 `Plugin` + `PluginHost`（`packages/core/src/types/plugin.ts`：
`install(host, {config})` / `init` / `dispose` / `rpc`），core 冻结（ADR-034）。
插件形态由 `package.json.vessel` 清单决定（`src/plugin/plugin-loader.ts` `readPlugin`，L394-470）：

| 形态 | 判据 | 登记路径 |
| --- | --- | --- |
| **child（体验插件）** | `vessel.entry` 非空 **且** `vessel.contributes` 是对象 | `createPluginHostManager`（`plugin-host-assembly.ts` L178）→ serve `PluginHostManager` 子进程宿主；懒激活 / 热重载 |
| **in-process + capabilityManifest** | 声明了 `vessel` 清单字段（除 `override`）但**无** `entry` | 默认集装载 install 后，`registerInProcessPlugin`（`plugin-host-assembly.ts` L218）把 `Plugin.rpc` 接进同一个 `PluginRpcRegistry`（canonical `plugin.<id>.<name>`） |
| **in-process 无清单（legacy）** | 无 `vessel` 块（或只有 `override`） | 只走 install 注册面（tool / provider / guardrail / hook），**无贡献面**（RPC/pages/settings 都不可声明） |

关键事实：**「manifest 发现 → 自动注册」在 0.51 / model-registry D3 之后已经存在**——
声明了 capabilityManifest 的 in-process 插件，其 RPC / pages / navGroups / settings 贡献
由装配层自动登记（`tenant-runtime-factory.ts` L884-921 收集 → L1614 `bundle.registerInProcessPlugins`；
provider 类由 `model-registry-wiring.ts` L127-136 收集）。**剩下的阻力不是「注册没自动化」，
而是「声明本身全是手写样板」+「少数类别仍要装配层特判」**。这决定了本设计的重心（§3）。

### 1.2 注册链路全景（发现 → 选择 → 安装 → 贡献登记 → 特化接线）

1. **发现**（`plugin-loader.ts`）：进程启动扫描一次（缓存，`refresh()/rescan()` 失效）。
   扫描根与优先级：repo `plugins/<category>/<name>`（layout=category）→ project
   `./.vessel/plugins`（auto：扁平或分类）→ user `~/.vessel/plugins`（auto）→ legacy
   `.vessel/mods` → `node_modules/@vessel-agent/*`（flat，跳过 core/config/tui/serve/permission）。
   同 id 冲突：project > user > repo > node_modules；覆盖内置必须 `vessel.override: true`
   （`resolveSourceConflict` L685）。入口解析：`exports['.']` → `module` → `main` →
   `src/index.ts` → `index.ts`（`resolveEntry` L153）。**放一个 package.json + 入口即被发现，
   无需改任何宿主代码**——目录约定已经是自动化的。
2. **清单校验**（`plugin-manifest.ts`，1577 行）：`validatePluginManifest` fail-closed——
   校验失败告警一次且**不加载代码**（`warnManifestFailure`）。必填：`id`（`PLUGIN_ID_RE`）、
   `name`、`version`（full semver）、`engines.vessel`（range，且与当前版本比对）；
   `side` 缺省 `both`；`ui.dir` / `ui.embed.entry` / `ui.embed.runtime.{react,sdk}` 声明即必填；
   `activationEvents` 缺省 `[]`；`permissions` / `dependencies` 有缺省空值。
   in-process 分支（0.51 期 0.5）：只写 `override` 的包不校验；external 源 HTTP 面只能占
   `/plugins/<own-id>/` 命名空间；`scope: member` / `permissions.ports` 只在 in-process 合法。
3. **选择**（`plugin-selection.ts`）：`plugins:` 缺省 → 默认集 = in-process ∧ 非 provider 类 ∧
   非 `FACTORY_PLUGINS`（mcp-client / evals / feishu / engine-client，硬编码 Set，loader L51）∧
   非 `OPT_IN_PLUGINS`（media，硬编码 Set，loader L65）∧ 非 hook-logging（debug 特判）。
   `plugins:` 一旦出现即**完整**启用清单（金丝雀 issue-0 陷阱，文件头注释）。
   外部插件默认集启动告警一次；`VESSEL_NO_EXTERNAL_PLUGINS=1` 只留 repo。
4. **安装**（`tenant-runtime-factory.ts` L864-968）：`buildPluginConfigMap`（`plugin-config.ts` L205）
   合成每插件安装配置 → `withPluginConfig` 包装 → `installPluginsIntoHost`（tenant 内一次）。
   **装配层按插件名硬编码的知识**（`plugin-config.ts`）：
   - `basic-tools.cwd` / `skills.cwd` ← `agent.cwd` 回落（L221-227）；
   - `recall` / `doc-subscription` / `skills` 的 `data_dir` ← 应用层 `resolveDataDir`（L321-331）；
   - `media` / `skills` 路径边界 ← `basic-tools` 的 `allowed_roots`/`deny_paths` 回落（L362-382）；
   - skills 收集库隔离：`<dataDir>/plugins/skills/library/` 追加进 basic-tools deny_paths（L257-270）；
   - `envGranularity` 注入：`doc-subscription→files`、`basic-tools→lock/conflict`（L276-305）。
   这些是「插件产什么 / 继承什么」的装配知识，今天**住在宿主代码里、按名字点名**，
   新插件要享受同等待遇必须改宿主——这是约定优于配置要消灭的第二类样板（§6.4）。
5. **贡献登记**：见 §1.1。child 的 settings 经 `settingsFor`（`plugins[].config`）懒激活注入；
   in-process 的 settings 经 `pluginConfigs` install 透传。settings 的**渲染与校验已自动化**
   （q-settings：serve 按 manifest `contributes.settings` 的 JSON Schema 子集校验，
   `setPluginConfigValue` 落盘，`plugin-config.ts` L129）。
6. **特化接线（必须显式的部分）**：
   - **provider 类**（`category === 'provider'`）：不进默认集，由 `provider-factory.ts` →
     `model-registry-wiring.ts` 单独装配 loop 加载，插件只 `registerProvider(protocol, factory)`
     （先例 `plugins/provider/anthropic/src/index.ts` L49）；多厂商路由 / 凭证 / 缓存是宿主语义。
   - **工厂式插件**（`FACTORY_PLUGINS`）：默认导出是工厂不是 Plugin，需要运行时依赖注入
     （events / tenantId / 专用 config 块），各有专属 wiring 文件：`mcp-wiring.ts`（`mcp_servers`）、
     `feishu-wiring.ts`（`feishu` 块）、`eval-wiring.ts`（`evals` 块）、engine-client
     （bootstrap L1216 `createEngineClient`，tools-engine 白名单转发）。消费点在
     `tenant-runtime-factory` / `gateway-wiring` / `eval-command` / `feishu-command`。
   - **CLI 命名空间**（`plugin-cli-command.ts`，0.48 M2）：`vessel <pluginId> <cmd>` 预解析，
     `contributes.cli[].path[0]` 必须等于 plugin id，`handler` 必须是 `contributes.rpc` 裸名，
     经控制面调 `plugin.<id>.<handler>`；需 gateway 在运行 + `plugins[].expose` 授权（外部插件）。
     **这条已全自动**：声明即接线，无需宿主代码。
   - **UI**：manifest `ui.dir` + `ui.embed` → serve 静态服务 + web 控制台 import map 加载
     embed 产物（plugin-embed 契约）。构建侧每个 UI 插件手写 `vite.config.ts`（iframe 档）+
     `vite.config.embed.ts`（lib 档）+ `tsconfig.web.json` + `web-src/`（embed.tsx / main.tsx /
     App.tsx / i18n.ts / env.d.ts / *.html / css），其中层序声明（`@layer … plugin.<id> …`）
     与 biome-ignore-all 产物头是**易错暗坑**（model-registry vite.config.embed.ts 注释）。
7. **热重载**：`plugin-watch.ts`（project/user 根 + config.yaml，300ms 去抖）→
   `createPluginReloader`（`plugin-host-assembly.ts` L295）：child 可热替换；in-process
   指纹变化只报 `restart_required`，不谎报。**新插件目录落盘后无需任何注册动作，
   重启（或 child 热重载）即生效**。

### 1.3 现有 21 个插件的注册现状盘点

| 插件 | category | 形态 | vessel 清单 | 今天的注册动作（手写部分） |
| --- | --- | --- | --- | --- |
| basic-tools | tools | in-process | 无 | install 注册工具；装配层 cwd/deny_paths/envGranularity 特判 |
| web-tools | tools | in-process | capability（settings） | package.json 清单 + install + parseWebToolsConfig |
| recall | tools | in-process | 无 | install；装配层 data_dir 特判 |
| delegate-task / team / engine-client | tools | in-process / 工厂 | 无 | engine-client 是工厂：bootstrap 显式构造 + 白名单 wiring |
| media | media | in-process | **无** | install + parseMediaConfig + 后端探测；`OPT_IN_PLUGINS` 硬编码；装配层边界回落特判 |
| skills | context | in-process | capability（i18n/pages/rpc/settings） | 清单 + createSkillsPlugin + parseSkillsConfig + UI 全套构建文件；装配层 cwd/dataDir/边界/隔离特判 |
| doc-subscription | context | in-process | 无 | install；装配层 data_dir/envGranularity 特判 |
| model-registry | provider | in-process | capability（i18n/navGroups/pages/rpc） | 清单（180 行 package.json）+ rpc switch + UI 全套构建文件；provider 类装配 loop 收集 |
| anthropic / openai | provider | in-process | 无 | `registerProvider` + 协议实现；provider 装配 loop |
| guardrail-pii / redact-secrets / tool-policy | security | in-process | 无 | install 注册 guardrail；声明式 `guardrails:` 条目即启用 |
| hook-logging | observability | in-process | 无 | install 注册 hook；`VESSEL_DEBUG` 特判 |
| usage | observability | **child** | 完整清单（entry+contributes） | NDJSON 协议入口 + 清单 + UI 全套构建文件 |
| marketplace | marketplace | **child** | 完整清单 | 同上 |
| mcp-client | mcp | 工厂 | 无 | `createMcpPlugin` + mcp-wiring + `mcp_servers` 配置块 |
| feishu | im | 工厂 | 无 | 工厂 + feishu-wiring + `feishu` 配置块 |
| evals(harness) | evals | 工厂 | 无 | 工厂 + eval-wiring + `evals` 配置块 |

统计：**21 个插件中 14 个没有 vessel 清单**（legacy 形态，贡献面为零）；有清单的 7 个里
3 个 in-process capability（web-tools/skills/model-registry）、2 个 child（usage/marketplace）、
其余声明 `override` 或无。每个有 UI 的插件（4 个）都携带 ~10 个近乎复制的构建/前端文件。

### 1.4 样板分布：已自动化 vs 仍手写

**已自动化（本设计不动，只复用）**：目录发现与优先级冲突裁决；默认集选择与 install；
capabilityManifest → RPC/pages/settings 贡献登记；child 宿主装配 / 懒激活 / 热重载；
settings 校验与落盘（q-settings）；CLI 命名空间（contributes.cli）；外部插件告警与信任门。

**仍手写（本设计的靶子）**，按阻力排序：

| # | 样板 | 体量/插件 | 性质 |
| --- | --- | --- | --- |
| B1 | package.json 骨架（name/version/type/main/exports/files/engines/scripts/deps） | ~45 行 | 纯复制，可生成 |
| B2 | vessel 清单必填四件套（id/name/version/engines）与 package.json 重复 | ~10 行 | 重复声明，可推导 |
| B3 | `contributes.rpc[]` 声明 ↔ `Plugin.rpc` switch 双写 | 每方法 2 处 | 重复声明，可单源化 |
| B4 | `contributes.settings` schema ↔ 手写 `parseXConfig` 双写 | 每键 2 处 | 重复声明，可单源化 |
| B5 | Plugin 对象骨架（name/version/description 重复、enabled 闸、boundary 构造、dispose） | ~40 行 | 模式固定，可生成+SDK 助手 |
| B6 | UI 全套：vite.config.ts / vite.config.embed.ts / tsconfig.web.json / web-src 十件套 | ~10 文件 | 复制+暗坑（层序/biome 头/externals），可生成+共享构建配置 |
| B7 | pages/navGroups/i18n 三处重复（manifest ↔ web-src/i18n.ts ↔ embed 具名导出） | 每页 3 处 | 重复声明，可推导+生成 |
| B8 | 装配层按名特判（cwd/dataDir/边界/envGranularity/opt-in/factory） | 宿主代码 | 知识住错了地方，可 manifest 化 |
| B9 | 工厂/provider 类的 wiring 文件 + 配置块 + bootstrap 分支 | 每类 ~200 行 | **语义必需，保持显式**（§3） |

### 1.5 宪法与先例约束（设计的硬边界）

- **零 gate / 零测试 / 零探针**（AGENTS.md L114-120，宪法第三、四条）：`*.test.*` / `__tests__/`
  一律不进仓库；原 `check-rpc-methods` 门禁脚本已删除、改为**评审项**（docs/agents/plugins.md）。
  ⇒ 脚手架**不生成测试文件**（任务书中「测试占位」以 `VERIFY.md` 人工验证清单替代，§5.4），
  **不新增静态断言/门禁命令**；一致性靠「生成即正确」+ 既有运行时 fail-closed 校验 + 评审项。
- **core 冻结**（ADR-034）：不为脚手架新增 core 接口；SDK 助手只能产出既有 `Plugin` 形状。
- **不新增第二套扩展机制**（ADR-004/037/099）：约定推导全部落在既有 manifest 校验器内，
  不引入运行时 codegen、不引入「import 代码后才校验」的路径（那会击穿 fail-closed）。
- **fail-closed 不变**：清单校验失败 = 不加载代码。默认值推导发生在**校验之前**，
  推导结果照样过全部既有校验（§6.1）。
- **宿主共享包白名单**（loader L204 `HOST_SHARED_PACKAGES`）：只转发
  `@vessel-agent/core` / `agent` / `basic-tools` 三包。user/project 目录的插件 import
  `@vessel-agent/config` / `plugin-sdk`（node 侧）会解析失败——model-registry 的 deps
  含 config，**它只能住在 repo**。脚手架模板必须按目标位置约束依赖（§4.3、§9）。
- **workspaces 约定已存在**：根 package.json `workspaces: ["packages/*", "plugins/*/*"]`——
  repo 内新建 `plugins/<category>/<name>/` 自动成为 workspace 包，无需改根配置。
- **先例形态**：skills / model-registry 确立「in-process + capabilityManifest + 装配层自动登记」
  为管理插件标准形态；media 确立「opt-in + 边界继承 + install 期后端探测」；
  q-settings 确立「contributes.settings 自动发现渲染」。脚手架照这些形态生成（§8）。

## 2. 目标与非目标

### 2.1 目标

- **G1 一条命令起插件**：`vessel plugin create <name> [--type capability|ui|tool]` 在
  user / project / repo 三种位置生成可被 loader 直接发现的完整插件包；生成物**零修改即可
  加载**（tool 型注册一个占位工具；capability 型注册一个占位 RPC；ui 型激活即回 hello）。
- **G2 声明单源化**：rpc / settings / pages 的「manifest ↔ 代码」双写降为单源 +
  显式生成命令（`vessel plugin sync`）；缺省字段可推导（id/name/version/engines/side/ui 路径/
  activationEvents），显式声明永远优先。
- **G3 装配知识归位**：opt-in、边界继承、dataDir/cwd 注入等「按插件名硬编码在宿主」的知识
  迁为 manifest 声明（additive 字段），宿主硬编码保留为 legacy 兜底，存量行为字节等价。
- **G4 UI 暗坑一次封装**：层序 / biome-ignore 头 / externals / 双产线收进共享构建配置工厂，
  脚手架生成的 vite 配置只有 ~5 行。
- **G5 迁移路径**：21 个存量插件逐个有明确迁移决策（迁 / 不迁 / 只迁一部分），
  全程零行为回归（§7）。

### 2.2 非目标

- **N1** 不做市场 / 联网 / 依赖解析（`plugin install` 现态就是本地目录操作，create 同口径）。
- **N2** 不做运行时 codegen / 动态 manifest 合成：manifest 永远是 package.json 里的静态 JSON，
  校验永远在 import 代码之前（fail-closed 时序不变）。
- **N3** 不新增 core 接口、不新增第二套扩展机制、不新增 gate/test/probe（宪法）。
- **N4** 不自动化 provider / 工厂式插件的装配 wiring（语义必需，§3.2）；脚手架 v1 不生成
  这两类（`--category provider` 明确拒绝并指路先例）。
- **N5** 不改变默认信任模型：外部插件告警、`VESSEL_NO_EXTERNAL_PLUGINS`、override 门禁、
  trust_ui / expose 授权全部原样。
- **N6** 不做插件热卸载（in-process 现态重启语义不变）。

## 3. 自动化裁决清单

任务书要求「找出哪些注册可自动化、哪些必须显式」。逐项裁决如下；
「已自动」= 现状即自动，本设计只复用；「生成」= 脚手架生成时解决；
「推导」= 运行时 additive 缺省值；「声明」= 从宿主硬编码迁为 manifest 声明；
「显式」= 语义上不可自动化，保持手写。

### 3.1 可自动化（含已自动）

| 注册操作 | 现状 | 裁决 | 机制落点 |
| --- | --- | --- | --- |
| 目录发现 / 入口解析 / 来源优先级 | 已自动 | 保持 | loader 不动 |
| workspace 接线（repo 内） | 已自动（`plugins/*/*` glob） | 保持 | 根 package.json 不动 |
| 默认集选择 + install + config 透传 | 已自动 | 保持 | selection / tenant-runtime-factory 不动 |
| capabilityManifest → RPC/pages/settings 登记 | 已自动（0.51+） | 保持 | registerInProcessPlugin 不动 |
| child 宿主装配 / 懒激活 / 热重载 | 已自动 | 保持 | createPluginHostManager 不动 |
| settings 校验 / 落盘 / 渲染 | 已自动（q-settings） | 保持 | serve + setPluginConfigValue 不动 |
| CLI 命名空间接线 | 已自动（contributes.cli） | 保持 | plugin-cli-command 不动 |
| package.json 骨架（B1） | 手写 | **生成** | create 模板 §5 |
| 清单必填四件套（B2） | 手写 | **生成 + 推导** | 模板写全；运行时缺省推导 §6.1 |
| rpc 声明 ↔ switch 双写（B3） | 手写 | **生成 + 单源** | defineRpcHandlers + sync §6.2/6.3 |
| settings schema ↔ parser 双写（B4） | 手写 | **生成 + 单源** | settings.ts 单源 + parseSettings + sync §6.2/6.3 |
| Plugin 骨架（B5） | 手写 | **生成 + SDK 助手** | defineCapabilityPlugin §6.2 |
| UI 十件套 + 构建暗坑（B6/B7） | 手写 | **生成 + 共享配置** | 模板 §5 + plugin-ui/build §6.5 |
| pages entry/component/activationEvents 缺省 | 手写 | **推导** | §6.1 |
| opt-in 名单（OPT_IN_PLUGINS） | 宿主硬编码 | **声明化** | `vessel.defaultEnabled` §6.4 |
| 边界继承 / dataDir / cwd 注入名单 | 宿主硬编码 | **声明化** | `vessel.inherit` §6.4 |
| envGranularity scope 名单 | 宿主硬编码 | **声明化（缓议）** | §6.4 开放问题 |
| 插件一致性核对 | 人工评审项 | **保持人工**（宪法禁门禁脚本） | VERIFY.md 清单辅助 §5.4 |

### 3.2 必须显式（不自动化，理由）

| 注册操作 | 理由 |
| --- | --- |
| `permissions`（fs/net/process/secrets/events/rpc/ports） | 安全声明是**授权意图**，推导 = 静默扩权；fail-closed 门禁的根基。脚手架只生成**最小空声明**，作者按需要显式加 |
| `scope: member` / `permissions.ports` | 成员身体端口是反向 RPC 通道（报告 §2.7），必须显式申请 |
| `vessel.override` | 覆盖内置是信任决策，现态门禁保持 |
| `trust_ui` / `plugins[].expose` | 用户侧授权，永远在 config 不在 manifest |
| `dependencies.plugins` / ordering | 依赖是作者意图；校验已自动（knownPluginIds），声明不推导 |
| `contributes.http[]` | 路由占位是攻击面管理（external 命名空间 / 保留路由 / 限额），逐条显式 |
| provider 类的 `registerProvider(protocol, factory)` | 协议实现是代码语义，不是声明；装配 loop 已自动加载，**注册动作本身已是单行**，无样板可减 |
| 工厂式插件的 wiring（mcp/feishu/evals/engine-client） | 需要宿主运行时对象（events/tenantId/engineClient）与专用配置块；这是**宿主功能**不是插件样板。四例各有专属契约，强行通用化 = 第二套扩展机制 |
| `contributes.rpc[].permission`（read/write） | 每方法的读写级别是安全语义；sync 生成时缺省 read，**写方法必须作者显式标 write**（§6.3） |
| 默认集成员资格的政策裁决 | `defaultEnabled` 只是把**声明位置**从宿主挪到 manifest；「某插件该不该默认开」仍是作者/评审的显式决策 |

### 3.3 一条总原则

> **声明可以少写，授权不能猜。** 凡属「重复 / 可推导 / 住错地方」的样板 → 自动化；
> 凡属「安全意图 / 信任决策 / 代码语义」的注册 → 保持显式。fail-closed 时序
> （先校验 manifest，后 import 代码）在任何方案下不得倒置。

## 4. 脚手架 CLI：`vessel plugin create`

### 4.1 命令形状

```
vessel plugin create <name> [options]

  --type <tool|capability|ui>   插件形态（缺省 tool）
  --where <user|project|repo>   目标位置（缺省 user）
  --category <cat>              repo 内的分类目录（缺省按 type 推导，见 §4.3）
  --ui                          capability 型附加 UI embed 脚手架（照 model-registry/skills）
  --rpc                         生成占位 RPC 面（capability 缺省开；tool 可选）
  --settings                    生成 settings 贡献 + 单源 schema（缺省开）
  --cli                         生成 contributes.cli 占位命令（需 --rpc；缺省关）
  --opt-in                      声明 vessel.defaultEnabled: false（照 media 先例）
  --force                       目标目录已存在时覆盖（缺省拒绝）
  --json                        机器可读输出
```

设计取舍：

- **三型对齐任务书**，语义映射到既有先例：
  - `tool` = in-process 工具插件（web-tools / media / recall 先例）：install 注册一个占位工具，
    可选 settings；无 UI。
  - `capability` = in-process 管理/RPC 插件（model-registry / skills 先例）：`install(){}` +
    rpc handler map + capabilityManifest；`--ui` 追加 embed 双产线（skills 形态）。
  - `ui` = **child 体验插件**（usage / marketplace 先例）：`vessel.entry` + NDJSON 协议入口 +
    完整贡献面。理由：in-process 的 UI 需求已由 `capability --ui` 覆盖；child 是独立形态，
    协议入口样板最重、最值得生成。**命名澄清**：`--type ui` 不是「给工具加界面」，
    帮助文案必须写明「child-process experience plugin」。
- **provider / 工厂式不生成**（N4）：`--category provider` → exit 2，stderr 指路
  `plugins/provider/anthropic`（registerProvider 单行注册）与 §3.2 裁决。
- 无 `--child` / `--in-process` 别名：形态由 type 唯一决定，避免双轴歧义。

### 4.2 目标位置与依赖约束

| where | 落点 | 发现来源 | 依赖约束（§1.5 白名单） |
| --- | --- | --- | --- |
| `user`（缺省） | `VESSEL_PLUGINS_DIR` → `~/.vessel/plugins/<name>/`（扁平） | user | 模板只 import `@vessel-agent/core`（type-only 亦经转发缝）；**不得**依赖 config/plugin-sdk(node 侧)/basic-tools 之外的宿主包。settings 解析用模板内置的迷你 parser（不 import SDK），或作者自行 bundle |
| `project` | `./.vessel/plugins/<name>/` | project | 同 user |
| `repo` | `plugins/<category>/<name>/` | repo | workspace 全量可用（`workspace:*`）；生成后提示 `bun install`；UI 型可用 plugin-sdk/plugin-ui/react 全套 |

- **user/project 模板的 SDK 助手问题**：§6.2 的 `defineRpcHandlers`/`parseSettings` 住在
  `@vessel-agent/plugin-sdk`，而该包**不在** HOST_SHARED_PACKAGES（它只被 web 产物消费）。
  裁决：v1 助手以**可复制的源码片段**形式进模板（template 内联 ~30 行 helper，标注
  「与 plugin-sdk 同形，repo 内可换 import」）；把 plugin-sdk 加入转发白名单是开放问题
  （§9，需回答「第二副本会不会出事」——sdk 的 semver/宿主对象是纯函数+冻对象，
  初步判断可加，但属独立决策，不夹带）。
- `--where repo` 时 category 缺省：`tool`/`capability` → `tools`；`ui` → `experience`
  （新分类目录；category 除 `provider` 外纯属组织语义，loader 不关心）。`--category` 可覆盖；
  值为 `provider` 时拒绝（见上）。
- 目标已存在：缺省 exit 1 并提示 `--force`（照 `plugin install` 先例）；`--force` 整目录替换。
  **不删任何非目标目录**；不触碰 config.yaml（启用语义见 §4.4）。

### 4.3 命名与冲突校验（生成前，全部本地）

1. `<name>` 必须匹配 `PLUGIN_ID_RE`（`^[a-z0-9][a-z0-9-]{1,63}$`）——与 manifest id 同规则，
   生成即合法；同时过 `PLUGIN_NAME_RE`（plugin-command.ts L31）。
2. 用 `PluginLoader`（照 `makeLoader` 先例注入 userDir）扫全部发现根：同 id 已存在 → exit 1，
   报出冲突来源（repo/user/project/node_modules）；**不自动加 override**。
3. id 不得占用内置 CLI 命令名（`builtinCommandTokens`，completion-spec）——
   与 manifest `reservedCliNames` 复检同口径，生成前就挡住。
4. `--cli` 时占位命令 path 固定 `[<name>, "hello"]`，handler 固定指向占位 rpc `hello`。

### 4.4 生成流程与生成后指引

流程（纯 fs，无网络、无 git 操作、无子进程）：
校验（§4.3）→ 渲染模板（字符串替换，无模板引擎依赖）→ 原子落盘（临时目录 + rename，
照宪法不建临时**进程**；临时目录是 fs 操作，允许）→ 打印下一步。

生成后指引（stdout，按 where/type 分支）：

- user/project：`Restart Vessel to load it.`（plugins: 缺省时外部插件默认加载；
  `--opt-in` 时改印启用示例 `plugins: [{ name: <name> }]`，照 media 文档口径）。
  **不自动写 config.yaml**——启用是用户决策（与 install 先例一致）；若检测到 `plugins:`
  已存在（完整清单陷阱），额外警告「需把 <name> 列入 plugins: 才会加载」。
- repo：`Run bun install, then restart Vessel.`；UI 型追加 `bun run --cwd plugins/<cat>/<name> build:ui`。
- 一律附 `VERIFY.md` 路径提示（人工验证清单，§5.4）。
- best-effort `plugins.reload`（照 enable/disable 先例 `requestGatewayPluginReload`）：
  in-process 新插件会得到 `restart_required`，如实转印，不谎报。

Exit codes：0 成功；1 运行期失败（冲突/IO）；2 用法非法（照 plugin-cli-command 口径）。
`--json` 输出 `{ name, type, where, dir, files: [...], nextSteps: [...] }`。

### 4.5 实现落点（供实现分支）

- `src/cli/args.ts`：`PluginCommandArgs` 追加 `{ kind: 'create'; name: string; type: ...; ... }`。
- `src/cli/commands/plugin/plugin-create.ts`（新）：校验 + 渲染 + 落盘；
  `plugin-command.ts` 的 `runPluginCommand` 加分支（照 list/install 先例返回
  `{exitCode, stdout, stderr}`，测试注入形状不变——但宪法零测试，注入选项仅为 API 一致性保留）。
- 模板住 `src/cli/commands/plugin/templates/`（`.ts` 模板字符串模块，随 src 分发；
  根 package.json `files` 已含 src，无需改）。
- `completion-spec.ts` / `help-spec.ts` 补 create 子命令与选项。
- **不新增** gate/check/test 命令（宪法）；`vessel plugin sync`（§6.3）是生成器，另列。

## 5. 模板结构

通用约定：所有模板生成物**零修改可加载**；占位语义显式标注 `TODO(<name>)`；
文件头注释照仓库风格（模块职责 + 契约指针）；biome 格式（生成即格式化，无后续 lint 债）。

### 5.1 `--type tool`（先例：web-tools / media）

```
<name>/
├── package.json          # B1 骨架 + vessel 清单（id/name/version/engines/side:backend/
│                         #   contributes.settings 占位一项 / permissions 最小空声明）
├── VERIFY.md             # 人工验证清单（§5.4）
└── src/
    ├── index.ts          # Plugin：install(host,{config}) → enabled 闸 → parseSettings →
    │                     #   host.registerTool(createXxxTool(...))；dispose 幂等占位
    ├── settings.ts       # SETTINGS_SCHEMA 单源（JSON Schema 子集 const）+ parseSettings
    │                     #   （内联迷你 parser：type/default/enum/minmax，~30 行）
    └── tool.ts           # 占位工具：<name>_hello，echo 参数；schema/描述完整可调用
```

要点：`--opt-in` 时清单写 `defaultEnabled: false`（§6.4 落地前的过渡期同时提示作者
「现态需进 OPT_IN_PLUGINS 或显式 plugins:」——模板按 §10 分期自适应）；
路径边界需求留注释指针（media 先例：`buildPathBoundary` 仅 repo 可用，user 模板不 import）。

### 5.2 `--type capability [--ui]`（先例：model-registry / skills）

```
<name>/
├── package.json          # vessel 清单：contributes.rpc[hello] + settings + permissions 最小声明
├── VERIFY.md
└── src/
    ├── index.ts          # defineCapabilityPlugin({ name, settings, rpc: { hello } })
    │                     #   → install(){}（RPC-only）或 install 注册工具（--rpc 之外可选）
    ├── settings.ts       # 同 tool
    └── rpc.ts            # handler map：{ hello: async (params) => ({...}) }
                          #   defineRpcHandlers 内联片段：未知方法抛 unknown_method
```

`--ui` 追加（照 skills/model-registry 双产线）：

```
├── vite.config.ts        # ~5 行：createPluginViteConfigs({pluginId, pages})（§6.5）
├── vite.config.embed.ts  # 同上 embed 档
├── tsconfig.web.json     # 照抄先例（web-src jsx / paths）
├── web-src/
│   ├── embed.tsx         # 具名导出 <Name>View（PluginMountProps → host.rpc/theme/i18n）
│   ├── main.tsx / App.tsx / <name>.html   # iframe 回退档
│   ├── i18n.ts           # en/zh-CN 占位（与 manifest i18n 由 sync 对齐，§6.3）
│   ├── env.d.ts / embed.css / styles.css
└── web/                  # 构建产物目录（.gitkeep；产物入库规则照先例 biome-ignore 头）
```

manifest 同步追加：`ui.dir/embed`、`pages[<name>]`（entry/component 按 §6.1 缺省可省）、
`navGroups[plugin:<name>]`、`i18n.nav.*`、`activationEvents`（child 才需要；capability 不写）。

### 5.3 `--type ui`（child，先例：usage / marketplace）

```
<name>/
├── package.json          # vessel.entry: src/index.ts + contributes 全套占位
├── VERIFY.md
└── src/
    ├── index.ts          # NDJSON JSON-RPC 协议入口骨架：plugin.hello/activate/event/
    │                     #   rpc/deactivate + ping→pong（照 usage 先例逐方法占位）
    ├── protocol.ts       # 帧读写 / DTO 校验内联片段（stdout 只放协议，stderr 诊断）
    └── rpc.ts            # handler map（hello 占位）
```

UI 文件与 §5.2 `--ui` 相同；child 的 settings 经 `plugin.activate` 注入（模板在 activate
handler 里留 `settings = params.settings` 占位）。**协议版本 / 超时 / 崩溃语义**在模板头注释
指回 CONTRACT-0.43 §3，不复制契约文本。

### 5.4 VERIFY.md：测试占位的宪法替代

任务书要求「测试占位」。仓库宪法（AGENTS.md L114-120）**禁止任何位置生成测试文件**，
且门禁脚本先例（check-rpc-methods）已删改为评审项。裁决：脚手架生成 `VERIFY.md`——
**人工验证清单**（文档，非脚本、非断言），内容按 type 分支：

- 通用：`vessel plugin list` 可见 / enabled 状态正确；重启后 `plugin.loaded` 事件；
  清单故意写错时 fail-closed 告警（评审项，照 docs/agents/plugins.md）。
- tool：占位工具出现在工具面、调用回 echo；`enabled:false` 时不注册。
- capability：`plugin.<name>.hello` 经 gateway 可调；未声明方法被拒（plugin_rpc_denied）。
- ui：页面在导航出现；embed 档渲染；isolated 回退 iframe；deactivate 后进程退出。
- 安全评审项：permissions 是否最小；external 源 http/cli 是否需 expose。

清单是**给作者/评审者的文档**，不构成 gate；与「不写测试」裁定（仓库外也不写）一致。

## 6. 约定优于配置：运行时 additive 机制

总纪律：**全部 additive**——显式声明永远优先；缺省推导只发生在「字段不存在」时；
推导结果照样过既有 fail-closed 校验；存量插件（字段全显式）行为**字节等价**。
落地顺序见 §10：脚手架（生成时）先行，运行时推导分期跟进，互不阻塞。

### 6.1 Manifest 缺省推导表（落点：`parsePluginManifest` 入口，校验之前）

| 字段 | 现态 | 缺省推导 | 校验不变 |
| --- | --- | --- | --- |
| `id` | 必填 | package.json 短名（去 scope；`readPlugin` 已算出，经 options 传入或校验器自读 baseDir/package.json） | `PLUGIN_ID_RE` / reservedCliNames / 冲突裁决照旧 |
| `name` | 必填 | `id`（展示名缺省即 id；title 化不做，避免 i18n 歧义） | 非空照旧 |
| `version` | 必填 | package.json `version`（须 full semver，否则仍 fail） | semver 校验照旧 |
| `engines.vessel` | 必填 | `>=0.43.0 <1.0.0`（清单契约诞生版；**宽缺省 + 显式收紧**是作者责任，模板生成时写当前版本下限） | range 解析 + 当前版本比对**照旧**（缺省不豁免版本门） |
| `side` | 缺省 both | 不变（已推导） | — |
| `ui.dir` | ui 存在则必填 | `web` | 越界检查照旧 |
| `ui.embed.entry` | 必填 | `embed/index.mjs` | `.mjs` / 相对路径检查照旧 |
| `ui.embed.css` | 可选 | `embed/index.css`（文件不存在时 serve 现态如何处理就如何处理——推导只改声明，不改存在性语义） | `.css` 检查照旧 |
| `ui.embed.runtime` | 必填 | `{ react: "^19", sdk: "^1" }` | semver range 校验照旧 |
| `pages[].entry` | 必填 | `<page-id>.html` | 越界检查照旧 |
| `pages[].component` | 可选（需 ui.embed） | 有 ui.embed 时缺省 `PascalCase(<page-id>)View`（与模板 embed 导出同名约定） | `PLUGIN_COMPONENT_RE` 照旧；**无 ui.embed 时不推导**（isolated 档无组件语义） |
| `activationEvents`（child） | 缺省 [] | 有 pages 时缺省 `onPage:<id>` 全集（懒激活语义不变，只是免去手写） | 事件形状校验照旧 |
| `description` | 可选 | package.json `description`（readPlugin 已有此回落，提升到清单层统一） | — |

**不推导**：`permissions` / `scope` / `ports` / `dependencies` / `http` / `rpc[].permission` /
`override` / `entry`（child 必填是形态判据，推导会改变 mode 判定——**绝对禁止**）。
特别地，`contributes.rpc` 整体**不从代码推导**：校验时序（先 manifest 后 import）是
fail-closed 的根基，任何「import 后补声明」方案都击穿它（§3.3）。

实现注：`validatePluginManifest` 的 options 增加 `packageJson?: {name,version,description}`
（由 readPlugin 传入，避免校验器二次读盘）；child / in-process 两分支共用同一推导函数。
`plugin list --json` 输出推导后的规范化清单（现态已如此），诊断可加 `derived: [...]` 字段
标注哪些字段来自缺省（additive，便于评审）。

### 6.2 SDK 编写助手（落点：`packages/plugin-sdk`，repo 内消费；user 模板内联同形片段）

三个纯函数助手，**产出既有 `Plugin` 形状，零 core 新接口**：

```ts
// 1. rpc handler map → Plugin.rpc（替代 switch 双写，B3）
defineRpcHandlers({ hello: async (params) => ({ ok: true }) })
// → { rpc(name, params) }：命中调 handler；未知抛 unknown_method:<name>（照 model-registry 现态）

// 2. settings 单源解析（替代手写 parseXConfig，B4）
parseSettings(rawConfig, SETTINGS_SCHEMA)
// → { config, warnings }：按 JSON Schema 子集（type/default/enum/minimum/maximum）
//   逐键校验+填缺省；未知键告警（照 skills parseSkillsConfig 口径）；enabled 闸内置

// 3. 能力插件骨架（B5）
defineCapabilityPlugin({ name, version?, description?, settings?, rpc?, tool? })
// → Plugin：install 解析 settings → enabled:false 不注册 → 有 tool 则 registerTool；
//   rpc 经 defineRpcHandlers；dispose 透传。name/version/description 缺省读自身 package.json
//   （repo 内）或模板常量（user 内联版）。
```

边界：助手**不做**路径边界 / dataDir 注入（那是装配层语义，§6.4）；不 import config 包
（依赖方向，plugin-config.ts 注释先例）；`parseSettings` 的 schema 子集与
`PluginSettingSchema` / serve 校验口径**完全一致**（q-settings 契约），不扩子集。

### 6.3 单源与 `vessel plugin sync`（生成器，不是门禁）

双写问题的根治：**代码侧 const 是唯一真相源，manifest 片段是派生产物**。

- `src/settings.ts` 的 `SETTINGS_SCHEMA` → `vessel.contributes.settings`；
- `src/rpc.ts` 的 handler map 键 + 每方法附注（`{ description, permission }`）→
  `vessel.contributes.rpc`；**permission 缺省 read，write 必须作者在 map 附注里显式标**
  （§3.2 安全语义不猜）；
- `web-src/i18n.ts` 的 en/zh-CN 表 → `vessel.contributes.i18n`（可选）。

`vessel plugin sync [<dir>]`：读上述源文件（**静态解析 export const 字面量**，不执行插件
代码——用 TS AST 或受限 JSON 字面量解析；handler map 只取键与附注，不取函数体），
把派生片段**写回 package.json 的 vessel 块**（保留其它键，照 setPluginConfigValue 的
只改目标键纪律）。显式命令、显式运行、diff 可见；**不在运行时执行、不做断言、不阻断
任何流程**——它是生成器（与 create 同类），不是 check/rpc-methods 那类门禁（宪法）。
一致性最终仍由运行时 fail-closed 校验 + 人工评审项兜底（docs/agents/plugins.md 现态）。

未跑 sync 的后果：manifest 与代码漂移 → 运行时按 manifest 白名单拒绝未声明方法
（现态语义，安全方向正确）。VERIFY.md 把「改 rpc/settings 后跑 sync」列为评审项。

### 6.4 装配知识 manifest 化（消灭 plugin-config.ts 按名特判，B8）

两个 additive 清单字段（名字待定，语义冻结）：

```jsonc
"vessel": {
  "defaultEnabled": false,          // 缺省 true。false = 不进默认集（opt-in），
                                    // 显式 plugins: 条目仍可启用（media 语义）
  "inherit": {
    "pathBoundary": "basic-tools",  // 路径边界回落来源（media/skills 现态语义：
                                    // 自身任一键存在即不回落，含显式空数组）
    "dataDir": true,                // 装配层注入应用层 resolveDataDir（recall 等现态）
    "cwd": true                     // agent.cwd 回落（basic-tools/skills 现态）
  }
}
```

消费点改造（全部「声明优先，硬编码兜底」）：

- `plugin-selection.ts`：默认集过滤改读 `descriptor.capabilityManifest?.defaultEnabled !== false`；
  `OPT_IN_PLUGINS` Set 保留为 legacy 兜底（无清单的 media 现态靠它）。media 迁移后 Set 清空删除。
- `buildPluginConfigMap`：`applyDataDirFallback` / `applyPathBoundaryFallback` / cwd 回落
  改为遍历「声明了 inherit 的插件」；**按名硬编码保留为兜底**，存量无清单插件行为不变。
  skills 收集库隔离（deny_paths 追加）是 skills 专属安全语义，**不通用化**，保持硬编码
  （或迁为 skills 清单的专属声明，开放问题 §9）。
- `envGranularity` scope 名单：**缓议**。它声明的是「插件产哪些 env scope」，属宿主对插件
  内部行为的断言，manifest 化等于让插件自报产出——语义上可行但需与 env-injection 契约
  对齐，v1 不动（§9 开放问题）。

**零回归论证**：存量 21 插件中，有清单者字段全显式（推导不触发）；无清单者走硬编码兜底
（路径不变）。新字段只被新插件/迁移后插件使用。热应用（assemblePluginTools）与 `--tools`
吃同一份 buildPluginConfigMap 结果（现态唯一产地），改一处全覆盖。

### 6.5 共享 UI 构建配置（落点：`packages/plugin-ui/build`，新 subpath export）

现状：4 个 UI 插件各持 ~130 行 vite.config.embed.ts + ~100 行 vite.config.ts，
其中层序声明 / biome-ignore-all 头 / externals 清单 / classic-script iframe 产线是
**逐字复制的暗坑**（model-registry 注释明言层序保证靠宿主预留槽位）。

设计：`createPluginViteConfigs({ pluginId, pages, uiDir? })` 返回
`{ iframe: UserConfig, embed: UserConfig }`，一次封装：

- embed 档：lib ESM → `web/embed/index.mjs` + `index.css`；externals 固定
  react/react-dom/react/jsx-runtime/@vessel-agent/plugin-sdk（契约 §6）；
  `@layer … plugin.<pluginId> …` 防御声明；biome-ignore-all 产物头（lint/format/assist）。
- iframe 档：照先例 classic-script 流程，每页一个 html 入口。
- 插件侧 vite.config.ts / vite.config.embed.ts 各 ~5 行（调工厂 + defineConfig）。

迁移：4 个存量 UI 插件逐个换用工厂，**产物字节等价**为验收（构建产物入库，diff 可审）。
plugin-ui 是浏览器侧包，build subpath 是 node 侧工具——package.json exports 分条件导出，
不污染浏览器 bundle（§9 风险）。

### 6.6 明确不做的「自动化」（防过度设计）

- 不做「扫描 src/ 自动生成 manifest」的运行时魔法（fail-closed 时序，§3.3）。
- 不做 navGroups 自动合成（导航是 UX 决策；模板生成 + 显式声明足够）。
- 不做 permissions 推导 / 最小权限自动收紧（授权意图不可猜）。
- 不做插件间依赖自动解析 / 自动安装（N1）。
- 不做 child 协议入口的运行时框架化（usage/marketplace 的 NDJSON 入口是契约实现，
  模板复制 + 指针足够；抽框架 = 第二套机制风险）。

## 7. 现有插件迁移路径

纪律（照 0.51 期 0 / model-registry 先例）：**每期对存量插件行为零变化**——
迁移 = 换声明位置 / 换生成工具，不改语义；验收以「配置快照 / 工具面 / RPC 面 / 构建产物
字节等价」为准（人工评审项，宪法零测试）。迁移全部可选、可逐个、可回退（显式字段写回即回退）。

### 7.1 逐插件决策表

| 插件 | 迁移内容 | 期 | 备注 |
| --- | --- | --- | --- |
| web-tools | settings 单源（settings.ts + sync）；清单四件套改缺省推导 | P2 | 最小 capability，先验证推导链 |
| media | 补 vessel 清单（`defaultEnabled:false` + `inherit.pathBoundary`）；settings 单源；**OPT_IN_PLUGINS 删名** | P3 | 无清单→有清单是行为敏感点：默认集语义由 Set 转声明，需逐字对齐（含显式空数组边界语义） |
| recall / doc-subscription | 补最小清单 + `inherit.dataDir`（doc-subscription 另 envGranularity 缓议） | P3 | 只迁 dataDir 注入；工具面不变 |
| skills | settings/rpc 单源 + sync；UI 换共享构建工厂；`inherit.{pathBoundary,dataDir,cwd}`；收集库隔离保持硬编码 | P3/P4 | 信任门 / TOFU / 三来源语义**不动**（q-skills-impl 刚落地，不碰安全面） |
| model-registry | rpc 单源（handler map 已在 rpc switch，改 defineRpcHandlers）；UI 换共享构建工厂；清单四件套缺省化 | P2/P4 | provider 类装配 loop 不动；凭证/明文纪律不动 |
| usage / marketplace | UI 换共享构建工厂；清单 activationEvents/pages entry 缺省化；协议入口不动 | P4 | child 热重载语义不动 |
| basic-tools | `inherit.cwd` 声明化；envGranularity 缓议 | P3 | deny_paths 注入方（skills 隔离）保持硬编码 |
| anthropic / openai | **不迁**（provider 注册已是单行，无清单需求） | — | 可选：补最小清单只为 plugin list 展示，非必需 |
| guardrail-pii / redact-secrets / tool-policy / hook-logging | **不迁**（声明式 guardrails/hooks 已自动；无贡献面需求） | — | 需要 settings 时再补清单 |
| mcp-client / feishu / evals / engine-client | **不迁**（工厂式，§3.2 显式裁决） | — | wiring 是宿主功能 |
| delegate-task / team | **不迁**（legacy 工具插件，无贡献面） | — | 同上 |

### 7.2 宿主侧清理顺序（严格后置）

1. P3 完成 media/recall/doc-subscription/skills/basic-tools 声明化后：
   `buildPluginConfigMap` 的按名硬编码**降级为兜底分支**（不删，legacy 外部插件可能依赖）；
   `OPT_IN_PLUGINS` 在 media 迁移后删名（Set 保留机制，空集）。
2. P4 完成 UI 工厂迁移后：4 份 vite 配置删除，产物 diff 评审归档。
3. 硬编码兜底的最终删除：**不设期限**——外部 legacy 插件（无清单）永远可能存在于
   user/project 目录，兜底是兼容面不是债。

### 7.3 新插件（脚手架产物）的出生形态

create 生成的插件**直接是目标形态**（单源 settings/rpc + 缺省推导 + inherit 声明），
不经历迁移。P1（脚手架）先于 P2-P4（运行时机制）落地时，模板按当时现态生成
（如 opt-in 过渡期写注释提示进 OPT_IN_PLUGINS）；模板随分期演进，**已生成的插件不受
模板演进影响**（生成物是普通源码，作者拥有）。

## 8. 与先例对齐

### 8.1 q-skills-impl（skills-plugin-design.md / 已落地 P1）

- **形态照抄**：capability 模板 = skills 形态（in-process + capabilityManifest +
  装配层 registerInProcessPlugin 自动登记 + `install(){}`/工具注册 + rpc 管理面）。
  skills 设计 §3 的形态选择理由（不进子进程、信任门在插件内）对模板同样成立。
- **安全面不碰**：TOFU 信任门 / 三来源 / 收集库隔离是 skills 专属语义，脚手架不通用化、
  迁移不触碰（§7.1）。模板的 permissions 生成**最小空声明**，与 skills「声明过才给」口径一致。
- **settings 协同**：skills 设计 §10 约定 contributes.settings 由 q-settings 自动发现渲染——
  模板 settings 单源（§6.3）产出的 schema 严格落在该子集内，不扩字段。
- **零测试纪律**：skills 实现分支按宪法删测试；本设计 VERIFY.md 替代测试占位（§5.4）同口径。

### 8.2 q-media-view（investigation.md / media 插件）

- **opt-in 语义**：media 的「不进默认集、显式 plugins: 才加载」迁为 `defaultEnabled:false`
  声明（§6.4），语义逐字保留（含「显式列表即信任」）。
- **边界继承**：media 的「自身 > basic-tools 回落、显式空数组 = 不限制」迁为
  `inherit.pathBoundary` 声明，优先级与空数组语义不变（plugin-config.ts L362 注释是契约）。
- **install 期探测**：media 的后端探测（pdftotext/tesseract/describe bridge）是插件内语义，
  脚手架 tool 模板留「探测占位 + 缺后端明确报错不降级」注释指针，不通用化探测框架。
- **refs 通道**：q-media-view 的「工具结果 → image refs」走宿主既有回执/注入通道，
  与脚手架无交集；模板不复制该机制。

### 8.3 q-settings（vscode-settings-design.md）

- settings 的校验（serve 按 manifest spec）/ 落盘（setPluginConfigValue）/ 渲染（自动发现）
  全链路已自动；本设计只解决「schema 与 parser 双写」（B4），不改 q-settings 任何接口。
- `parseSettings` 助手的校验口径 = serve 方法层口径（type/enum/minmax），**插件侧预校验
  不是第二套权威**：serve 仍按 manifest 校验，助手只是让 install 拿到类型化 config。

### 8.4 plugin-embed 契约 / model-registry

- 共享构建工厂（§6.5）封装的正是契约 §6（externals/import map）/ §9（层序）/ §10（双产线）
  的现态实现；工厂**不新增契约语义**，只消灭复制。
- capability 模板的 rpc 注册路径 = model-registry D3 路径（Plugin.rpc → registerInProcess →
  同一 PluginRpcRegistry / canonical 名 / DTO 校验），不自造注册路径（model-registry 头注释纪律）。

## 9. 风险与开放问题

| # | 风险 | 缓解 |
| --- | --- | --- |
| R1 | **缺省推导弱化 fail-closed 的观感**：id/version 从 package.json 推导后，「清单写错」变成「package.json 写错」 | 推导只补缺省、不豁免任何校验（§6.1 表右列）；`plugin list --json` 标注 derived 字段；评审项照旧 |
| R2 | **engines 宽缺省（>=0.43）让老宿主装上新插件** | 缺省下限是契约诞生版而非「无约束」；模板生成时写**当前版本**下限；作者要兼容旧版须显式放宽——方向与现态一致（显式才是意图） |
| R3 | **user/project 模板依赖越界**：作者照 repo 先例 import config/plugin-sdk → 加载失败（HOST_SHARED_PACKAGES 只三包） | 模板按 where 约束依赖（§4.2）；加载失败已有可归因错误（pluginDependencyError 点名缺包）；VERIFY.md 列评审项 |
| R4 | **plugin-sdk 是否进转发白名单**（开放）：sdk 是纯函数+冻对象，第二副本初步判断无害，但白名单入选标准是「第二副本会不会出事」的逐包裁决 | 独立决策，不夹带进本设计；v1 模板内联同形片段绕开 |
| R5 | **sync 静态解析的脆弱性**：handler map 附注 / schema const 若不是纯字面量（含表达式/展开），AST 解析取不到 | sync 只认字面量形状，取不到就**报错退出、不写回**（生成器失败安全）；模板保证生成物是字面量；作者手写复杂形状时回退手写 manifest（现态） |
| R6 | **模板漂移**：先例演进（如 embed 契约 P3 加 router/dialog）后模板过时 | 模板头注释标注「照 <先例> @ <版本>」；共享构建工厂把最易漂移的暗坑收进一处（§6.5）；模板演进不影响已生成插件 |
| R7 | **defaultEnabled 迁移改变默认集**：media 从 Set 转声明若口径不齐，会意外进/出默认集 | P3 验收以「默认集名单逐字等价」为准（人工评审）；Set 兜底保留到迁移完成；显式 plugins: 完整清单语义不动 |
| R8 | **inherit 通用化过度**：把 skills 收集库隔离这类专属安全语义也通用化 = 给任意插件开 deny_paths 注入面 | §6.4 明确隔离不通用化；inherit 只含现态已有的三类回落（pathBoundary/dataDir/cwd），不新增注入语义 |
| R9 | **plugin-ui/build 的 node/browser 边界**：build subpath 引入 vite 依赖，污染浏览器侧包 | exports 条件导出（node 条件 / 独立 subpath `./build`）；vite 本就是 UI 插件 devDependency，不新增运行时依赖 |
| R10 | **脚手架成为第二套扩展机制的观感**（ADR-004/037/099） | create/sync 只产出**既有机制的合法输入**（package.json + Plugin 源码）；运行时零新机制；§6.6 负面清单 |
| R11 | **Windows 路径/软链**：user 模板落盘与转发缝 junction 现态已处理；create 不涉及软链 | 落盘用 path.resolve + 原子 rename；不触碰 loader 的 farm 逻辑 |
| R12 | **envGranularity manifest 化的语义争议**（开放）：插件自报 env scope 产出 vs 宿主断言 | v1 缓议（§6.4）；需与 env-injection 契约（框架轴 A）对齐后另议 |

开放问题汇总（需实现期裁决，不阻塞设计）：R4（sdk 白名单）、R12（envGranularity）、
`inherit` 字段最终命名、skills 收集库隔离是否迁专属声明、`--type ui` 的 category 缺省
`experience` 是否引入新组织约定（loader 无感，纯目录语义）。

## 10. 分期实施计划

每期独立可交付、独立可回退；P1 不依赖任何运行时改动，先行消灭最大阻力。

### P1：脚手架 CLI（纯生成，零运行时改动）

- `vessel plugin create` 三型 + where 三位置 + 校验 + 模板 + VERIFY.md（§4/§5）。
- 模板按**现态**生成（清单四件套写全、opt-in 写注释指针、UI 复制先例构建文件）。
- 验收（人工评审项）：三型各生成一个临时插件 → 重启后 `plugin list` 可见、
  占位工具/RPC/页面可调 → 删除；user/repo 两位置各验一次；冲突/非法名/保留名被拒。
- 落点：args.ts / plugin-command.ts / plugin-create.ts / templates/ / completion / help。

### P2：manifest 缺省推导 + SDK 助手 + sync（单源化）

- §6.1 推导表（validatePluginManifest options 扩展）；§6.2 三助手；§6.3 sync。
- 迁移 web-tools（settings 单源）+ model-registry（rpc 单源）验证全链。
- 验收：存量 21 插件清单全显式 ⇒ 加载行为/贡献面/默认集逐字不变；web-tools/model-registry
  迁移后配置快照与 RPC 面等价；sync 对非字面量形状失败安全。

### P3：装配知识 manifest 化（defaultEnabled / inherit）

- §6.4 两字段 + selection/buildPluginConfigMap 声明优先改造；硬编码降级兜底。
- 迁移 media / recall / doc-subscription / skills / basic-tools（§7.1）。
- 验收：默认集名单逐字等价；media 边界回落（含显式空数组）语义等价；
  dataDir/cwd 注入等价；热应用与 --tools 同口径。

### P4：共享 UI 构建工厂 + UI 插件迁移

- §6.5 createPluginViteConfigs；4 个 UI 插件换用；模板改 ~5 行 vite 配置。
- 验收：4 插件构建产物**字节等价**（入库 diff 评审）；embed/iframe 双档渲染等价。

### P5（可选，独立裁决）：开放问题收口

- sdk 转发白名单（R4）、envGranularity 声明化（R12）、硬编码兜底清理评估（§7.2）。

## 附录 A：注册链路时序

```
进程启动
  └─ PluginLoader.scan()                          [发现：目录约定，已自动]
       ├─ repo plugins/<cat>/<name> ─┐
       ├─ project .vessel/plugins ───┤ 同 id 优先级裁决 + override 门禁
       ├─ user ~/.vessel/plugins ────┤
       └─ node_modules/@vessel-agent ┘
       └─ readPlugin: package.json + vessel 块
            ├─ entry+contributes → child descriptor
            ├─ vessel 无 entry → capabilityManifest（fail-closed 校验）
            └─ 无 vessel → legacy in-process
  └─ resolvePluginSelection()                     [选择：默认集/opt-in/工厂排除]
  └─ createProvider → model-registry-wiring       [provider 类单独装配 loop]
  └─ buildPluginConfigMap()                       [安装配置：显式>声明式>装配回落]
  └─ installPluginsIntoHost(withPluginConfig…)    [install：tenant 一次]
  └─ 工厂 wiring（mcp/feishu/evals/engine）        [显式：宿主运行时依赖]
  └─ createPluginHostManager(child descriptors)   [child 宿主，已自动]
  └─ registerInProcessPluginEntries(capability…)  [RPC/pages/settings 登记，已自动]
  └─ activateStartupPlugins(onStartup/*)          [child 启动激活；其余懒激活]
运行期
  └─ plugin-watch → createPluginReloader          [child 热替换；in-process restart_required]
  └─ vessel <plugin> <cmd> → contributes.cli      [CLI 命名空间，已自动]
  └─ q-settings → contributes.settings            [校验/落盘/渲染，已自动]
```

## 附录 B：manifest 前后对比（capability + UI 型）

**现态**（model-registry 实样，~135 行 vessel 块）：id/name/version/engines/description/side
全显式；ui.dir/embed.entry/embed.css/embed.runtime 全显式；pages 每页 entry/component 显式；
activationEvents 显式；rpc 10 条与代码 switch 双写。

**目标态**（缺省推导 + 单源后，作者手写部分）：

```jsonc
{
  "name": "@vessel-agent/my-plugin",
  "version": "0.1.0",
  "vessel": {
    // id/name/version/engines/side/description → 推导（§6.1）
    "ui": {},                          // dir=web / embed 全套 → 推导
    "contributes": {
      "pages": [{ "id": "main" }],     // entry=main.html / component=MainView → 推导
      "navGroups": [{ "id": "plugin:my-plugin", "title": "My Plugin", "icon": "plugins" }],
      "rpc": [/* sync 从 src/rpc.ts 生成；write 权限作者显式附注 */],
      "settings": {/* sync 从 src/settings.ts 生成 */},
      "i18n": {/* sync 从 web-src/i18n.ts 生成（可选） */}
    },
    "permissions": { "fs": ["data-dir"] }   // 永远显式（§3.2）
  }
}
```

手写量从 ~135 行降至 ~20 行；代码侧 switch/parseConfig 由助手 + 单源替代；
UI 构建文件由 ~10 个复制文件降至模板生成 + ~5 行 vite 配置。**授权声明一行不减。**

---

*本设计由 q-plugin-scaffold 产出（design/q-plugin-scaffold，基点 723fb673）。
实现另开分支；本文档不构成任何代码承诺。*