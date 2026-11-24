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
created: 2026-11-24
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
- **不做语义检索 / embedding**（P1）：子串 + 标签检索足够百级规模；P3 opt-in 再议。
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

```text
 技能文件（真相源，三个来源）                 Node 进程（单执行面）
 ┌────────────────────────────┐   ┌──────────────────────────────────────────────────────┐
 │ project  <repo>/skills/    │   │ PluginLoader（启动扫描一次）                          │
 │ user     ~/.vessel/skills/ │──▶│   plugins/context/skills ── install(host, {config})   │
 │ library  <dataDir>/plugins/│   │     ├─ PluginHost.registerTool(skills)   ← agent 工具 │
 │          skills/library/   │   │     └─ Plugin.rpc ── registerInProcessPlugin          │
 └────────────────────────────┘   │            │                                          │
        │ scan / watch(300ms)     │            ▼                                          │
        ▼                         │   PluginHostManager（serve）                          │
 ┌────────────────────────────┐   │     ├─ PluginRpcRegistry: plugin.skills.*  ◀── gateway│
 │ SkillScanner + Indexer     │   │     ├─ contributionsFor ─▶ plugins.list / plugin.changed
 │  → index.json（派生缓存）  │◀──┤     └─ staticMounts ─▶ /plugins/skills/ui/**          │
 │  → trust.json（TOFU 锁）   │   │                                                       │
 │  → loads/<session>.json    │   │   apps/web（浏览器）                                  │
 └────────────────────────────┘   │     PluginEmbed ─ import SkillsView(?v=hash)          │
        ▲                         │       └─ createPluginHost ─ host.rpc('list'|'get'|…)  │
        │ 读文件 + 校哈希 + 记录  │                                                       │
 ┌──────┴─────────────────────┐   │   agent run（工具管道）                               │
 │ skills 工具 handler        │◀──┤     skills(list|search|load)                          │
 │  list/search: 只读索引     │   │       └─ checkPermission: 信任门（allow/ask/deny）    │
 │  load: 信任门 → 内容进     │   │       └─ load 成功 → 工具结果进语言空间（持久化）     │
 │       语言空间 + 记加载态  │   │                                                       │
 └────────────────────────────┘   └──────────────────────────────────────────────────────┘

 既有通道（不改）：前端 @path 引用 / UI「注入会话」──▶ RunOptions.messages ──▶ core
```

要点：

- **一个插件、四个面**，全部经既有机制：工具走 `PluginHost`，管理 / UI 数据走
  `plugin.skills.*` RPC，页面走 embed 契约，设置走 `contributes.settings`。
  不新增 core 接口、不新增宿主事件类型、不新增第二注册表。
- **两条加载通道并存且互不替代**：
  - *用户通道*（现态保留）：前端 `@path` 引用 → `RunOptions.messages` 注入。插件不改它；
    UI 的「注入会话」动作（P2）也只是把技能路径交给前端走同一条路。
  - *模型通道*（本设计新增）：`skills load` 工具结果进语言空间。信任门只管这条通道
    与 library 的隔离（§9）。
- **索引是缓存不是真相**：load 永远重读文件并校哈希；索引损坏 / 过期只影响 list/search
  的时效，不影响加载正确性。
- **装配接线**（实现期落点，均在既有缝上）：
  - `src/bootstrap.ts` / `installPluginsIntoHost`：默认集加载 `plugins/context/skills`；
    config 经 `buildPluginConfigMap` 合并（继承 basic-tools 的 `allowed_roots` /
    `deny_paths`，media 先例）。
  - `src/plugin-host-assembly.ts:registerInProcessPlugin`：install 后登记 manifest
    贡献面与 RPC handler（零改动复用）。
  - gateway `plugins.list` / `plugin.changed` / 静态挂载：零改动复用。

## 5. 数据模型与存储 / 索引

### 5.1 来源与目录布局

| source | 根 | 性质 | 信任基线 |
|---|---|---|---|
| `project` | `<repo>/skills/`（node cwd） | 随仓库提交、团队共享 | 本地 authored，首次加载 TOFU |
| `user` | `~/.vessel/skills/` | 用户级跨项目复用 | 本地 authored，首次加载 TOFU |
| `library` | `<dataDir>/plugins/skills/library/` | **收集库**：导入 / marketplace 落地 | 外来内容，隔离 + 信任门（§9） |

- 三个根都是**既有约定的延伸**：project / user 两根与 runtime-api.md 的现态约定逐字
  一致（前端 `@path` 继续可用）；library 是插件私有目录（`permissions.fs: ["data-dir"]`），
  收集来的技能唯一落地处。
- 技能两种形态（兼容 Claude Code 惯例与本仓平铺惯例）：
  - **flat**：`<root>/<name>.md`（或嵌套子目录，id 含相对路径）。
  - **dir**：`<root>/<name>/SKILL.md` + 附件（参考文档 / 模板 / 脚本）。附件只列清单，
    模型要读附件用 `read`（路径边界照常判定）；插件不代读、不执行。
- 扫描 containment：每个根 realpath 钉死；**symlink 条目跳过**（目标可被无痕替换，
  ui-bundle 哈希锁同款 fail-closed 口径）；单文件上限 1 MiB（超限条目标 `oversize`，
  可 list 不可 load）；条目总数上限 5000（超出告警截断，防 DoS）。

### 5.2 技能文件格式（frontmatter 子集）

```markdown
---
name: code-writing
description: 本仓代码风格与提交纪律（写代码前加载）
version: 1.2.0
tags: [code, style, commit]
---

# 正文（markdown，技能本体）
…
```

- frontmatter 是**可选** YAML 子集：只认 `name / description / version / tags` 四个键，
  标量与字符串数组，自写子集解析器（不引第三方 YAML 库、绝不 eval）。
- 无 frontmatter → `name` 取文件名（dir 形态取目录名），`description` 取正文首个
  标题 / 首段（截断 200 字符）；解析失败 → 条目仍入库，`frontmatter: 'invalid'` +
  warning，load 返回原文。**宿主 never 把 frontmatter 当指令解释**——它只是元数据。
- 正文就是纯文本数据；插件不渲染执行其中任何「命令 / 脚本 / 工具调用」记法。

### 5.3 存储布局（插件私有目录）

```text
<dataDir>/plugins/skills/
├── library/                  # 收集库技能文件（真相源之一，导入落地处）
│   └── <imported-skill>/SKILL.md
├── index.json                # 派生缓存：全量条目元数据（可整文件重建）
├── trust.json                # 信任记录：TOFU 哈希锁（宿主侧写，唯一真相）
├── loads/
│   └── <sessionId>.json      # 会话加载状态（工具 handler 写，UI 读）
└── logs/plugin.log           # 宿主既有日志面（1 MiB 轮转）
```

写纪律：`index.json` 整文件覆盖（O(1) 当前态，DOC-MANAGEMENT 口径）；`trust.json` /
`loads/*` 经临时文件 + rename 原子写；并发写以进程内单写队列串行化（in-process 无跨进程
竞争；多 node 各自 dataDir 天然隔离）。

### 5.4 核心类型（接口契约，实现期落 `plugins/context/skills/src/types.ts`）

```ts
type SkillSource = 'project' | 'user' | 'library';
type FrontmatterState = 'ok' | 'partial' | 'none' | 'invalid';
type TrustState = 'unknown' | 'trusted' | 'stale' | 'revoked';

interface SkillEntry {
  id: string;              // `<source>/<relpath 去扩展名>`，如 'user/code-writing'、'library/foo/SKILL'
  name: string;            // frontmatter.name ?? 文件名
  description: string;     // ≤200 字符
  tags: string[];          // ≤16 个，每个 ≤32 字符
  version?: string;
  source: SkillSource;
  relPath: string;         // 相对来源根，'/' 分隔
  absPath: string;         // realpath（扫描期钉死）
  format: 'flat' | 'dir';
  auxFiles?: string[];     // dir 形态附件相对路径清单（≤50 条，超出截断标注）
  bytes: number;
  mtimeMs: number;
  sha256: string;          // 内容哈希（扫描期算；load 期重算比对）
  frontmatter: FrontmatterState;
  warnings?: string[];     // oversize / 解析失败 / 截断等
}

interface SkillIndex {
  version: 1;
  generatedAt: string;     // ISO8601
  entries: SkillEntry[];   // 按 id 排序（确定性序列化，指纹可比）
}

interface TrustRecord {
  sha256: string;          // 钉住的内容哈希
  recordedAt: string;
  origin: 'local' | 'import' | 'marketplace';
  state: 'trusted' | 'revoked';   // stale 是派生态：trusted 但当前哈希 ≠ 锁哈希
}

interface TrustStore {
  version: 1;
  skills: Record<string /* skill id */, TrustRecord>;
}

interface SessionLoad {
  id: string;
  sha256: string;          // 加载时的内容哈希（内容后来变了也能追溯当时加载的是什么）
  loadedAt: string;
  runId: string;
}

interface SessionLoads {
  version: 1;
  sessionId: string;
  loaded: SessionLoad[];   // 追加式，上限 200 条（超出丢最旧）
}
```

派生规则（单一口径，工具 / RPC / UI 共用）：

- `trustState(entry)`：无记录 → `unknown`；`revoked` → `revoked`；
  `trusted` 且 `entry.sha256 === record.sha256` → `trusted`；不等 → `stale`。
- **id 唯一性**：source 前缀保证三根同名技能共存不冲突；同根内 relpath 天然唯一。
- **索引重建**：install 期异步全量扫描；`watch: true` 时三根 fs.watch 去抖 300ms
  （gateway 热重载同款节奏）增量重扫；`rescan` RPC 手动全量。library 的导入写入由
  插件自己完成，写后直接更新索引，不等 watch。
- **load 不信任索引**：每次 load 重读文件 → 重算 sha256 → 与 trust 锁比对 → 通过才
  返回内容并更新索引条目。索引过期只影响 list/search 时效，不影响信任判定。

## 6. Agent 工具契约：`skills`

### 6.1 存在性论证（回答「能被其他工具替代吗」）

一个工具，三个动作，全部只读。逐条对照判据：

1. **发现不可替代**：收集库跨三个根，其中 library 在插件私有目录（且建议进
   `deny_paths` 隔离，§9.3）——模型的 `read` / `bash` 根本够不到；project / user 根
   也不在成员 cwd 的必然视野里。没有 `skills list`，模型不知道「有哪些技能可用」，
   收集库等于不存在。
2. **检索不可替代**：跨根、按元数据（name / description / tags）排序的子串检索，
   不是对已知路径 grep；成员 `allowed_roots` 可能不含 home 目录。
3. **信任门不可替代**：load 是收集内容进入语言空间的**受控入口**——TOFU 哈希锁 +
   `checkPermission` ask/deny + 来源标注。`bash cat` 没有这道门（所以 library 要
   隔离，§9.3）；门与隔离配套才成立。
4. **token 经济**：只注册一个工具（一份 name/description/schema 税）；技能内容
   **渐进披露**——list/search 只回元数据行，全文只在显式 load 时进上下文。不做
   「每技能一个工具」（那是 N 份永久税 + 选错空间爆炸）。
5. **不注册可替代动作**：create / edit / delete 不进工具面（`write` / `edit` / `bash`
   已覆盖，文件是真相源）；import / trust 管理走 RPC + UI（人类动作，不是模型动作）。

### 6.2 工具定义

```ts
{
  name: 'skills',
  description:
    'Browse and load the managed skill library (project skills/, user ~/.vessel/skills/, ' +
    'and the collected library) - NOT a file reader: ids come from list/search, not paths. ' +
    'action=list: one metadata line per skill (id · name · source · trust · description), ' +
    'paged (limit ≤ 50), filter by source/tag. action=search: substring over name / ' +
    'description / tags / id, best matches first. action=load: return the full skill ' +
    'content by id (≤ 64 KiB, truncated with a notice) plus its auxiliary file list; ' +
    'untrusted or changed content asks the user for confirmation first.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'search', 'load'],
                description: 'Default list' },
      query:  { type: 'string', description: 'search: substring to match (required for search)' },
      id:     { type: 'string', description: 'load: skill id from list/search (required for load)' },
      source: { type: 'string', enum: ['project', 'user', 'library'],
                description: 'list: only this source' },
      tag:    { type: 'string', description: 'list: only skills carrying this tag' },
      offset: { type: 'number', description: 'list/search: skip this many rows' },
      limit:  { type: 'number', description: 'list/search: max rows (capped at 50)' },
    },
  },
  display: { label: 'Skills', kind: 'search' },
  checkPermission: /* §6.4 */,
  handler: /* §6.3 */,
}
```

描述纪律照 recall：**开头一句把「不是读文件」讲死**（模型最容易把它当 `read` 用、
拿路径当 id）；只描述事实（读什么、给什么、上限多少），不写劝导性文字。

### 6.3 动作语义与返回线格式

**list**（缺省动作）——每技能一行，确定性排序（source 优先级 project > user > library，
同源按 id）：

```text
<id> · <name> · <source> · <trust> · <description 截断 120 字符>
…
(total <N>, showing <offset+1>–<offset+K>; use offset/limit to page)
```

**search**——子串匹配（大小写不敏感）name / description / tags / id，排序：name 命中 >
tag 命中 > description 命中 > id 命中，同级按 id；行格式同 list，附命中字段标注。
无命中回「no skills match "<query>"」+ 建议 list。P1 不做分词 / 模糊 / 语义。

**load**——信任门（§6.4）通过后：

```text
<skill id="user/code-writing" source="user" path="/abs/path/code-writing.md" trust="trusted">
<技能正文，≤ max_load_bytes（缺省 64 KiB），超限截断并在末尾标注>
</skill>
auxiliary files (read them with the read tool if needed):
  references/checklist.md
  templates/commit.txt
(truncated: content exceeded 65536 bytes; …)   ← 仅超限时
```

- 包裹格式与前端 `@path` 的 `<file path="…">` 注入同族（来源可辨、边界清晰），
  但标签是 `skill` 且带 `source` / `trust` 属性——**模型与用户都能看出这是技能库内容，
  不是用户原话**。
- 成功后写 `loads/<sessionId>.json`（§5.4），UI 加载状态由此而来。
- 失败线格式（一律可追溯，不静默）：未知 id → `skills: unknown id "<id>" (use list/search)`；
  oversize → 拒绝并给 bytes；信任门拒绝 → 复述是**信任判定**要求确认 / 已撤销
  （文案契约照 basic-tools：不复述完整路径）。

### 6.4 信任门（`checkPermission`）

| 动作 / 信任态 | 判定 |
|---|---|
| list / search | `allow`（只读元数据，无副作用） |
| load · `trusted`（哈希一致） | `allow` |
| load · `unknown`（首次） | `ask`（用户确认后钉住当前哈希 = TOFU） |
| load · `stale`（内容变了） | `ask`（重新确认；**不自动更新锁**） |
| load · `revoked` | `deny` |
| `trust_default: 'deny'` 时的 unknown / stale | `deny`（fail-closed 收紧档） |

- 判定是**工具自己的权限判定**（ADR-026 口径）：ask 被拒时错误说明走
  「… by user (the tool's own permission check asked for confirmation)」既有文案契约。
- TOFU 钉锁发生在**用户批准之后**（handler 内），不是 checkPermission 里——
  判定函数无副作用。
- 门只约束本工具通道；library 的 read/bash 隔离见 §9.3（两者配套，缺一则门可绕）。

## 7. RPC 接口契约

canonical 名 `plugin.skills.<name>`（宿主补前缀）；in-process handler 即 `Plugin.rpc`，
与 child 共用 DTO 校验。权限列是 gateway 调用方权限（read / write），不是模型权限。

| 方法 | 权限 | params | result | 语义 |
|---|---|---|---|---|
| `list` | read | `{source?, tag?, query?, offset?, limit?}` | `{items: SkillEntry[], total, generatedAt}` | 索引快照分页；query 存在时同 search 排序 |
| `get` | read | `{id}` | `{entry, content, auxFiles, trust: TrustState, trustRecord?}` | 详情：content 截断至 max_load_bytes；**不写 loads、不做信任门**（UI 详情是人类面，§9.5） |
| `search` | read | `{query, limit?}` | `{items: SkillEntry[], total}` | 同工具 search 的排序口径 |
| `loads` | read | `{session_id?}` | `{sessions: SessionLoads[]}` | 缺省返回全部会话（上限 100 会话）；给会话 id 则单会话 |
| `rescan` | write | `{}` | `{added: string[], removed: string[], changed: string[], total, warnings: string[]}` | 手动全量重建索引（watch 失效 / 网络盘兜底） |
| `trust_set` | write | `{id, action: 'trust' \| 'revoke'}` | `{id, trust: TrustState, record?}` | trust = 钉住**当前**哈希（重新确认）；revoke = 置 revoked。UI 信任面板唯一写口 |
| `import` | write | `{path}`（P2） | `{entry, warnings}` | 从本地路径导入技能到 library（ containment + 大小校验）；marketplace 对接 P3 |

契约纪律：

- **DTO additive**：所有 result 字段只增不改；旧客户端忽略新字段。
- **错误码**复用宿主闭集（`plugin_rpc_denied` / `plugin_permission_denied` /
  `plugin_config_invalid`…）；业务错误（unknown id / oversize / revoked）在 result 里
  带 `error: {code, message}` 结构化字段，不发明新信封 code。
- **get 与 load 的边界**：`get`（UI 详情）返回内容给**人类看**，不记加载态、不触发
  TOFU；`load`（工具）进**语言空间**，过信任门、记加载态。两条通道不混用（§9.5）。
- **不新增宿主事件**：UI 刷新 = mutation 后重拉 + 手动刷新 + 页面聚焦重拉；
  技能文件变化不广播 `skills.changed`（避免事件面增长；watch 只更新索引，UI 下次
  list 自然看到）。P2 若需要实时推送，再评估经既有 `plugin.changed` 或新事件走 ADR。

## 8. UI 设计

### 8.1 页面与导航

- **一个页面** `skills`（master-detail，不做第二个详情页）：
  `nav: "integrations"`（内置分组，技能是扩展内容，与 marketplace 同区；不新增
  navGroup，避免导航膨胀），`icon: "tools"`，`order` 排在 marketplace 之后。
- `component: "SkillsView"`（embed 具名导出）+ `entry: "skills.html"`（iframe 回退，
  契约必填）。builtin → `ui_trust: embedded` 自动成立；双产线 `build:ui` 照 usage 样本
  （`tsc --noEmit && vite build && vite build --config vite.config.embed.ts`，
  react / react-dom / plugin-sdk external，产物入库带 biome-ignore 头）。
- 数据全部走 `host.rpc('list' | 'get' | 'search' | 'loads' | 'rescan' | 'trust_set')`；
  不接触 gateway token / client 原对象（SDK 冻宿主面）。

### 8.2 布局与交互

```text
┌────────────────────────────────────────────────────────────────────┐
│ Skills            [搜索框 query] [source ▾] [tag ▾]  [重新扫描] [导入]│
├──────────────────────────────┬─────────────────────────────────────┤
│ 列表（分页，≤50/页）          │ 详情（选中项）                       │
│  name        source  trust   │  name / version / tags / source      │
│  code-writing  user   ●trusted│  描述 + frontmatter 状态 / warnings  │
│  deploy-check  project ●stale │  ── 正文（markdown 渲染，截断标注）──│
│  foo           library ○unknown│  附件清单（auxFiles，只列不读）     │
│  …                           │  ── 信任面板 ──                      │
│                              │  状态 / sha256(短) / recordedAt      │
│                              │  [信任此版本] [撤销信任]              │
│                              │  ── 加载状态 ──                      │
│                              │  会话 <id 短> · <loadedAt> · <runId> │
│                              │  （loads RPC；无记录显示「未加载」）  │
└──────────────────────────────┴─────────────────────────────────────┘
```

- **信任徽标**四态：`trusted`（绿）/ `stale`（黄，内容已变需重新确认）/
  `unknown`（灰）/ `revoked`（红）。徽标服务端算（`trustState` 派生规则 §5.4），
  前端只消费——与 `ui_trust` 同款纪律。
- **信任面板**：`trust_set` 是唯一写口；「信任此版本」对 unknown / stale 可用
  （钉当前哈希），「撤销信任」对 trusted / stale 可用。stale 时正文预览顶部挂
  「内容与已信任版本不一致」横幅（预览仍可见——人类面不受信任门限，§9.5）。
- **加载状态**：`loads` RPC 拉取；列表行可显示「已加载 ×N 会话」计数徽标；
  详情列会话短 id / 时间 / runId。P2 加 run-detail panel（`slot: "run-detail"`）
  显示本 run 加载过的技能。
- **导入**（P2）：文件选择 / 路径输入 → `import` RPC → 落 library → 列表刷新，
  新条目 trust = unknown。
- **刷新策略**：mutation（rescan / trust_set / import）后重拉 list + 选中项 get；
  手动刷新按钮；页面聚焦重拉。不订阅宿主事件（P1 无新事件，§7）。
- **空态 / 错误态**：未连接 / 插件 disabled → 宿主既有 `NotEnabledState`；
  RPC 失败 → `ErrorState` + 重试；索引为空 → 引导文案（三个根路径 + 「把 markdown
  放进 skills/ 或导入」）。

### 8.3 样式与 i18n 契约

- CSS 整体包在 `@layer plugin.skills`；自定义选择器以
  `[data-vessel-plugin="skills"]` 或 `.vp-skills-` 开头；消费宿主 tokens.css 变量
  （暗色自动）；不自建 portal，提示统一 `host.toast`。
- 文案经 `contributes.i18n`（en / zh-CN 两份，key 集合 typecheck 对齐）；
  markdown 渲染复用 web 侧既有渲染组件的 embed 可达版本（实现期确认 plugin-ui
  是否已导出；没有则 P1 用 `<pre>` 等宽降级 + P2 补渲染，**不为它引第三方运行时依赖**）。
- embed 加载 / 错误 / 版本不兼容 / 隔离回退全部走宿主既有 PluginEmbed /
  PluginErrorBoundary 机制，插件不自做。

## 9. 权限与安全：skill 加载的信任边界

### 9.1 威胁模型（先说清楚防什么、不防什么）

技能内容是**进入语言空间的非用户文本**——与附件 / 引用文件同族。威胁：

| # | 威胁 | 对策 | 残余 |
|---|---|---|---|
| T1 | 外来技能携带提示注入（诱导模型泄密 / 跑命令 / 改行为） | 信任门（TOFU + ask/deny）+ 来源标注包裹 + 收集库隔离 | 用户信任后的技能仍可注入；信任是人的判断，门只保证「人看过且内容没被掉包」 |
| T2 | TOFU 后内容被掉包（供应链 / 本地篡改） | 每次 load 重算 sha256 比对锁；不等 → stale → 重新 ask，**不自动更新锁** | 哈希锁不防「用户盲目重新确认」；UI 横幅明示差异 |
| T3 | 绕过工具直接 read/bash 读收集库 | library 根进 basic-tools `deny_paths`（§9.3） | bash 不是沙箱：cwd 校验外的命令仍可访问路径（现态边界，ADR-055 口径）；隔离是缓解不是关闭 |
| T4 | 扫描期路径逃逸（symlink / `..`） | 根 realpath containment + symlink 条目跳过 + 词法 safeRelativePath | 与 ui-bundle 哈希锁同款 fail-closed |
| T5 | 资源耗尽（超大文件 / 海量条目 / 深目录） | 单文件 1 MiB / load 64 KiB / 条目 5000 / 附件清单 50 / 目录深度上限 8 | 索引 O(n) 子串检索在 5000 上限内可接受 |
| T6 | frontmatter 解析注入（YAML 反序列化 gadget） | 自写标量子集解析器，无第三方 YAML 库、无 eval、无对象构造 | — |
| T7 | 技能附件脚本被插件执行 | 插件永不执行技能内容；附件只列清单 | 模型自己用 bash 跑脚本 = bash 的权限判定（ask），不是本插件授权 |

**明确不防**：已 trusted 技能的内容语义（门是完整性 + 来源确认，不是内容审查）；
宿主进程内恶意插件（in-process 信任模型现态）；OS 级沙箱（全仓都没有，不假装）。

### 9.2 信任状态机

```text
                首次 load + 用户批准（TOFU 钉锁）
   unknown ─────────────────────────────────────▶ trusted
      │                                            │  内容哈希变化（load 期发现）
      │  trust_default='deny'                      ▼
      │  → load deny                            stale ──重新确认──▶ trusted（新锁）
      │                                            │
      └────────────── trust_set(revoke) ◀──────────┘
                          │
                          ▼
                       revoked（load deny；trust_set(trust) 可恢复 → trusted 新锁）
```

- 锁文件 `trust.json` **只由插件宿主侧写**（工具 handler / RPC handler），
  技能文件本身不携带任何「自证可信」标记——frontmatter 里写 `trusted: true` 无效。
- `origin` 记录来源（local / import / marketplace），UI 展示；P3 marketplace
  签名验证落地前，marketplace 来源不自动提升信任。

### 9.3 收集库隔离（与信任门配套）

- **建议装配**：`buildPluginConfigMap` 合并时，把 `<dataDir>/plugins/skills/library/`
  追加进 basic-tools 的 `deny_paths`（插件自身 config 可显式覆盖）。效果：模型
  `read` / `edit` 收集库文件 → deny（文案可追溯）；技能内容只能经 `skills load`
  的信任门进入语言空间。
- project / user 根**不隔离**：它们是用户自己的文件，现态 `@path` / `read` 通道保留
  （隔离它们会破坏既有约定，且用户 authored 内容本就在用户信任域内）。
- 诚实声明：bash 命令本身不受路径沙箱约束（现态），隔离挡的是**工具面顺手读**，
  不是决心绕行的命令。这与全仓「子进程不是 OS 沙箱」的措辞一致。

### 9.4 权限声明（manifest permissions）

```jsonc
"permissions": {
  "fs": ["data-dir"],     // 插件私有目录（index/trust/loads/library）
  "net": [],              // P1 零网络；P3 marketplace 对接再 additive 申请
  "process": false,       // 永不 spawn
  "secrets": false,
  "events": [],           // 不订阅宿主事件（P1）
  "rpc": []
}
```

- 扫描 project / user 根是**读用户技能目录**，不是 `fs: ["data-dir"]` 的语义范围——
  实现期经装配层传入根路径（install options），插件用 `buildPathBoundary`
  （继承 basic-tools 边界）判定可读性；越界根不扫描、告警。这与 media 插件
  「读文件继承 basic-tools 边界」同口径。
- 工具面权限全部下沉 `checkPermission`（§6.4）；RPC 面权限 read/write 由 gateway
  既有判定；**不申请 ports、不申请 member scope**。

### 9.5 人类面与模型面的边界

- `get` RPC（UI 详情预览）**不过信任门**：看 ≠ 加载。人类在 UI 里读未信任技能原文
  是信任决策的输入（先看了才决定信不信）；它不进任何 run 的语言空间、不记 loads。
- `load` 工具（模型面）过门 + 记 loads。UI 的「注入会话」动作（P2）走前端
  `RunOptions.messages` 用户通道——那是**用户显式动作**，等价于用户自己 `@path`，
  不经过模型信任门（用户自己就是信任权威）。
- 三条通道（工具 load / 用户 @path / UI 注入）各自可追溯：loads 记录 / 注入消息
  持久化 / 前端原文不改。审计时能回答「这段技能内容是谁、在哪一轮、以什么哈希放进
  上下文的」。

## 10. 设置域：contributes.settings 与 q-settings 协同

### 10.1 声明（manifest `contributes.settings`，JSON Schema 子集）

```jsonc
"settings": {
  "enabled":        { "type": "boolean", "default": true,
                      "description": "Master switch; false = install registers nothing" },
  "sources":        { "type": "object",
                      "default": { "project": true, "user": true, "library": true },
                      "description": "Which skill roots to scan (project / user / library)" },
  "watch":          { "type": "boolean", "default": true,
                      "description": "Watch skill roots and rebuild the index (300ms debounce)" },
  "trust_default":  { "type": "string", "enum": ["ask", "deny"], "default": "ask",
                      "description": "Policy for untrusted / changed skill content on load" },
  "max_load_bytes": { "type": "number", "default": 65536,
                      "description": "Cap for skill content returned by load / get" },
  "allowed_roots":  { "type": "array",
                      "description": "Inherited from basic-tools when unset (assembly merge)" },
  "deny_paths":     { "type": "array",
                      "description": "Inherited from basic-tools; library root appended by assembly" }
}
```

- 每个键都带 `description` / `default`——q-settings 编辑器渲染表单的最小元数据齐备。
- `sources` 是 object：宿主 `typeMatches` 只校验到 object 层，内部形状由插件
  `parseSkillsConfig` 自校验（doc-subscription `parseDocSubscriptionConfig` 同款），
  非法形状 fail-closed 回缺省 + 告警，不半应用。
- P2/P3 additive 键（`pinned`、`import_policy` 等）届时追加，不改既有键语义。

### 10.2 下发与生效链路（现态机制，零新缝）

```text
config.yaml plugins[].config ──▶ buildPluginConfigMap（装配层合并 basic-tools 边界）
   ──▶ install(host, {config})（in-process，install 期解析一次）
   ──▶ filterSettings（child 路径同款校验：未声明键丢弃 / 类型不符 plugin_config_invalid）
```

- **生效语义 = 重启**：in-process 插件 install 期钉死 config（§3.2）；改设置后
  `plugins.reload` 返回 `restart_required: true`，UI 必须如实显示「需要重启」
  （catalog `restartRequired` 字段已有）。**不谎报热应用**。
- 例外澄清：技能**文件**变化（watch / rescan）不是设置变化，随时生效，不需要重启。

### 10.3 与 q-settings 的接口约定（协同契约）

q-settings 设计 VSCode 式设置编辑器（本工作树尚未见其产出，以下按既有机制推导，
落地前需与 q-settings 对齐）：

1. **渲染数据源**：编辑器从 `plugins.list` catalog 取 `manifest.contributes.settings`
   （schema 子集）渲染插件设置分组——skills 插件保证声明齐备（type / description /
   default / enum），**不需要 q-settings 为 skills 写任何专用代码**。
2. **写路径（关键依赖）**：现态 `config.set` 白名单不含 `plugins[]`（plugin-embed
   契约 §1 明示）。约定首选方案：**q-settings 把 `plugins.<name>.config.<key>` 纳入
   `config.set` 白名单**，写入前按 manifest schema 校验（复用 filterSettings 口径）。
   这是通用能力，所有插件受益，skills 不做 per-plugin 写 RPC。
   - 若 q-settings 一期不落该白名单：skills 设置一期**只读展示 + 手改 config.yaml**
     （与现态 trust_ui 确认同款过渡），UI 显示「编辑 config.yaml 后重启生效」指引。
     **不做** `settings_set` 私有 RPC 绕道（避免第二写路径与白名单纪律冲突）。
3. **i18n**：现态 `PluginSettingSchema.description` 是单字符串。若 q-settings 引入
   `descriptionKey`（走 contributes.i18n），skills additive 跟进；一期 description
   用英文单语（与 model-registry rpc description 同口径），中文文案进 UI 层 i18n。
4. **重启提示**：编辑器对 `restartRequired` 插件的设置项挂「需要重启」徽标；
   保存成功 ≠ 已生效，文案不得暗示热应用。
5. **边界**：q-settings 拥有「编辑器 + config.set 白名单扩展」；skills 拥有
   「schema 声明 + install 期解析 + 生效语义」。两侧经 catalog / config.yaml 两个
   既有真相源交汇，不新增共享状态。

### 10.4 开放问题（留给实现期 / q-settings 对齐）

- 热应用细化：若未来装配层给 in-process 插件注入 live config getter（assembly
  `getConfig` 已有），`trust_default` / `max_load_bytes` 这类纯行为键可调用期读活值、
  免重启；`sources` / `watch` 涉及 watcher 生命周期，仍走重启。本期不承诺，
  避免与「install 期钉死」先例口径分裂。
- `sources` 内部形状的 schema 表达（宿主子集只到 type: object）：是否推动
  q-settings / manifest 子集扩展 `properties`，由 q-settings 统一决策，skills 跟随。

## 11. Manifest 示例

`plugins/context/skills/package.json` 的 `vessel` 块（照 model-registry 先例：
**无 `entry` ⇒ in-process capabilityManifest**；`side: "both"`；ui.embed 双产线）：

```jsonc
{
  "name": "@vessel-agent/plugin-skills",
  "version": "0.57.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "web"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build:ui": "tsc -p tsconfig.web.json --noEmit && vite build && vite build --config vite.config.embed.ts"
  },
  "dependencies": {
    "@vessel-agent/basic-tools": "workspace:*",   // buildPathBoundary（media 先例）
    "@vessel-agent/core": "workspace:*",          // 仅 import type（运行时值导入禁令）
    "@vessel-agent/plugin-sdk": "workspace:*",
    "@vessel-agent/plugin-ui": "workspace:*",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "vessel": {
    "id": "skills",
    "name": "Skills",
    "version": "0.1.0",
    "engines": { "vessel": ">=0.56.0 <1.0.0" },
    "description": "Managed skill library: scan / index / trust-gated load + library UI",
    "side": "both",
    "ui": {
      "dir": "web",
      "embed": {
        "entry": "embed/index.mjs",
        "css": "embed/index.css",
        "runtime": { "react": "^19", "sdk": "^1" }
      }
    },
    "activationEvents": ["onPage:skills"],
    "contributes": {
      "i18n": {
        "en": { "nav.skills": "Skills", "trust.trusted": "Trusted", "trust.stale": "Changed",
                "trust.unknown": "Untrusted", "trust.revoked": "Revoked" },
        "zh-CN": { "nav.skills": "技能库", "trust.trusted": "已信任", "trust.stale": "已变更",
                   "trust.unknown": "未信任", "trust.revoked": "已撤销" }
      },
      "pages": [
        { "id": "skills", "title": "Skills", "titleKey": "nav.skills",
          "nav": "integrations", "icon": "tools", "order": 60,
          "entry": "skills.html", "component": "SkillsView" }
      ],
      "rpc": [
        { "name": "list",      "description": "Skill index page (metadata only)", "permission": "read" },
        { "name": "get",       "description": "Skill detail: entry + content + trust (human view)", "permission": "read" },
        { "name": "search",    "description": "Substring search over name/description/tags/id", "permission": "read" },
        { "name": "loads",     "description": "Per-session skill load records", "permission": "read" },
        { "name": "rescan",    "description": "Rebuild the index from all enabled roots", "permission": "write" },
        { "name": "trust_set", "description": "Pin current hash (trust) or revoke trust for a skill", "permission": "write" },
        { "name": "import",    "description": "Import a local skill into the collected library (P2)", "permission": "write" }
      ],
      "settings": { /* §10.1 逐字 */ },
      "events": []
    },
    "permissions": {
      "fs": ["data-dir"],
      "net": [],
      "process": false,
      "secrets": false,
      "events": [],
      "rpc": []
    }
  }
}
```

校验要点（fail-closed，`plugin_manifest_invalid`）：

- 无 `entry` + 有 `vessel` 清单 ⇒ loader 判 in-process（`capabilityManifest`）；
  `src/index.ts` 默认导出仍是标准 `Plugin`（`install` + `rpc`），装配层
  `registerInProcessPlugin` 登记贡献面。**声明 rpc 必须给 handler**（§1.1）。
- `pages[].entry` 必填（iframe 回退）；`component` 具名导出形状合法；
  `nav: "integrations"` 在内置分组闭集内；`icon: "tools"` 在白名单内。
- `contributes.events ⊆ permissions.events`（双空，平凡成立）。
- `ui.embed` 有 `ui.dir`；entry `.mjs` / css `.css`；runtime semver range 可解析。
- 模块纪律：core 只 `import type`；需要的常量（如工具名 / 来源枚举）插件内自声明
  字面量、用 core 类型钉住（plugins.md 反向纪律）。

## 12. 分期实施计划

> 宪法口径：每期验收 = `bun run build`（typecheck + biome ci）+ 构建产物读数 +
> **用户手动行为验证**；零测试 / 探针 / 临时进程。实现另开 `feat/skills-*` 分支，
> 本设计分支不写代码。每期独立可交付、additive、可回滚（install scope 回滚机制既有）。

### P1 · MVP（索引 + 工具 + 只读 UI + 信任门）

| # | 交付 | 落点 |
|---|---|---|
| 1 | 类型 + frontmatter 子集解析 + 扫描器（三根、containment、上限） | `plugins/context/skills/src/{types,frontmatter,scanner}.ts` |
| 2 | 索引 / 信任 / 加载态 store（原子写、单写队列） | `src/store.ts` |
| 3 | `skills` 工具（list/search/load + 信任门 checkPermission） | `src/tool.ts` |
| 4 | `Plugin.rpc`：list / get / search / loads / rescan / trust_set | `src/rpc.ts` |
| 5 | install 面（config 解析、enabled 开关、watch、默认导出） | `src/{config,index}.ts` |
| 6 | 装配接线：默认集 + buildPluginConfigMap 边界继承 + library deny_paths 追加 + registerInProcessPlugin | `src/bootstrap.ts`、`src/plugin-config.ts`（既有缝，小改） |
| 7 | embed UI：SkillsView（列表/详情/信任面板/加载状态）+ iframe 回退 + 双产线 | `web-src/`、`web/`（产物入库） |
| 8 | manifest（§11）+ settings 声明（§10.1） | `package.json` |
| 9 | 文档：plugins.md / extensions.md / tools.md 增补 skills 条目；tools.md「被判死」表加一行澄清（skills-loader ≠ 本插件） | `docs/architecture/**` |

P1 验收（用户手动）：放一个 md 进 `~/.vessel/skills/` → UI 列表可见；模型
`skills list/search/load` 三动作可用；首次 load 弹 ask、批准后 trusted；改文件再
load → stale 重新 ask；revoke 后 deny；`read` library 文件被 deny_paths 拒。

### P2 · 收集与人类工作流

- `import` RPC + UI 导入（本地路径 → library，containment / 大小 / 冲突校验）。
- 「注入会话」UI 动作（走前端 `RunOptions.messages` 用户通道，§9.5）。
- run-detail panel（`slot: "run-detail"`）：本 run 加载的技能清单。
- q-settings 写路径落地后：设置编辑器可写 + 重启提示联调（§10.3）。
- 信任重确认体验：stale diff 摘要（旧锁哈希 vs 新哈希 + 变更行数），降低盲目确认。
- id 稳定性细化：rename 检测（同哈希不同 id → 提示迁移信任锁，不自动迁）。

### P3 · 生态与自动化（每项先过设计评审 / 必要时 ADR）

- marketplace 技能包对接（registry 下载 → 校验和 → library 落地；`net` 权限
  additive 申请；签名验证随 plugin-registry P4）。
- pinned / 自动加载：BeforeLlm 尾部消息注入（doc-subscription 先例），**opt-in、
  按会话、有 token 预算上限**；因 ADR-011 已 superseded，落地前以新 ADR 确认
  「hook 注入技能」与现态纪律的关系。
- 语义检索（provider embedding，opt-in 设置键；不默认开，token / 成本税）。
- 团队 / workspace 级技能共享（随 topology 的 Workspace 数据目录落地）。

### 明确不做（任何期）

- core 新增接口 / 事件 / SkillHost；第二注册表；技能内容执行；CRUD 模型工具；
  跨节点复制协议；OS 沙箱承诺。

## 13. 风险与开放问题

| # | 风险 | 等级 | 缓解 / 决策 |
|---|---|---|---|
| R1 | **收集库为空时工具面退化**：用户只有本地两个目录时，list/search/load 接近可被 read+bash 替代，重蹈 skills-loader 覆辙 | 高 | 承重墙是 library + 信任门（§2.2）；P2 import / P3 marketplace 必须跟上，否则工具面应降级为 opt-in（设置 `enabled` 缺省值届时重审）。设计评审显式检查点 |
| R2 | 提示注入残余：trusted 技能内容仍可诱导模型 | 高 | 门只保证完整性 + 来源确认（§9.1 T1）；来源标注包裹让模型可辨；不承诺内容审查。文档明示「信任 = 人的判断」 |
| R3 | bash 绕过 library 隔离 | 中 | deny_paths 挡工具面顺手读；bash 非沙箱是现态边界（ADR-055），措辞不夸大（§9.3） |
| R4 | watch 不可靠（WSL / 网络盘 / 编辑器原子写） | 中 | load 期重读 + 校哈希兜底正确性；rescan 手动兜底时效；UI 显示 generatedAt |
| R5 | in-process 无热重载，设置改动要重启 | 中 | 如实 `restart_required` + UI 徽标（§10.2）；live-config 细化留开放问题（§10.4） |
| R6 | q-settings 写路径未落地 → 设置一期只读 | 中 | 过渡 = 手改 config.yaml（trust_ui 同款先例）；不做私有写 RPC 绕道（§10.3） |
| R7 | token 税评审：新增一个工具 = 每轮固定税 | 中 | 单工具三动作、描述只写事实、渐进披露（§6.1）；落地 PR 附 description/schema 字数读数供评审 |
| R8 | id = 路径 ⇒ rename 即新 id，信任锁孤儿化 | 低 | 语义明示「rename = 新技能需重新确认」；P2 做同哈希迁移提示，不自动迁（自动迁 = 掉包攻击面） |
| R9 | frontmatter 生态分歧（Claude Code 键集更大） | 低 | 只认四键子集，未知键忽略 + partial 标注；不追全量 YAML spec |
| R10 | 多节点各自一份库，无同步 | 低 | 非目标（§2.3）；团队共享走仓库提交 / marketplace，不做复制协议 |
| R11 | 索引 / 信任文件损坏 | 低 | index 可整文件重建（派生缓存）；trust.json 损坏 → fail-closed 全部 unknown（重新确认），不静默放行 |

### 开放问题（实现前需裁决）

1. **R1 的 opt-in 阈值**：library 来源未落地前，`skills` 工具是否默认注册？
   倾向：P1 默认注册（project/user 根的发现 + 信任门已有独立价值），但 P2 import
   若延期，重审缺省 `enabled`。
2. **markdown 渲染组件**：plugin-ui 是否已有 embed 可达的 markdown 渲染器？
   没有则 P1 `<pre>` 降级是否可接受（§8.3）。
3. **q-settings schema 扩展**（`descriptionKey` / object `properties`）的时间表
   与归属（§10.4）——skills 跟随，不先行发明。
4. **loads 保留策略**：会话删除时 loads/<sessionId>.json 是否随会话清理钩子回收？
   现态无会话删除广播，倾向 P1 留文件 + 上限 200 条自滚动，P2 对齐会话生命周期。