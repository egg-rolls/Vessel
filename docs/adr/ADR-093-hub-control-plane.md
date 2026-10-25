---
adr: 93
title: Hub 控制面（S5）
status: accepted
date: 2026-10-23
related: [36, 49, 50, 51, 52, 53, 67, 91, 92]
tags: [hub, control-plane, directory, pairing, scoped-token, secret-store]
---

## ADR-093：Hub 控制面（S5）

- **上下文**：历史方向裁决（个人侧决策记录，不在本仓库）把多节点协作拆成 **control plane**（hub ↔ node 常驻 WSS，只传目录与指针元数据）与 **data plane**（浏览器 ↔ node 直连，传消息、事件、工具调用与权限请求）。hub 是**目录**，不是内容代理：它只回答“哪个节点、哪个 team、有多少成员、现在健康与否”，不转发正文，也不替节点做授权。S5 在 S3 Team 契约之上落地 hub 进程、节点目录、一次性配对与 scoped token；跨节点 A2A 仍留到 S7。本条 ADR 记录 **S5 已实现** 的边界与不变量。

- **决策**：
  1. **hub 是 app 层独立前台进程**：实现位于 `src/hub/`（registry / control-client / server / secret-store / token-broker / wiring），不新增可发布 package，也不塞进 `packages/serve`、`packages/agent` 或 `packages/core`。serve 只提供节点侧的 `/v1/hub/control` 与 `/v1/hub/pair`；hub 通过 app 层装配启动，进程生命周期独立于单个节点。
  2. **hub 主动拨号节点**：hub 作为 WSS 客户端连接节点的 `/v1/hub/control`；协议 `vessel.hub/1` 的帧统一带 `dialer: 'hub' | 'node'`，方向无关。S5 只实现 hub → node 的拨号方向；节点收到 `dialer !== 'hub'` 的帧以 4400 关闭。node → hub 的反向连接是 S5.1，不在本切片。
  3. **一次性配对码**：`POST /v1/hub/pair` 用一次性码换取节点签发的 `view` + `exchange` 两枚 token。配对码只存 `sha256` hash、默认 5 分钟有效、消费时先原子写 `used_at` 再返回，重放无效。两枚 token 默认 30 天、可吊销；`auth.exchange` 允许 `admin` / `exchange` principal，且交换结果固定 `scope: 'control'`——`exchange` 不能签出 `view` / `admin`。
  4. **scope 映射既有 rank**：动态 token 的 scope 为 `view | exchange | control | admin`，映射到既有 `read / write / admin` 方法与白名单，不新增 role 字符串，也不改 `ROLE_RANK`。`view` 只读目录与健康；`exchange` 只能调用 `auth.exchange`；`control` 只能调用节点控制面白名单（events / interactions / permission / ask / teams 只读）；team 收窄在**节点侧**强制，hub 不据此做授权决策。
  5. **hub 凭据落 SecretStore**：hub 的 `view` / `exchange` token 走 `SecretStore` 端口（Windows DPAPI、macOS Keychain、Linux libsecret `secret-tool`，不可用时才退到 AES-256-GCM 文件适配器），不进明文 YAML。节点侧只存 `sha256(token)`，明文仅在签发响应中出现一次。
  6. **token 绑定 hub_id**：token 记录持久化 `hub_id`；`/v1/hub/control` 的首帧鉴权要求 `principal.hub_id` 存在且与帧内 `hub_id` 一致，防止 A hub 的 token 被 B hub 复用。缺失或不一致一律 4401 关闭。
  7. **目录主键与上限**：目录记录主键为 `pairing_id = node_id:tenant_id`，同一节点可有多个 pairing。`<hubDataDir>/registry.json` 以 `0600` 原子写（250ms debounce）。写入前强制 `teams ≤ 500`、`agents ≤ 2000`，超限截断并置 `truncated: true`。节点离线时保留最后一次目录快照，只读展示；hub 不替节点伪造在线状态。
  8. **指针只推元数据**：推送 payload 固定 `{node_id, team_id, request_id?, reason, ts}`，不含正文、事件或工具结果。指针只在线推送，不持久化、不排队；消费方按 `ts` 超过 60 秒丢弃（Web 消费方在 S6 落地）。客户端收到指针后**直连节点**拉取渲染所需数据，hub 不做消息正文代理。
  9. **快照新旧按 `(incarnation, revision)`**：节点进程代际 `incarnation` 变化时 hub 无条件接受下一个快照并重置 revision 比较；同一 incarnation 下 `revision <= lastRevision` 的快照丢弃。`incarnation` 只用于该比较与事件去重，不与 `node_id` 混用。
  10. **授权权威在节点**：hub 只做目录与配对分发，不判断 team 成员资格、不批准权限、不代表用户身份。节点仍是唯一执行与授权权威；跨节点 A2A 的 allowlist / hop budget 属于 S7，S5 不提供。
  11. **canonical 计数**：S5 新增 `auth.exchange`（write）/ `auth.revoke`（admin）/ `auth.tokens`（admin）三个 canonical RPC 方法。**本分支 canonical 合计 48**（45 + 3）；S3 的 `teams.*`（+4）与 S5 的 `auth.*`（+3）合并后最终 52，本分支只声明 48。

- **非目标**：
  - Web UI 与浏览器 data token 的 sessionStorage 落地（S6）。
  - 跨节点 A2A（team ↔ team、allowlist、hop budget，S7）。
  - 权限审批人与权限决策（S4）。
  - 消息正文 / 事件 / 工具结果代理；hub 不做内容中转。
  - 节点自动发现、mesh、多 hub 联邦。
  - node → hub 反向连接（S5.1）。
  - hub daemon / 系统服务注册。
  - mTLS、逐事件签名、以 hub 为信任根。

- **后果**：hub 可以横向扩展为纯目录服务，节点断连不影响本机与浏览器直连；代价是客户端必须自行向节点拉取渲染数据，且指针只是提示而非可靠队列。配对与 token 生命周期独立于节点重启；吊销与 `hub_id` 绑定把“token 被另一个 hub 复用”变成显式失败。

- **关联**：[ADR-036](ADR-036-gateway-protocol-v1.md)（gateway 控制面）、[ADR-049](ADR-049-multi-tenant-isolation.md)（tenant principal）、[ADR-050](ADR-050-yaml-first-config-and-secrets.md)（密钥分层）、[ADR-051](ADR-051-remote-control-plane.md)（远程控制面）、[ADR-052](ADR-052-cross-node-transport.md)（跨节点 transport）、[ADR-053](ADR-053-remote-security-baseline.md)（远程安全基线）、[ADR-067](ADR-067-cross-node-dedup-keys.md)（去重范围维度）、[ADR-091](ADR-091-agent-body-and-presence.md)（节点身份 / Team / Body）、[ADR-092](ADR-092-agent-rotate-and-epoch-fencing.md)（rotate 与 epoch fencing）。方向裁决见个人侧决策记录（不在本仓库）；仓库内相邻决策见 ADR-091 / ADR-092。

## Addendum（0.19 收口）

> S5 合并进 `0.19-integration` 后的当前事实；只追加，不改写上面的 S5 结论。

- **canonical 最终计数为 47**：0.18 移除 workflow（ADR-090）后基数为 40；S3 `teams.*`（+4）与 S5 `auth.*`（+3）合并后为 47。上文第 11 条的“本分支 48”是 S5 分支上的中间计数，“最终 52”在 0.18 合并后不再成立。
- **S4 后 canonical 为 48**：0.19 S4 新增 `teams.budget`（`write`，`status|override`，不进 control scope）。本 Addendum 第一条的“最终计数为 47”是 S4 合并前的计数。
- **control scope 白名单包含 `teams.post`**：`control` token 映射 `write`，允许 `teams.list` / `teams.get` / `teams.post` 与 events / interactions / permission / ask 白名单；`teams.members` 不在 control 白名单。上文第 4 条“teams 只读”应收窄为“teams 读 + post”，且 team 收窄仍只在节点侧执行。
- **`SecretStore` 文件回退不自动启用**：Windows DPAPI / macOS Keychain / Linux libsecret 不可用时，只有 `hub.allow_file_secrets: true` 才退到 AES-256-GCM 文件适配器；否则 fail-closed（`secret_store_unavailable`）。上文第 5 条“不可用时才退到文件适配器”需以该显式开关为准。
- **`POST /v1/hub/data-token` 与 `vessel hub data-token` 已实现**：hub 用该 pairing 的 `exchange` token 向节点换短期 `control` token 并只返回给调用方；hub 不持久化短期 token。浏览器端（sessionStorage / Web 消费）仍未实现；Web 当前直连节点，不消费 hub 目录或 data token。
- **实现文件位置**：hub 进程与目录实现在 `src/hub/`；app 层装配（`HubControlLike` / `TeamScopeLike` / `NodeTokenControlLike` 投影）在 `src/hub-wiring.ts`，节点 token 表 / 配对在 `src/node-token-store.ts` / `src/node-token-control.ts` / `src/hub-pairing.ts`，均不在 `src/hub/` 内。上文第 1 条的文件清单应包含这些 app 层文件。
- **node → hub 出站仍为 S5.1**（**已被下方 S5.1 Addendum 取代**）：节点收到 `dialer !== 'hub'` 的帧以 4400 关闭；配置虽接受 `direction: node`，运行时拒绝。跨节点 A2A（S7）仍未实现。

## Addendum（S5.1）

> node → hub 出站（NAT）已在 `0.19-s5.1-node-outbound` 分支实现；只追加，不改写上文 S5 结论与 S5 的 hub → node 行为。

- **方向翻转，协议不变**：仍使用同一套 `vessel.hub/1` 帧，帧内 `dialer: 'node'` 表示连接发起方是节点；hub 作为 WS acceptor，只接受 `dialer === 'node'`（错配 4400）。节点 gateway 主动拨号 `${hub.url}/v1/hub/node-control`，因此节点可以只监听回环，无需开放入站端口。`auth` + `pong` 由 dialer（节点）发，`hello` + `ping` 由 acceptor（hub）发，`snapshot` + `pointer` 仍只由元数据生产者节点发。
- **join code 方向为 hub 生成、node 消费**：`vessel hub join-code` 在 hub 侧生成一次性码（默认 300 秒、只存 `sha256`）；`vessel hub join <hub-url> --code` 在节点侧换取凭据。这与 S5 的“节点生成、hub 消费”互为镜像，两条流程并存。
- **node token 由 hub 签发**：join 成功后 hub 签发 `scope: 'node'` token（默认 30 天），只持久化 `sha256` 到 `<hubDataDir>/node-tokens.json`；节点把明文 token 存 SecretStore，非秘密状态（URL / `hub_id` / `node_id` / `tenant_id` / `pairing_id` / `token_id`）写 gateway data dir 的 `hub-node.json`。node token 绑定 `hub_id` / `node_id` / `tenant_id`，任一不匹配返回 4401；它不是 `PrincipalScope`，不进入 canonical RPC。
- **端点与可见性**：hub 新增 `POST /v1/hub/join`（code 换 token）与 WSS `GET /v1/hub/node-control`（节点出站连接的 acceptor）。node-dial 记录不进入 hub 的 `token-broker` / `control-client` 拨号路径；目录响应补 `direction` / `public_url?` / `data_plane`。
- **陈旧快照仍按 `(incarnation, revision)`**：重连后节点以新 `incarnation` 或更高 `revision` 对齐；同一 pairing 只保留一条活动连接，新连接接管，旧连接的 close 不得覆盖新状态。hub 重启时 node-dial 记录不拨号，等待节点重连。
- **数据面归属**：`data_plane: 'direct' | 'unreachable'` 由 `public_url ?? url` 派生，客户端据此区分“控制面健康”与“正文可达”。NAT 节点若没有 `public_url`（隧道 / 反向代理），浏览器无法直连拉取正文；hub 仍不代理、不落盘任何正文。
- **单 hub 限制**：一个 node 进程 / data dir 只加入一个 hub（单份 `hub-node.json`）；多 hub 需要多个 data dir / 进程。S5.1 不做自动发现、多 hub 联邦、token 自动刷新或 mTLS。
- **收口**：canonical 仍为 **47**，不新增 RPC 方法、不改任何 manifest、版本线仍 0.19；既有 hub → node（`vessel hub pair` / `vessel hub node add` / `/v1/hub/control`）行为不变。
- **上文 S5 Addendum 的“node → hub 出站仍为 S5.1、运行时拒绝 `direction: node`”已被本节取代**：`vessel hub start` 仍只接受 `direction: hub`（hub 进程不扮演 node），而 gateway 的 `hub.direction: node` 现在启动节点出站。该历史句子只描述 S5 当时的状态。
