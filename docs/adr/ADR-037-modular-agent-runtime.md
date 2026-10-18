---
adr: 37
title: Vessel as a modular agent runtime
status: accepted
date: null
related: [3, 4, 12, 15, 17, 30, 34, 36, 38]
---

## ADR-037：Vessel as a modular agent runtime

- **上下文**：0.1.0 把 Vessel 定位为「自组织 Agent Harness」——单 agent loop + 9 接口 + 两个插槽。0.1.0 已证明 loop 可用，但多 agent 诉求被塞进两处边缘实现：`delegate_task` 在工具 handler 内每次新建子 `AgentRuntime`；`@vessel/team` 插件内自带一个 `InProcessRuntimeHost`。二者都没有成员注册表、调度、统一取消、跨进程传输，也无法被 gateway / 其它 shell 复用。继续沿这条路走，等于把平台能力固化在插件里，core 仍是单 agent，外壳各自发明多 agent 协议。
- **决策**：
  1. **定位**：Vessel 是可嵌入的**多 agent 平台 runtime**；TUI / CLI / Web / Gateway 是参考 harness 外壳，只消费 runtime 的 SDK 与事件。
  2. **分层**：`Contracts ← Kernel ← Modules ← SDK ← Shells`；`Plugins` 只依赖 Contracts / 公开 API，经 `PluginHost` 在运行期 install。依赖方向单向。
  3. **Kernel 最小集**：`RuntimeHost` / `AgentHandle` / `RunHandle` / `Scheduler` / `EventBus` / `Cancellation` / `Limits`。`AgentRuntime` 继续是**单 agent loop**；Host 负责注册、生命周期、调度与消息，不重写 loop。
  4. **Module ≠ Plugin**：Module 是编译期/构造期边界（provider / context / session / policy / transport / observability），一个 port 一个实现；Plugin 仍是唯一运行期扩展机制。**禁止 `ModuleHost` / `ModuleRegistry` / 第二套扩展机制。**
  5. **包内模块优先**：0.2 只在 `@vessel/core` 内做 ports & adapters + subpath exports，不立即拆成多个 `@vessel/*` 包；待依赖图稳定后再按需拆包。
  6. **Transport 是 port**：0.2 只做 in-process 与 loopback HTTP 实现；loopback 只绑 `127.0.0.1` 并复用 gateway v1 的 token 鉴权，禁止 `0.0.0.0`。远程、TLS、跨机器调度仍是非目标。
  7. **兼容性**：9 接口、`AgentRuntime` 公开面、`RunOptions` / `RunEvent`、事件名、插件机制全部冻结；0.2 只做加法与内部替换，不删除公开 API。`RunHandle.status()` 用方法/getter 暴露可变状态；`CancellationScope.child()` 必须随父取消自动中止。
  8. **非目标**：durable execution / workflow / evals / MCP / 多租户 / 远程监听 / TLS / 跨机器调度 / 单二进制主分发。
  9. **依赖方向必须自动检查**：层级规则不能只写在文档里；0.2 用 biome `noRestrictedImports` 或等价脚本在 CI 中阻断 `types → 实现`、模块间内部 import、core → shell 的反向依赖。
  10. **事件字段命名**：core TypeScript 内部用 camelCase（`agentId`），gateway JSON 用 snake_case（`agent_id`），映射只在 gateway 边界做一次；事件名保持开放字符串，不新增常量/枚举。
- **备选**：(a) 把 `delegate_task` 放大成 team——没有身份、生命周期、调度、inbox、取消，所有能力塞进一个工具，工具面与平台面混淆；(b) 立即拆出 `@vessel/runtime` 包——依赖图尚未稳定，拆包带来路径/版本/构建 churn，且不增加运行时能力；(c) 引入 `ModuleHost` 动态模块——与 `PluginHost` 形成第二套扩展机制，违反 ADR-004/034 的单一扩展原则；(d) 重写 `AgentRuntime`——ADR-015/034 已证明 loop 正确，问题在宿主层，不在循环。均不取。
- **后果**：
  - 多 agent 成为一等能力：成员有 id、状态、inbox、run 句柄与取消；team / delegate / gateway 共用同一 Host 与 Scheduler。
  - core 公开面增加 Kernel 类型与 subpath exports，但 `AgentRuntime` 与 9 接口不变；0.2 不删除任何公开 API。
  - 代价：Host / Scheduler / Transport 带来生命周期、并发、背压与测试复杂度；0.2 仍为 pre-1.0，本机 / loopback 之外不做承诺。
  - `delegate_task` 改为 Host 上的临时成员，工具名与语义保持不变；`@vessel/team` 的 `InProcessRuntimeHost` 降级为兼容适配层并在 0.3 移除。
- **对 ADR-015 的关系（局部 supersede）**：ADR-015 的决策 3 中有一条「A2A / 多 agent / 树搜索 → 工具（handler 内部 spawn 子 runtime）」。本 ADR **只取代这一条中「多 agent 只能/应当在工具 handler 内 spawn」作为唯一实现方式的表述**；该 bullet 作为 0.1 的过渡解释仍成立。**ADR-015 的主结论——「不需要 `LoopStrategy` 抽象，工具调用循环保持通用」——继续有效，本 ADR 不废止 ADR-015。**
- **关联**：局部 supersede ADR-015 的上述单条；保持 ADR-003（插件不进构造函数）、ADR-004（唯一扩展机制）、ADR-012/017（core 小）、ADR-030（事件名开放）、ADR-034（极简核心）、ADR-036（gateway 传输边界）、ADR-038（reasoning 不回传事件）。架构事实见 `ARCHITECTURE.md`；0.2 规划见其「0.2 目标架构（planned，未发布）」小节。
