---
adr: 94
title: 跨节点 federation（team ↔ team）
status: accepted
date: 2026-10-23
related: [36, 49, 50, 52, 53, 67, 91, 93]
tags: [federation, cross-node, team, allowlist, hop, tls, token]
---

## ADR-094：跨节点 federation（team ↔ team）

- **上下文**：0.19 已把节点内的 Team 日志、`@` 定向投递与 Agent / Body 模型落地；hub 只是目录，
  不代理正文（ADR-093）。跨节点协作需要一个**独立于 hub 数据面**的节点 ↔ 节点投递面，
  且只允许 team ↔ team，不能让远端按 agent id 直接唤醒本机 worker。
  旧的 `/v1/team/*` 是 agent 寻址、走 gateway principal，不能复用为 node ↔ node 凭据；
  `RemoteTransport` / `NodeRegistry` 没有生产装配。本条 ADR 记录 0.20 已实现的边界与不变量。

- **决策**：
  1. **独立 federation 平面**：新增入站 `POST /v1/federation/messages`，注册在 gateway
     `principalForRequest` 之前；出站由 `vessel federation post|peers` 一次性进程发起。
     不复用 legacy `/v1/team/*`、`RemoteTransport` 或 hub 控制面。
  2. **wire 只表达 team**：envelope 为 `vessel.federation/1`，字段固定
     `protocol / message_id / conversation_id / from{node_id,team_id} / to{node_id,team_id} /
     content / ts / hop / request_id?`。不出现 agent id、mentions、权限或 transcript。
     未知 / 缺失字段一律 `federation_invalid`（严格解析）。
  3. **默认关闭 + 显式 allowlist**：全局配置 `federation.enabled` 缺省 false；
     `federation.peers[]` 显式声明 `(nodeId, teamId)`、`url`、`tokenEnv`、`direction`
     （`in|out|both`，缺省 both）、可选 `caFile` 与 `localTeamId`。
     没有通配、没有自动发现、workspace 之外的 team 不会被报文指定。
     明文 `token` 被 validator 拒绝，只接受环境变量名 `tokenEnv`；缺失 token 的 peer 丢弃（fail closed）。
  4. **node ↔ node 凭据与 TLS**：每个 peer 一份 bearer token，节点内存定长比较；
     gateway 用户 token / hub node token 与 peer token 三套命名空间不交叉。
     非回环 `url` 必须 https，`caFile` 透传；v1 不做 mTLS、不做 token 自动轮换。
  5. **入站顺序 fail closed**：enabled → peer bearer → direction → `from` 身份等于 peer →
     严格解析 → `to.team_id` 等于本机映射（`localTeamId ?? teamId`）→ `hop <= maxHops` →
     自指环 → 本机 Team 存在 → 去重 → 写日志。拒绝无副作用，只发一次
     `federation.rejected`，不带正文 / token。
  6. **落点是 Team 日志**：入站调用 `TeamControlLike.post`，`from` 为
     `federation:<node>:<team>`，`to / mentions = []`。S7.1 默认只写日志、0 run；
     只有接收 Team 显式 `teams[].policy.federation.accept = 'members'` 时才对本机 present
     且非 private 的成员 fan-out（S7.2，默认 `log`）。
  7. **hop 与环**：`hop` 是节点间跨越次数，首次投递为 1；`hop > federation.maxHops`
     （1..16，缺省 4）返回 409。v1 没有自动中继，hop 恒为 1，只作防御上界；
     不预埋 `path` / `via` / `ttl`。配置期拒绝自指 peer，运行期拒绝 `from.node_id === 本机`。
  8. **去重与 tenant**：去重键 `(from.node_id, from.team_id, message_id)`，进程内 LRU 1024；
     v1 固定 default tenant，多 tenant federation 非目标；不声称跨重启 exactly-once。
  9. **事件与错误码**：接收侧发 `federation.received` / `federation.rejected`
     （payload 不带正文）；出站一次性进程不发事件，结果走 CLI JSON / exit code。
     错误码固定 `federation_disabled|unauthorized|not_allowed|invalid|hop_exceeded|
     cycle_detected|peer_unreachable|peer_error`、`team_not_found`、`team_log_write_failed`。
  10. **canonical 不变**：不新增 canonical RPC，方法表仍 **48**；federation 是传输面，
      不是 RPC 方法。runtime / event 去重键与既有节点事件面不混用。

- **非目标**：
  - worker / agent 跨节点寻址；远程 spawn / close / rotate / resume / fork。
  - hub 代理正文、hub 存 transcript、hub 转发事件流、hub 下发 federation data token。
  - 自动中继 / mesh / mDNS / 自动发现 / 多跳路径。
  - 离线队列、重试、持久回执、跨重启 exactly-once。
  - 多 tenant federation；跨节点权限应答 / 审批人。
  - mTLS、逐报文签名、token 自动轮换。
  - 复用或复活 legacy `/v1/team/*` / `RemoteTransport` / `NodeRegistry`。

- **后果**：
  - 跨节点 A2A 默认不可用；启用需要两端配置 peer allowlist 与 token。
  - 接收侧默认不会自动唤醒成员：远端报文只是一条 Team 日志，是否让成员开工由接收 Team
    的 `federation.accept` 显式决定。
  - 无离线队列：对端离线时发送方立即失败，由人重试。
  - legacy 跨节点 Agent 面在删除前继续冻结，禁止新增调用方。

- **关联**：[ADR-036](ADR-036-gateway-protocol-v1.md)（gateway）、
  [ADR-049](ADR-049-multi-tenant-isolation.md)（tenant）、
  [ADR-050](ADR-050-yaml-first-config-and-secrets.md)（配置与密钥）、
  [ADR-052](ADR-052-cross-node-transport.md)（旧跨节点 transport）、
  [ADR-053](ADR-053-remote-security-baseline.md)（远程安全基线）、
  [ADR-067](ADR-067-cross-node-dedup-keys.md)（去重键）、
  [ADR-091](ADR-091-agent-body-and-presence.md)（Team / Agent）、
  [ADR-093](ADR-093-hub-control-plane.md)（hub 只做目录，不做数据面）。

## Addendum（0.21 成员寻址）

> 0.21 把 S7 的 team ↔ team 投递改为**按成员寻址**。本节只追加当前事实；
> 上面“wire 不出现 agent 标识 / worker 不可跨节点寻址”的不变量由本节取代。

- **地址**：`<principal>@<node_id>:<team_id>`；`principal` 是目标 Team 的 present 成员名，
  或保留字 `human`。三段字符集互斥；principal 是名字，不是 agent id。
- **wire**：`from` / `to` 为 `{ node_id, team_id, principal }`；严格解析不变，
  缺 `to.principal` 返回 `federation_principal_required`。
- **单点投递**：入站最多 1 个 run。`human` 只写日志；其他名字必须命中唯一
  present 非 private 成员，否则 404 且零写入；private / left / closed / 重名同样 404。
  解析使用完整 roster，不受 `teams.get` 的展示窗口影响。
- **删除 fan-out**：`accept` 只有 `'principal'`（缺省）与 `'log'`；
  `'members'` 在配置、team.json 与运行时都是显式错误；未知值 fail-safe 为 `log`，绝不唤醒成员。
- **回复**：`agent` 工具的 `send` 接受地址形状，运行时填 `from`（模型不能伪造）；
  人类 owner 走 `vessel federation post --from human@<node>:<team>`。
- **Team 信息**：`description?` / `default_principal?`；`teams.get` 的 `members_limit`
  （缺省 20，最大 100，活跃优先）；opt-in `POST /v1/federation/team-info`
  （peer `allowDirectory`，缺省 false），只返回名字 / presence / `last_seen` / desc，
  不含 agent id / workspace / policy / private。
- **信任边界**：peer token 认证节点，principal 由发送节点自证；不是用户级密码学身份。
  unknown principal 与 unknown team 统一 404，不泄漏存在性。
- **限流**：`federation.rateLimitPerMinute` 1..600（缺省 60），超限 429，零写入。
- **不变**：hub 不参与数据面；hop = 1；无中继 / 离线队列 / 跨重启 exactly-once；
  canonical 仍 48；v1 固定 default tenant。

## Errata（`federation.enabled` 缺省值）

> 2026-10-25，只追加。上文决策 3 写 `federation.enabled` 缺省 false；当前运行实现为缺省
> true，只有显式 `false` 关闭。正文保留当时结论，配置缺省以本条为准。

- 归一化位置：`src/federation-config.ts`（`enabled: federation?.enabled !== false`）；
  validator 只校验布尔值类型，不改变缺省。
- `federation.peers[]` 仍是显式 allowlist；没有 peer 就没有对端，也不会自动发现。
- 0.21 Addendum 的 principal 寻址与 `accept` 语义不变。

## Errata（0.27 删除 team-info `default_principal`）

> 2026-10-25，只追加。上文正文保留当时结论。

- federation team-info 响应不再返回 `default_principal`；`description` / 成员列表 / 计数 /
  `last_seen` 不变。
- 不新增协议版本号；旧 peer 多返回该键会被客户端忽略。
