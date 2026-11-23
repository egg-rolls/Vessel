# Serving 全链审计（S8 双轨 + O2/S1/S2/S4）

切片：q-serving（fix/q-serving）。方法：**代码级端到端追踪**（宪法第三/四条：不写测试、
不起探针/临时进程；行为判真落在用户本人验证与产物读数）。每跳给 file:line + 判定；
行号以本分支提交时的工作树为准。

基线点状修复（本文不重复修，只核链）：
- `95361fac` staticMounts 补 in-process；
- `6c1fe2d4` ensureActive 放行 in-process；
- `332fd2e7` model-registry 双路注册按 name 去重；
- `1a075344` web 资产 URL 保留代理路径。

复盘教训（engineering-quality-reflection §五）：只修报的点没核全链 → 反复 404。
本轮把「child entries 单轨假设」一次扫齐，并把机制适用边界写进注释/类型。

---

## 1. 双轨模型与机制边界（S8 收口）

`PluginHostManager` 有两张表：

| 表 | 内容 | 位置 |
|---|---|---|
| `entries: Map<string, Entry>` | child 体验插件（spawn / 重启 / 事件管道 / HTTP/WS 代理） | manager.ts:720 |
| `inProcess: Map<string, InProcessRecord>` | in-process 能力插件（登记即激活，与进程同寿命） | manager.ts:732；记录形状 :163 |

**双轨读面**（凡面向「插件整体」的读/开关，必须两表都遍历）：

| 方法 | child 遍历 | in-process 遍历 | 判定 |
|---|---|---|---|
| `ensureActive` | :910-923（requireEntry→startEntry） | :903-909（enabled 放行 / disabled 抛契约错） | ✅ 双轨（基线 6c1fe2d4，本轮核通） |
| `activate` | :910 起 | :871-877（本轮补：enabled no-op / disabled 抛错） | ✅ 双轨 |
| `staticMounts` | :1261-1277 | :1280-1295 | ✅ 双轨（基线 95361fac，本轮核通） |
| `contributionsFor` | :1245-1249 | :1250-1254 | ✅ 双轨 |
| `contributionsSnapshot` | :1073-1085 | :1086-1096 | ✅ 双轨 |
| `statuses` / `status(id)` | :1307 / :1314-1315 | :1308 / :1316-1317（**本轮补**） | ✅ 双轨 |
| `enable` / `disable` | :1158-1167 / :1138-1144 | :1151-1156 / :1131-1136（**本轮补**，handler 留存供重注册） | ✅ 双轨 |
| `reload` diff | 只作用于 child（设计如此） | 删除循环不触碰 inProcess；混入 in-process id → fail-closed `plugin_id_conflict`（:995-1002，**本轮补**）；`active` 结果含 enabled in-process（:1048-1062） | ✅ 边界显式 |

**child-only 机制面**（只作用于 entries 是**机制必然**，不是遗漏；本轮全部加注释显式化）：

| 方法 | 为什么 child-only | 位置 |
|---|---|---|
| `startEntry` / `doStart` / `handleExit` / `scheduleRestart` | spawn/重启的对象是子进程 | manager.ts:1550 起 |
| `resolve` / `httpEndpointFor` / `match` / `rebuildHttpRoutes` | 动态 HTTP 代理目标 = 子进程自报 loopback endpoint；in-process 没有该机制 | :1352 / :1340 / :1321 / :1436 |
| `attachEventSource` / `subscribeEvents` | 事件经 `plugin.event` NDJSON 管道发给子进程；in-process 事件面由 core 运行时装配接线 | :1174 / :1726 起 |
| `deactivate` | 无可停的子进程 → no-op（卸载需重启，装配层报 restart_required） | :1106 |
| `stopAll` | in-process RPC 由末尾 `rpc.clear()` 统一注销；登记记录保留（终态关闭） | :1386 |
| `denialsFor` / `webSocketStats` | deny/WS 记账发生在子进程 RPC/WS 面 | :1371 / :1376 |
| `requireEntry` | child-only 查找助手；in-process 走 `this.inProcess` | :1815 |

**fail-closed 边界（本轮新增）**：in-process 插件声明 `contributes.http` 在
`registerInProcess` 直接拒绝（manager.ts:1205-1212）——动态 HTTP 面永远不可能服务它，
静默接受 = 登记后一律 404（正是复盘里反复 404 的同类洞）。

---

## 2. 链 A：in-process 静态 UI（model-registry 形态）

登记 → 列表 → web → （代理）→ node → 文件，逐跳：

| # | 跳 | file:line | 判定 |
|---|---|---|---|
| A1 | loader 发现 in-process descriptor（capabilityManifest） | src/plugin-loader.ts:455-468 | ✅ mode='in-process'，entry=模块入口（dir 内） |
| A2 | install 后双路收集（wiring provider 路 + 通用装载路） | src/model-registry-wiring.ts:126-134；src/tenant-runtime-factory.ts:882-900 | ✅ 两路各持同一 descriptor/plugin |
| A3 | 去重登记单实现（按 name 只登记一次；enabled 取自 config） | src/plugin-host-assembly.ts:246-276 `registerInProcessPluginEntries`；调用点 src/tenant-runtime-factory.ts:1604-1609 | ✅ 本轮从 factory 闭包抽出（332fd2e7 的收口）；rows.enabled 不再恒 true |
| A4 | descriptor 映射（child/in-process 共用） | src/plugin-host-assembly.ts:77-172 `manifestToServeDescriptor`（ui.dir→uiDir :83，embed/trust_ui :85-86，enabled :170） | ✅ 单实现 |
| A5 | manager 登记：复检 + http 拒绝 + embedState + RPC | manager.ts:1196-1225 `registerInProcess`；RPC 注册 :1228-1240；embed trust/hash :1525-1538 `embedStateFor`（与 child 同算法/同 TOFU 锁） | ✅ 本轮补 embedState（此前 in-process 无 ui_trust/ui_bundle_hash → web 永远回落 iframe） |
| A6 | plugins.list 基础行并入 | src/cli.ts:1329-1351（bundlePluginEntries+pluginRuntimeEntries）；src/bootstrap.ts:2043-2054 | ✅ 两处都按 name 去重 |
| A7 | plugins.list 合并（贡献 + E10 元数据） | packages/serve/src/gateway/methods/config.ts:463-486 `mergePluginList`（**本轮补按 name 去重**：statuses 双轨后 cli 的基础行与 runtime 行会含同名 in-process）；数据源 gateway.ts:2434-2435（contributionsFor + pluginMetadata←statuses :3189-3191） | ✅ in-process 行现在带 mode:'in-process' / status / version / ui_* |
| A8 | web embed 档判定 | apps/web/src/domains/plugins/PluginPageView.tsx:33-42（component && ui_trust==='embedded' && ui_embed && ui_bundle_hash） | ✅ A5/A7 补齐字段后 model-registry（builtin→embedded）走 embed；缺字段才回落 iframe（fail-closed 不变） |
| A9 | embed 资产 URL | apps/web/src/domains/plugins/plugin-contributions.ts:285-296 `pluginEmbedAssetUrl` → `joinBaseUrl`（见 §5） | ✅ 代理模式 `<platform>/nodes/<id>/plugins/<pid>/ui/<path>` |
| A10 | 平台代理白名单 + 剥前缀 | packages/serve/src/platform/proxy-config.ts:63（PLUGIN_EMBED_STATIC_RE）、:279-319（仅 GET/HEAD）、:216-232（parseProxyRoute 剥 `/nodes/<id>`）；转发 proxy.ts:316-319 | ✅ rest=`/plugins/<pid>/ui/<path>` 拼到 node origin（node api_url 是纯 origin，此处 new URL 用 base.origin 是**正确**的，与 S4 的浏览器侧 base 带路径不同） |
| A11 | node gateway 静态分支 | packages/serve/src/gateway.ts:4089-4121：`pluginStaticId` :4091 → `ensureActive` :4094 → `servePluginAsset(path, staticMounts())` :4111-4114 | ✅ embed 静态路径先于动态路由判定（:4068-4069 `isPluginEmbedStaticPath`），`ui` 命名空间不被动态路由遮蔽 |
| A12 | ensureActive in-process 放行 | manager.ts:903-909 | ✅ enabled → return（无 child 可 spawn）；disabled → `plugin_activation_failed` → gateway 404（:4096-4108） |
| A13 | staticMounts in-process 挂载 | manager.ts:1280-1295（enabled + uiDir；embedEntry/embedCss 归一化） | ✅ |
| A14 | 文件服务 + containment | packages/serve/src/plugin-host/static.ts:121-162：parsePath :62-86（剥 `ui` 首段 :84）→ mount 查找 :127 → realpath 根 :132 → resolve+isWithin :136-137 → realpath 目标+isWithin :141-145 → Bun.file :147 → 缓存头 :93-110（embed 入口/CSS no-cache，其余 immutable） | ✅ symlink 逃逸/穿越/未知 entry 一律 null→404，不回落 index.html |

**链 A 判定：通。** 每一跳的 in-process 分支都存在且口径一致；本轮补的洞在 A5（embedState）、
A7（元数据+去重）、A3（enabled 真值）。

## 3. 链 B：child 静态 UI（体验插件形态）

| # | 跳 | file:line | 判定 |
|---|---|---|---|
| B1 | loader child descriptor（vessel.entry+contributes） | src/plugin-loader.ts:413-447 | ✅ |
| B2 | 装配 createPluginHostManager（descriptors + settingsFor + exposeFor） | src/plugin-host-assembly.ts:178-206 | ✅ |
| B3 | 构造期复检 + 懒激活 RPC 预注册 | manager.ts:795 起（validateDescriptor :375 起；registerRpc :1540 起） | ✅ invalid 不注册只留诊断态 |
| B4 | 首次页面访问 → ensureActive → startEntry spawn | manager.ts:910-923 → :1549 起 doStart；ChildPluginProcess.start handshake/activate packages/serve/src/plugin-host/child.ts:306-416 | ✅ active 后 httpEndpoint/订阅就绪 |
| B5 | staticMounts child 挂载 | manager.ts:1261-1277（enabled && status!=='invalid' && uiDir） | ✅ |
| B6 | servePluginAsset | 同 A14（mounts 来源不同，服务逻辑单实现） | ✅ |
| B7 | 停用/禁用收口 | deactivate :1106（ terminate child，RPC 定义保留）；disable :1138（unregister RPC + rebuildHttpRoutes）→ staticMounts 因 enabled=false 立即摘除 | ✅ |
| B8 | reload diff | manager.ts:940-1069：删除→deactivate+unregister+删条目；变更→重激活；in-process 不受影响（:995 守卫） | ✅ |

**链 B 判定：通。** child 轨是基线既有行为，本轮未改其语义，只补边界注释与 reload 守卫。

## 4. 链 C：RPC（双轨共用一个注册表）

| # | 跳 | file:line | 判定 |
|---|---|---|---|
| C1 | dispatcher 动态解析 | packages/serve/src/rpc.ts:490（静态表未命中→dynamic.resolve）；gateway.ts:2691（dynamic=manager.rpc） | ✅ |
| C2 | canonical 名 + DTO 校验单实现 | packages/serve/src/plugin-host/registry.ts:99-167（register：plugin.<id>.<name>，params/result 双向 DTO+1MiB） | ✅ 双轨共用 |
| C3 | child：首次调用懒激活再转发 | manager.ts:1629 起 callRpc（ensureActive→child.callRpc）；child.ts:419-428 | ✅ |
| C4 | in-process：handler 直达（Plugin.rpc，传输无关） | manager.ts:1228-1240（登记/enable 注册）；handler 留存于 InProcessRecord :163 | ✅ disable→unregister（:1134）→method_not_found；enable→重注册（:1154） |
| C5 | 平台代理 RPC 命名空间 | packages/serve/src/platform/proxy-config.ts:88-92（`plugin`/`plugins` 在白名单；DENIED_RPC_METHODS 仍生效） | ✅ embed/iframe 数据面代理模式可用 |

## 5. S4：资产 URL 构造单实现

**问题形状**（1a075344 根因）：代理模式 base = `<platform>/nodes/<id>`（带路径）。
`new URL('/plugins/...', base)` 按 URL 规范用根绝对路径**替换 base 整个路径** →
`/nodes/<id>` 丢失 → 落平台根 `/plugins/*`（平台 server.ts:84-85 一律 404）。
RPC 用字符串拼接故通，资产用 new URL 故 404 —— 两套拼接实现漂移。

**本轮收口（单实现）**：apps/web/src/gateway/url.ts
- `normalizeBaseUrl` :104（trim + 去尾斜杠；base 可带代理路径）
- `pageOrigin` :113（结构化读 globalThis.location，无 DOM lib 也能编；拿不到→''）
- `joinBaseUrl` :124（**字符串拼接** `${normalizeBaseUrl(base)}${path}`）

消费点（全部改走单实现）：
| 消费点 | file:line |
|---|---|
| ProtocolClient.baseUrl 归一化 | apps/web/src/gateway/node/protocol.ts:140 |
| httpBase（空 base→同源→Node 探针回落 127.0.0.1，既有语义保留） | protocol.ts:195-198 |
| WS URL / health 预探 | protocol.ts:201 / :213 |
| RPC fetch | apps/web/src/gateway/node/rpc.ts:57 |
| pluginFrameUrl（new URL 只用于给**已是绝对 URL** 的串追加 query，不再做 base 解析） | apps/web/src/domains/plugins/plugin-contributions.ts:263-268 |
| pluginEmbedAssetUrl | plugin-contributions.ts:293 |
| resolveNodeOrigin（空串=页面同源 legacy） | plugin-contributions.ts:244-246 |

**三态核对**：
- 代理：base=`https://platform/nodes/n1` → 资产 `https://platform/nodes/n1/plugins/<pid>/ui/...`，
  RPC `https://platform/nodes/n1/v1/rpc` —— 前缀保留，同源（动态 import 必须同源）。✅
- 直连：base=node origin（纯 origin）→ 拼接与 new URL 结果一致。✅
- legacy（`--serve` 页面同源）：base='' → pageOrigin()；拿不到 location（Node 探针）时
  资产 URL 返回 null（调用方渲染错误态），RPC 回落 http://127.0.0.1 —— 两侧回落语义
  与改动前逐字一致。✅

**iframe 侧**：平台模式 iframe 直连 node api_url（PluginFrame.tsx:78-89，2026-11-23
用户裁决：代理白名单只转发 embed 静态 /ui/**，iframe HTML 不经代理）；api_url 是纯
origin，无代理前缀问题。直连模式跨源 CORS 是既有缺口（1a075344 已注明另批），不在本轮。

## 6. S8 同类缺口清单（本轮扫出并修齐）

扫描面：manager.ts 全部方法 + plugin-host/*.ts + 装配层（assembly/factory/cli/bootstrap）
+ gateway 静态/列表接线 + web URL 构造。判据：凡「只遍历 child entries / 只查
requireEntry / 假设插件必有子进程」的地方，逐一判定是机制必然（加注释）还是缺口（修）。

| # | 缺口 | 位置（改前） | 后果 | 修复 |
|---|---|---|---|---|
| G1 | `statuses()`/`status(id)` 只遍历 entries | manager.ts statuses/status | in-process 在 plugins.list 缺 version/mode/status/ui_trust/ui_bundle_hash/ui_embed；**web embed 档判定（PluginPageView.tsx:40-42）永远不成立 → model-registry 永远回落 iframe**；catalog 无 status | 双轨 + `inProcessStatusOf`（mode:'in-process'，enabled?'active':'disabled'）；登记时算 embedState（与 child 同算法/TOFU 锁） |
| G2 | `enable`/`disable`/`activate` 走 requireEntry | manager.ts | 对已登记 in-process 抛 `Unknown plugin`（与 ensureActive 修前同款根因） | 三方法补 in-process 分支；InProcessRecord 留存 handler 供 disable→enable 重注册 RPC |
| G3 | `reload` 可为 in-process id 建影子 child 条目 | manager.ts reload add 分支 | 同 id 双份贡献/挂载/RPC 冲突（装配层目前过滤 child 才没触发） | fail-closed：inProcess.has(id) → errors[plugin_id_conflict]，不建条目；result.active 含 enabled in-process |
| G4 | `registerInProcess` 静默接受 contributes.http | manager.ts | in-process 无子进程 endpoint，动态 HTTP 永远 404（静默） | 登记时 fail-closed 拒绝 + 边界注释 |
| G5 | `mergePluginList` 不按 name 去重 | gateway/methods/config.ts | G1 修复后 cli 的 plugins.list 基础行（装配 rows）与 runtime 行（statuses）含同名 in-process → 双份导航/页面 | 合并前按 name 去重（首见优先），单视图单实现 |
| G6 | 双路去重在 factory 闭包内 + rows.enabled 恒 true | src/tenant-runtime-factory.ts:1600-1619 | 去重不可独立审计；config 禁用 model-registry 时 plugins.list 仍报 enabled:true（与 ensureActive 404 矛盾） | 抽出 `registerInProcessPluginEntries`（assembly 单实现）；enabled 取 `pluginEnabledInConfig` |
| G7 | web 两套 base 归一化/拼接（RPC vs 资产） | protocol.ts currentOrigin+ctor / plugin-contributions.ts resolveNodeOrigin | 1a075344 修了资产侧 new URL，但归一化/回落仍是两份实现，继续漂移风险 | url.ts `normalizeBaseUrl`/`pageOrigin`/`joinBaseUrl` 单实现，六处消费点全接入（§5） |
| G8 | 机制边界未显式化 | manager.ts 多处 | 下一个修 bug 的人无法区分「child-only 是设计」与「漏了 in-process」 | §1 两张表所列注释全部落进代码；types.ts PluginStatusEntry.mode / PluginHostManagerLike.statuses 文档同步 |

基线已修点复核（未重复修）：ensureActive in-process 放行（manager.ts:903-909）✅；
staticMounts in-process（:1280-1295）✅；双路去重（现 assembly:246-276）✅；
资产 URL 代理前缀（现 joinBaseUrl 单实现）✅。

## 7. 不变量（owner + oracle）

判真口径（宪法）：**owner 负责代码正确性；oracle 是用户本人的行为验证与产物读数**，
不是 AI 自写脚本。「跑一遍全绿」不构成验收。

| # | 不变量 | owner | oracle（用户行为 / 产物读数） |
|---|---|---|---|
| I1 | 启用 model-registry 后，平台代理模式打开其页面走 embed 档（非 iframe），资产 200 | q-serving（G1/G4/A5-A14） | 用户浏览器打开模型管理页：Network 里 `/nodes/<id>/plugins/model-registry/ui/embed/index.mjs?v=<hash>` 200 且 Content-Type: text/javascript；页面渲染为内嵌组件 |
| I2 | 禁用 model-registry（config enabled:false）后，页面/资产 404、RPC method_not_found、plugins.list 报 enabled:false | q-serving（G2/G6） | 用户改 config 后刷新：导航消失；直访资产 URL 得 404 JSON（code 前缀 plugin_activation_failed） |
| I3 | 双路登记（provider 路 + 通用装载路）同时触发不崩、只登记一次 | q-serving（G6/A3） | 用户正常启动 node（显式启用 model-registry）：启动日志无 plugin_id_conflict；plugins.list 中 model-registry 仅一行 |
| I4 | 代理前缀 /nodes/<id> 在 RPC 与资产 URL 中都保留 | q-serving（G7/§5） | 用户代理模式操作：Network 中所有数据面请求路径以 /nodes/<id>/ 开头，无落平台根的 /plugins/* /v1/* |
| I5 | child 插件懒激活链不回归（首次页面访问 spawn→静态 200；禁用→404） | q-serving（链 B） | 用户启用任一 child 体验插件并访问其页面 |
| I6 | 静态服务 containment：穿越/symlink/未知 entry 一律 404，不回落 SPA | q-serving（A14，既有逻辑未改） | 用户/运维抽查 `/plugins/<id>/../...` 类请求得 404 |
| I7 | plugins.list 单视图无同名双份；in-process 行带 mode/status/ui_* | q-serving（G5/G1） | 用户读 plugins.list RPC 响应（或控制台插件页）：model-registry 一行、mode:'in-process'、status:'active' |
| I8 | 构建门禁：typecheck（根+examples+apps/web）+ biome ci 全过 | q-serving | `bun run build` 独立 exit code + 输出证据（§8）；产物读数 |

## 8. 门禁读数

唯一门禁形态：`bun run build`（= typecheck 根+examples+apps/web + biome ci .）。
日志：个人侧 `D:/Application/APP/Vessel/docs/dev/tmp/q-serving/gates.log`。
判定：独立 exit code + 输出证据（`error TS\d+` / `Found N error` / 末行 `📦 Build complete!`），
不只看 WSL 返回码（L-047：退出码可能被吞成 0）。

读数（gates.log，三次运行；回报只留 exit code + 失败摘要）：

| 运行 | typecheck | lint（biome ci） | GATE_EXIT_CODE | 备注 |
|---|---|---|---|---|
| RUN 1 | ✅ | ❌ 3 errors | 1 | 3 个 error 全在本切片两个 web 文件（plugin-contributions.ts format / protocol.ts organizeImports+format）；`biome check --write` 修复 |
| RUN 2 | ✅ | ✅（0 errors；22 warnings / 39 infos 为存量，非本切片文件） | 0 | 输出含 `📦 Build complete!` |
| RUN 3 | ✅ | ✅（0 errors） | 0 | 最终树复核；输出含 `📦 Build complete!` |

首错原文（RUN 1）：`apps\web\src\domains\plugins\plugin-contributions.ts format — × File content differs from formatting output`。

## 9. 遗留（不在本轮）

- 直连模式跨源 CORS 缺口（1a075344 注明另批）：iframe 直连 node 时 ACAO 未开。
- in-process 事件面：manager 事件管道是 child-only；能力插件如需事件，由 core 运行时
  装配接线（本轮仅显式化边界，未新增机制）。
- `stopAll` 是终态关闭：之后 in-process 登记记录仍在但 RPC 已 clear；不应再服务请求
  （既有语义，注释显式化）。
- worktree 收尾由 main 合并后统一删。