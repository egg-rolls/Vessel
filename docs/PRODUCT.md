# Vessel 产品设计：分布式蜂巢

> 本文是产品概念模型，不是功能清单：节点、Hub、Team、Agent 如何组成一个蜂巢，
> 三类信息素如何在它们之间流动，以及哪些已经实现、哪些只是方向。
> 当前能力边界见 [README](../README.md#能力边界)，技术契约见
> [architecture/INDEX](architecture/INDEX.md)。

## 1. 定位

Vessel 不试图做一个「更聪明的单体 Agent」。它给 Agent 一个可扩展的组织形态：

- **一个节点就是一个蜂巢。** 节点自己执行、自己授权、自己持久化。
- **一个工作目录就是一个 Team。** Team 是蜂群，成员有名字、可见性、共享日志与预算。
- **Agent 是个体蜂。** 身份持久，身体（Body）可替换；主 Agent 可以组建和收缩蜂群。
- **Hub 让蜂巢彼此可见。** 它只交换目录与指针，不替节点做事。
- **信息素决定谁看到什么、对谁说话、何时被唤醒。** 环境、定向、扩散三层分开建模。

产品判断标准只有一句：**一个新节点接入后，其他节点能不能看见它、找到对的人、
把任务递过去，并让结果回到原处。**

## 2. 设计公理

1. **节点是权威。** 执行、权限、身份、数据都在节点上；Hub 不代理正文，也不替节点授权。
2. **目录与正文分离。** 看见 ≠ 有权操作。Hub 只回答「谁在哪」，消息由节点之间直接投递。
3. **工作目录是 Team 的边界。** `workspace` 是 Team 的唯一分组键；换目录就是换蜂群。
4. **身份与身体分离。** Agent 是持久身份，Body 是 session + engine；`rotate` 换身体，不换身份。
5. **名字是路由，不是 id。** 跨节点地址用 `<principal>@<node_id>:<team_id>`；principal 是 Team
   内的名字，wire 上不暴露 agent id。
6. **少工具，多组合。** `bash` / `read` / `edit` 是通用原语；能用它们组合出来的能力，
   不再单开一个工具。
7. **信息素分层。** 环境、定向、扩散三种信号分开建模；上下文只装当前 run 需要的那一层。

## 3. 概念模型

| 产品概念 | 代码里的东西 | 一句话职责 |
| --- | --- | --- |
| 节点 / 蜂巢 | 一次 Vessel 进程，`node.json` 里的 `node_id` + 数据目录 | 执行、授权、持久化；跨节点通信的端点 |
| Hub | `vessel hub` 目录服务，`vessel.hub/1` | 配对、节点 / Team / 成员目录、在线状态、指针；不传正文 |
| Team / 蜂群 | `workspace` + `team_id` + roster + 日志 + policy | 一个工作目录的成员、共享日志、预算、可见性 |
| Agent / 个体蜂 | 持久身份 + 可替换 Body | 干活、发消息、写日志、轮换身体 |
| 地址 | `<principal>@<node_id>:<team_id>` | 跨节点定向投递；`human` 指向该 Team 的人类 |
| Federation | `vessel.federation/1`，节点到节点 | 一条消息一个收件人；静态 peer allowlist |

```text
Hub（只做目录与指针）
 ├─ node-a（蜂巢）── Team lab/ ── alice, bob
 └─ node-b（蜂巢）── Team ops/ ── carol

alice@node-a:lab  ── federation ──▶  carol@node-b:ops
        ▲                                   │
        └────────────── reply ──────────────┘
```

- Hub 让 `node-a` 看见 `node-b` 有 `ops`、`ops` 里有 `carol`；但消息不经过 Hub。
- Hub 不自动发现节点：节点用配对码加入，或由 hub 主动拨号纳入。
- 浏览器、CLI、另一个节点要操作时，仍然直连节点自己的 gateway。
- 这是刻意的权限边界：**看见不等于有权操作。**

## 4. 一个任务如何流动

1. 人在 `node-a` 的 `lab` 目录启动 Vessel；`lab` 是已声明的 Team（`workspace` 匹配当前目录）。
2. 人类用 `agents.create`（`kind: peer|contractor` + `team_id`）把 `alice`、`bob` 招进 Team；root owner 也可用 `agent(hire)` 招自己的 contractor。每个成员有独立 Body 和会话。
3. 成员用 `read` / `bash` / `edit` 读取环境信息素：文档、代码、系统状态、命令输出。
4. 成员用 `agent(send)` 定向同步；`agent(post)` 只写 Team 日志，不唤醒任何人。
5. 需要 `node-b` 的 `carol` 时，`alice` 发 `carol@node-b:ops`；接收侧只唤醒 `carol` 一个，不广播。
6. 结果写回各自 Team 日志；人从 TUI / Web 时间线看到过程与终态。

当前版本里，第 2、4、5 步都是**显式派发**：谁做什么由主 Agent 或人决定。
「自组织」目前指的是这些原语组合出来的工作方式，不是内建的自治规划器或任务市场。

## 5. 三层信息素

Vessel 不把上下文当成一条不断膨胀的聊天记录，而是持续把三类信号折进语言空间。

| 层 | 是什么 | 现在怎么流动 | 状态 |
| --- | --- | --- | --- |
| **环境信息素** | 文档、代码、系统状态、命令输出 | `read` / `bash` / `edit`、`@路径` 引用、skills、`AGENTS.md` | 已实现 |
| **定向信息素** | 用户对话、工具调用、指名消息 | 当前 run 的 messages、`agent(send/post)`、Team 日志、federation 地址 | 已实现 |
| **扩散信息素** | 微小状态变化：成员加入/离开、run/工具事件；文件变化尚未观察 | 事件流、presence、Hub 目录、Web 时间线 | 部分：可观测，Agent 还不能订阅 |

### 5.1 环境信息素

「存在即事实」。Agent 每次主动读取：文件、命令输出、项目约定、技能文档。
特点是**按需**——不读就不在上下文里；读了就是当前版本，没有缓存副本。

### 5.2 定向信息素

「谁对谁说」。用户的一轮输入、工具的调用与结果、成员之间的 `send`、跨节点地址消息。
特点是**有明确收发者**：只进当前 run 或目标 Agent，不广播。

### 5.3 扩散信息素

「变化本身」。成员上线/离线、run 开始/结束、工具调用、Hub 目录更新。
当前这些变化进入事件流，人和 Web 控制台能看见；**Agent 侧没有订阅接口**，
只能在下一次 run 里重新读取环境来发现变化。

### 5.4 订阅：下一步

目标行为：Agent 用工具订阅文件、目录或事件；变化在**下一个 run 开始前**以 diff 注入上下文，
只带上次看过之后的改动。它解决的是「文件更新一次，Agent 就整读一遍，甚至读好几遍」的问题。

产品约束（方向，尚未实现）：

- 复用现有消息注入通道，不把订阅概念塞进 core；core 仍然只认 `RunOptions.messages`。
- 不做轮询循环；变化由宿主侧观察，在 run 边界投递。
- 有大小上限与去重游标；订阅失败不能让 run 失败。
- 跨节点订阅另算，不在第一版。

当前状态：**没有 `subscribe` 工具、没有 diff 注入、没有已读游标。** Agent 只能按需重读。

## 6. 跨节点：看见与说话分开

| 平面 | 传什么 | 不传什么 | 谁负责 |
| --- | --- | --- | --- |
| **Hub 控制面** | 节点 / Team / 成员目录、在线状态、指针 | 正文、事件、工具结果、transcript | Hub |
| **Federation 数据面** | 一条按 Team / principal 寻址的消息 | roster、权限、transcript | 发送节点与接收节点 |

- 地址是 `<principal>@<node_id>:<team_id>`；`principal` 是目标 Team 的 present 成员名或保留字 `human`。
- 一条报文恰好一个收件人；没有 mentions 数组、没有广播。
- 信任是**节点级**：peer token 认证节点，principal 由发送节点自证；不是用户级密码学身份。
- 当前只有静态 peer allowlist；没有自动发现、mesh、中继、离线队列，hop 恒为 1（只作防御上界）。
- 入站最多产生一个 run；`human` 只写日志，不唤醒 Agent。

## 7. 与 MCP / A2A 的关系

- **MCP 是工具接入。** Vessel 把 MCP 当插件，把外部工具注册进 `PluginHost`；
  MCP 不提供 Agent / Team / 节点身份。
- **A2A 是 Agent 互操作协议。** Vessel 的节点、Team、principal、权限与预算是一等公民，
  所以跨节点对话不需要先把自己包装成一个 A2A 适配层。
- 但「更原生」指的是**身份与路由原生**，不是协议兼容：当前 wire 是自有的
  `vessel.federation/1`，**没有实现 A2A 协议**，也不承诺与 A2A 客户端互通。

## 8. 现状与方向

| 能力 | 状态 |
| --- | --- |
| 单节点 Agent 生命周期（`create` / `hire` / `send` / `close` / `list` / `rotate` / `post`） | 已实现 |
| Team 声明后按工作目录匹配，带 roster / 日志 / 预算 / 可见性 | 已实现 |
| Hub 配对、目录、在线状态、指针 | 已实现 |
| 跨节点按地址投递与回复（静态 peer） | 已实现 |
| Agent 主动发现远端节点 / Team / 成员 | 部分：CLI `federation team-info`（opt-in）、Hub 目录或 `bash`；无专用发现工具 |
| 成员 Agent 再派生 Agent（蜂群增长） | 已实现：peer / contractor 两条路径、close 人类审批、每 Team present ≤20、Team 冻结；无 TTL / spawn 预算 / 跨 Team 派生 |
| 跨节点 spawn / close / rotate / resume | 未实现 |
| 扩散信息素订阅（文件 / 目录 / 事件 diff） | 未实现（方向） |
| 自动发现 / mesh / 中继 / 离线队列 / 跨重启 exactly-once | 未实现（暂不承诺） |
| A2A 协议兼容 | 未实现 |
| 自治调度（自动分工、任务市场） | 未实现（当前是显式派发） |

## 9. 非目标

- 不做更大的 core、不做更多能力工具；能用 `bash` + 模型组合出来的，不新增抽象。
- 不让 Hub 代理消息、保存 transcript 或替节点做权限决定。
- 不做无身份广播（v1 明确一条消息一个收件人）。
- 不做「万能协议适配层」；MCP / A2A 按需接，不为了兼容而兼容。
- 不在没有明确需求时做 mDNS、服务网格、mTLS、多 tenant federation。
- 不做持久化消息队列与跨重启 exactly-once；当前队列在内存，重启丢失未处理消息。
- 不先做自治规划器 / 市场；先把身份、路由、订阅这些原语做稳。

### 为什么先不做

- **自动发现**：没有信任模型之前，自动发现等于把节点暴露给未知 peer；先用配对码显式建立信任。
- **广播**：一条消息唤醒 N 个成员会产生 N 个 run 和 N 个权限请求；v1 只做单点寻址。
- **自治调度**：没有可靠的任务分解与验收之前，自治规划器只会放大错误；先让原语可观察、可回放。

## 10. 指针

- [README](../README.md)：是什么、怎么跑、能力边界
- [architecture/INDEX](architecture/INDEX.md)：分层、运行时、gateway
- [federation-hub](architecture/federation-hub.md)：Hub 控制面与 federation 数据面
- [member-team](architecture/member-team.md)：AgentService、Body、Team、dispatch
- [REMOTE](operations/REMOTE.md)：证书、两机配置、独立前端
