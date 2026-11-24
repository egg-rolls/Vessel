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