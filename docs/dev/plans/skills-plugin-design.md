---
title: SKILLS 插件设计——收集技能库的管理、agent 工具面、UI 与信任边界
kind: draft
triggers: [skills, skill, 技能, skills 插件, 技能库, 收集, 索引, 信任, TOFU, skills 工具, 加载状态, plugin.skills, q-settings]
paths:
  [
    packages/core/src/runtime/plugin-host.ts,
    packages/serve/src/plugin-host/manager.ts,
    src/plugin-host-assembly.ts,
    src/plugin-manifest.ts,
    packages/plugin-sdk/src/index.ts,
    docs/architecture/plugins.md,
    docs/architecture/runtime-api.md,
  ]
created: 2026-12-01
---

# SKILLS 插件设计（design/q-skills）

> 状态：**设计稿，未实现**。本分支只产出文档，不改代码；落地时按 §12 分期另开实现分支。
> 上位约束：[plugins](../../architecture/plugins.md)、[extensions](../../architecture/extensions.md)、
> [plugin-embed 契约](../../architecture/plugin-embed.md)、[runtime-api](../../architecture/runtime-api.md)、
> [tools](../../architecture/tools.md)（工具判据与 token 税）。
> 协同：q-settings（VSCode 式设置编辑器）——接口约定见 §10。

## 目录

1. [调研结论（设计的事实基础）](#1-调研结论设计的事实基础)
2. [目标与非目标](#2-目标与非目标)
3. [插件形态选择：in-process（理由与备选）](#3-插件形态选择in-process理由与备选)
4. [架构总览](#4-架构总览)
5. [数据模型与存储 / 索引](#5-数据模型与存储--索引)
6. [Agent 工具契约：`skills`](#6-agent-工具契约skills)
7. [RPC 接口契约](#7-rpc-接口契约)
8. [UI 设计](#8-ui-设计)
9. [权限与安全：skill 加载的信任边界](#9-权限与安全skill-加载的信任边界)
10. [设置域：contributes.settings 与 q-settings 协同](#10-设置域contributessettings-与-q-settings-协同)
11. [Manifest 示例](#11-manifest-示例)
12. [分期实施计划](#12-分期实施计划)
13. [风险与开放问题](#13-风险与开放问题)

## 1. 调研结论（设计的事实基础）

以下全部来自本工作树源码与 current 文档，是设计的硬约束；每条给出落点。

### 1.1 插件机制：一套机制、两种形态

- **唯一扩展机制**是 `Plugin` + `PluginHost`（`packages/core/src/types/plugin.ts`、
  `packages/core/src/runtime/plugin-host.ts`）。core 冻结，不为任何扩展类型新增接口
  （ADR-034 supersede ADR-011/017）。
- **能力插件（in-process）**：`install(host)` 注册 tool / provider / guardrail / hook /
  memberBody / readSideMasker；`Plugin.rpc` 经装配层 `registerInProcessPlugin`
  （`src/plugin-host-assembly.ts`）登记进 serve 的 `PluginHostManager.registerInProcess`，
  与 child **共用同一个 `PluginRpcRegistry` / canonical 名 `plugin.<id>.<name>` / DTO 校验**；
  声明 `contributes.rpc` 却无 handler ⇒ fail-closed `plugin_manifest_invalid`。
- **体验插件（child）**：独立子进程，NDJSON JSON-RPC / DTO 通信，贡献 pages / commands /
  settings / rpc / events / panels / toolbar / http / cli；**不直接注册 core 类型、不进入
  提示词**。子进程是崩溃 / 生命周期隔离边界，**不是 OS 沙箱**（ADR-099）。
- **in-process 也能有完整贡献面**：判据是「package.json 声明 `vessel` 清单但无 `entry`」
  （`descriptor.capabilityManifest`）。先例 `plugins/provider/model-registry`：`side: "both"`、
  `ui.embed`、pages / navGroups / rpc / i18n 全有，`contributionsFor()` / `staticMounts()`
  对 child 与 in-process 双遍历同口径（manager.ts）。`ensureActive` 对 in-process 登记即激活
  （commit 6c1fe2d4 修过 model-registry UI 404）。
- **热重载不对称**：child 可热重载；in-process 改动必须重启进程，`plugins.reload` 返回
  `restart_required`，不谎报已重载。
- **发现与信任**：扫描根 project `./.vessel/plugins` > user `~/.vessel/plugins` > repo
  `plugins/**` > `node_modules`；builtin（repo 源）可信，外部默认不可信、显式 `plugins:`
  条目视为信任确认。扫描只在启动发生一次（`PluginLoader` 缓存）。
- **settings 贡献点**：`contributes.settings` 是 JSON Schema 子集
  （`PluginSettingSchema { type?, description?, default?, … }`，`src/plugin-manifest.ts`）；
  `config.yaml` 的 `plugins[].config` 在激活时经 `filterSettings` 下发——未声明键告警丢弃、
  类型不符 `plugin_config_invalid`（manager.ts）。**宿主 v1 不自动渲染表单**；
  `config.set` 白名单**不含 `plugins[]`**（plugin-embed 契约 §1），现 WebUI ConfigView
  是只读扁平表。VSCode 式设置编辑器由 q-settings 设计（见 §10）。
- **UI embed 档**：`ui.embed { entry(.mjs), css?, runtime{react,sdk} }` + `pages[].component`
  具名导出；builtin 自动 `ui_trust: embedded`，外部需 `trust_ui` + TOFU 哈希锁；
  SDK `createPluginHost` 冻宿主对象（rpc / events / theme / toast / i18n / log / permissions），
  白名单只防误用不是沙箱；iframe `entry` 必填回退；CSS 走 `@layer plugin.<id>` 作用域约定。
- **插件私有目录**：`<dataDir>/plugins/<id>/`；`permissions.fs` 含 `data-dir` 时下发全局
  dataDir。日志 `<dataDir>/plugins/<id>/logs/plugin.log`。

### 1.2 工具面纪律（本设计必须回答的质疑）

- **唯一注册入口** `PluginHost.registerTool`；本仓工具名必须 snake_case
  （`^[a-z][a-z0-9_]*$`）且 provider-safe；权限判定下沉工具自身
  （`checkPermission(input, ctx) → allow | deny | ask`，ADR-026）。
- **API surface = prompt surface**：tool 的 name / description / inputSchema 每轮都是固定
  token 税；判据只有一条——**能被其他工具替代的工具就不该存在**（tools.md）。
- **skills-loader 曾被判死**（tools.md「被判死的工具」表）：理由是「skills 就是文件；
  前端引用、core 只收消息」。本设计不是复活它——差异论证见 §2.2 与 §6.1。
- 单工具多动作有先例：`subscribe`（add / remove / list / inspect）、`recall`（无参列表 /
  有参读回）、`vessel`（控制面桥）。工具描述**只描述事实**（recall 开头一句就把「不是读
  文件」讲死）。

### 1.3 skills 的现态约定

- **skills 不是一条加载通道**（runtime-api.md）：技能就是 markdown 文件，两个约定位置——
  仓库 `skills/`（项目级，随仓库提交、团队共享）与 `~/.vessel/skills/`（用户级，跨项目复用）。
  **纯约定，代码里零硬编码**；harness 不扫描、不解析、不注入。
- **前端引用路径**：REPL / TUI 发送前扫 `@<路径>`（行首或空白后起 token，全角标点截断、
  剥尾部半角标点），命中文件读为一条 user 注入消息（`<file path="...">内容</file>`，
  >100KB 截断标注），经 `RunOptions.messages` 注入；用户原文一字不改。headless 对应
  `--run @file`。
- **core 不解释语义**：注入消息与用户输入一样持久化进 WorkingContext；core 不知道哪条是
  skill。`BeforeLlm` hook 只能读 `ctx.systemPrompt`、往 `ctx.messages` 追加持久化尾部消息
  （system 冻结；doc-subscription 的 `vessel:notice` 是现态先例）。
- **路径边界**（ADR-055）：read / edit / bash cwd 按 realpath 判定，内置 denylist
  （`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）；插件 `allowed_roots` /
  `deny_paths` 可收紧；读文件的插件（media）**默认继承 basic-tools 的边界**，合并由装配层
  `buildPluginConfigMap` 做。**bash 只校验 cwd，不是沙箱**。
- ADR-011（skills 经 skills-loader 插件 + BeforeLlm 注入）已被 ADR-034 supersede；
  本设计不恢复「core 加 SkillHost」路线，也不默认做 hook 自动注入（§12 P3 再议）。

### 1.4 可复用的先例插件

| 先例 | 复用点 |
|---|---|
| `plugins/provider/model-registry` | in-process + capability manifest + embed UI + RPC 管理面的完整样板 |
| `plugins/context/doc-subscription` | install 期解析 config、`enabled:false` 不注册、per-session 状态存 stateDir、BeforeLlm 尾部消息、路径边界 `buildPathBoundary` |
| `plugins/tools/recall` | 单工具事实性描述、只读 `checkPermission: allow`、安装期钉死数据目录 |
| `plugins/observability/usage` | embed 双产线 `build:ui`（iframe + ESM）、`@layer` 样式契约 |
| `plugins/media/media` | 读文件插件继承 basic-tools 路径边界的装配口径 |

## 2. 目标与非目标

### 2.1 目标

设计一个内置插件 `skills`（目录 `plugins/context/skills/`，包名 `@vessel-agent/plugin-skills`），
管理 **vessel 收集来的技能库**，并提供四个面：

1. **管理面**：扫描 / 索引三个来源的技能文件（项目 `skills/`、用户 `~/.vessel/skills/`、
   插件私有收集库 `<dataDir>/plugins/skills/library/`），维护元数据、内容哈希与信任记录；
   文件永远是真相源，索引只是派生缓存。
2. **agent 工具面**：一个 `skills` 工具（list / search / load 三动作），让模型在 run 中
   发现、检索、按信任门加载技能内容进语言空间。
3. **UI 面**：技能库列表 / 详情 / 信任状态 / 会话加载状态，embed 档渲染、iframe 回退。
4. **设置面**：经 `contributes.settings` 声明技能库配置，进 q-settings 的 VSCode 式
   设置编辑器；权限与安全边界（加载信任门、收集库隔离）见 §9。

### 2.2 与「被判死的 skills-loader」的差异（为什么这次该存在）

tools.md 判死 skills-loader 的理由是「skills 就是文件；前端引用、core 只收消息」。
本设计**不推翻那条判据**，而是论证管理对象变了：

| 维度 | 被判死的 skills-loader | 本设计的 skills 插件 |
|---|---|---|
| 管理对象 | 本地两个目录的 markdown 扫描 + CRUD + 文件监听 | **收集来的技能库**：含插件私有 library（marketplace / 导入 / 团队分享落地处），带来源与信任元数据 |
| 工具面 | scanner + CRUD（create / edit / delete 全注册成工具） | **只有一个只读工具**（list / search / load）；写技能 = 模型用 `write` / `edit` 改文件，不注册 CRUD 工具 |
| 加载语义 | 扫描后自动注入 | **信任门控的显式加载**：TOFU 哈希锁 + `checkPermission` ask/deny；不自动注入（P3 再议） |
| 可替代性 | 读文件 = `read`，建文件 = `write`，全可替代 | 发现 / 检索 / 信任门**不可被 read+bash 组合替代**（论证见 §6.1） |
| core 改动 | 无 | 无（core 冻结不动，注入仍走既有工具结果 / `RunOptions.messages` 通道） |

一句话：**skills-loader 死于「把文件操作注册成工具」；本插件活于「管理一个有信任边界的
收集库」**。如果未来收集库不存在（用户只有本地两个目录），本插件的工具面确实退化到接近
可替代——所以 library 来源与信任门是设计的承重墙，不是装饰（§13 风险 R1）。

### 2.3 非目标

- **不改 core**：不加 SkillHost、不加事件类型、不改 `RunOptions.messages` 语义。
- **不做技能的自动注入**（P1/P2）：不注册 BeforeLlm hook 往每轮塞技能内容；
  加载只由模型显式 `skills load` 或用户前端 `@path` / UI 动作触发。
- **不做技能创作 CRUD 工具**：写 / 改 / 删技能文件是 `write` / `edit` / `bash` 的事。
- **不做语义检索 / embedding**（P1）：子串 + 标签检索足够百级规模；P3  opt-in 再议。
- **不做跨节点同步**：技能库是 node 本地数据（dataDir 本地）；联邦 / 团队共享走
  marketplace 与仓库提交，不在本插件内做复制协议。
- **不执行技能附带脚本**：技能是数据（markdown + 附件），插件永不执行它；模型若用
  `bash` 跑附件脚本，那是 bash 的权限判定，不是本插件的授权（§9.4）。
- **不写测试 / 探针 / 临时进程**（宪法）：验证 = `bun run build`（typecheck + biome ci）
  + 用户手动行为验证。

## 3. 插件形态选择：in-process（理由与备选）

**结论：in-process 能力插件 + capability manifest（`side: "both"`、无 `entry`），
完全照 model-registry 先例。`vessel.scope: 'node'`（缺省），不申请成员端口。**

### 3.1 理由（按承重顺序）

1. **agent 工具面只有 in-process 能给**。`registerTool` 是 `PluginHost` 的方法，
   child 插件不直接注册 core 类型、不进入提示词（plugins.md「对 Vessel 与 AI 流的作用」）。
   若选 child，工具必须经「child RPC → 装配层转发注册」的第二套桥——这正是被禁止的
   第二注册入口，且 MCP client / engine-client 之外没有先例。需求②直接排除 child。
2. **贡献面不受损**。in-process + capability manifest 同样有 pages / ui.embed / rpc /
   settings / i18n / navGroups（model-registry D3 先例，`registerInProcess` 与 child 共用
   RPC registry / DTO 校验 / contributionsFor / staticMounts）。需求③⑤不需要 child。
3. **builtin 可信，隔离收益为零**。child 的价值是崩溃 / 生命周期隔离 + 外部不可信代码的
   进程边界。本插件是 repo 内置、可信；技能解析是纯数据操作（markdown + frontmatter），
   不执行任何技能代码，没有「不可信代码在插件里跑」的场景。为它付 IPC 往返、spawn、
   崩溃重启监督的成本没有对价。
4. **工具调用在热路径上**。`skills load` 每次调用都进 run 的工具管道；in-process 是
   函数调用，child 是 NDJSON IPC + DTO 校验往返。检索 / 加载延迟直接计入 run 时长。
5. **per-session 状态与 hook 扩展**。加载状态按 session 存 stateDir（doc-subscription
   同构）；P3 若做 pinned 注入需要 `registerHook`——同样只有 in-process 能给。

### 3.2 代价（诚实列出）

- **无热重载**：插件代码 / manifest 改动必须重启进程；`plugins.reload` 返回
  `restart_required`。技能**文件**的变化不受此限——扫描 / watch / rescan 是数据层，
  随时生效（§5.4）。
- **与宿主共命运**：插件崩溃 = 进程崩溃。缓解：解析全程防御（大小上限、frontmatter
  子集解析、失败降级为 raw 条目），不做任何网络 / 子进程操作（P1）。
- **settings 热应用受限**：install 期拿 config（doc-subscription 口径），改设置需重启；
  UI 必须如实显示「需要重启」（catalog `restartRequired` 已有该字段）。见 §10.4。

### 3.3 备选与否决理由

| 备选 | 否决理由 |
|---|---|
| child 体验插件 + 装配层转发工具 | 第二注册入口（禁）；IPC 热路径税；builtin 无隔离收益 |
| 工厂式插件（FACTORY_PLUGINS，装配层构造） | 不需要装配层注入特殊依赖（config / dataDir 经 install options 就够）；工厂式是 mcp / engine-client 这类「无 install 注册面」的特例，本插件有标准 install 面 |
| `scope: 'member'` + 端口 | 端口闭集只有 inbox，本插件不需要；工具按 tenant 安装一次、per-session 状态走 store 即可（doc-subscription 同构） |
| 拆两个插件（in-process 工具 + child UI） | 同一份索引 / 信任状态被两个进程共享 = 引入锁与一致性问题；model-registry 已证明单插件双面可行 |

## 4. 架构总览

（待扩充）

## 5. 数据模型与存储 / 索引

（待扩充）

## 6. Agent 工具契约：`skills`

（待扩充）

## 7. RPC 接口契约

（待扩充）

## 8. UI 设计

（待扩充）

## 9. 权限与安全：skill 加载的信任边界

（待扩充）

## 10. 设置域：contributes.settings 与 q-settings 协同

（待扩充）

## 11. Manifest 示例

（待扩充）

## 12. 分期实施计划

（待扩充）

## 13. 风险与开放问题

（待扩充）