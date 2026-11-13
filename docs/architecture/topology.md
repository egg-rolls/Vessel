---
title: 部署拓扑：公司 / 平台 / 团队
kind: current
triggers: [topology, company, workspace, platform, team, plugin scope, ownership, tenant, hub, node, connection, session, guest, owner, node registry, gateway nodes, data_locked]
paths: [src/hub/**, src/gateway/**, src/plugin-loader.ts, packages/serve/src/platform/**, packages/serve/src/plugin-host/**, plugins/**, docs/architecture/topology.md]
---

# 部署拓扑：公司 / 平台 / 团队

> **现态。** 归属模型见 [ADR-100](../adr/ADR-100-node-company-topology.md)，Gateway/Node
> 拆分见 [ADR-101](../adr/ADR-101-platform-gateway-and-node-api.md)，Hub 见
> [ADR-093](../adr/ADR-093-hub-control-plane.md)（0.49 Errata）。共享侧文档是唯一真源。
> **一句话：一个 Vessel 实例 = 一家公司；运行在哪家公司就属于哪家公司，服务所有公司才属于 Platform。**

## 现态（已实现）

| 维度 | 现态 | 证据 / 决策 |
|---|---|---|
| 实例 / 公司 | 一个 Node 服务一家公司；tenant 运行时抽象已移除 | ADR-100 / ADR-049 Errata；T0–T5 |
| Gateway / Node | Platform Gateway（8642：WebUI/TUI 宿主、node registry、平台 RPC）+ Node API（8644：公司数据）；G1 同进程双监听 | ADR-101；G1 |
| 本地多 Node | 每个本地 Node 是 Gateway 的子进程，登记在 `nodes.json`；`gateway nodes list/add/remove`、`node start --config` | G3 |
| Hub | 独立 `vessel hub start` 进程；仅 node → hub 出站；配对键为 `node_id` | ADR-093 Errata；`src/hub/**` |
| 数据布局 | 根布局 `<dataDir>/**`；`tenants/` 非空 fail-fast（`non_root_layout`）；`tenant.json` 仅内部持久 id | T2/T5 |
| 写锁 | 单公司 data-dir 写意图锁 `<dataDir>/.lock`；冲突 `data_locked`；运行时不再取写者锁 | T3/T5 |
| 访问模型 | 双 token：平台 token（Gateway）与 per-node token（Node API）；不区分 guest | ADR-100 / ADR-101 |
| 多节点视图 | UI 经 Gateway node registry + 各 Node API 聚合；Gateway 不反代 Node | G1/G3 |

## 未实现 / target

| 项 | 状态 |
|---|---|
| **G4 分布式 Node**：Node 跨机独立进程、Gateway 按 URL/token 连接 | 未排期 |
| **G5 清理**：删除 legacy `--serve` 单进程入口与迁移期兼容面 | 未排期 |
| **Workspace 插件独立包**：`<workspace>/.vessel/plugins/<id>/`，独立版本、独立更新 | 未实现；当前发现根仍是 project / user / repo / node_modules |
| **Workspace = 公司数据目录**：workspace 从 Team 目录键改为公司数据目录 | 未实现；当前 workspace 仍作 Team 的目录键 |

## 四层（归属模型）

判断归属先拆三个轴：代码 / 包（谁发布维护）、运行时实例（进程服务几家公司）、状态 / 凭据
（数据与 token 属于谁）。同一实体可以「代码平台级、实例公司级」：Platform Gateway = Platform
code + 平台 state；Node API = Platform code + Company runtime + Company state。

| 层 | 内容 | 谁拥有 | 复用 |
|---|---|---|---|
| **Platform** | Platform Gateway、WebUI/TUI 宿主、node registry、平台认证、Hub / registry / marketplace 后端（若做） | 社区 | 所有公司共享 |
| **Workspace / Company** | Node API、runtime、插件安装与启用、connections、团队、配置、数据目录 | owner | 公司内复用 |
| **Team** | 部门、成员、工具策略、协作范围 | owner / 部门负责人 | 使用公司能力，不拥有插件 |
| **Agent / Session** | 员工身份、一次工作 / 对话 | owner | 引用公司能力与连接 |

- 多公司 = 多 Node，不是同一 Node 里的多个客户 tenant；Team 是使用范围，不是所有权。
- Connection 是 workspace 级外部账号 / 资源绑定（OAuth / token / 配置），员工与部门引用，不复制 token。

## Console（Gateway 的 UI surface）

- **WebUI / TUI 由 Platform Gateway 提供宿主**；它们不是独立的归属层。
- Gateway 提供 node registry / 平台认证；UI 用平台 token 访问 Gateway，用 per-node token 访问各 Node API。
- 多节点数据来自 Gateway 的 node registry + 各 Node API；Gateway 不代理 Node 请求，也不拥有公司 runtime 数据。
- 不在某个 Node 的进程里挂平台 UI；UI 宿主属于 Gateway（legacy `--serve` 是 G5 前的兼容例外）。

## 实体映射

| 实体 | 代码 / 包 | 运行时 | 状态 / 凭据 |
|---|---|---|---|
| **Platform Gateway** | Platform | 平台级；托管多个 Node | node registry / 平台 token |
| **Node API** | Platform | 每公司一个 | 公司 runtime / 数据 / per-node token |
| **Console（WebUI/TUI）** | Platform | 由 Gateway 提供 | 平台 token + 各 Node token |
| **Runtime / Agent / Team / Session** | Platform | 公司内 | 公司 |
| **Plugin** | 作者发布，默认 Workspace 归属 | 公司内（Platform plugin 例外） | 公司；Platform plugin 属社区 |
| **Connection** | 连接器插件 | 公司内 | 公司（per workspace，不复制 token） |
| **Hub / Federation** | Platform | Hub 服务多家公司；Federation 节点直连 | Hub 目录 / token 属社区；正文不落 Hub |

## 插件归属

| 类型 | 归属 | 例子 | 生命周期 |
|---|---|---|---|
| **Workspace plugin** | 一家公司 | 工具、视觉、管理页、org pack、连接器 | 公司级安装；配置与数据属公司 |
| **Platform plugin** | 社区 / 平台 | Hub、registry、marketplace 后端（若做）、内置能力 | 随 Vessel 发布或独立服务；所有公司可用 |

- 默认是 Workspace plugin；只有**服务所有公司的基础设施**才是 Platform plugin；一个包可同时声明两种归属，按归属分别安装与启用。
- **未实现**：Workspace 插件独立包（`<workspace>/.vessel/plugins/<id>/`，独立版本 / 更新）；当前发现根是 project / user / repo / node_modules（见 [plugins](plugins.md)）。
- Team 不安装、不拥有插件；它只通过 tool policy 决定谁能用哪些能力。catalog 的 `scope` 是发现来源，不是本节的归属级。
- 当前 registry 是静态 GitHub，没有市场服务端；若未来做 marketplace 后端，才归 Platform。

## 访问模型

- **双 token**：平台用户 token 认证 Platform Gateway（node registry/UI/平台操作）；per-node token 认证 Node API（公司数据）。Gateway 维护 node registry 与 token 分发。
- 不区分 guest：拿到 node 访问权的人就是 owner；有 node token 即全权，插件不做 owner / guest 可见性过滤。
- 这里的 owner 指 node 访问者，不是 Agent 记录里的 `owner_id` 或成员归属。
- 安全含义：node token 等于公司钥匙；撤销只能换 token。未来若做只读访客，另开角色模型。

## Hub 与 Federation

- **Hub** = 公司间通讯录 / 邮局前台：目录、配对、发现、token；只传元数据，不代理正文。
- **Federation** = 信件投递：节点到节点直接转发，正文不经 Hub；授权权威在节点。
- Hub 服务多家公司，属于 Platform；公司可独立运行，需要跨公司协作时才接入。
- 现态：`vessel hub start` 独立前台进程（`src/hub/**`）；gateway 不启动本地 hub；节点只出站拨号 Hub。见 [federation-hub](federation-hub.md)。
- **重启语义**：`vessel gateway restart` = 只重启平台层（handoff）——旧 Gateway 退出时**不终止**自己 spawn 的 node/hub，新 Gateway 按 `gateway.pid` 三元组 / hub lock adopt 接管，故改平台层 / Web / registry 不打断在跑的 run；`gateway stop` 仍真停（连 node/hub），`--keep-nodes` / `--no-keep-nodes` 是显式开关。node 自身重启不在本语义内（需 marker + resume，待做）。

## 非目标

- 不做多客户 SaaS（客户级隔离 / 计费 / 账号体系）；多公司靠多 Node。
- 不做 per-team 插件所有权（Team 只是使用范围）；不做 guest 可见性过滤。
- 不在本拓扑里改 Hub 协议、Federation 数据面或插件加载机制。

## 指针

- [ADR-100](../adr/ADR-100-node-company-topology.md)（accepted）· [ADR-101](../adr/ADR-101-platform-gateway-and-node-api.md)（accepted）· [ADR-049](../adr/ADR-049-multi-tenant-isolation.md)（superseded by ADR-100）· [ADR-093](../adr/ADR-093-hub-control-plane.md)（0.49 Errata）
- 相关模块：[plugins](plugins.md) · [extensions](extensions.md) · [gateway](gateway.md) · [federation-hub](federation-hub.md) · [config](config.md)
- **唯一真源**：本文 + ADR-100 固定归属模型。个人侧只保留过程记录，不复制规则。
