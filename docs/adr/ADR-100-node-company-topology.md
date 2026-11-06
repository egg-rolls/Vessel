---
adr: 100
title: 节点即公司：Platform / Workspace / Team / Agent 拓扑
status: proposed
date: 2026-11-06
related: [49, 93, 99]
tags: [topology, company, workspace, platform, team, plugin, hub, ownership, tenancy]
---

## ADR-100：节点即公司：Platform / Workspace / Team / Agent 拓扑

- **上下文**：插件扩展面开始承载 Hub 级能力，但归属口径不清：现有文档把节点、
  workspace、tenant、Team 混在同一层（`workspace` 同时是 Team 的目录键、隔离单位
  是 tenant、Hub 跑在 gateway 内）。产品方向已经明确：未来不是「多个客户共用一个
  应用」，而是「一个用户把多个应用的资源串起来」。需要先冻结部署与归属模型，
  再谈 Hub 抽取、插件作用域与访问控制；否则每个切片都会重新解释一遍。

- **决策**：
  1. **一个 Vessel 实例 = 一家公司。** 一个数据目录、一个 gateway、一组插件与
     connections。不做多客户 SaaS：不做客户级隔离、计费或账号体系；多公司靠多 node。
  2. **三个轴分开判定归属。** 代码 / 包（谁发布维护）、运行时实例（进程服务几家公司）、
     状态 / 凭据（数据与 token 属于谁）。同一实体可以「代码平台级、实例公司级」；
     Gateway 即 Platform code + Company runtime + Company state。
  3. **四层作用域。** Platform（社区共享的 Vessel 本体、内置插件、Hub / registry /
     marketplace 后端）→ Workspace / Company（插件安装与启用、connections、团队、
     配置、数据目录）→ Team（部门、成员、工具策略、协作范围）→ Agent / Session
     （员工身份、一次工作 / 对话）。
  4. **插件默认 Workspace 级。** Workspace plugin 增强一家公司，安装、启用、配置与
     数据按 workspace 隔离；只有服务所有公司的基础设施（Hub、registry、marketplace
     后端（若做）等）才是 Platform plugin。一个包可同时声明两种归属，但按归属分别
     安装与启用。当前 registry 是静态 GitHub、没有市场服务端；后端的 Platform 归属
     是未来项。
  5. **Team 是使用范围，不是所有权。** Team 不安装、不拥有插件；部门专用能力仍是
     公司级安装，用 tool policy 限定谁能用。Agent / Session 只组合当前公司启用的能力。
  6. **不区分 guest。** 拿到 node 访问权的人就是 owner；有 token 即全权，插件不做
     owner / guest 可见性过滤。这里的 owner 指 node 访问者，不是 Agent 记录的
     `owner_id`。未来若做只读访客，另开角色模型。
  7. **Hub 属于 Platform。** Hub 本体是服务多家公司的独立服务；UI / CLI / 配置页
     可以是可选的薄 Platform plugin surface，但 Hub runtime 不寄生在某家公司的
     gateway，也不做成 Workspace plugin。Federation 数据面仍是节点直连。
  8. **tenant 的现状与目标。** 当前 `tenant` 是真实的运行时隔离机制（ADR-049），
     一个 gateway 可服务多个 tenant；目标态是一实例一公司，tenant 与公司的收敛
     方式待裁决。本 ADR 不 supersede ADR-049。0.48 仍保留 default-tenant 403
     作为单公司 / 遗留安全边界；移除与否待收敛，不在 0.48 改已冻结契约。

- **备选**：
  - (a) 多客户 SaaS / 客户级租户与计费——与「一个用户串联自己的应用」的产品方向相反，
    且会把插件、连接、凭据都变成租户资产。
  - (b) 插件按 Team 安装与授权——Team 是部门，会迫使同一公司内复制安装、配置与数据；
    公司级安装 + Team policy 更简单。
  - (c) Hub 做成 Workspace plugin / 寄生在某个 gateway——邮局属于一家公司，跨公司
    生命周期、token 与数据目录都不干净。
  - (d) 引入 guest / 只读访客可见性过滤——当前没有角色模型，token 即全权；提前加过滤
    会制造第二套权限语义。
  - (e) 保留现状（workspace = Team 目录键、Hub 在 gateway 内）——无法解释插件归属
    与 Hub 的公司间语义，后续每个切片继续返工。
  均不取 (a)–(e)；选择上述决策。

- **后果**：
  - 文档口径统一：新增 [topology](../architecture/topology.md)，插件归属、Hub 边界、
    访问模型各只有一个家；`plugins.md`、`PRODUCT.md` 只留指针。
  - 插件安装与启用按 Workspace 计算；catalog 的 `scope`（发现来源）与新归属级不是
    同一概念，文档必须分开写。
  - Hub 抽取为 Platform 服务成为独立计划；节点侧保留最小 hub client。
  - 代价：现有 `workspace` / `tenant` / `owner` 三个词都有历史用法，需要逐处
    加限定语；tenant 与「一实例一公司」的收敛方式仍需裁决。
  - 不改变插件加载机制、Hub 协议、Federation 数据面或已有 RPC 方法。

- **关联**：[ADR-049](ADR-049-multi-tenant-isolation.md) ·
  [ADR-093](ADR-093-hub-control-plane.md) ·
  [ADR-099](ADR-099-plugin-contribution-surfaces-and-trust.md)。
  实现口径见 [topology](../architecture/topology.md)。
