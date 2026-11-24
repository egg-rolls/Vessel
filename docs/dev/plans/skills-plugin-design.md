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
  memberBody / readSideMasker；`Plugin.rpc`经装配层 `registerInProcessPlugin`
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

（待扩充）

## 3. 插件形态选择：in-process（理由与备选）

（待扩充）

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