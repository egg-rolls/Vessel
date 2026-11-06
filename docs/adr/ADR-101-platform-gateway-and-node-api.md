---
adr: 101
title: Platform Gateway 与 Node API 分离
status: accepted
date: 2026-11-06
related: [100, 93, 99]
tags: [gateway, node, platform, console, webui, tui, auth, cli, topology]
---

## ADR-101：Platform Gateway 与 Node API 分离

- **上下文**：当前 `serve` 一个进程同时承担两件事：本 node 的 `/v1/rpc`、WS、SSE
  与 runtime 宿主，以及 `apps/web/dist` 静态宿主。WebUI 加载后又会用 per-node
  token 直连其它 node。结果是：
  - 数据权威仍在各 node，但 UI 从某家公司实例加载，产品上看起来“公司托管了平台 UI”；
  - CLI `vessel gateway ...` 起的是 node API，不是平台入口；
  - “Gateway 是公司级还是平台级”无法自洽回答。
  ADR-100 已固定 Node = 公司、插件默认 Workspace；本 ADR 修正 Gateway 角色。

- **决策**：
  1. **Gateway = 平台级入口。** 负责 WebUI/TUI 宿主、node registry、平台用户认证、
     `vessel gateway` CLI、Hub/远端连接；不拥有任何公司的 runtime 数据。
  2. **Node = 公司级运行时。** 当前 `serve` 的 runtime/数据/RPC 面收敛为 Node API；
     node 拥有 agents / teams / sessions / plugins / connections / data。
  3. **本地模式：Gateway 托管多个本地 Node。** 初期可同进程 co-locate；node 有独立
     数据目录与 Node API。后续需要分布式时，Node 改为独立进程，Gateway 通过
     Node API URL/token 连接，不改变产品语义。
  4. **WebUI 宿主迁移到 Gateway。** Node API 不再提供 WebUI 静态宿主；WebUI 由
     Gateway 提供。多 node 视图由 Gateway 的 node registry + 各 Node API 数据构成。
  5. **CLI 分开。** `vessel gateway ...` 管理平台 Gateway；`vessel node ...` 管理
     公司 Node。迁移期保留旧命令别名，收口时删除。
  6. **双 token。** 平台用户 token 认证 Gateway（node registry/UI/平台操作）；
     per-node token 认证 Node API（公司数据）。Gateway 维护 node registry 与
     token 分发；WebUI 同时持有两类 token（平台 token + 各 node token）。
  7. **迁移顺序。** 先拆 Node API 与 Platform Gateway（保持本地 co-locate），
     再把 UI 宿主直接迁到 Gateway；之后做本地多 node，最后做分布式 Node 进程。

- **后果**：
  - ADR-100 的 “Gateway = Platform code + Company runtime + Company state” 被本
    ADR 细化：Gateway 是 Platform runtime；Node API 才是 Company runtime。
  - `topology.md` 的四层/实体映射、`gateway.md` 的现态说明需要同步。
  - 迁移期 `vessel gateway start` 仍可启动当前组合进程（兼容别名），但新 CLI 语义
    以 `vessel gateway`（平台）/ `vessel node`（公司）为准。
  - 需要独立契约与探针：node registry、平台 token、node token、UI 宿主、local
    多 node、分布式连接。
  - 不改变 Node 内部 runtime、插件加载、Hub/Federation 协议。

- **备选**：
  - (a) Gateway 继续做 Node API，另建 Console 服务——名字仍不直观，平台入口没有
    独立归属；不取。
  - (b) 维持双角色（现状）——省事但无法解释 Gateway 的公司/平台边界；不取。
  - (c) 一开始就做分布式 Node 进程——本地单用户不需要，迁移风险高；先 co-locate。

- **关联**：[ADR-100](ADR-100-node-company-topology.md)（Node=公司/插件归属）·
  [ADR-093](ADR-093-hub-control-plane.md)（Hub 平台服务）·
  [ADR-099](ADR-099-plugin-contribution-surfaces-and-trust.md)。
  目标拓扑见 [topology](../architecture/topology.md)。
