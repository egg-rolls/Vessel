---
title: Hub 控制面与跨节点 Federation
kind: current
triggers: [hub, federation, control plane, data plane, node, peer, pairing, join code, token, directory, attention, allowlist, hop, cross-node]
paths: [src/hub/**, src/hub-*.ts, src/federation-*.ts, packages/serve/src/gateway/**]
---

# Hub 控制面与跨节点 Federation

> 两个独立平面：**hub 控制面**只传目录与指针元数据；**federation 数据面**只做节点到节点的 team 投递。hub 不代理正文、不替节点授权（ADR-093 / ADR-094）。

<a id="planes"></a>

## 两个平面

| 平面 | 方向 | 传什么 | 不传什么 |
|---|---|---|---|
| hub 控制面 | hub ↔ node 常驻 WSS | 节点 / team / 成员目录、在线状态、指针 | 消息正文、事件、工具结果 |
| federation 数据面 | node → node | 按 team / principal 寻址的一条消息 | agent id 列表、权限、transcript |

节点仍是唯一执行与授权权威；hub 不判断 team 成员资格、不批准权限、不代表用户身份。浏览器渲染所需数据由客户端直连节点拉取。

<a id="hub"></a>

## Hub 进程与连接方向

- hub 是 **app 层独立前台进程**，实现在 `src/hub/`，不新增可发布 package，也不进 `packages/core` / `packages/agent` / `packages/serve`。节点侧只提供 `/v1/hub/control` 与 `/v1/hub/pair`。
- 两个方向共用协议 `vessel.hub/1`，帧内 `dialer: 'hub' | 'node'` 标明发起方：
  - hub → node：hub 作为 WSS 客户端拨号节点的 `/v1/hub/control`。
  - node → hub：节点主动拨号 `${hub.url}/v1/hub/node-control`，因此节点只需监听回环，不必开放入站端口。
- 本地 hub：gateway 在 `<dataDir>/hub` 启动同进程目录服务，只监听回环；`hub.autoStart` 缺省 true，显式 false 关闭，不自动 join / 配对。
- 同一 pairing 只保留一条活动连接，新连接接管；hub 重启时 node-dial 记录不拨号，等待节点重连。

<a id="pairing"></a>

## 配对、join code 与 token

- `POST /v1/hub/pair`：节点生成一次性配对码，hub 用码换 `view` + `exchange` token；码只存 `sha256`、默认 5 分钟、消费时先原子写 `used_at`。
- `vessel hub join-code`：hub 生成一次性 join code（默认 300 秒、只存 hash），节点用 `vessel hub join <hub-url> --code` 换 hub 签发的 `node` token。
- scope：`view | exchange | control | admin | node`，映射到既有 `read / write / admin` 方法与白名单，不新增 role 字符串。`exchange` 只能调用 `auth.exchange`，且结果固定 `control`。
- token 绑定 `hub_id`（node token 还绑定 `node_id` / `tenant_id`）；首帧身份或绑定不一致一律 4401 关闭，防止 A hub 的 token 被 B hub 复用。
- 明文只在签发响应出现一次；hub 侧凭据走 `SecretStore`，节点侧只存 `sha256(token)`。文件回退适配器只有 `hub.allow_file_secrets: true` 才启用，否则 fail-closed。

<a id="directory"></a>

## 目录、指针与快照

- 目录主键 `pairing_id = node_id:tenant_id`；`<hubDataDir>/registry.json` 以 `0600` 原子写（250ms debounce）。写入前限制 `teams ≤ 500`、`agents ≤ 2000`，超限截断并置 `truncated: true`。
- 快照新旧按 `(incarnation, revision)`：`incarnation` 变化无条件接受并重置 revision；同一代际下 `revision <= lastRevision` 丢弃。`incarnation` 只用于比较与事件去重，不与 `node_id` 混用。
- 节点离线时保留最后一次目录快照，只读展示；hub 不伪造在线状态。
- 指针 payload 固定 `{node_id, team_id, request_id?, reason, ts}`，只在线推送、不持久化、不排队；消费方按 `ts` 超过 60 秒丢弃。`data_plane: 'direct' | 'unreachable'` 由 `public_url ?? url` 派生。

<a id="federation"></a>

## Federation：team ↔ team

- 入站 `POST /v1/federation/messages` 注册在 gateway `principalForRequest` 之前；出站由 `vessel federation post|peers` 一次性进程发起。不复用 legacy `/v1/team/*`、`RemoteTransport` 或 hub 控制面。
- envelope 为 `vessel.federation/1`，字段固定 `protocol / message_id / conversation_id / from / to / content / ts / hop / request_id?`；`from` / `to` 为 `{node_id, team_id, principal}`，严格解析，缺字段即 `federation_invalid`。
- 地址 `<principal>@<node_id>:<team_id>`：`principal` 是目标 Team 的 present 成员名或保留字 `human`；它是名字，不是 agent id。
- 默认开启（`federation.enabled` 缺省 true，显式 false 关闭），但没有 peer 就没有对端。`federation.peers[]` 显式声明 `(nodeId, teamId)` / `url` / `tokenEnv` / `direction` / `caFile?` / `localTeamId?`；无通配、无自动发现，明文 `token` 被 validator 拒绝。
- 每个 peer 一份 bearer token，内存定长比较；gateway 用户 token / hub node token / peer token 三套命名空间不交叉。非回环 `url` 必须 https。

<a id="federation-guards"></a>

## Federation 的失败顺序与边界

- 入站顺序 fail closed：enabled → peer bearer → direction → `from` 等于 peer → 严格解析 → `to.team_id` 等于本机映射 → `hop <= maxHops` → 自指环 → 本机 Team 存在 → 去重 → 写日志。拒绝无副作用，只发一次不带正文 / token 的 `federation.rejected`。
- 落点是 Team 日志：`from` 为 `federation:<node>:<team>`，`to / mentions = []`。最多 1 个 run：`human` 只写日志；其他名字必须命中唯一 present 非 private 成员，否则 404 且零写入。
- `hop` 是节点间跨越次数，首次为 1；`maxHops` 1..16 缺省 4。v1 没有自动中继，hop 恒为 1，只作防御上界。
- 去重键 `(from.node_id, from.team_id, message_id)`，进程内 LRU 1024；不声称跨重启 exactly-once。入站限流 `federation.rateLimitPerMinute` 1..600（缺省 60），超限 429、零写入。
- 事件：`federation.received` / `federation.rejected`，payload 不带正文；出站一次性进程不发事件，结果走 CLI JSON / exit code。

## 不做什么

- hub 不做消息正文 / 事件 / 工具结果代理，不存 transcript，不做 mTLS、多 hub 联邦或节点自动发现。
- federation 不做 worker / agent 跨节点寻址、远程 spawn / close / rotate / resume / fork、自动中继 / mesh、离线队列 / 重试、跨重启 exactly-once、多 tenant、权限审批人。
- federation 是传输面，不新增 canonical RPC 方法；跨节点 attention 由运行 agent 的节点本地应答。

## 指针

- [gateway.md](gateway.md#remote) · [gateway-rpc.md](gateway-rpc.md) · [assembly.md](assembly.md#assembly) · [REMOTE.md](../operations/REMOTE.md) · [CONFIG.md](../operations/CONFIG.md)
- 决策：[ADR-093](../adr/ADR-093-hub-control-plane.md) · [ADR-094](../adr/ADR-094-federation-team-to-team.md) · [ADR-052](../adr/ADR-052-cross-node-transport.md) · [ADR-067](../adr/ADR-067-cross-node-dedup-keys.md) · [ADR-053](../adr/ADR-053-remote-security-baseline.md)
