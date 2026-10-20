---
adr: 59
title: Gateway 方法表按域拆分为模块
status: accepted
date: 2026-10-20
related: [36, 48, 49, 57]
tags: [gateway, rpc, refactor, modules]
---

## ADR-059：Gateway 方法表按域拆分为模块

- **上下文**：0.8.1 的第一阶段拆分把 auth / frames / sse / static 移出了 `gateway.ts`，但方法表本身仍集中在一个文件里：约 4000 行中大半是各 domain 的方法定义与 handler 闭包。新增一个 RPC 方法要在巨型数组中间插入，review 时难以看出一次改动落在哪个域；不同域的依赖（tenant、session、run、trace、workflow、evals）也全部挤在 `startGateway` 的闭包里，边界不可见。

- **决策**：
  1. **按 domain 建模块**。`packages/serve/src/gateway/methods/` 下每个文件导出一个或多个 `createXxxMethods(deps): RpcMethodDefinition[]`：`config.ts`（`createConfigMethods` / `createToolMethods` / `createPluginsMethods`）、`sessions.ts`、`runs.ts`、`observability.ts`（`createEventsMethods` / `createMetricsMethods` / `createTraceMethods`）、`tenants.ts`、`interactions.ts`、`workflow.ts`、`evals.ts`、`mcp.ts`、`feishu.ts`。每个 `create` 只接收该域真正需要的依赖（对应的 `XxxMethodsDeps` 接口），不传整个 gateway 上下文。
  2. **`gateway.ts` 只保留装配与路由**。选项校验、缓冲 / 连接状态、HTTP / WS 路由、SSE、鉴权顺序仍在 gateway；方法表用 `...createXxxMethods(deps)` 展开，顺序保持拆分前的短路 / 覆盖语义，最后 `defineMethods(rpcMethods)`。
  3. **共享小工具抽到 `common.ts`**：`tenantParamSchema`、`stringParam`、`checkpointBelongsToTenant` 作为纯函数 / 常量复用，避免每个 domain 各写一份参数校验与租户归属判断。
  4. **`MethodError` 独立成文件**（`gateway/errors.ts`）。拆分后 handler 与 gateway 的 legacy 错误处理必须仍然命中同一个 `instanceof MethodError`，所以类不能随方法一起搬进各模块。
  5. **保留依赖连接状态的方法**。`events.subscribe` 仍写在 `gateway.ts` 的数组里：它要读连接类型（ws / http）、事件缓冲游标与 tenant 作用域，属于连接状态而不是纯方法。
  6. **对外不变**。方法名、`params_schema`、返回形状、协议错误码与鉴权顺序全部保持不变；没有新增或删除方法，也没有改动 wire 行为。

- **备选**：(a) 继续单文件、只按段落加注释——文件仍在增长，依赖边界依旧不可见；(b) 拆成每个方法一个文件——文件数暴涨，同一域的参数 schema 与错误处理反而重复；(c) 用类 + 继承组织方法——引入新的对象生命周期，且与现有 `RpcMethodDefinition[]` 表驱动模型不一致；(d) 把 `events.subscribe` 也搬走——需要把连接状态一并传入，等于把路由语义复制进方法模块。均不取。

- **后果**：新增方法落到对应 domain 文件，review 范围与依赖清单同时变小。代价是方法表不再能在一个屏幕内读完，要看全貌需沿着 `gateway.ts` 的组装顺序跳转；domain 之间共享的逻辑必须显式放进 `common.ts`，否则会重复。拆分只动文件组织，不改变任何协议或运行时行为。

- **关联**：ADR-036（Gateway 协议 v1）、ADR-048（统一 RPC 方法表）、ADR-049（多租户隔离与单 gateway 多 tenant）、ADR-057（配置单一 resolver，0.8.1 的第一阶段拆分）；`packages/serve/src/gateway.ts`、`packages/serve/src/gateway/errors.ts`、`packages/serve/src/gateway/methods/*.ts`。
