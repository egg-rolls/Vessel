---
title: 部署拓扑：公司 / 平台 / 团队
kind: target
triggers: [topology, company, workspace, platform, team, plugin scope, ownership, tenant, hub, node, connection, session, guest, owner]
paths: [src/hub/**, src/plugin-loader.ts, packages/serve/src/plugin-host/**, plugins/**, docs/architecture/topology.md]
---

# 部署拓扑：公司 / 平台 / 团队

> **目标 / 迁移态，非现态。** 决策见 [ADR-100](../adr/ADR-100-node-company-topology.md)（proposed）；
> 插件扩展面见 [plugins](plugins.md)。**共享侧文档是唯一真源**；个人侧 design / contract /
> plan 仅作过程记录，不作为实现依据，也不从本文反向链接。
> **一句话：一个 Vessel 实例 = 一家公司；运行在哪家公司就属于哪家公司，服务所有公司才属于 Platform。**

## 三个轴

判断归属先拆三个轴，不要用一个词同时回答三个问题。

| 轴 | 问什么 | 例子 |
|---|---|---|
| 代码 / 包 | 谁发布、谁维护？ | Vessel 本体、内置插件、Hub 服务 |
| 运行时实例 | 这个进程服务几家公司？ | 每家一个 gateway；Hub 服务多家 |
| 状态 / 凭据 | 数据、token、连接属于谁？ | 公司的 connection；Hub 的目录 |

同一实体可以「代码平台级、实例公司级」：**Gateway = Platform code + Company runtime + Company state**。

## 四层

| 层 | 内容 | 谁拥有 | 复用 |
|---|---|---|---|
| **Platform** | Vessel 更新、内置插件、Hub / registry / marketplace 后端（若做）等共享基础设施 | 社区 | 所有公司共享 |
| **Workspace / Company** | 插件安装与启用、connections、团队、配置、数据目录 | owner | 公司内复用 |
| **Team** | 部门、成员、工具策略、协作范围 | owner / 部门负责人 | 使用公司能力，不拥有插件 |
| **Agent / Session** | 员工身份、一次工作 / 对话 | owner | 引用公司能力与连接 |

- 多公司 = 多 Workspace / Node，不是同一 node 里的多个客户 tenant。
- Team 是公司内的使用范围，不是所有权级别；部门专用能力仍是公司安装 + Team policy 限制。
- Agent / Session 只组合当前公司启用的能力。
- `tenant` 是运行时的数据隔离标签（[ADR-049](../adr/ADR-049-multi-tenant-isolation.md)），不是客户 / owner 层；与「一实例一公司」的收敛待裁决（见 ADR-100）。

## 实体映射

| 实体 | 代码 / 包 | 运行时 | 状态 / 凭据 |
|---|---|---|---|
| **Gateway** | Platform | 每公司一个 | 公司 |
| **Runtime / Agent / Team / Session** | Platform | 公司内 | 公司 |
| **Plugin** | 作者发布，默认 Workspace 安装 | 公司内（Platform plugin 例外） | 公司；Platform plugin 属社区 |
| **Connection** | 连接器插件 | 公司内 | 公司（per workspace，不复制 token） |
| **Hub / Federation** | Platform | Hub 服务多家公司；Federation 节点直连 | Hub 目录 / token 属社区；正文不落 Hub |

- **Connection** 是公司级外部软件关系（OAuth / token / 配置，如 GitHub、Gmail、文件、MCP、渠道）；不要与 `ConnectionProvider`（模型连接）混淆。

## 插件归属

| 类型 | 归属 | 例子 | 生命周期 |
|---|---|---|---|
| **Workspace plugin** | 一家公司 | 工具、视觉、管理页、org pack、连接器 | 安装在 workspace；per-workspace 配置与数据 |
| **Platform plugin** | 社区 / 平台 | Hub、registry、marketplace 后端（若做）、内置能力 | 随 Vessel 发布或独立服务；所有公司可用 |

- 默认是 Workspace plugin；只有**服务所有公司的基础设施**才是 Platform plugin。
- 只服务一家公司 → Workspace；公司之间 / 社区基础设施 → Platform。
- 一个包可以同时声明两种归属，但安装、启用、数据按归属分开。
- 安装根（`<workspace>/.vessel/plugins` 还是用户级共享包 + per-workspace 启用）仍待裁决；本文只固定归属级，不预判目录布局。
- Team 不安装、不拥有插件；它只通过 tool policy 决定谁能用哪些能力。
- catalog 的 `scope` 字段表示发现来源（builtin/user/project/node_modules），不是本节的归属级，不要混用。

## 访问模型

- 不区分 guest：拿到 node 访问权的人就是 owner。
- 有 token = 全权；插件不做 owner / guest 可见性过滤。
- 这里的 owner 指 node 访问者，不是 Agent 记录里的 `owner_id` 或成员归属。
- 安全含义：token 等于公司钥匙；撤销只能换 token。未来若做只读访客，另开角色模型。

## 复用机制

1. **Package vs instance**：插件包可缓存 / 共享；每个 workspace 有自己的启用状态、配置、数据。
2. **Connection per workspace**：外部关系是公司级；员工 / 部门引用，不复制 token。
3. **Capability per workspace**：插件注册的 tool / command 对公司内 agent 可用；Team 用 policy 限制。
4. **One backend, many surfaces**：Web / CLI / HTTP / TUI 共用同一 `plugin.<id>.<method>`。
5. **UI reuse**：`@vessel-agent/plugin-ui` 的 PageScaffold / TableToolbar / DataTable / tokens。

## Hub 与 Federation

- **Hub** = 公司间通讯录 / 邮局前台：目录、配对、发现、token；只传元数据。
- **Federation** = 信件投递：节点到节点直接转发，正文不经 Hub。
- Hub 服务多家公司，属于 Platform；公司可以独立运行，需要跨公司协作时才接入。
- 形态：**Platform 独立服务 + 可选薄 Platform plugin surface**（UI / CLI / 配置页）；
  不是 Workspace plugin，不把 Hub runtime 寄生在某家公司的 gateway。
- 实现见 [federation-hub](federation-hub.md)；抽取立项后另开 ADR / 计划，本文只固定边界。

## 非目标

- 不做多客户 SaaS（客户级隔离 / 计费 / 账号体系）；多公司靠多 node。
- 不做 per-team 插件所有权（Team 只是使用范围）。
- 不做 guest 可见性过滤；插件不按访客裁剪。
- 不在本拓扑里改 Hub 协议、Federation 数据面或插件加载机制。

## 指针

- [ADR-100](../adr/ADR-100-node-company-topology.md)（proposed）· [ADR-099](../adr/ADR-099-plugin-contribution-surfaces-and-trust.md)
- 相关模块：[plugins](plugins.md) · [extensions](extensions.md) · [gateway](gateway.md) · [federation-hub](federation-hub.md) · [config](config.md)
- **唯一真源**：本文 + ADR-100 固定归属模型；实现收敛后把 `kind` 转 current、ADR 转
  accepted。个人侧只保留过程记录，不复制规则。
