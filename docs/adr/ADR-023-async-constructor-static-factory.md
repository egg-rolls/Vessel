---
adr: 23
title: AgentRuntime 构造函数异步反模式修复——改用静态工厂方法
status: accepted
date: null
related: [17, 18]
---

## ADR-023：AgentRuntime 构造函数异步反模式修复——改用静态工厂方法

- **上下文**：`AgentRuntime` 构造函数中启动 `installPlugins()` 但不 await，将 Promise 存为 `_readyPromise`，暴露 `ready` getter 让用户手动 await。这是异步构造反模式——构造函数同步返回但对象处于半初始化状态，忘记 `await runtime.ready` 则插件未安装就开始 `run()`，行为未定义。
- **决策**：属 ADR-017(2b)「修复 loop 级 bug」。构造改为 `private`，只做纯同步初始化；新增 `static async create(opts): Promise<AgentRuntime>` 工厂方法，在返回前 await 完插件安装；删除 `_readyPromise` 和 `ready` getter。所有调用方从 `new AgentRuntime(opts)` + `await runtime.ready` 改为 `await AgentRuntime.create(opts)`。此变更不改变 tool-calling loop 行为、不改变 Plugin/Hook/Guardrail 扩展机制、不改变 Core 接口契约——仅修复对象生命周期的一致性。
- **论证为何无法用 Plugin/Hook/Guardrail/事件表示**：构造函数是 TypeScript 语言级约束，无法通过插件扩展改变构造语义。静态工厂方法是唯一能在构造后、返回前执行异步初始化的标准模式。Plugin 在构造完成后才有机会注册，无法决定对象何时暴露给外部。
- **备选**：(a) 保持 async-in-constructor + `ready`——已证明反模式，P0 issue (#17)。(b) 让构造函数接受临时 Promise 并在外部等待——不改变现状。均不取。
- **后果**：用户拿到 runtime 时插件已就绪，无需额外 await。构造函数私有化防止直接 `new`。静态工厂方法成为标准实例化路径。Core 冻结不变——本 ADR 属 bug 修复不冲击冻结状态。
- **关联**：ADR-017(2b)、ADR-018；[issue #17](https://github.com/egg-rolls/Vessel/issues/17)。
