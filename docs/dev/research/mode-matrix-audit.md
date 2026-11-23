# 模式矩阵审计（S5/S6/S7）· q-modes

> 基线：`db69c381`（含 `1aae9ace` restart 模式保持 / `57e514f7` 代理模式修复 / `1a075344` URL 拼接保留代理路径）。
> 分支 `fix/q-modes`。方法：**代码级逐路径静态追踪**（宪法第三/四条：不写测试文件、不起临时进程、
> 行为验证归用户本人；本文每格给 file:line + 判定，作为用户行为验证的对照单）。
> 标注：**[通]** = 全链静态核通；**[设计内]** = 行为是既有裁决/文档明示；**[缺口·修]** = 本次发现并修复；
> **[缺口·留]** = 既有已留档缺口，本次不动（owner + oracle 见 §5）。

---

## 1. S5 · gateway restart 保持运行模式

### 1.1 机制全链（一个事实一个家）

模式事实的唯一来源 = **pid record 的 `daemon` 字段**；唯一写入依据 = **env 标记
`VESSEL_GATEWAY_DAEMON`**（daemon 子进程 argv 与前台 start 完全相同，命令行不可区分）。

| 环节 | 位置 | 事实 |
|---|---|---|
| record 字段 | `src/gateway/pid.ts:21` | `daemon?: boolean`（可选，旧记录无字段） |
| env 标记常量 | `src/gateway/pid.ts:28` | `GATEWAY_DAEMON_ENV = 'VESSEL_GATEWAY_DAEMON'` |
| 读侧校验 | `src/gateway/pid.ts:124` | 非 boolean ⇒ 整条 record 判 corrupt（fail-loud） |
| 写侧透传 | `src/gateway/pid.ts:224` | `writeGatewayPid` 原样落盘 |
| daemon spawn 置标记 | `src/gateway/daemon.ts:248` | `env: { ...process.env, [GATEWAY_DAEMON_ENV]: '1' }` |
| 子进程 argv | `src/gateway/daemon.ts:128-153` | `buildDaemonArgv` = `gateway start`（**不带 --daemon**）⇒ 子进程走前台分支写 record |
| 平台前台写 record | `src/gateway-command.ts:3296` | `daemon: env[GATEWAY_DAEMON_ENV] === '1'`（kind=platform） |
| legacy/node 前台写 record | `src/cli.ts:1651` | 同口径（kind 缺省 node） |
| 解析三态 | `src/cli-args.ts:2011-2072` | `--daemon` ⇒ true（:2025-2028）；缺省 ⇒ undefined；未知参数 ⇒ 报错（:2057） |
| 分发前解析 | `src/cli.ts:369-378` | `daemon === undefined` ⇒ `resolveRestartDaemonMode`，**先于**注册表与前台分支 |
| 模式解析 | `src/gateway-command.ts:713-729` | 读目标实例 record：`record?.daemon === true`；任何失败/缺席 ⇒ false（历史行为） |
| state kind | `src/gateway-command.ts:152-157` | `VESSEL_LEGACY_SERVE=1` ⇒ 'node'，否则 'platform'（与两侧写入口径一致） |
| 路由分流 | `src/gateway-command.ts:3468-3472` | `isForegroundGatewayCommand` = `daemon === false` |
| 注册表（daemon 路） | `src/commands/registry.ts:293-301` | `!isForegroundGatewayCommand` ⇒ `runGatewayCommand` |
| daemon restart 执行 | `src/gateway-command.ts:2348-2400` | 停前快照 instance/port/host → `stopGateway`(keepNodes) → `startDaemonCommand` |
| 前台 restart 执行（非 legacy） | `src/gateway-command.ts:2786-2831` | 快照 → listen 守卫（停前）→ `stopGateway`(keepNodes) → 本平台进程继续起 |
| 前台 restart 执行（legacy） | `src/cli.ts:446-465` | 快照 → `stopGateway` → `--serve` 管线 |
| 文档 | `docs/operations/GATEWAY.md:108-111` | 模式保持 + 旧记录回落 + --all 约束 |
| help | `src/cli-help-spec.ts:459-463` | restart flags 无 `--foreground`（与解析器一致） |

### 1.2 模式矩阵（每格 = 一条代码路径）

| 运行中实例 \ restart 参数 | 缺省 | `--daemon` | `--foreground` |
|---|---|---|---|
| **daemon**（record.daemon=true） | **[通]** 保持 daemon：cli.ts:376 → gateway-command.ts:725 读 true → registry:296 → restartDaemonCommand:2348 → spawn 再置标记（daemon.ts:248）⇒ 新 record 仍 true | **[通]** 强制 daemon：cli-args.ts:2026 ⇒ true，跳过解析，同左路 | **[设计内]** `Unknown argument for gateway restart: --foreground`（cli-args.ts:2057）。依据：1aae9ace 提交说明「未加 --foreground（宪法 10，切前台用 stop+start）」；main 2026-11-23 裁决维持 |
| **前台**（record.daemon=false） | **[通]** 保持前台：resolve ⇒ false → 非 legacy 走 cli.ts:402-427 平台前台分支（runPlatformGatewayForeground restart :2786）；legacy 走 cli.ts:446-465 | **[通]** 显式切 daemon（覆盖语义）：true → registry → restartDaemonCommand | **[设计内]** 同上，解析期拒绝 |
| **旧记录**（无 daemon 字段，升级前已在跑） | **[设计内]** 回落前台：`record?.daemon === true` 为 false（gateway-command.ts:725）。1aae9ace 明示：需一次 `start --daemon` 重写 record 后才保持 | **[通]** 强制 daemon，且新 record 带标记（自愈路径） | **[设计内]** 拒绝 |
| **无实例 / lock-only / 读取失败** | **[设计内]** 回落前台：resolveGatewayTargets 无匹配或异常 ⇒ false（gateway-command.ts:724-727）；随后前台 restart 按无实例正常起 | **[通]** 正常 daemon 起 | **[设计内]** 拒绝 |

补充格：

| 场景 | 判定 |
|---|---|
| `--all` 不带 `--daemon` | **[设计内]** 解析期拒绝 `gateway restart --all requires --daemon`（cli-args.ts:2062-2064；undefined 与 false 都拦） |
| `--all --daemon` | **[通]** restartDaemonCommand:2382-2400 逐实例 startDaemonCommand |
| 多实例无选择器 + 缺省 | **[通]** resolve 先回落 false，前台路径 resolveGatewayTargets 报 `multiple_instances`（gateway-command.ts:690-699）⇒ 显式失败，不静默换模式 |
| legacy（VESSEL_LEGACY_SERVE=1）daemon/前台 × 缺省 | **[通]** kind='node'（gateway-command.ts:156）读 gateway.pid；写入侧 cli.ts:1651 同 kind ⇒ 口径闭合 |
| `--stop-nodes` / `--keep-nodes` / `--no-keep-nodes` | **[通]** 与模式正交：keepNodes 只影响 stopGateway 是否连 node/hub 一起停（cli-args.ts:2029-2043；两条 restart 执行路径同口径 :2370 / :2820） |
| 模式解析时机 | **[通]** cli.ts:369-378 在注册表（:382-397）与前台分支（:402）**之前**；两条路由都按 `daemon === false` 分流，晚解析会走错路 |

**S5 结论：基线修复全链核通，无新缺口。** 唯一注意项 = 旧记录一次性回落（§5 G3）。

---

## 2. S6 · NodeProvider 健康/attention 的模式路由

### 2.1 模式选择全链

| 环节 | 位置 | 事实 |
|---|---|---|
| 代理能力探测 | `apps/web/src/gateway/bootstrap.ts:109-133` | whoami.proxy.enabled ⇒ **不取 credentials**，nodeToken=''、nodeCredentials=[]；baseUrl = `${platformOrigin}${basePath}/${node_id}`（basePath 缺省 /nodes） |
| 直连平台模式 | `bootstrap.ts:135-190` | 逐节点取 credentials（多节点带 node_id），按 node_id 分槽 |
| legacy 判定 | `bootstrap.ts:82-83` + `ConnectionProvider.tsx:218-235` | /platform/rpc 不存在 ⇒ kind:'legacy'，nodeUrl=platformUrl（页面同源），旧 token 槽 |
| 代理接线 | `ConnectionProvider.tsx:254-274` | proxyMode=true；nodeUrl=proxy.baseUrl；**清理直连遗留 token 槽**（:256-258）；nodeToken=平台 token（仅平台鉴权用） |
| 直连接线 | `ConnectionProvider.tsx:276-316` | nodeUrl=normalizeNodeOrigin(api_url)（:55-58，origin 归一）；token 按 node_id 落 sessionStorage |
| client 构造 | `ConnectionProvider.tsx:162-163` | `new GatewayClient(nodeUrl ?? '', proxyMode ? { proxy: true } : {})` |
| 节点切换 | `ConnectionProvider.tsx:341-349` | selectionSeq ⇒ 重跑 bootstrap ⇒ 代理基路径随选中节点重建 |
| 当前节点健康 | `NodeProvider.tsx:140-146` | current ⇒ `client.getHealth()`；其余 ⇒ fetchNodeRpc 直连 |
| 当前节点 attention | `NodeProvider.tsx:200-206` | current ⇒ `client.listInteractionsPage()`；其余 ⇒ fetchNodeAttention 直连 |
| 健康轮询范围 | `NodeProvider.tsx:148-162` | 平台模式只轮询当前节点；其它节点健康来自 platform.nodes.list 的 status 投影 |
| getHealth 实现 | `gateway/node/integrations.ts:112-114` | `rpc('health.get')` |
| RPC 传输 | `gateway/node/rpc.ts:55-58` | **拼接** `${httpBase()}${path}`（保留 /nodes/<id>）；proxy ⇒ `credentials:'same-origin'`（cookie）；无 token 且非 proxy ⇒ 显式 unauthorized（:46-48） |
| httpBase | `gateway/node/protocol.ts:210-212` | baseUrl 空 ⇒ 页面同源（legacy） |
| 预探健康 | `gateway/node/protocol.ts:223-255` | `/health` 拼接；proxy ⇒ same-origin cookie（:230，0.58 修 omit 丢 cookie） |
| WS | `gateway/node/protocol.ts:214-216, 289` | `toWebSocketBase(httpBase()) + /v1/events`（拼接保路径）；首帧 auth token |
| 代理 RPC 白名单 | `packages/serve/src/platform/proxy-config.ts:72-98` | health / interactions / plugin / plugins 等命名空间在表内；DENIED_RPC_METHODS（:107-115）仍生效 |
| HTTP/WS 同口径 | `packages/serve/src/platform/proxy.ts:388, 661` | 两条传输共用 checkRpcMethod |
| 代理 WS 鉴权 | `packages/serve/src/platform/server.ts:990-1025` | 升级时平台鉴权（cookie/Bearer/回环）；配了平台 token 时允许首帧延迟鉴权 |

### 2.2 模式矩阵

| 数据面 \ 模式 | proxy | direct（平台） | legacy |
|---|---|---|---|
| 当前节点 health.get | **[通]** `<platform>/nodes/<id>/v1/rpc` + cookie；health 命名空间白名单 | **[通]** node origin + credentials token | **[通]** 页面同源 + legacy token |
| 当前节点 interactions.list | **[通]** 同上（interactions 在表内） | **[通]** | **[通]** |
| 当前节点 WS 事件流 | **[通]** `<platform>/nodes/<id>/v1/events`（WS 白名单 proxy-config.ts:49） | **[通]** node origin | **[通]** 同源 |
| 当前节点 teamControl | **[通]** NodeProvider.tsx:241-243 current ⇒ client（活连接） | **[通]** | **[通]** |
| 额外节点 health/attention/teams | **[缺口·留 G1]** fetchNodeRpc 直连 api_url；proxy 模式 token 槽被清（ConnectionProvider.tsx:256-258）⇒ 无 Authorization ⇒ 401 | **[通]** 各节点 credentials 分槽 token（bootstrap.ts:139-164） | **[通]** 手填节点 sessionStorage token |
| 全节点 attention 扇出 | **[缺口·修]** 原 fetchAllAttention 走 fetchAllNodeAttention 统一扇出，**含当前节点** ⇒ 代理模式当前节点也 401（S6 同类）。已修：逐节点委托 fetchAttention（NodeProvider.tsx:208-239），当前节点走活连接；错误归一 NodeRpcError 保持结果形状。当前无消费方（潜在缺口，修后 API 面与单节点口径一致） | **[通]** | **[通]** |

**S6 结论：基线修复（当前节点走活连接）全链核通；扫出并修复 1 处同类潜在缺口（fetchAllAttention）。**

---

## 3. S7 · 插件 iframe / embed 的设计意图贯彻

设计意图（plugin-embed 契约 §4，2026-11-23 用户裁决）：
**iframe HTML 直连 node origin**（静态免鉴权）；**embed 模块经 nodeUrl**（代理模式 = 平台同源转发，
动态 import 必须同源）；**数据面 RPC 经活连接**（代理模式走 /nodes/<id> 代理）。

### 3.1 全链

| 环节 | 位置 | 事实 |
|---|---|---|
| iframe origin 选择 | `apps/web/src/domains/plugins/PluginFrame.tsx:83-89` | platform ⇒ 选中节点 api_url（直连/代理子模式同口径）；legacy ⇒ nodeUrl（页面同源=node） |
| iframe URL 构造 | `PluginFrame.tsx:93-102` → `plugin-contributions.ts:248-273` | **拼接** `${origin}/plugins/<id>/<entry>`（:267，1a075344 修 new URL 吞路径）；entry 白名单校验（safeEntryPath :222-231） |
| iframe 沙箱 | `PluginFrame.tsx:221` | `allow-scripts allow-forms`，无 allow-same-origin ⇒ opaque origin；消息按 source 硬校验（:143-144） |
| embed 模块/CSS URL | `PluginEmbed.tsx:62-63, 102` → `plugin-contributions.ts:282-293` | `${nodeUrl}/plugins/<id>/ui/<path>` 拼接；proxy 模式 nodeUrl=<platform>/nodes/<id> ⇒ 同源 |
| 代理路径白名单 | `packages/serve/src/platform/proxy-config.ts:63, 295-310` | 只放行 `/plugins/<id>/ui/**` 且仅 GET/HEAD；**iframe HTML 路径不在白名单** ⇒ 404 proxy_path_not_allowed（:311-318，错误文案明示「iframe 页仍请直连 node」）⇒ 设计意图在 serve 侧强制贯彻 |
| CSP frame-src | `packages/serve/src/gateway/auth.ts:596-607` | 有扩展源 ⇒ `frame-src 'self' <node origins>`；无扩展源保持旧输出（default-src 'self' 兜底）；frame-ancestors 'none' 不变 |
| node origins 来源 | `packages/serve/src/platform/server.ts:548-555` + `src/gateway-command.ts:3210` | cspNodeOrigins = registry 各节点 apiUrl + 派生来源（回环+本机私网）；只进 CSP，不扩 CORS |
| CSP 下发点 | `packages/serve/src/platform/server.ts:1041-1057` | 平台 HTML（text/html）响应注入；frameSrc/connectSrc 都带 node origins |
| node 静态免鉴权 | `packages/serve/src/gateway.ts:4079-4122` | 非 API 的 GET/HEAD 不进鉴权链（:4135-4138 注释明示）；/plugins/* 先 ensureActive 懒激活（:4092-4110，in-process 放行 = 基线 6c1fe2d4）再 servePluginAsset（staticMounts 含 in-process = 基线 95361fac） |
| embed 静态保留命名空间 | `packages/serve/src/gateway.ts:4057-4077` | `/plugins/<id>/ui/` 永不命中动态路由 ⇒ 代理白名单只会转发到静态服务 |
| iframe 桥 RPC | `PluginFrame.tsx:155-156` | `client.rpc('plugin.<id>.<method>')` ⇒ 代理模式经 /nodes/<id>；方法白名单 = contributions.rpc ∪ commands（plugin-contributions.ts:456-467） |
| plugin 命名空间过代理 | `proxy-config.ts:88-92` | 'plugin'/'plugins' 在表内（2026-11-23 用户裁决）；DENIED_RPC_METHODS 仍生效 |
| embed 宿主 RPC | `host-factory.ts:155` / `plugin-catalog.ts:38` | 同样经 client.rpc（活连接），不直连 |