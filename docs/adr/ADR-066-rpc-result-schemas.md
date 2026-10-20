---
adr: 66
title: canonical RPC 方法的结果 schema 与可选校验
status: accepted
date: 2026-10-20
related: [36, 48, 59]
tags: [rpc, schema, validation, protocol]
---

## ADR-066：canonical RPC 方法的结果 schema 与可选校验

- **上下文**：统一 RPC 方法表（ADR-048）为每个 canonical 方法声明了 `params_schema`，但返回值只有 TypeScript 类型，没有运行时契约。客户端（Web 控制台、远程 transport、第三方集成）只能靠文档和试错推断形状；handler 重构时把 `null`、缺字段或类型漂移带进结果，测试不一定覆盖，错误会推迟到消费端。另一方面，协议版本常量此前在不同入口各自硬编码 `1`，HTTP、WS、`hello`、team 与 transport 之间可能出现不一致。core / serve 已有的校验器只支持 JSON Schema 的一个子集，直接引入完整 schema 库会破坏依赖边界。

- **决策**：
  1. **全量声明结果 schema**。37 个 canonical 方法（36 个 domain 方法 + `events.subscribe`）全部补 `result_schema`；跨方法复用的片段集中在 `packages/serve/src/gateway/methods/schemas.ts`（`runStatusSchema`、`sessionInfoSchema`、`usageSchema` 等），domain 模块只引用，不各写一份。
  2. **只使用现有校验器支持的子集**：`object` / `array` / `string` / `number` / `integer` / `boolean`，以及 `required` / `properties` / `items` / `enum` / `minLength` / `maxLength` / `minimum` / `maximum`。不引入 `oneOf` / `$ref` / `additionalProperties`，因此不新增依赖。
  3. **运行时校验默认关闭**。`VESSEL_VALIDATE_RESULTS=1` 时在 RPC 分发层校验结果；违反 schema 的方法返回 `internal`，details 只含 `method` 与 `path`（不回显结果值，避免泄漏与放大 payload），同时发布开放事件 `rpc.result_invalid`。未设置该变量时行为与此前完全一致，不增加生产热路径开销。
  4. **协议版本单源**。`packages/serve/src/protocol.ts` 的 `PROTOCOL_VERSION` 是唯一常量，`RPC_VERSION` 作为兼容别名导出；HTTP / WS / `hello` / team / transport 全部引用它，不得再写字面量 `1`。
  5. **无法精确表达的可选字段不声明类型**。`sessions.list` 的 `branch` / `tenant_id` / `ended_at` / `end_reason` 在真实 session 文件中可能是 `null` 或缺失，而校验器不支持 nullable / union；这四个字段写成空 schema（任意值通过），其余字段与 `required` 仍受约束。

- **备选**：(a) 生产默认开启校验——结果错误会直接变成 `internal`，把一次可选断言升级为可用性风险，且增加每次调用的开销；(b) 引入 Ajv 等完整 JSON Schema 实现——依赖变重，且 serve 的校验器与其它入口会出现两套语义；(c) 只写文档不写 schema——无法在 CI 中防止漂移；(d) 为 nullable 增加 union 支持——扩大校验器与协议表面，收益只覆盖四个可选字段，暂不做。均不取。

- **后果**：CI 的 `quality` 与 `cross-platform` 在 Test step 设置 `VESSEL_VALIDATE_RESULTS=1`，方法结果一旦偏离 schema 会直接红；运行时默认不校验，客户端的既有行为不变。`runs.get` 的结果同时可能是内存 `RunStatus` 或 durable checkpoint，schema 只能取两者的宽松超集，属于已知限制。校验是开发期契约，不是安全边界——权限与 tenant 归属仍由 handler 与 auth 层保证。

- **关联**：ADR-036（Gateway 协议 v1）、ADR-048（统一 RPC 方法表）、ADR-059（方法表按域拆分）；`packages/serve/src/gateway/methods/schemas.ts`、`packages/serve/src/gateway/methods/*.ts`、`packages/serve/src/rpc.ts`、`packages/serve/src/protocol.ts`、`packages/serve/src/gateway.ts`。
