---
adr: 65
title: 插件生命周期 v2（init / dispose / 安装回滚）
status: accepted
date: 2026-10-20
related: [4, 33, 54]
tags: [plugins, lifecycle, dispose, runtime]
---

## ADR-065：插件生命周期 v2（init / dispose / 安装回滚）

- **上下文**：插件是唯一运行期扩展机制（ADR-004）。v1 只有 `install()`：它既负责注册，又被迫承担初始化，且没有任何回收钩子。由此产生三个问题：(a) 插件无法在“全部插件都已注册”之后做跨插件初始化（例如按最终方法表建索引），只能依赖安装顺序的偶然性；(b) 长驻的 gateway / REPL 以及反复创建 runtime 的测试没有释放入口，连接、定时器与文件句柄会泄漏；(c) `install()` 中途失败时，已经注册的 tool / provider / guardrail / hook 留在 host 上，runtime 构造失败但 host 处于半注册状态。core 需要一条与注册解耦、可失败隔离、可回收的生命周期链，且不能改变 `install()` 的 fail-fast 语义。

- **决策**：
  1. **初始化后置**。新增可选 `Plugin.init?(ctx: { host: PluginHost })`；所有插件的 `install()` 成功之后，按安装顺序依次调用。单个 `init` 抛错只发布 `plugin.init.failed`（`{ name, error }`），继续调用后续插件；初始化异常不得让 runtime 构造失败。
  2. **回收逆序且 best-effort**。新增可选 `Plugin.dispose?()`；`AgentRuntime.dispose()` 按**逆安装顺序**调用，异常只发布 `plugin.dispose.failed`（`{ name, error }`），不向外抛，随后关闭 session。`dispose()` 用 Promise 缓存保证幂等：重复调用返回同一个 Promise，插件与 session 只释放一次。
  3. **安装作用域与回滚**。`PluginHost.beginPluginInstall?()` 返回 `{ commit, rollback }`。`AgentRuntime` 在每次 `install()` 前后建立作用域：成功 `commit()`，失败 `rollback()` 清掉该插件本次的全部注册，再发布 `plugin.failed` 并把原始异常重新抛出。安装阶段仍是 fail-fast——`Plugin.init` 的隔离只发生在“全部安装成功之后”。
  4. **装载事件**。安装成功发布 `plugin.loaded`（`{ name, version? }`），便于观测实际生效的插件集合。
  5. **装配层负责工厂插件**。MCP client 与 workflow engine 这类工厂式插件由装配层显式关闭（并各自实现幂等 `dispose()`）；bootstrap / CLI / serve 的 shutdown 链必须 `await` runtime 释放，不得提前退出。

- **备选**：(a) 让 `install()` 继续兼任初始化——无法表达“全部安装完成之后”，且跨插件依赖仍是隐式的；(b) 只加 `dispose()` 不加 `init()`——回收有了，但初始化时序问题未解；(c) 初始化失败也 fail-fast——一个可选插件的初始化失败会拖垮整个 runtime，与 ADR-054 的插件异常隔离原则冲突；(d) 安装失败不回滚、由调用方重建 host——registry 是共享对象，半注册状态会污染同进程的后续 runtime。均不取。

- **后果**：插件 API 纯增量（两个可选方法 + 一个可选 host 能力），现有插件不改也能运行；新增插件若在 `install()` 中创建不可回收资源，必须实现 `dispose()`，否则长驻进程会泄漏。`init()` 的调用顺序等于安装顺序，插件不得假设“后续插件已安装”；需要全局视图时应订阅 `plugin.loaded` 或在 `init` 中读取 host 的最终注册表（此时全部安装已完成）。直接使用 `PluginHost` 的 host 模式绕过 `AgentRuntime` 的生命周期编排，是已知限制（见 `docs/versions/0.9.0.md`）。

- **关联**：ADR-004（Plugin + PluginHost 扩展机制）、ADR-033（依赖倒置与编排外推）、ADR-054（RunExecution 与插件异常隔离）；`packages/core/src/types/plugin.ts`、`packages/core/src/runtime/plugin-host.ts`、`packages/core/src/runtime/agent-runtime.ts`、`src/bootstrap.ts`、`src/factory-plugins.ts`、`plugins/mcp/client`、`plugins/workflow/engine`。
