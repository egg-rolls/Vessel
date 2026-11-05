---
adr: 99
title: Plugin 贡献面分层与信任模型
status: accepted
date: 2026-11-05
related: [3, 4, 34, 37, 65]
tags: [plugin, extension, contribution, trust, manifest, lifecycle, isolation]
---

## ADR-099：Plugin 贡献面分层与信任模型

- **上下文**：ADR-004 / ADR-034 / ADR-037 确立了「单一运行期扩展机制」：插件经
  `Plugin` 在 `PluginHost` 上注册，禁止第二套构造期注册表。此后文档把这条原则读成
  「插件只能贡献 tool / provider / guardrail / hook」。这个读法对**能力**成立，对
  **体验**不成立：页面、命令、设置、RPC、事件订阅、面板都由 harness 宿主持有，core
  不感知，却常被误判为「第二套扩展机制」。同时，外部插件将进入用户机器，旧的
  「默认加载、完整进程权限」信任模型不足以描述新契约。

- **决策**：
  1. **保留单一 plugin 机制**：只有一个 plugin loader、清单（manifest）与安装生命周期；
     所有 plugin 经同一条发现与安装路径进入，`PluginHost` 仍是 core 唯一的运行期注册入口。
     禁止在 core 新增第二套构造期注册表（`ModuleHost` / `ModuleRegistry`）。
  2. **贡献面可以扩展，且不属于第二套扩展机制**：`pages` / `commands` / `settings` /
     `rpc` / `events` / `panels` 是 harness 层（`packages/serve`、`apps/web`、CLI 装配层）
     的宿主贡献点，由宿主在安装时收集与路由；core 不新增接口、不感知这些词。新增贡献点
     必须先改清单契约，不能由 plugin 自行发明。
  3. **能力插件与体验插件是同一机制下的两种投放形态**：
     - **能力插件**（capability）：in-process，`install(host)` 往 `PluginHost` 注册
       tool / provider / guardrail / hook；需要直接调用 core 的注册方法。
     - **体验插件**（experience）：独立子进程，只经换行分隔的 JSON-RPC / DTO 与宿主通信，
       提供页面、RPC、事件与面板；UI 运行在独立 origin 的 iframe 中，经 postMessage
       与宿主桥通信。
     - 两者同名「plugin」、同一份清单与发现规则；差别只在执行位置与贡献面，不在扩展机制。
  4. **子进程是隔离与生命周期边界，不是安全沙箱**：它隔离崩溃、约束 cwd / env、负责回收
     与重启，并让宿主在每次调用检查声明能力；它不承诺 OS 级隔离，也不限制子进程拥有的
     用户权限。文档与安装提示不得把它说成沙箱。
  5. **信任模型**：内置插件（随 release 发布）默认可信；外部插件（`~/.vessel/plugins/`、
     项目 `.vessel/plugins/`）默认不可信，安装时必须展示其声明的 `permissions`
     （`fs` / `net` / `process` / `secrets` / `events` / `rpc`），未声明的能力默认拒绝；
     显式 `plugins:` 条目视为用户对信任的确认。插件不得改写权限判定、路径边界、密钥脱敏、
     协议 / 事件语义或数据完整性。
  6. **不提供任意 patch**：不做 monkey-patch / 运行时改写 core 或其它 plugin。扩展点不够时
     先加贡献点，逃生门不是 v1 的选项。
  7. **失败即拒绝、安装 ≠ 激活**：清单解析或校验失败一律 fail-closed，不加载代码；
     `activationEvents` 命中才启动；禁用 / 卸载必须与激活对称，并清理路由、订阅、子进程
     与定时器。

- **备选**：
  - (a) 维持「插件只能贡献四类能力」的字面读法——体验面只能焊进主 Web 包，插件生态失去
    意义，且与「放文件夹即扩展」的产品方向冲突。
  - (b) 为体验面在 core 新建 `ModuleHost` / page registry——这正是 ADR-034 / ADR-037
    禁止的第二套构造期注册表。
  - (c) 把子进程宣传为安全沙箱——能力边界实际由宿主 API 与安装时授权保证，不是 OS 隔离；
    错误承诺会让用户对恶意插件放松警惕。
  - (d) 把所有能力插件也迁出进程——需要 tool proxy，v1 无收益且扩大故障面；将来若做，
    另立契约。
  均不取。

- **后果**：
  - 「唯一扩展机制」的准确含义是「唯一的 plugin 加载 / 清单 / 生命周期」，不是「唯一的
    贡献面」；文档与红线按此措辞。
  - 体验插件获得与能力插件一致的安装、信任与生命周期语义；宿主承担贡献点收集、RPC 路由、
    事件转发与 iframe 桥接。
  - 代价：宿主多一层贡献点目录与子进程管理；体验插件的调试成本高于 in-process 能力插件。
  - 外部插件的安装期授权成为用户可见的产品面；未声明的能力默认拒绝，不会静默降级。

- **与 ADR-004 / ADR-034 / ADR-037 的关系**：
  - **澄清并局部修正措辞，不 supersede**：三者的核心意图——单一运行期扩展机制、core 只放
    领域无关运行时、禁止 `ModuleHost` / `ModuleRegistry`——全部保留。
  - ADR-004 的「tool / provider / guardrail / hook 经 `Plugin.install(host)` 注册」仍描述
    **能力插件**；本 ADR 补充同一机制下的**体验插件**与其 harness 贡献面，不新增 core
    注册入口。
  - ADR-034 的「插件发现收敛为一套」与 ADR-037 的「Module ≠ Plugin」继续有效；本 ADR
    只把「唯一」的作用域从「贡献面」纠正为「加载 / 清单 / 生命周期」。
  - 生命周期细节见 [ADR-065](ADR-065-plugin-lifecycle-v2.md)；插件不进 runtime 构造函数见
    [ADR-003](ADR-003-no-plugin-in-runtime-constructor.md)。

- **关联**：[ADR-003](ADR-003-no-plugin-in-runtime-constructor.md) ·
  [ADR-004](ADR-004-plugin-pluginhost-extension.md) ·
  [ADR-034](ADR-034-minimal-refactor-unfreeze-core.md) ·
  [ADR-037](ADR-037-modular-agent-runtime.md) ·
  [ADR-065](ADR-065-plugin-lifecycle-v2.md)。
