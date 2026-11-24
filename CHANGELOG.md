# Changelog

> 本文件是 O(1) 当前态：**只保留当前版本的变更摘要**。
> 所有历史版本在 [`docs/versions/`](docs/versions/INDEX.md) 中按版本一文件保存，
> 索引见 [`docs/versions/INDEX.md`](docs/versions/INDEX.md)，当前版本见
> [`docs/versions/CURRENT.md`](docs/versions/CURRENT.md)。
>
> 变更记录遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 0.x 阶段：breaking 变更走 minor，功能点/新功能走 patch（第三位 +1），修复走 patch；minor 留里程碑收口。
> 管理规则见 [`docs/DOC-MANAGEMENT.md`](docs/DOC-MANAGEMENT.md)。

## [0.56.1] - 未发布

> 红蓝开发首轮晋升（金丝雀验收后合入 main）。**功能点起 patch 递增**（用户裁决 2026-11-24，见 RELEASE §1）。

### 新增

- **早退修复 + 无感重试**：tool-calling-loop 空响应 nudge 兜底（限次防死循环）+ `emptyResponse.seamless` 无感重调（空轮发布前丢弃，零疤痕）；设置 `enabled/seamless/maxRetries/nudge` 四路同步（YAML/config.set/CLI/WebUI）。
- **VSCode 式设置（S1–S6）**：可检索弹窗（分类树/搜索 @token/用户·工作区层）+ **插件设置域自动发现**（manifest `contributes.settings` 透传归一化，装上即出现）+ `plugins.config.set` 写 RPC + **默认视觉契约**（系统消息默认隐藏、设置入口右上角齿轮替换 gateway 图标，`specs/default-visual-contract.md`）。
- **federation peer 动态管理 CLI**（`vessel federation peer add/list/remove` 热应用）+ **CLI node targeting**（`--connect`/`--node` 任意 node 建 agent）+ 双舰队接入指南。
- **显示修复**：async bash 完成通知来源归 `tool:bash`（前端「来自 bash」）+ 环境信息增量卡运行中 live 可见（`buildLiveItems` 投影 `message.injected`）。

### 修复

- **issue-0**：`plugins[]` 热应用引擎注册表/成员工具面轮边界原子收敛（消除「模型被广告却执行不了」窗口，保留 opt-in 语义）。
- **issue-1**：工具输出落本舰队 `dataDir`（bootstrap 设 `VESSEL_DATA_DIR`，修隔离缺口）。

### 变更

- **计划 C**：src 大重组（139 文件 → 14 领域 + shared，`cli.ts` 唯一顶层入口，944 import 精确重写，11 处运行时路径暗礁修正）。

## [0.56.0] - 未发布

> 本节只写**已在 main 上落地**的条目（0.54.0 收口线 `c31dba42` 之后）。真机读数逐字引自对应
> commit message（实施切片的真机取证，标「来源=commit message」）；**未标注读数的条目行为验证归用户**。
> 不按「计划」写。历史版本段已迁 `docs/versions/`（0.54.0 → [0.54.0.md](docs/versions/0.54.0.md)）。

### 破坏性（升级须知）

- **`#token=` 退场为一次性引导码（P2 认证）**（`merge 966395fc` / `552badba`，feat `067ba8cb`）：
  URL 里的 `#token=` / `#bootstrap=` 不再是长期平台 token 的导入方式，只作**一次性引导码**（单次 + 10 分钟），
  提交 `POST /auth/bootstrap` 换引导会话；引导会话只能设口令（`/auth/password/set`）/ 绑 TOTP（`/auth/totp/enroll`），
  `/auth/setup/finish` 轮换成正常会话。**重放已用引导码 ⇒ 409 + 撤销它当初签发的会话（含轮换后代）+ 告警**。
  旧 URL 里的长期平台 token 从此不再是登录方式。口令/TOTP/限速细节见「认证与登录」。
- **成员快照 v4→v5：读侧一次性全清旧 `model` 字段**（`merge 26846d35`，feat `3de5f823`）：
  无法区分历史显式 pin 与烧进去的缺省值（D2 批准），升级后**所有旧会话跟随 config 缺省模型，需重新显式 pin**。
  首次写 v5 前留 `.v4.bak`，备份失败放弃写入；旧二进制不认 v5；回滚顺序 = 停进程 → 恢复 `.v4.bak` → 回退二进制（不能反）。
- **事件订阅缺省作用域收紧**（`merge 8949b016`）：服务端对**不带 `session_id`/`run_id`/`types` 的订阅缺省 0 帧**；
  全局流必须显式 `allow_global`（WS/RPC 参数或 `?allow_global=1`）；`events.subscribe` 的 `stream_url` 现在带回作用域参数。
  客户端 `acceptOwner` 归属校验：外会话帧丢弃 + `droppedForeign` 计数 + 首条 warn；作用域订阅成功后才盖章；正常订阅不丢帧。
- **inbox 语义改「read 就是拿走」**（`merge 69bd1108`）：工具层 `read` 取正文即消费（unread/held 一视同仁），
  held 先撤 queued run（结果新增 `delivery_cancelled`）；**工具层 `claim` / `includeHeld` 删除**
  （老 `claim` 调用当 read 别名 + note，`includeHeld` 容忍并忽略；`agents.claim` RPC 保留给 web 条带）。
  `list` 只回 `{id, ts, source, preview(前 40 字符), more_chars, held}` + additive `chars`，正文不再出现在 list。
- **上公网 P0 四项最严口径（默认生效）**（`merge f28cf7fd`）：① 平台 fail-closed：非回环监听 + 无 `gateway.token`
  ⇒ 拒绝启动（`platform_listen_insecure`，文案含两条可复制修法；restart 守卫在停旧实例之前）；
  ② `platform.nodes.credentials` 必须 `mode==='token'`（回环匿名不再是凭据来源，错误码沿用 `platform_unauthorized`、
  message 换可操作文案；`nodes.list` 匿名只读面不变）；③ hub 三个回环判定（目录/单节点/删节点）在配了
  `hub.proxy_secret_env` 时要求 `X-Vessel-Proxy-Secret`（本机 `vessel hub directory` / `hub node rm` 自动带头，不自阻）；
  ④ `vessel doctor` 新增 `[warn] exposure`（只提示、不改退出码口径）。
  实测（来源=commit message）：回环无 token ok / `0.0.0.0` 无 token 拒绝启动 / 非回环带 token ok、无凭据 401 /
  配 proxy secret 缺头错头 401、正确 200；credentials 回环无凭据 401、带 Bearer 200；hub 三端点缺头 401/403、带头 200、WS 4401。
- **回环匿名改 opt-in**（`merge e9a6283a`，feat `dcd26463`）：`auth.allow_loopback_anonymous` **缺省 false**；
  开启才恢复「本机直连免登录」（判据 = 开关 true ∧ 回环 socket ∧ 未被证明是受信反代 ∧ Host 指回环），
  只影响「是否要求身份」，origin/CSRF/Bearer 三闸不变；开启时 validator 出 warning（任何本机进程免登录，共享/公网不要开）。
  背景：未配反代密钥时 `viaProxy` 恒真 ⇒ `localDirect` 恒假，免登录曾是死代码。

- **日志行格式变更（日志中枢，`feat/gateway-log`）**：
  - **去掉 `[vessel]` 前缀**（pretty 与 json 都去）。pretty 改 `时间 LVL 事件名 k=v` 单行
    （TTY clock / 落盘 iso）。grep `[vessel]` 的运维脚本请改 grep 事件名；`vessel logs tail`
    只读行、不依赖前缀，不受影响。
  - **json 逃生阀形状统一**为单行 `{time, level, event, ...fields}`：原 core Logger 的
    `{time,level,message,fields:{...}}` 与 logEvent 的 `[vessel] {"event":...}` 两种形状合并
    （Logger 的 message 进 `event` 位）。`VESSEL_LOG_JSON=1` 或 `observability.log.format: json` 开启。
  - **info 级事件行从 stdout 改到 stderr**（诊断只走 stderr 红线）：只抓 stdout 的管道会少这部分行。
  - **`createStderrLogger` 不再接受 options**（`LoggerOptions` 的 level/redact 移除，仓内无调用方受损）：
    阈值与脱敏由进程级中枢统一控制；嵌入方要自定义 sink 仍注入自己的 Logger 端口（ADR-069 不变）。
  - 回滚方式：revert 对应 commit 即恢复旧格式（前缀 / 双 JSON 形状 / console.info 通道）。

- **`serve:` 段移除**：`serve` 从此**不是配置块**，写它就**启动失败**（`exit 2`），整块一个键都不生效
  —— 不是「警告 + 照旧生效」。文案逐键给出可照做的改名提示（`serve.token -> node.token`、
  `serve.token_env -> node.token_env`、`serve.allowed_origins -> node.allowed_origins` …），
  用户复制改名即可，字段名与语义一个都没变。为什么现在动：`serve:` 是 0.3 时代的名，`vessel serve`
  命令 0.49 就没了；留着两个名字读同一份字段，`doctor` 和启动迟早会漂开。同步落地：loader 拦住并**丢弃**
  该块（绝不静默生效）、验证错误路径一律写 `node.*`、脱敏路径 `serve.tokens.*` → `node.tokens.*`
  （token 永不打印这条不变）、`vessel doctor` 的 `config` 一行直接显示这条错误（状态 `fail`）。
  口径见 [operations/CONFIG §2.0](docs/operations/CONFIG.md)、[operations/REMOTE §3.1](docs/operations/REMOTE.md)。

- **`events.ndjson` 的读写代码全删：0.54 之前的会话格式不再支持**
  - 删了什么：`packages/core/src/session/session-event-log.ts`（整文件，旧日志实现）、
    `tenant-paths.ts#sessionEventsFilePath`、`timeline/freeze.ts`（只读冻结整块）、
    `TimelineWriter` 的 `adoptLegacyShapedSession`、`src/session-migrate.ts` +
    `src/session-migrate-command.ts` 与 CLI 的 `vessel session migrate`（含 help / completion /
    i18n 条目）、双写旁路里的 `frozenSessions` / `counters.frozen_sessions` 与两层时间推断
    （构造时快照 + 旧日志首条 `ts`）。
  - 现在会怎么坏：**旧格式会话（只有 `events.ndjson`、无任何 timeline 标记）读不了**。
    `sessions.get` / `sessions.events` / `events.subscribe{after_timeline_seq}` 会拿到
    `legacy_session_unsupported`（取代 `session_frozen_readonly`，serve / rpc / core 三张错误码表同步），
    文案写明「不读、不写、不迁移；用 0.54 导出后再用 0.55 打开」。**不静默降级成空会话**
    —— 那会让人以为历史丢了却不给原因。写侧同样拒绝（避免造出半新半旧的目录）。
    判据仍只有一处：`packages/core/src/timeline/legacy-format.ts#assertSessionFormatSupported`，
    读口 / 写者 `open()` / 索引写回三处调用。
  - 用户该怎么办：旧备份或老数据目录先用 **0.54** 跑一次 `vessel session migrate <id>|--all`
    （或直接用 0.54 打开把会话导出来），再把产物交给新版；新版本自己不读、不写、不迁移。
    新版起**没有** `vessel session migrate` 这个命令了。
  - 口径见 [event-log-policy §1](docs/architecture/event-log-policy.md)。
  - **已知遗留已解决**：usage 插件数据面已在本版迁到时间线（见「性能 / 语义变更」首条），不再读 `events.ndjson`。

- **`timeline_source` 四件一起删：帧字段 / 读源标记 / 老格式退回路径 / `gap` 帧**
  - 删了什么：① `hello.timeline_source` 帧字段（服务端 `frames.ts` / `protocol.ts` /
    `events.subscribe` 的 result 都停发）；② `TimelineReadFrom` 类型与 `read_from` 残留口径
    （`serve/gateway/timeline-protocol.ts`）；③ 老格式会话的退回路径（上一组删 `events.ndjson`
    之后它已经没有活分支，客户端那侧剩下的是「没有 `timeline` 段 ⇒ 老 epoch」这一条，保留）；
    ④ `gap` 帧整条链：`ServerFrame` 的 `kind:'gap'`、`frames.ts#gapFrame`、WS 背压补发 /
    心跳补发 / 回放缺口 / SSE 的三处发送点，以及客户端的 `onGap` 订阅与 `offGap` 分支
    （`GapFrame` 类型、`TimelineGapSource` 的 `'server'` 成员一起删）。
  - 判据换成**形状**：客户端 `readHelloTimelineSegment` 只看 `hello` 上那六个键在不在
    （`apps/web/src/gateway/node/protocol.ts` 的 wire → 内部形状映射仍只有一处）；服务端
    `helloFrame` 只在有时间线段时才带那几个键。
  - 现在会怎么坏（**用户视角**）：**升级后请刷新页面**。48 小时内
    没刷新的老前端还靠 `timeline_source` 判读：服务端停发该键之后它会把这趟当成老 epoch，
    于是 ① 不做四条 count 校验、② 忽略 `timeline-epoch-end`、③ 看到假缺口（表现为时间线上
    一条「这一段读不回」的污点条）。刷新页面即恢复（新前端判形状，不依赖该键）。
  - 老服务端（0.54）不受影响：`timeline_source` 只是被当成未知键忽略，而新前端读的是同一批
    形状键，四条校验照旧生效。
  - 口径见 [gateway-rpc §订阅 epoch](docs/architecture/gateway-rpc.md)、
    [events](docs/architecture/events.md)、[session-replay](docs/architecture/session-replay.md)。

### 认证与登录（auth-strategy / origins-core / login-ui / web-avatar / node-autojoin）

- **P2 认证：口令 argon2id + TOTP + 恢复码 + 限速**（`merge 966395fc`）：口令 argon2id
  （m=64MiB, t=3, p=1，参数写进 PHC 串；无 `Bun.password` 退回 scrypt 并 fail-closed）；hash 只来自
  `password_hash_env` 或 `<dataDir>/auth/credentials.json`（0600）；**配置写明文口令 validator 直接报错**；不生成默认口令。
  TOTP：RFC6238 / 6 位 / 30s / ±1 步；同 step 只接受一次（`totp.lastStep` 单调持久化，重启仍拒 `code_replayed`）；
  配了 `totp_secret_env` 或绑过 TOTP ⇒ 登录必须二因子（无开关）；恢复码 10 个一次性、只存 sha256（`/auth/recovery/rotate`）。
  限速：IP+账户双维度，递增延迟 `min(250ms*2^(n-1), 8s)`，15 分钟内 8 次锁 15 分钟，状态落 `auth/lockout.json`
  重启不清锁；`/auth/unlock`（回环+平台 token），429 文案自带可照抄命令。配置键（YAML）：`auth.backends[].kind: password`、
  `username`（缺省 admin）、`password_hash_env`、`totp_secret_env`、`label`。路由面：`/auth/login`、`/auth/login/totp`、
  `/auth/bootstrap`、`/auth/password/set`、`/auth/setup/finish`、`/auth/totp/enroll`、`/auth/recovery/rotate`、`/auth/unlock`。
  不破坏可用性：不配 `auth.backends` / `auth.enabled:false` / 回环匿名 `whoami=anonymous` 全过；github_oauth 缺
  public_origin 只摘掉该后端（口令后端照跑）。实测（来源=commit message）：口令错误 401 → 正确 200 且 totpRequired；
  8 次失败 rate_limited 且正确口令也被拒；unlock 后 200；TOTP 同 step 第二次 code_replayed；恢复码一次性；
  引导码首次 200、第二次 409 且旧 cookie 失效、日志有 revoked N；两份日志里口令/TOTP secret/恢复码/argon2 串命中 0。
- **单一根密钥 + HKDF 派生 token + `--data-dir` / `--user-config` 全族**（`merge 0c9efe5d` / `f727d101` / `1c063c39`，
  feat `fbc758ae`）：根密钥 `<dataDir>/root-secret`（32 字节、base64、0600，首次启动自动生成；权限不对拒绝启动
  `root_secret_insecure_permissions`，文案给 chmod 命令）。派生：HKDF-SHA256(root, salt=`vessel/v1`,
  info=`vessel:<purpose>[:<id>]`, 32B)，purpose = platform / hub / node:<nodeId> / proxy:<instanceId>；派生值带 `vsk_`
  前缀（base64url）；同 root+purpose 跨进程恒等，rotate 全换。优先级：**显式配置 > 注入 > 派生**。
  `token show`（仅回环+交互）/ `token list`（只给指纹，不创建 root）/ `token rotate`（一并轮换「登记 node 跑在自己
  dataDir 时那儿的 root」）；doctor tokens 行逐条标 explicit/derived + 指纹。`--data-dir` 覆盖 gateway
  start|stop|restart|status|list|nodes list|nodes remove、node start|status|stop|reload、doctor、token show|list|rotate；
  优先级 `--data-dir > VESSEL_DATA_DIR > 项目 config > 用户 config`；只覆盖数据目录；spawn 的 daemon/node 子进程继承。
  `--user-config` 只替换用户配置层、不参与子命令解析，子进程继承；读不到 exit 2 +「建空文件或去掉该参数」文案；
  doctor 回显路径（不含内容）。同单：web 产物缺失改可操作失败（新增 `build:web` 脚本、检查前移到启动信息之前、
  文案给「`bun run build:web` 或 `VESSEL_STATIC_DIR`」、doctor 新增 web 行）。配套真 bug 修复：新增
  `explicitPlatformToken` —— 只有显式配置才算「已配置」，否则派生值恒在 ⇒ 回环豁免消失（事故回归）。
  配置层弃用警告现在在 gateway start/list 等命令逐条可见（原先只有 REPL / config show），不含任何值。
  `serve:`→`node:` 改名见「破坏性」。实测（来源=commit message）：两 node_id 派生不同且跨进程重算不变；
  rotate 后旧派生值 401、新值 200，显式 token 不受影响；0644 ⇒ 拒绝启动；同机两实例 gateway list 互不可见、
  默认实例不受影响；对 B rotate 后 B 指纹变、A 的 root 与派生值不变。
- **WebUI GitHub 登录（单用户）+ 三个挡登录页的缺口**（`merge 3e730e64`）：单用户白名单按**数值 GitHub id**
  （`allow_user_ids`）；redirect_uri 只由 publicOrigin + 固定路径拼；state 一次性 + 10 分钟专用绑定 cookie
  （会话 cookie 是 Strict，跨站回跳不带它）；access token finally 置空。会话基座：只存 sha256(sid)、256bit CSPRNG、
  登录轮换+重发 CSRF、空闲 30min/绝对 12h、落盘 0600；cookie `__Host-vessel_sid` + HttpOnly/Secure/SameSite=Strict；
  CSRF 同步令牌（缺/错/跨 Origin 分别 403）。三个缺口：① hostAllowed 认公网域名（publicHosts 来自 `auth.publicOrigin`，
  Host/X-Forwarded-* 只在「socket 属受信代理 ∧ proxy secret 成立」时采信）；② 401 闸后移到静态资源之后
  （登录页本身能加载）；③ CSP 的 ws/wss 由受信边缘有效协议推导（经反代下发 wss，直连回环仍 ws）。
  自愈：auth 配错只降级为「未启用登录」+ 告警，gateway 照常启动。
- **登录页恢复：多 provider OAuth 品牌按钮（Vessel 风格）**（`merge c4576e00`，feat `54038aeb`）：
  auth 策略化收口时富登录页被极简版顶掉（只渲染 github_oauth，且用了 `bg-page`/`text-page` 死类）；
  从已删 wip `96245dd7` 逐字节恢复（已验证 `067ba8cb` 是其祖先、main LoginPage 此后未变；口令/TOTP/恢复码逻辑保留 main 版不动）。
  品牌按钮 **github / microsoft / gitee**（`OAUTH_ICONS` 按服务端 id 取图标，实心填充），任意组合逐个渲染；
  未知 provider 只是没图标，label 与 startPath 都来自服务端（`/auth/status`），前端不硬编码 provider 清单
  （`oauthBackends = backends.filter(kind !== 'password')`）。Vessel 风格：L2 `Button`/`Field`/`Input`/`Icon` + L1 token
  （`bg-bg`/`border-line`/`shadow-elev-1`/`text-title`/`bg-sunken`/`danger-soft`），独立全屏页不套 PageScaffold；
  title 恢复「登录 VESSEL / Sign in to VESSEL」。点击 `window.location.assign(backend.startPath)` 整页跳转 →
  `GET /auth/<provider>/start`（服务端签发一次性 state + PKCE，302 去 provider）→ 回调已泛化为 `/auth/<id>/callback`；
  state 不经前端存储，平台 RPC 挂了也能走。无口令后端时第一个 OAuth 按钮是 primary，其余 plain；
  错误位额外显示原始错误码本身（排障分界线）。删写死 GitHub 的 redirectUri/CALLBACK_PATH + 孤儿 i18n 键
  （`auth.login.subtitle` / `auth.login.redirectHint`，zh/en 同步）；`auth.error.*` 保留 main 已泛化版不回退。
  行为验证归用户（开 /login）。
- **策略注册表 + `GET /auth/whoami`**（`merge 99c7f59e`，feat `5426aebe` / `3bae030e`）：
  `packages/config/src/auth-strategies/`，`AuthStrategy = {id, kind, label, allowUserIdsShape, authorizeUrl,
  handleCallback, identityOf}`，Map<kind, strategy> + BUILT_IN_STRATEGIES；**加 provider = 一个策略文件 + 注册一行，
  不改 validator**。kind 开放取值：github_oauth / microsoft_oauth / gitee_oauth / password。`allow_user_ids` 语义按 kind：
  github 数值 id；microsoft Graph objectId（GUID/16-hex，大小写不敏感）；gitee 用户名或数值 id；password 不适用（配了报错）。
  报错文案点名 backend 下标 + kind + 期望形状 + 正例 + 当前注册 kind 清单。`GET /auth/whoami`（与 RPC `platform.whoami` 区分）
  返回 identity / node / team / backends / auth_mode，**未登录也可调用**；backends = 当前启用且真能发起登录的策略；
  node/team 由组合根注入，未接线时恒 null。
- **401 自解释入口 + 矛盾组合告警**（`merge 04de80f0` / `5c9bb671`，feat `9917fab6` / `5a62537e`）：
  `sessionRequiredMessage(origin)` 指到**当前请求 origin 的 /login**，说清会话 cookie 按 host 区分
  （127.0.0.1 登录过再开公网域名 = 突然全 401）；删掉失效的「回环匿名」承诺。取证：8644 是 node API 只认 node token，
  8642 数据面唯一入口 `/nodes/<node_id>/…`。`gateway.proxy_nodes: false` × 配了 `auth.backends` ⇒ validateConfig
  一条描述式告警（不报错、不新增配置项）：浏览器拿不到 node token（credentials 只发持平台 token 客户端），
  数据面会 401 除非手工粘平台 token。配套 [TROUBLESHOOTING-401](docs/operations/TROUBLESHOOTING-401.md) 文档。
- **origins 收口：`http.allowed_origins` 与 `auth.public_origins` 拆职**（`merge 0342a8cb` / `99c7f59e` / `042170a7`，
  feat `b2fd0ae6` / `1ca21971` / `3bae030e`）：`http.allowed_origins` = 浏览器 HTTP 访问控制（谁能发 RPC），
  平台 origin 闸 / CORS / CSP 统一用它；缺省回落 `auth.public_origins` + 三条回环通配，显式配置即全权
  （`[]` = 只允许同源）。`auth.public_origins` = OAuth redirect_uri 来源选择，**必须具体 origin，端口通配一律拒**
  （validator + 平台启动 fail-fast 双报错）；回环通配 `http://127.0.0.1:*` / `localhost:*` / `[::1]:*` 仅
  allowed_origins 可用，`selectPublicOrigin` 永不返回通配条目。多来源选择：纯函数 `selectPublicOrigin(edge, whitelist)`，
  生效 Host 匹配 → 本机直连退白名单回环来源 → 否则 null fail-closed（`/auth/github/start` 500 `public_origin_missing`）；
  state 绑定选中 origin，callbackOrigin 不符 ⇒ `state_invalid`；`public_origin` 保留兼容（= publicOrigins[0]，两键同写合并去重）。
  受信凭据跳 origin 闸：bearer 验过（`credentialVerified`）才跳白名单，cookie 会话路径仍逐条过闸。
  CORS：命中判定走 `originMatchesAllowlist`，回显请求 Origin（绝不 `*`）+ `Vary: Origin`；Allow-Credentials 只在
  `credentials:true`（平台 cookie 路径）且命中白名单时给；预检允许头补 `X-Vessel-CSRF`；node 侧纯 bearer 不传 credentials。
  relay 受信 origin 声明：头 `x-vessel-origin`，采信三选三（密钥已配置 ∧ `edge.viaProxy` ∧ `edge.proxySecretOk`；
  未配密钥时 `proxySecretAllowed()` 恒真，不能当受信依据）；dev vite 代理发送端密钥 `VESSEL_PLATFORM_PROXY_SECRET`
  否则 `VESSEL_DEV_RELAY_SECRET`，声明值 `VESSEL_TRUSTED_ORIGIN_CLAIM` 否则浏览器 Origin，都没配 ⇒ 什么都不发、行为逐字不变。
  实测（来源=commit message `042170a7`）：回环直连 302 redirectUri=http://127.0.0.1:8642/...；伪造 Host evil.test 403；
  伪造 XF-Host 无密钥仍回环 302；受信代理 redirectUri=https://egg-rolls.top/... 且 CSP 含 wss://egg-rolls.top；
  伪造域名 Host 无密钥 403；只写 public_origin 时与基线逐项 diff 逐字相同。
- **反代共享密钥闸（opt-in，默认关，默认行为一字不改）**（`merge 78c440de`）：键 `node.proxy_secret_env`
  （只存环境变量名；旧名 `serve.proxy_secret_env` / `gateway.proxy_secret_env`）。配了则「回环」= 回环 socket ∧
  `X-Vessel-Proxy-Secret` 定长哈希 + timingSafeEqual；带 Bearer 语义不变；node 无凭据 HTTP/WS 首帧必须带头。
  威胁模型：同机反代下 requestIP 恒 127.0.0.1，凭据端点只查回环 ⇒ 一条无凭据 POST 可取走全部 node token
  （node 侧映射 admin），hub 可被匿名吊销 token（DoS）。口径见 [operations/REVERSE-PROXY](docs/operations/REVERSE-PROXY.md)。
- **头像：三级降级 + `/auth/avatar` 代取缓存 + 账号浮层**（`merge 7a8b9a4f` / `9b2ae882` / `acaf0b6a`，
  feat `604a8a39` / `afed9a92`）：头部圆形小头像，点开账号浮层五块 —— 身份（显示名+id+角色/团队 Badge）→
  当前节点（名字+状态点 up/connecting/down/unknown，多节点可切换）→ 登录方式（策略列表；已登录=重新登录/切换账号）→
  设置 → 登出；头部与浮层共用同一头像组件，同哈希同色。**三级静默降级**：`identity.avatarUrl` → `GET /auth/avatar` →
  首字母（404/网络错/不是图片都往下落；字符层常驻最底下，图片 onLoad 后淡入，无骨架屏无闪烁）；
  `whoami.avatarUrl` = 同源 `/auth/avatar?v=<sha256(subject.id)[:8]>`；未登录不问 /auth/avatar。首字母中文取首字、
  英文取前两词首字母（ada-lovelace → AL）；id 优先 name 兜底做稳定哈希 → 5 组两色 135° 渐变（色标全来自既有令牌，不新造颜色）；
  无身份走中性底+通用人形；img `referrerpolicy=no-referrer`。服务端：策略新增 `avatarOf(profile)` 两种形状
  `{kind:'url'}`（github/gitee 公开 avatar_url）/ `{kind:'graph-photo'}`（Microsoft 须带 token 取 Graph `/me/photo/$value`）；
  头像失败不带垮登录；Microsoft scope 增补 offline_access；token 只存进程内 AvatarService，会话文件永不存 token。
  **代取 = 服务端 fetch**：浏览器只认平台自己的 /auth/avatar，不直连各家 CDN，CSP img-src 保持 `'self'`；
  内存缓存正 1h / 负 5min / 上限 128 条；只收 image/*、>256KB 丢弃、单次 fetch 3s 超时；SSRF 闸：只代取公网 http(s)，
  内网/回环/云元数据不取，重定向落点也校验；未登录一律 404（不是 401，避免成为又一个「会话失效」提示源）；
  重启后内存令牌没了 → Microsoft 无头像。
- **node 自动加入 + 注册表派生来源集**（`merge dc98f3fb` / `f22666ff`，feat `163cce51` / `829397e5`）：
  以前浏览器连 node 要手写 origin 白名单，新机器/新端口/Vite dev relay 写漏 = 403 forbidden_origin / 401。
  现在 node `POST /v1/hub/join`（新增 entries loopback|private|public、capabilities、version、incarnation；
  `validateNodeRegistration` 按地址事实重算分类，声明不符即 400，且校验在消费邀请码之前 —— 400 不烧 code；public 必须 https）
  → hub 落 `registry.json` 并在 join 响应下发 trusted_origins → `vessel hub join` 写 `hub-node.json` →
  gateway 启动并入 node allowed_origins；平台启动时**读 registry.json 文件**（不打 HTTP，hub 可能还没起）派生来源集 D。
  三消费点：平台 CORS = D 的**回环子集**（唯一收窄点，只加不减）；平台 CSP = 全量 D；node allowed_origins = 全量 D；
  未传 derivedOrigins 时输出与旧版逐字一致。邀请码/重连：带 code 首注与轮转都放行；无 code + 有效 token + 回环 peer →
  同机自助重连（免新码）；否则 400 code_required / 409 node_exists；token 永不进 join 请求体。安全边界：loopback 无条件进；
  private 必须被本机网卡列表证明；public 永不进；fail-closed 输入异常 → 空集；`hub.token_ttl_days`（1–365，缺省 30）
  只影响新签发 node token。实测（来源=commit message `829397e5`）：回环派生 origin 被 ACAO 回显；私网 origin 无 ACAO
  但出现在 connect-src/frame-src；负向把收窄条件去掉后私网立刻进 CORS（已复原）。
- **修：假超时全仓收口（`AbortSignal.timeout` 在 bun 1.3.9 可能不触发）**（`merge 5892ddf1` / `ecd908c7` / `e7142771`，
  feat `c653e5af` / `19e84264` / `8adebb2e` / `e55644dc`）：根因（BUN-QUIRKS）—— `AbortSignal.timeout(ms)` 定时器是 unref 的，
  signal 只被一次挂起的 await 等待且无其它活跃定时器时，abort 永不到来，进程不报错也不动。唯一封装
  `packages/core/src/timeout.ts`（`startDeadline` / `withDeadline`：普通 ref 定时器 + AbortController，必须 dispose）；
  全仓一次性路径 **14 处**替换（CLI/探活、启动期 node supervisor 等 /health、平台节点注册探针、联邦投递、
  上下文摘要、AI 起标题、marketplace registry 拉取与安装包下载）；顺手修 config-write-apply 兜底定时器原本 unref 的反向坑；
  provider 两处已有 Promise.race + 显式定时器，未改。OAuth 令牌端点/用户端点两条腿各自 startDeadline + finally dispose
  （令牌腿挂住不吃用户腿预算）；refreshOAuthToken 同；avatar 删自写 startTimeout 改用 core startDeadline（消掉第二套）。
  TimeoutError DOMException 语义不变，超时与用户取消仍是两个错误来源。文档 [TIMEOUTS](docs/operations/TIMEOUTS.md) +
  [BUN-QUIRKS](docs/operations/BUN-QUIRKS.md)。附带修复：`allow_user_ids` 塞数字（如 `[174765587]`）原在 fold() 崩
  `value.trim is not a function` ⇒ 500，现非字符串（含空串）返回 null 不参与比较 → 302 `/login?error=not_allowlisted`；
  **不做 String() 强转**（`"undefined"` 会误命中白名单）；`normalizeAllowUserIds` 显式判 null 归 rejected；
  `isAllowlisted` 对非字符串白名单项拒绝而不是抛错。

### 模型管理（model-registry / model-follow / model-cli）

- **models 注册表 + ModelRef 解析 + legacy 字节等价**（`merge 004fca7d`，feat `0df19e27`）：新增 config 块 `models`
  （additive）：`models.default`（ref 字符串）/ `models.vendors.<id>` / `models.aliases.<alias>`="vendor/model"。
  YAML 磁盘 snake_case（ADR-019，loader snakeToCamel）：vendor 条目 `protocol` / `base_url?` / `credential?` 与
  `api_key_env?` 互斥 / `models.<wire-model-id>.prompt_cache?`；DTO/validator 用 camelCase。vendor id 形状
  `^[a-z0-9][a-z0-9-]{0,63}$`，`legacy:` 前缀保留；别名扁平（key 不含 `/`，别名→别名拒绝）；`models.default` 与别名目标
  必须命中注册条目。promptCache 三态：true 强开 / false 强关 / 缺省 auto（openai 兼容按模型名含 claude；anthropic 默认 true）。
  `resolveModelRef` 五段顺序：① 空 ref → 有效默认（`models.default ?? legacy 条目 model ?? defaultModelForProvider`）
  ② 别名精确命中展开 ③ 首个 `/` 切 vendorId+wireModel（model id 可含 `/`，只切第一段）④ 显式 `legacy:<name>/<model>`
  ⑤ 过渡兜底：未命中字符串原样作 wireModel 透传默认 vendor（P0–P2 保留，P3 删）。严格面：注册 vendor 下未注册 model
  立即 `ModelRefError`（code=unknown_vendor/unknown_model/unknown_alias，带候选）；legacy 条目保留透传、不受注册清单约束。
  legacy 兼容：`synthesizeLegacyRegistry` 把 provider.*（env 覆盖后）折成隐式 vendor `legacy:<provider.name>`，
  **无 models 块存量配置字节等价**；legacy promptCache 回落修复（provider.promptCache 是 vendor 级开关，legacy 条目
  任意 model 均回落它，与直传字节等价；注册 vendor 只取每模型 flag，auto 留 undefined 交插件默认）。
  env 优先级：VESSEL_MODEL 与 models.default 并存 env 赢。validator：KNOWN_CONFIG_KEYS+`models`，块键逐层查未知键；
  loader preserveConfigMapKeys 覆盖 models.vendors/aliases 与 vendor 模型清单键（用户自定义 id 属数据，不做 snake_case 改写）。
  Breaking：无（纯 additive + 字节等价）。
- **官方 in-process 插件 + 加密凭证库 + 多厂商路由 + 热应用**（`merge 14fa2112` / `9caa44f9` / `d6a67cf7` / `dc686279`，
  feat `31cc50fb` / `f9d80d18` / `f38aefdd` / `177a012f`）：core `Plugin.rpc` 可选入口 + `TenantRuntimeProfile.resolveModel`
  可选接缝（缺省路径逐字不变）；`manager.registerInProcess` 同一 PluginRpcRegistry/canonical 名/DTO 校验，in-process
  不进 entries/statuses（child 语义），声明 rpc 无 handler fail-closed，stopAll 的 rpc.clear() 覆盖注销，
  plugins.list contributions 生效。写原语 readUserConfigRoot/writeUserConfigRoot + withConfigLock 逐字移入
  packages/config（错误码 ui_settings_* 与锁语义保留；src/config-lock.ts 移空整删、不留兼容 re-export；
  marketplace 独立副本不动）。root-secret TokenPurpose+`{kind:'credentials'}` additive（`vessel:credentials`），
  platform/hub 逐字不变；`token show --purpose credentials` 显式拒绝（exit 2，防 else 兜底把平台 token 误标成 credentials 回显）。
  插件 `@vessel-agent/model-registry`（plugins/provider/model-registry，vessel.id=`model-registry`，无 entry → in-process，
  builtin → ui_trust 自动 embedded；permissions fs=[data-dir, user-config]、net=[*]、process=false、secrets=false、events=[]）。
  **凭证存 `<dataDir>/credentials.json`**（与 `<dataDir>/auth/credentials.json` 登录库互不消费）：信封
  `{v:1, entries:{id:{iv,tag,data,createdAt,updatedAt}}}`，AES-256-GCM；key=derivePurposeToken(root,{kind:'credentials'})
  去 `vsk_` 前缀 base64url 解码（32B）；atomicWrite 0600 + 模块级串行写队列；轮换 bump updatedAt；
  **root-secret 轮换 → 全部失效需重录**（D10，不做重加密迁移）；损坏≠不存在抛错；reveal 只供用户触发连通性测试，
  RPC/日志永不回显。registry-store：withConfigLock 内 read-modify-write + validateModels 写前预校验，只改 models 块，
  vendor DTO 未知键拒绝，写后读回。连通性两级：openai 系未指定 model → GET {baseUrl}/models（Bearer）；
  anthropic 或指定 model → 最小 chat（max_tokens=1）；单次 15s 不走 withRetry；error 经 redactor；自定义协议 → unsupported_protocol。
  路由（src/model-registry-wiring.ts）：registry 快照 + provider 实例缓存（键=`vendorId|凭证信封 updatedAt|promptCache flag`，
  不含 model，req.model 逐请求透传）+ delegating LLMProvider wrapper（每请求按当前键取/建实例，req 原样透传 —— 前缀不变量；
  凭证轮换 live EU 下一请求生效，无通知通道）；凭证 fail-loud：credentialRef 缺失/不可解密 → ProviderConfigError
  明确本地错误（D10），不发空 key 拿 401。**热应用边界**：provider 全域移出 RESTART_FIELDS + models.* 热应用（D5）；
  applier 泛化（from/to=有效缺省 wire model，next 转发重建快照+清缓存）；新 body/新 EU 立即用新值，
  live body/EU 的 model 是构造期只读快照，本具仍旧值、下一具才生效；解析不出有效缺省 → 变化域诚实进 requires_restart；
  不新增 reload scope/事件名；summarizer 消费同一 resolver；mock 不注入 resolveModel 走 legacy；
  `config.agent.model` 仍属 agent 域需重启。
- **RPC 十方法 + A+B 两个 additive 只读字段（用户已批）**（`merge d6a67cf7` / `cba7189e`，feat `56bcbdc8`）：
  `plugin.model-registry.*` —— `list`（read：vendors/aliases/default/effective/legacy；env 赢；无效配置 effective
  缺省仍回 registry 供 UI 修复；vendors 投影 id/protocol/baseUrl?/credentialRef?/apiKeyEnv?/models/inUse；
  effective={vendorId,wireModel}；legacy={present,ref?}）/ `vendor_set`（write：整条替换，未知键拒绝，写后读回）/
  `vendor_remove`（aliases/default 仍引用时拒绝）/ `alias_set` / `alias_remove` / `default_set`（返回 effective model）/
  `credential_set`（write-only 永不回显）/ `credential_remove`（vendors 仍引用时拒绝）/ `credentials_list`
  （read：只出元数据 id/createdAt/updatedAt/usedBy，无值）/ `test`（write：用户触发对已存厂商发真实最小请求）。
  权限档由 gateway 既有 token role（ROLE_RANK）判定，CLI/WebUI 均不绕。**A**：list 的 vendors 投影补 `apiKeyEnv`
  （环境变量名，非密钥值；VendorForm 预填凭证来源与变量名，消除「整条替换保存静默清除 apiKeyEnv」脚枪）。
  **B**：agents.* 读 DTO 补只读 `model?: string`（显式 pin；缺省=跟随节点默认，不写键）；挂点 MemberStatus /
  AgentStatusLike / TeamMemberSummary，agents.get/list/create/update 响应与 teams.get roster 全覆盖；
  AgentEditView 预填 pin（baseline 含现 pin，未触碰不重发；空值项=不修改保留现 pin）；MemberModelSwitch 打开时
  agents.get 读 pin → 预填+「当前固定」展示，读失败诚实降级，value===pin 禁保存（不发 no-op）；system_prompt 仍不进 DTO；
  写路径不变；live body 实际模型仍由 system_context.model 表达，不伪造 pin；旧 gateway 无 model 字段时 web 诚实降级不预填。
- **WebUI：vendors/credentials 管理页 + native ModelPicker + 成员模型切换**（`merge 2054e338` / `d043a9f5`，
  feat `f714120a` / `b9914eff`）：P2a 管理页（plugin-react embed + iframe 双档）：navGroups `plugin:model-registry`
  （order 45），pages `vendors`（VendorsView，vendors.html，order 10）/ `credentials`（CredentialsView，credentials.html，order 11）；
  nav zh-CN 厂商与模型/凭证、en Vendors/Credentials；activationEvents onPage:vendors / onPage:credentials。
  VendorsView：厂商列表/增改表单 protocol/baseUrl/凭证来源二选一/models+promptCache 三态/别名/default/测试按钮
  （文案「真实请求 · ~1 token」+ 结果 ok/latencyMs/models/error + 模型清单导入）。CredentialsView：元数据列表无值无片段、
  password+autocomplete=off 提交即清永不回显、两步删除+引用错误展示。permissions.events 保持 []（不新增事件名）→
  写后读回+手动刷新；保存文案「已保存，下一具 body/run 生效」；构建产物入 git（web/embed/index.mjs + index.css，
  @layer plugin.model-registry）。P2b native ModelPicker（apps/web/src/components/ModelPicker.tsx）：数据源唯一 =
  plugin.model-registry.list（当前节点 client.rpc / 远端 fetchNodeRpc）；选项 = 跟随默认空值项（当前：<effective>）+
  别名组 + vendor/model 分组；RPC 不可用 → 禁用占位不造第二数据源；非空未注册值原样保留+未注册标记（仅 ready 后判定），
  不静默丢；形状复用 plugin-ui Select。切换入口：AgentCreateDialog（model Input → ModelPicker，空=跟随默认不发送 model，
  只存显式 pin）；AgentEditView（留空=不修改，空值项「不修改（当前：<effective>）」）；chat/MemberModelSwitch.tsx =
  SessionHeader 标题行 chip（session.agent 存在才显示），走现有 `agents.update {model}`，**零新 wire 字段**。
  生效边界：live body/当前 run 不变，下一具 body/续接 run 生效+环境卡；空值禁保存（wire 拒空串，unpin 属另批）；
  「当前模型」读 sessions.get.system_context.model，不伪造 pin。i18n zh/en 15 新键。
- **`vessel model` CLI 子命令组（cli→rpc 控制路）**（`merge b2a45ce7`，feat `90b1dccd`）：10 子命令一一对应
  plugin.model-registry.* canonical RPC：`list` / `vendor-set <id> --entry <json>`（--entry 必填，JSON.parse）/
  `vendor-remove <id>` / `alias-set <alias> <ref>` / `alias-remove <alias>` / `set-default <ref>` /
  `credential-set <id> [--value-env <ENV> | --value-stdin]` / `credential-remove <id>` / `credentials-list` /
  `test <vendor> [--model]`。映射：set-default→default_set、credentials-list→credentials_list，其余 kebab→snake；
  前缀 `plugin.model-registry.`。公共旗标 `--json --connect --connect-token --ca`；连接走 resolveControlPlaneTarget
  （本地 attach 或 --connect，与 agents/status/errors 同口径）；write 权限由 gateway 既有 token role 判定，不绕。
  凭证纪律：credential-set 值不进 argv 明文，只经 --value-env / --value-stdin / TTY 隐藏输入（raw mode 不回显）；
  值绝不回显，credentials-list 只出元数据。test 发真实请求：人类模式发请求前向 stderr 提示成本；客户端超时 30s >
  插件内 15s。--json 原样输出 RPC 结果（纯数据无 ANSI）；人类输出走 ui+i18n（zh-CN/en），数据行英文。
  声明式面同步：cli-help-spec / completion-spec / cli-help 全局总览 / commands registry（ADR-060，不在 cli.ts 加 if 链）。纯 additive。
- **model-follow：record.model 只存显式 pin + 跨重启统一通知 + provider.model 热应用**（`merge 26846d35`，
  feat `3de5f823` / `e92483d5` / `eb539b9b`）：create/derive/rotate 不再把 defaultModel 烧进记录，derive/rotate
  继承源的显式 pin；删零消费的 AgentServiceOptions.defaultModel；agent 工具 model 参数描述改为显式 pin 语义。
  跨重启通知：复用已持久化的 SessionState.prompt_context 指纹（零新增持久字段）；EU（重）建后首个 run
  （executeRun/resumeRun 双入口）在首次请求前，存档指纹 model ≠ 当前 model ⇒ 追加一张 `vessel:notice`（scope=model），
  进本次请求、UI 同见；同一 A→B 过渡只报一次，回滚照报；Web 已认 scope=model，零 Web 改动。热应用：
  `provider.model` 移出 RESTART_FIELDS，config reload 原地改 owner profile + 成员宿主缺省模型；**只对此后 spawn 的
  body 生效**，live EU/body 的 model 构造期只读（前缀不变量），live 会话换模型须 rotate/重启；未注入 applier 时
  model 进 requires_restart；摘要器/标题生成/TUI 显示快照重启前仍旧值。v5 迁移见「破坏性」。
- **prompt cache 断点：OpenAI 兼容端点对 claude 模型自动打**（`merge 804fb176`，feat `99f1997a`）：
  OpenAICompatibleProvider 缺省按请求模型名自动 —— `/claude/i` 含 claude 才开；`provider.promptCache`
  （兼容 `prompt_cache`）显式 true/false 覆盖；真 OpenAI/DeepSeek 等自动缓存厂商不加（避免未知字段被严格端点拒绝）；
  anthropic 直连默认 true 不变。断点位置（最多 3 个，Anthropic 上限 4）：最后一个工具定义、最后一条 system 消息、
  system 之后最后一条可标记消息（assistant 跳过）；只附加 cache_control 字段，不改文本不重排（append-only 不变量不破）；
  tools 克隆后再标，不污染共享 ToolSchema。同时解析网关透传的 cache_creation/cache_read 计入 usage。
  实测（来源=commit message）：修复前「经 LiteLLM 等网关转发 Claude 时网关不自动打断点，实测 0 命中」；
  body 无修复后命中读数（行为验证归用户）。

### 插件面（plugin-react / 解析缝）

- **ADR-102 插件内嵌 React UI（embed/iframe 双档）**（`merge f39a7d40`，feat `91d88c1f` / `a1796339` / `e8a14ce7`）：
  信任判据 = builtin 自动 embedded；其他来源需显式 `trust_ui: embedded` + sha256 哈希锁，独立于进程权限条目；签名放 P4。
  样式前缀约定 + 构建期校验（不上 Shadow DOM）；一期只做 pages，mounts 放 P3；pages 必须保留 iframe 回退入口。
  契约 [plugin-embed](docs/architecture/plugin-embed.md)。manifest `ui.embed {entry, css, runtime:{react:"^19", sdk:"^1"}}` +
  `pages[].component`（具名导出），fail-closed 校验；contributes.http 保留 ui 首段；semver 搬家至 @vessel-agent/plugin-sdk
  并扩 ^/~（书写精度感知，node-semver 语义），plugin-manifest re-export 消费方不变。plugins.list additive wire 字段
  `ui_trust` / `ui_bundle_hash` / `ui_embed`；其他来源需 config plugins[].trust_ui: embedded + TOFU 哈希锁
  `<dataDir>/plugins/<id>/ui-bundle.lock.json`；无锁 → 钉住当前哈希（写锁失败 → isolated）；锁不等/损坏/读错误/symlink →
  isolated，不自动更新锁（P4 重新确认）；ui_bundle_hash = embedRoot 下全部文件按相对路径排序逐文件哈希。
  静态/代理边界：`/plugins/<id>/ui/<path>` embed 静态命名空间（剥 ui 首段）；入口/css no-cache，哈希 chunk immutable；
  realpath containment 不变；平台代理 `/plugins/<id>/ui/**` 仅 GET/HEAD 静态白名单（其他方法 405 proxy_method_not_allowed）；
  平台根 `/plugins/*` 仍 404；gateway 动态路由对 ui 命名空间让位（含 :param 首段）。CSP：script-src 追加冻结 import map
  的 sha256（`sha256-JsT6ZWwn6/2gf6Vl12MVmyYFCLzmESS0MeB1fBIVxb8=`，260 字节冻结 JSON），不引入 unsafe-inline/unsafe-eval；
  哈希与 import map 内容互为冻结契约，改一处必须同步另一处并重算。前端：main.tsx createRoot 前注册 `__VESSEL_SHARED__`；
  vite 产出 5 个稳定路径 vendor shim（react / react-dom / react-dom/client / react/jsx-runtime / @vessel-agent/plugin-sdk →
  /assets/vendor/*.mjs）+ 冻结 import map（head-prepend）；PluginEmbed loader（加载前 semver 核对 React.version/SDK_VERSION
  对 manifest runtime 范围 → 不满足 incompatible 错误卡+隔离动作；`import(url?v=ui_bundle_hash)`；取 module[page.component]
  具名导出，非函数 → failed）+ PluginErrorBoundary（重试/改用隔离）+ host 工厂（Object.freeze、rpc/events 白名单复核、
  按 pluginId 追踪订阅强制回收）；PluginPageView 按 ui_trust 选档，fail-closed 卡片回落 iframe；热更新按 ui_bundle_hash
  重挂载+dispose；index.css 预留 plugin 层槽位（legacy 与 utilities 之间），插件层不盖宿主 utilities；i18n plugins.embed.* zh/en。
  样本 usage 双产线（iframe classic-script 不变 + embed ESM lib），embed 产物入库带 biome-ignore 头，iframe 产物字节不变。
  已记录缺口：代理模式 iframe 回退先存不可用。**sdk 版本线独立**（e8a14ce7，裁定 4 纠正）：packages/plugin-sdk version
  `1.0.0` 独立版本线；bump 策略 = 仅 SDK 契约变更时 bump（additive→minor，破坏→major），宿主 React 主版本升级才升 major
  并写 CHANGELOG；仓库 release 版本不影响它；scripts/version.ts INDEPENDENT_VERSION_MANIFESTS 跳过 plugin-sdk
  （写模式不改、--check 不查）；usage 样本 runtime.sdk "^0.54"→"^1"。修复的问题：sdk 跟随仓库 0.x 时 caret 语义
  （^0.54 => >=0.54 <0.55）使仓库每次 minor 发版都让样本 plugin_ui_incompatible。SDK_VERSION 经 vite define 从
  package.json 注入，无第二份硬编码。
- **宿主为插件提供裸指定符解析缝**（`merge 9fecb6cf`，feat `a323b646`）：.tgz 插件不自带 @vessel-agent/*，
  市场安装器只解包不起包管理器；user 作用域（~/.vessel/plugins/<id>）上溯链没有宿主 node_modules ⇒ 裸导入必挂；
  repo 作用域上溯能碰到 workspace 链接，两种作用域不对称。做法（不引入打包流水线）：plugin-loader.ts 加载前在插件目录下
  补 node_modules，把白名单包软链到**宿主自己的包根**（ensureSpecifierFarm / hostPackageRoot，import.meta.resolve 上溯到
  package.json）；两边 realpath 相同 ⇒ 同一模块实例（枚举同一引用、instanceof 成立、单例不分裂）；必须在首次 import 前建：
  bun 1.3.9 缓存一次解析失败，重试仍报 Cannot find module；repo 作用域跳过。白名单
  `HOST_SHARED_PACKAGES = @vessel-agent/{core,agent,basic-tools}`（入选标准「第二个副本会出事」；plugin-ui 走浏览器打包不在表内）。
  缺包报错改可归因：`plugin "X" depends on "Y", which the host does not provide`（附宿主白名单 + 底层错误），
  不再裸抛 Cannot find module。反向纪律：插件不得从 core 做运行时值导入；doc-subscription 的 HookType 改字面量 +
  Hook['type'] 断言作示范；[plugins.md](docs/architecture/plugins.md) 新增「插件与宿主的模块边界」整节。

### 工具 / 运行时

- **工具名统一 snake_case**（`^[a-z][a-z0-9_]*$`，≤64）：判据收在
  `packages/core/src/runtime/tool-name.ts`（唯一真源）。之前只有 provider 那条下限
  `[A-Za-z0-9_-]{1,64}`，所以 `piiReveal` 这种驼峰能跑但生态上不一致（模型先验、MCP 落地面、
  大小写不敏感环境撞名、grep 搜不全）。本次改名：`piiReveal` / `pii.reveal` → **`pii_reveal`**；
  `ask_user` → `ask`（早前遗留）。**旧名保留一版**：别名表 `TOOL_NAME_ALIASES`（一处），
  `MemoryPluginHost.getTool` 统一解析，`tool-pipeline` 命中别名时把一行弃用提示追加进回给模型的
  结果（错误路径也带），`--tools` 末尾单列 `Deprecated tool-name aliases`；`src/legacy-tool-names.ts`
  改成从同一张表派生（配置层 `auto_approve` / `never_auto_approve` 的旧名换算与注册表不再各存一份）。
  **机制级校验两道**：注册期 `registerTool` 不合规直接抛（文案带正则与建议名，`badName → bad_name`）；
  装配期 `assertToolNameLegality` 全量扫描，挂在 `installPluginsIntoHost` 收尾、`bootstrap` 收尾、
  `--tools` —— 内置工具违规**列出全部违规项后失败**，不再等模型调用时才炸。**外部来源（MCP）原样透传**：
  走 `registerTool(def, { external: true, source: 'mcp:<server>' })`，同样过校验但只记 warning
  （装配日志 + `--tools` 的 warnings 可见），名字我们改不了，但不能不可见。规则见
  [docs/architecture/tools.md § 命名规则](docs/architecture/tools.md#tool-name-rule)。
- **tools-engine P2：核心工具 / MCP 迁 engine 子进程外置执行**（`merge 4074a263` / `383fbb83` / `45fc97ab` /
  `7d8a6dbc` / `799c47fc` / `94e66068` / `b1d12243`，feat `2b3feee7` / `29a0546a` / `799ae06c` / `a122d2c9` /
  `6163de44` / `b0786f5c` / `3fe23c9e` / `90d814c7` / `a2c34806` / `96d43c59` / `10dfd558`）：
  **最终架构**：每 host 一个 engine child（复用 ChildPluginProcess，合成 descriptor 不进 PluginLoader/catalog），
  child 内 worker 用 `createBasicTools({})` 同一份包源码。exec=worker：read/edit/write/bash(sync)
  （批次1白名单，wiring.ts 逐字 `['read','edit','write','bash']`）+ 全部 MCP 工具含辅助工具
  list_resources/read_resource/list_prompts（批次2）。exec=callback：bash 逐调用分流 `args.async===true`
  （jobs/通知槽/dispose 留 host）+ ask/inbox/agent/recall/pii_reveal 恒 callback（批次3）。留 node host in-process：
  web_search/web_fetch、subscribe/media/vessel 等未接线工具。MCP server 进程不变，改由 engine spawn 成**孙进程**；
  engine dispose 杀 server 孙进程。**方案 A「零新 canonical 方法」**：有状态工具的内部执行端点 = 原 handler 闭包
  （host 进程）；engine 只带关联 id（键 `JSON.stringify([run_id, tool_call_id])`），host 按在途 pending 记录执行原 handler，
  零 ctx 序列化、不新增任何 canonical RPC 方法；形状不过/查无/state≠pending 一律 callbackRejected fail-closed。
  permission/session 留 host：authorize 先于派发（host 侧 checkPermission 原闭包），engine 不判权限非沙箱；
  会话 journal/vault/Team 注册表等状态全在 host 原闭包里；成员面经 restrictPermissions spread 继承转发 handler，
  多 body inbox 按 pending 关联不串台。**批次1 隔离+热加载**：隔离 = child 崩溃不污染 host/tools[] 快照；
  重启走 PLUGIN_MAX_RESTARTS/PLUGIN_RESTART_WINDOW_MS 滑动窗口，预算尽 disabled fail-closed `engine_unavailable`
  （不静默回退 in-process），onReady → pushRegistry 对账。热加载 = cli tools applier 在 applyTools 后、refreshTools 前
  重接线（新 def 新指纹，移除 unwire）+ pushRegistry；boundary/config 每次装配与热应用用当时安装配置重建（host 权威）；
  接线就地换 handler（def 身份不变，WeakSet 防二次包裹）；预算三级 def.timeout > bash args.timeout_ms > 120s 缺省。
  **O2**：YAML `permission.bridge_deny`（loader snake→camel 自动映射 PermissionConfig.bridgeDeny），缺省 [] = 零变化；
  vessel-bridge guardrail 精确名匹配（别名经 core resolveToolNameAlias 单表）命中拦 call_tool，vessel 自身代码层硬排除。
  **O4**：core 仅 additive 落点 —— tool-pipeline 认领 takeToolTransport → ToolPipelineResult.transport；
  markBridgeCall(replacement)；loop started 带 via_bridge、EU completed/failed 带 transport/via_bridge；
  缺省不写 = 旧事件逐字节不变。**serve child.ts 通道**：`ChildProcessOptions.maxMessageBytes` 缺省 1MiB
  （体验插件不变），engine 通道 8MiB（write 工具内容上限 4MiB），超限折 plugin_payload_too_large；
  tool.callback 受限反向请求 = 关联-only，hook 未注入按未知方法拒，engine 不能注入任意调用；engineRequest timeoutMs
  可选，**缺省不设 per-request timer**（心跳守活），有预算时 host 宽限 +10s、worker 背停 +5s。wire 方法逐字：
  `tool.invoke` / `tool.cancel` / `tool.callback` / `engine.registry.sync` / `engine.impl.swapped` /
  `engine.impl.reject` / `engine.health` / `engine.mcp.control`；impl.swapped 指纹（canonicalJSON+sha256）
  对拍校验权在 host，不一致 → implReject+rejected。**批次2 MCP**：mcp-client 连接/传输/pending 迁 engine worker；
  `engine.mcp.control` 6 action 逐字：**configure / reconnect / listTools / listResources / readResource / listPrompts**；
  configure 请求-回包带工具集 → host 启动期同步注册（tools[] 快照时点不变）；`engine.health` notification additive
  `mcp?: McpServerStatus[]`，host client.ts 逐条机械校验（name/status/transport/tools 必备，不过整条忽略）重建透传存
  lastHealth（校验权 host）。注册语义抽取 registration.ts：registerMcpTools/registerMcpResourceTools（碰撞跳过+告警、
  external:true、source `mcp:<server>`、autoApprove 原始名精确匹配否则 ask）；ports.callTool 晚绑定 entry.connection ⇒
  **reconnect 换连接不换定义**。密钥同 PII 信任边界：engine 不持久化 config、日志只记 name/status（sanitizeLogText）；
  worker events=noop shim，事件全 host 发布；cli mcp applier/toggle/gateway RPC 零改动（createMcpControl 单实现）。
  修复（10dfd558）：engine-client 包无 vessel 清单 → loader 误扫成 in-process 描述符 → 默认插件集选中它 →
  load() 找不到带 install() 的 default export → 每次启动 console.warn+plugin.failed 噪声；修 = FACTORY_PLUGINS 增
  'engine-client'，cli MCP_FACTORY_PLUGINS 改引用同一份名单消灭漂移。**用户可见**：执行位置变了，
  工具面/权限/审批不变（def 身份不变、authorize 仍 host 派发前、tools[] 快照不受影响）。缺省：本地 bootstrap
  **恒启动** engine child（无配置开关）；connect 模式无本地执行面；library/tenant factory 缺省不接线（零变化）。
  唯一新配置键 `permission.bridge_deny`（缺省 []）。无真机读数（行为验证归用户）。
- **vessel 元工具：单工具面结构化控制面桥**（feat `22eba0bb`）：单工具 `vessel`（用户裁决，squash 掉被否的两工具 v1）。
  inputSchema（src/vessel-meta.ts 逐字）：`op` enum `['call_tool','rpc','set_config']` required；
  `tool_name`:string + `args`:object（call_tool）；`method`:string + `params`:object（rpc）；
  `key`:string + `value`（set_config，boolean 键给 boolean 其余 string）。**全走 RPC**：rpc/set_config 由 vessel 自执行，
  经 bootstrap localDispatcher（getter 晚绑定，装配完成前 undefined 即 fail-closed）`dispatch({v:1,id,method,params})`；
  set_config 固定走 `config.set` 既有白名单（permission.* 不可写、无自升级）；方法发现走 `capabilities.list`；
  params 原样透传给 dispatcher 的 normalizeParams/params_schema，不另造校验。**call_tool 走 guardrail 改写**：
  vessel-bridge（ToolCall stage，priority 40 先于 tool-policy 50）改写成目标 ToolCall，保留原 tool_call.id（C-05 配对）→
  authorize 落在**目标工具+最终 args**（ADR-058），auto_approve/checkPermission 按目标键控原样命中；目标可以是 live
  注册表任意工具（含 MCP），桥不放宽目标自身任何权限规则；目标不在注册表不在此拦，管道重 getTool 兜底标准 tool_not_found。
  **fail-closed 占位**：vessel.checkPermission 对 call_tool/未知 op 一律 deny，handler 永不转发（直达入口返回稳定错误文本）
  —— 关闭 guardrail 阶段的入口（EU delegate 等）无法绕过桥直达任意工具。**rpc 方法级分层**在 vessel.checkPermission
  （ADR-026 对最终 args）：manifest permission read→allow / write→ask / admin→deny / 未知→deny；硬禁名单逐字
  `permission.respond` / `ask.respond` / `permissions.setToolPolicy`（防自审批/自改策略）；ask/auto_approve/remember
  全走既有 PermissionPolicy；rpc 面 = 启动期冻结方法表+逐方法门（有界执行）。装配关系：src/vessel-meta.ts 装配层实现，
  core 零改动；不注册第二执行器只桥接；注册进 PluginHost 常驻 tools[]；hot-apply 排除元工具防 reload 误注销；
  与快照整合 = vessel 常驻冻结快照、桥够到快照外新工具。O2 bridge_deny 只影响桥可达性，不影响新会话直调。
  无真机读数（行为验证归用户）。
- **P0：tools[] 会话冻结快照 + 工具面变更环境卡**（`merge befda595`，feat `7db97411`）：请求 tools[] 从
  「每轮 live 读 pluginHost.listTools()」改为 EU 内按 sessionId 隔离的快照 pin（execution-unit.ts `ensureToolPin`），
  **懒捕获于该会话首条 LLM 请求**（listToolSchemas 读 pin）。映射形状与旧 live 读逐字相同
  （type:'function'+name/description/parameters）；宿主同名更新走 unregister+register 新对象不改写旧对象 ⇒ 快照内容稳定；
  provider 两条适配路径每请求新建/克隆 wire 对象，pin 不被 cache_control 污染；会话内 tools[] 不变保前缀缓存。
  **重建触发点**：新会话/rotate/重启续接 = 新 EU 重建；session_switch 与段起点压缩成功重 pin（D1）；
  同会话新 run/branch/pop 不重建。**环境卡**：每轮请求前 diff「模型相信的面」reportedToolSurface vs live 宿主名字集，
  非空 → 先推进 reported 再经 appendInjectedMessages 追加一张 `vessel:notice`（scope=tools，append-only，
  落 message.injected 事实，UI 同见）；不改 system、不发 prefix reason、tools[] 本身不动；受 envCadence gate。
  卡格式（context-notice.ts renderToolSurfaceNotice 逐字）：头行 `tools: N added, M removed; the request tool list
  is a session-start snapshot and stays fixed until a new session/body`；新增行 `+ name — description`（≤80 字符，D3）；
  移除行 `- name (removed; calls will be rejected)`；明细超上限折 `and N more`。MCP toggle/热应用/refreshTools/权限档/inbox
  都改同一宿主，下一轮 diff 自动出卡，零新触发代码。**执行侧零改动**：保持 live getTool，miss → 既有 tool_not_found
  优雅拒绝；新增工具 best-effort 可执行。**spawn 顺序不变式**：懒捕获在首条 LLM 请求 ⇒ spawn 期 registerTool 全部先于快照；
  批次3 agent 在 `registerTool(wiring.tool)` 后立即接线、先于 startOwner，inbox 经 inboxTool() choke point
  （spawn+热刷新共用）。**为什么是 vessel 桥硬前置**：快照冻结后「live 注册表 ⊃ 会话工具面」成为常态，
  vessel 描述明说桥用于「invoke a registered tool that is not directly callable in this session」；没有冻结快照，
  桥与直调面就没有稳定边界。D1–D6：删 zero-consumer tool-surface-delta.ts+8 导出、撤旧 createToolSurfaceDeltaHook
  防双卡；热应用 config 摘要卡与 tools 卡并存（D5）；跨重启工具卡/专门 removed 文案不做（D6）；PrefixChangeReason 未新增。
  无真机读数（行为验证归用户）。
- **新增 `write` 工具（建文件 / 整体替换 / 追加，逐字节落盘不经 shell）**（`merge 38549e18`）：path/content 必需，
  mode 词表逐字 `create`（缺省）| `overwrite` | `append`；权限与 bash/edit 同口径（ask，deny 直接拒）；上限 4MiB；
  create 用 link 落位（已存在抛 EEXIST，无 TOCTOU，不支持硬链接的盘退 rename）；overwrite 沿用原权限位；
  符号链接按 realpath 写被指文件、指向 deny 目录在边界判定就拒；只自动创建一级父目录。
  实测（来源=commit message）：内容含反引号 / 美元括号 / 变量 / 中文 / emoji 落盘逐字节相等（sha256 一致）。
- **compaction 变可逆视图（索引 + recall 工具 + 一次性 stub）**（`merge 35588aae`）：core compaction-index.ts 三处同源
  （context.compacted 的 data.compaction / SessionState.compactions 壳缓存 / 会话目录 compactions.ndjson，可从事件重建）；
  compaction_id 同会话单调；区间按「空档≤512、最多 8 段」合并；recall 工具在 plugins/tools/recall（无参列段、
  给 id/区间读原文，描述开头写死 NOT files，data_dir 由装配层注入），上界 ≤200 条 / ≤16k token / ≤20000 事件扫描，
  分页 next_offset+next_from_seq；stub 只在压缩当刻追加一次（`[compacted] N messages (seq a..b) … call recall with
  compaction_id=…`），重放逐字节一致。实测（来源=commit message）：全量逐条核对 oracle 711 条 vs 读回 711 条
  **逐条 sha256 0 mismatch**（7 页 8.1s）；边界：老会话 55 条读不回 → unmapped_messages:55 不编区间。
- **bash 异步化（opt-in，默认同步逐字节不变）**（`merge 71942e6d`）：工具参数 `async:true`（无新配置键、不新开工具名）；
  立即返回 job id+命令+cwd+超时+日志路径（第一秒可 read 看进度），完成经既有 runtime notice 注入；有界：
  同时在跑 4 条（第 5 条显式拒绝不排队）、异步缺省超时 30 分钟、单条输出 16MiB 封顶、一次注入 4 条/保留 16 条已送达；
  超时杀整棵进程树；刻意不挂 run AbortSignal；预览 1200 token 头30/尾70 再整条走 boundToolResult（≤16k）。
  实测（来源=commit message）：async sleep 40 → 立即返回、50s 后收 finished 通知；并发 5 → 第 5 条被拒。
- **后台 bash 作业完成时自己起一轮 run 送结果 + 运行期身份 origin:bash_job**（`merge 816e489f` / `5c369b29`）：
  src/bash-job-delivery.ts 把同一份已过出口闸的通知正文交 AgentService.admit（与 ask-answer-delivery 同一准入链）；
  二选一：收口问出口 true ⇒ 标 announced、hook 永不注入，false ⇒ hook 兜底等下一次 run；在途 admit≤4 超限返回 false
  不排队；通知 TTL 1 小时。顺带修：dispose 不再杀作业（宿主每次 body 收口都 dispose 插件而作业表进程级）、
  异步子进程不继承宿主 stdin。AgentMessage.origin 与 AdmitInput.origin 闭集合加 `bash_job`（与 ask_answer 同级、不是人类）；
  admitInternal 只跳过 canView，member_closed/strict/预算闸（hop/cycle/team/wall-clock）/inbox+mailbox 投递照旧；
  from=identify(session_id).id（起作业的那个成员），删归属者兜底与 member_not_visible 重试，失败一次返回 false
  交 hook 兜底永不重试；inbox 来源固定标签 bash。实测（来源=commit message）：40s async 作业 → 回合立刻结束 →
  40.7s 后 agent.bash_job.delivered 自己起一轮 run，delivered 1 次、notice 形态同 job 消息 0 次；
  `agent.bash_job.delivered {from:"main", status:"running", run_id:bb45080d, elapsed_ms:12224}` —— from 是成员自己而不是归属者。
- **bash 写入类命令的提示（只警告、不阻断、无回归噪声）**（`merge 1264b695`）：警告追加 bash 结果文本末尾，
  一次调用最多一行、多命中合并；命令照跑、退出码与输出逐字节不变，不动 deny/ask 与 boundToolResult、不加新事件；
  判据 sed -i / tee 文件 / 重定向到像文件的目标（排除 /dev/null、/dev/stdout、/dev/stderr、/dev/fd、/dev/tty 与 &1/&2）/
  heredoc 正文含反引号或美元括号/花括号 / 任何反引号；判定前先抹 heredoc 正文与引号字面量防误报；
  异步路径挂起步文本、收口不重复。实测（来源=commit message）：验收 37/37，回归 17 条一个字都没多。
- **修：Windows WSL 启动器反引号/$() 传输层**（`merge a1e78b43`，feat `8d92c951`）：以前 Windows 宿主 bash 解析到
  system32 WSL 启动器时，`-c` 字符串被外层 shell 在 spawn cwd 二次解析 —— 单引号里的反引号/$() 也被提前展开，
  命令替换里的 `> f` 在 cwd（多为仓库根）留 0 字节垃圾文件。现在探测一次 Bun.which('bash') 含 system32 并缓存；
  WSL 启动器 → `bash -c 'source <(printf %s <base64> | base64 -d)'`，命令逐字节到达内层 bash 只解析一次；
  编码后 >8000 字节 → 系统临时目录随机名脚本（0600，绝不落仓库），执行后即删（另有退出同步兜底清扫、spawn 失败即删）。
  边界：非 WSL 启动器 argv 零变化；BACKTICK_WARN/HEREDOC_META_WARN 只在未修复路径保留；
  cwd/管道/stdin/killProcessTree/超时/取消/退出码语义不变；description/schema 未动。行为验证归用户（Windows+WSL 真机）。
- **工具结果出口闸按 token 收口 + 上移 core**（`merge 7475f2bb` / `6e5f4866`）：闸序 token→行(2000)→字节(2MiB)；
  单条 ≤16k token，头 30%/尾 70% + 落盘路径；token 闸量未被任何闸动过的原文（3MiB 输出末尾 FATAL 保住，
  旧行为字节闸先砍尾）；read 原本无闸现同走此闸；预算边界 15,997 不裁 / 16,001 即裁。上移 core：
  packages/core/src/runtime/tool-result-gate.ts 唯一实现，boundToolResult 返回显式信封 {content, bounded, originalChars}；
  tool-calling-loop gateToolResult(outcome, sessionId) 在写回 role:tool 前一处收口，**插件工具全部纳入 16k 预算**；
  回执 markToolResultBounded/takeToolResultGateReceipt 挂每次调用新建的 ToolContext（WeakMap，非正则嗅探），
  guardrail 真改写时回执失效；basic-tools 保留第二道闸；≤16k 输入返回同一字符串引用。
  实测（来源=commit message）：事故形体 423,386 字节 → 105,851 → 15,636 token，落盘全文逐字节对账
  （423,597 = 原文 423,386 + 211）；假 MCP 工具 26723 token → 15766（落盘全文、只 1 个 log），回归十组与基线逐字节一致。

### 蜂群协作与订阅（Phase 1 / 订阅闭环 / env-injection）

- **蜂群协作 Phase 1：三重保险最小集**（`merge f94274b8`，feat `44418855`）：
  ① **write `expected_content`**（additive 可选 string，**仅 mode=overwrite** 生效，create/append 忽略）：
  在写锁临界区内 `Buffer.equals` 逐字节比对当前文件；不符 → 稳定错误**不写**，错误文本带当前字节/行数并指示
  「用 read 重读…更新 expected_content 后重试，或改用 edit」；非 string 也报错；不传 = 旧行为零回归；
  edit 既有 old_string 唯一匹配语义保留（含 replace_all）。
  ② **edit/write 自动订阅 + `subscribe:false` opt-out**（additive 可选 boolean，缺省 true）：AfterTool hook
  `doc-subscription-auto`（host 侧，覆盖 in-process/engine worker 两条执行路）把所改文件加入调用者 session 订阅；
  **attempt-based**（edit 未匹配 / write EEXIST 也订阅）；基线抑制：订阅时记当前 rev 为 notified_rev，
  自己刚改不出卡，他人再改才通知。传 `subscribe:false` → 完全不订阅 → **无任何通知**（不是短通知）；
  「短通知 + 按需 inspect」是订阅后的标准流：run 边界发 files 短卡，正文靠 `subscribe` 工具 `action=inspect`
  取 diff（首读取全文）；感知只在 run 边界（BeforeLlm append-only），hook 本身不注入消息；best-effort 失败静默。
  ③ **`<baseCwd>/.vessel/write.lock` 工作区单锁**：锁的是毫秒级写动作（读→比对→写临界区），非任务/文件 lease；
  原语 = 仓库 data-lock 模式：link 原子发布（不支持硬链接回退 open 'wx'）+ owner JSON{pid,started_at,host,nonce} +
  stale 回收（pid ESRCH；存活 pid 持有 >30s 判 hung；不可解析 mtime 宽限 5s；跨主机 24h）+ .reclaim 守卫 + 全等才释放；
  争用短轮询 25ms、上限 **10s**（WRITE_LOCK_WAIT_MS），超时折稳定错误「写入锁等待超时…请稍后重试」，run 继续不写；
  基础设施失败 **fail-closed**（不静默降级无锁写）。**合作式协议**：只约束经 edit/write 的写入者
  （跨进程/跨 engine/跨 node 同机）；bash/IDE/git 非合作写入者不受约束。已知局限：锁权威 = baseCwd
  （成员 cwd 不同则锁不同）；自动订阅相对路径按 config.cwd 解析。零 core 改动、零新工具；.gitignore 已含 .vessel/。
  无真机读数（行为验证归用户）。
- **订阅闭环：line-level 阅读订阅 + 订阅生命周期（placeholder 清除耦合）**（`merge a3877811`，feat `98caf1ab`）：
  read AfterTool 自动订阅所读行范围；零 wire clamp：追踪范围 = 请求范围 ∩ 文件实际行数，是实际返回的超集
  （token 闸只裁不增）⇒ 只多通知不漏；offset/limit 校验镜像 read 工具，天然滤掉失败 read。每 ref 存规范化
  (offset,limit)（offset??1、limit??DEFAULT_READ_LIMIT）+ clamp 后 start/end + 范围内容 text（仅 ≤maxFullBytes=102400 才存）。
  观察时**内容锚重定位**（首尾行匹配、恰 1 个候选才重定位，上方插行仍精准）+ 范围 unifiedDiff；
  **只第一个（path 序）变化条目带 diff 明细行**，总行数 ≤11/卡（SUBSCRIPTION_NOTICE_MAX_LINES，含摘要+元数据≤8+
  溢出概括+inspect 提示），字节预算 `maxTotalBytesPerRun`（缺省 262144，YAML max_total_bytes_per_run）；
  超限折「… diff truncated — inspect for the full change」。锚歧义/无 text/diff truncated → 回落整文件 rev 既有语义
  （ref 更新全有或全无）；已有条目只追加引用不动 rev/notified_rev/seen_rev 游标；新条目基线抑制。
  **生命周期（placeholder 清除）**：BeforeLlm 观察前消费会话壳 `cleared_tool_call_ids` 冻结集 diff（边缘触发 +
  `cleared_consumed` 单调 ledger 按 id 幂等；空订阅也消费防 remove 后误释放）；trim 把 read 结果换占位符 ⇒
  按规范化 (offset,limit) 匹配释放一条 read 引用（同请求多次 read 可互换）。守护① **引用归零才过期**：
  origin='read' 且 reads=[] 才删条目；② **origin 升级梯 manual>edit>read**（只升不降；read 订阅的文件被 edit 后升级 edit），
  edit/manual 永不自过期。过期只由清除驱动 —— 压缩/pop 不触发；passthrough 档 cleared 恒空 ⇒ 订阅不动。
  零新 core 实体：壳读 best-effort（file backend 文档化 JSON，sqlite 无壳跳过），core 仅函数导入；
  basic-tools additive export DEFAULT_READ_LIMIT/splitLines（行号单一真源）；data_dir 透传泛化到 doc-subscription。
  subscribe 显式面：无新字段/新 action（add/remove/list/inspect 不动），仅 description 披露 read 自动订阅；
  read_range 精确信封字段不做（待批、测量触发）。无真机读数（行为验证归用户）。
- **read `subscribe:false` opt-out（与 edit/write 一致，用户已批）**（`merge 9a02f771`，feat `8e081d1b`）：
  read inputSchema additive 可选 boolean `subscribe`，**handler 忽略该键**（缺省零回归）；description 披露
  「The line ranges you read are auto-subscribed for change notices; subscribe:false opts out.」及参数说明
  （一次性查看省 token，他人改所读行不再通知）；AfterTool hook 的 subscribe:false 检查统一到 read/edit/write 分支前；
  subscribe 工具 description/头注释 + tools.md read/subscribe 行 + AGENTS.md 同步。read_range 精确信封不做
  （用户裁决：测量触发升级，当前零 wire clamp 够用）。
- **环境信息注入粒度框架：per-scope request/run 可配 + lock/conflict 环境卡**（`merge 84e7c1a3`，feat `fe496151`；
  `2479b2a0` / `bff27893` 仅 biome 行宽纯格式修复，行为中性）：YAML 顶层 `env_injection`（loader 映射 camelCase
  `envInjection`），形状 `{ default?: 'request'|'run', scopes?: { <scope>: 'request'|'run' } }`。两轴：
  轴 A 检测节奏 **request = 每 LLM 请求前检测 / run = 每 run 首次请求前检测**；轴 B 抑制去重
  （believed-value/游标/签名/预算）恒开不动。gate 在 producer 入口（观察/diff 之前），禁汇聚点吞卡。
  **缺省逐 scope（DEFAULT_ENV_CADENCE = 今天节奏，零回归）**：restart/identity/fields/model/tools/lock/conflict/context/pii
  = request；**files/trim = run**；bus legacy 词 config/permission/mcp/update/peer = request。解析序：
  显式 scopes > 内置表 > default > 'run'；default 只管未来新词。校验：值必须 request|run；scopes 键必须在内置表
  （拒未知词防 typo）；**trim/model 配 request 被 validator 显式报错拒绝**（不静默钳制）—— trim = 段起点冻结前缀不变量、
  model = EU 首 run 生命周期，这两个 producer 自然节奏钉死、不经 cadence gate。整 hook 取最细（finestCadence）：
  self-card-delta 取 identity/fields/model/tools/context 五词；runtime.notice bus 取 config/permission/tools/mcp/update/peer
  六词；任一 request ⇒ 整 hook request，要整体推迟须组内全配 run。bus 合并卡按 scope 优先级**显示序**
  （peer 最高，其余按词表序），FIFO 选择/游标不动不丢通知。core additive：EnvCadence 叶类型、
  HookContext.request_index（loop 传 round-1，旧 caller 缺省 0 恒放行）、EU envCadence 端口 gate tools/pii
  （per-run 环形守卫 64）。**lock/conflict 环境卡**：新 scope 词三处联动（agent ENV_INFO_SCOPES 排 tools 后 files 前 +
  Web ENV_NOTICE_SCOPES + en/zh-CN i18n）；basic-tools 在工具失败点记录：lock = 写锁争用超时/不可用，
  conflict = expected_content 并发冲突；**工具失败语义不变**（仍返回原错误文本，卡是 additive 表面，
  此前这两类事实无卡）。进程级 buffer 按 session、签名去重、TTL 1h、announced 上限 16；drain 按条目 scope cadence
  过滤（run 且 requestIndex>0 留缓冲到下个 run 首请求）—— gate 在 drain 不在记录点，不丢事实；每卡 ≤10 明细超出 +N more；
  hook 名 write-coord-notice，走 vessel:notice 通道。doc-subscription files gate 缺省 run = 原 processedRuns 零回归。
  envGranularity 经 buildPluginConfigMap 注入插件 install config，缺省不注入。**热应用**：bus hook cadence 为注册期快照
  （幂等注册 existing→return），**热更需重启**；cli 热应用路径会以新 envInjection 重建 plugin config map。
  无真机读数（行为验证归用户）。

### 搜索与多模态（web-tools / vision）

- **web_search / web_fetch：声明式搜索后端（现态收敛）**（`merge 35c38be6` → `d9ffb64d` → `7e50fac4` → `2ab16c51` →
  `87f9e060` → `11542c5f` → `0ac936b0` → `87a229e9` → `9d3eeb21`）：插件 plugins/tools/web-tools；
  src/backends.ts 唯一注册点，注册顺序 = auto 优先级 **deepseek → tavily → serper → bocha**。web_search 返回候选页
  （title/url/summary/date），信封带 `backend:<id>`；web_fetch 双后端 `local`（缺省，免费，每跳过 SSRF+robots）|
  `deepseek`（服务端抓取返 Markdown，花钱+URL 出网）；模型用 backend 参数改后端默认禁止
  （`allow_model_backend_override: false`）。成本闸常量：MAX_SEARCH_PER_RUN=15 / MAX_DEEPSEEK_FETCH_PER_RUN=20 /
  MAX_BILLED_CALLS_PER_DAY=500（只数计费调用）。**声明式 custom 后端配置键**（`plugins[].config.custom_search[]`，
  YAML snake；代码 search/custom.ts）：`id`（注册为 `custom:<id>`；保留名 deepseek/tavily/serper/custom/bocha
  install 期报错）/ `request.url`（必须 https；http 仅 loopback/私网/裸主机名/.local|.internal；url 含 `{{` 直接拒）/
  `request.method`（POST|GET）/ `request.query_in`（body|query）/ `request.body` / `request.headers` /
  `auth.style`（bearer|header|query）/ `auth.header_name` / `auth.key_env`（只存环境变量名）/
  `response.results_path`（点号路径）/ `response.field_map`（只认 title/url/summary/content/date；写 site/icon
  install 期报错）/ `limits.max_count` / `limits.requires`（声明必用占位符，body/headers 缺占位符 install 期报错）。
  占位符恰 8 个：`{{query}} {{count}} {{need_content}} {{freshness}} {{site}} {{lang}} {{after}} {{before}}`；
  字面替换无表达式；整值即占位符保留类型；缺值整键省略（单边日期 ⇒ freshness 整键消失，不报错不猜）。
  顶层键：`search_provider`（缺省 auto）、`always_register`、`env_file`（顶层，路径或路径数组；KEY=VALUE/export 前缀/
  引号/#注释/不插值；真实 env 优先；显式路径缺失报错；在 env 层之前加载，只回键名与计数）。缓存键 `custom:<id>` +
  version `1.<spec指纹8位>`（specVersion，改配置自动失效）；映射失败 `provider_schema_mismatch`（绝不返回 0 条）。
  **预设与凭据**（代码核实）：deepseek → DEEPSEEK_API_KEY（可被 key_env/search_key_env/fetch_key_env 覆盖）；
  tavily → VESSEL_TAVILY_API_KEY（Bearer，上游上限 20）；serper → VESSEL_SERPER_API_KEY（X-API-KEY）；
  bocha → BOCHAAI_SEARCH_API_KEY（内置预设走 custom 引擎，短名 id `bocha`，零配置；custom_search 同 id 可覆盖）。
  **缺凭据三形态**（README 固化，9d3eeb21）：① auto 无任何 key ⇒ 缺省不注册 web_search（stderr+warnings 给恢复方式）；
  always_register:true 时 provider_auth_failed：「没有可用的搜索后端：按注册顺序（deepseek → tavily → serper → bocha）
  都没有可用的 key。设置其一即可：deepseek → DEEPSEEK_API_KEY、tavily → VESSEL_TAVILY_API_KEY、
  serper → VESSEL_SERPER_API_KEY、bocha → BOCHAAI_SEARCH_API_KEY；或用配置 search_provider 指定某一家
  （本次没有发出任何请求）」② 显式指定缺那把 key ⇒ provider_auth_failed 只点名一家：「环境变量
  VESSEL_TAVILY_API_KEY 未设置或为空；设置后重试（本次没有发出任何请求）」③ 未注册 id ⇒ provider_unavailable
  （配置错非缺凭据）：「配置 search_provider=bravesearch 没有对应的搜索后端；已注册：deepseek | serper | tavily」。
  共同规则：只出现变量名不出现值；本地拒绝 0 请求；失败仍进指标行。**过滤最终规则**（0ac936b0 定稿，取代
  87f9e060 的「丢过滤=发请求前硬报错」）：能映射照常映射，映射不了丢弃并在信封 `filters_ignored: <名>` 行点名
  （与 budget:/cached: 同层，仅真被忽略时出现，缓存命中仍在 —— 是 query×后端的事实）；unsupportedFilters?(query)
  纯本地判定不发请求；custom/tavily 实现，deepseek/serper 全映射不实现；披露值形态 site、lang、after/before、
  after/before 单边。**工具描述矩阵**（web_search description）：deepseek maps site/lang/after/before into query string；
  serper site→q、lang→hl/gl、dates→tbs（无正文，need_content 无效，date 是 "2 days ago" 相对时间）；
  tavily 仅 site→include_domains，无 lang/日期，cap 20；bocha 无 site/lang、仅完整 after..before 区间。
  **默认加载**：87a229e9 起 web-tools 转默认（OPT_IN_PLUGINS 只剩 media）；关闭用 `plugins: - name: web-tools` +
  `enabled: false`。breaking/缺省变化：专用 search/bocha.ts（157 行）已删（7e50fac4）；预设短名回归 bocha（2ab16c51），
  旧 search_provider:bocha 兼容；无 key 时 web_search 从「仍在册报 provider_auth_failed」改为缺省隐藏（d9ffb64d）；
  过滤从旧 Bocha 适配器静默不传 → 披露。另修：plugins[].config snake→camel 归一（此前 YAML snake 键全哑）；
  requestedCount=upstreamCount（不把上游少给算成预算限制）；fetch 缓存命中按本次预算再收口。
  实测（来源=commit message）：d9ffb64d「results 5 / 306ms（upstream 303）/ 同 query 第二次 cached:true 0ms 且
  quota_used 仍 1」；7e50fac4「results 5 / 322ms / 二次 cached 1ms」；35c38be6「真机 104 项 PASS」「真 DeepSeek
  tools API 的成功路径未验：环境无可用 key，网关 /v1/tools/* 是 404」；87a229e9「真 key 的成功路径未验
  （VESSEL_TAVILY_API_KEY / VESSEL_SERPER_API_KEY 当前都未设置，不伪造）」。
- **多模态 P0/P1：原生视觉直通 + 投递四态 + blob GC + [refs] 三档**（`merge 606512be` / `16f2e0e2`，feat `3758017c`）：
  P0 原生视觉直通：图字节经内容寻址 blob（`<dataDir>/blobs/sha256/xx/<sha256>`，同 sha256 ⇒ 同字节，前缀守卫不变量）→
  CanonicalImagePart → 后端 toRequestPart 内联进 LLM 请求；读 blob 不读 path。core 只有形状与机制
  （packages/core/src/types/vision.ts + vision/{blobs,ingest,plan}.ts），不含任何一家块形状；注册点
  LLMProvider.vision? / ExecutionUnitOptions.vision?。VisionBackend = 2 标识（id、kind:native|derived）+ 8 必选方法
  （supportsImage/formats/maxImagesPerRequest/maxBytesPerImage/maxBytesPerRequest/detailLevels/tokenCost/toRequestPart）
  + 可选 sniffImageMime?/keyEnv?（格式知识属后端）。首份实现 plugins/provider/openai/src/vision.ts：id 缺省
  openai-compat，image_url dataURL 块，PNG/JPEG/GIF/WEBP magic bytes，tokenCost=1024×N。事件 image.sent /
  context.image_dropped 只带 sha8/数字永不带 base64。**投递状态现态 = wire 四态**（3758017c 初版三态，16f2e0e2 加第四态；
  schemas.ts enum 逐字）：`sent`（附 backend/model/每图 tokens）/ `dropped`（本轮算过决定不发：预算/格式/缺 blob/
  占位/压缩，带 reason）/ `not_sent`（根本没进通路：kill switch/无视觉后端/没入池）/ `unknown`（无记录，派生覆盖不到）。
  位置 sessions.get.session.messages[i].image_delivery[]，从事件派生、按 sha8 匹配（非消息下标）、不写进 refs
  （会改写历史前缀且 messageSignature 只取 kind:path）、与 content 8KiB 裁剪无关。P1 派生改会话级快照
  {coveredSeq,facts} 按 seq 折叠 + `coverage: complete|partial`：complete 缺席 = not_sent；partial（旧格式/日志洞/
  翻页预算尽）只报 unknown。**blob GC 接线**（src/image-blob-gc.ts，bootstrap.ts 装配）：引用集合扫会话壳
  （文本收 64 位 hex，壳损坏也能收）+ 事件日志（整份解码+同目录文本兜底）；只收可证明超集，任一处证明不了 ⇒
  aborted 且 0 字节删；启动第一趟固定 dry-run，之后按间隔真删。config.vision.*（YAML snake）：`blob_gc_enabled`
  （缺省开）/ `blob_gc_interval_hours`（缺省 6，夹[1,168]）/ `blob_gc_dry_run` / `orphan_grace_hours`（缺省 24，夹[0,168]）/
  `image_blob_ttl_days`（缺省 30）；池上限 2GiB 是 core 常量（IMAGE_BLOB_POOL_MAX_BYTES）非配置键，触顶新图不再内联+
  明示不静默；池不在数据目录内 ⇒ 跳过+warn。**[refs] 尾注三档**（src/refs-notice-hook.ts 逐字）：档1 已发送
  `(images attached to this message — do not read them again)`，同批有没附上的追加
  `; the rest: use media: action=read|ocr|describe`（兜底半句）；档2 未发送/被丢
  `(content not attached — use media: action=…)`；档3 无视觉能力（无 VisionBackend/kill switch）⇒ 老文案逐字不变。
  判据：视觉面探针 + 图有无 sha256（无 = 从没入池 = 一定不内联）；探针缺省走老文案。旧会话逐字节不变靠机制：
  尾部 append、projectMessages 产不出带 name 消息、reconcile 原地保留。**refs.sha256**：refs[] 可选 64hex 内容地址；
  形状不对只丢该字段不判整条非法（path 仍有效退化旧语义）；节点侧上传落盘时算并回填；用途 = 内容身份对齐（sha8）+
  内联判定；preprocess≠none 时产出新字节必须写回 refs.sha256（否则前缀守卫必报 prompt.prefix_changed）。
  breaking/缺省变化：vision 段此前不在 KNOWN_CONFIG_KEYS（写什么都静默不生效），16f2e0e2 补未知键校验；
  vision 故意无 enable 键，`disabled` 是闸不是默认门（缺省 false，等价 VESSEL_DISABLE_VISION=1）；
  maxImagesPerRequest 缺省 6。未做：Anthropic/Responses VisionBackend 适配、Files API。
  实测（来源=commit message）：606512be「image.sent 仅 1 条、prompt.prefix_changed 0 条、每轮
  images={images:1,tokens:1024,bytes:10439,sha8:[afda6ae6]} 完全一致；第 4 轮前把原图文件改写成文本，模型仍在描述原图」
  「1 图=1024（同段 base64 字符口径 419,432 ≈410×）；7 图→6 发 1 丢=6144」「20 条 refs=3,013 B（≈151 B/条），
  反事实 20×1MiB base64=+26.7 MiB；真机会话 grep base64=0」；16f2e0e2「4000 条 filler…新实现 coverage=complete」
  「bytes identical true」。

### 性能 / 语义变更

- **usage 插件迁到时间线**（`merge b006338d`）：数据源从 `sessions/<id>/events.ndjson`（0.54 起停写）改为
  `wal.log` 的**事实行**（只对进合计的行做逐行 CRC32）。不读 `wal.blocks`（只有 chunk 帧、无用量字段）、
  不读 `timeline.ndjson`（是 `wal.log` 前缀副本，两份会重复计数）。有界：单会话 ≤64 MiB（超了读尾部记
  `partial_files`）、单次 ≤512 MiB / 4096 会话、保留 ≤192 MiB 按会话 LRU；峰值内存 = 索引行 + 至多一个会话的投影事件。
  增量索引升 v2（按会话存 size+mtime，未变零字节）。实测 330 会话 / 425 MiB / 282k 行整目录 **5.7 s**。
  真数据对账（同一拷贝、同一聚合、只换源）：2026-11-15 当天**逐项完全一致**（501 请求 / prompt 102,615,306 /
  completion 293,052 / cache_read 101,152,640）；全期差异 2.0x **逐项可解释**——旧源停在 0.54 切版时刻。
- **写者 `open()` 只读尾部**（`perf(core/timeline)`，commit `daa0b00a`）：`timeline.initialize()` 拆成两条路径 ——
  增量（缺省）：`timeline.idx` 打底 + `wal.log` / 归档 / `timeline.manifest` 尾窗（`readNdjsonTail`，首窗 256 KiB、
  上限 4 MiB）+ 只解**最后一个块** + `holes.ndjson` 全读；全量：老路径一条判定不改，任何自洽检查不成立就退回。
  19/20 万 seq 的会话（`d813eaea` 只读拷贝，before/after 各 3 次交错跑）：**中位 4484.0 ms → 87.6 ms（51×，约 −98%）**，
  冷缓存首次 8531.2 ms → 87.6 ms；`heads` 逐字段一致（`wal_head` / `timeline_head` / `published_head` / `holes` / `tainted`）。
  为什么必须改：那是**启动路径**（进程启动 / 会话打开 / idle 压缩 / adopt 每一次都付一遍），第十一条禁止启动路径出现
  O(会话大小)。为什么能在尾部结束：判据没放松 —— 索引算术（`first_seq = 1` 且 `count = last_seq`）+ 尾窗实测
  `tailMax >= last_seq` 且 `(last_seq, tailMax]` 逐号齐全 ⇒ 记录集恰好是 `[1..tailMax]`；`knownMax` 仍含
  `manifest.archivedTo`，所以「manifest 说已归档、盘上却读不回来」照样声明成洞、照样顶 `wal_head`。
- **语义变更（运维要知道的一条）**：**历史中段**（早已封好的老块、更早的 `wal.log` 行）的**外部**损坏不再每次打开重扫 ——
  这是启动路径的取舍，不是故障。**显式修复路径 = 删 `<sessionDir>/timeline.idx/` 整个目录再 open**（整份重读 + 重建索引 +
  重新声明洞；索引本就可重建，ADR-105 §5 的不变式「删掉索引 ⇒ 所有读 RPC 返回逐字节相同的结果，只有耗时变长」）。
  **尾部损坏的判定一个字节都没省**：坏行 / 坏帧 / manifest 说写完但帧缺 / 撕裂尾帧按原口径处理（尾窗里见到就整份退回）。
  口径见 [event-log-policy §7](docs/architecture/event-log-policy.md)，步骤见 [operations/GATEWAY §7](docs/operations/GATEWAY.md)。
- **块改 run 级可追加容器（124x）**（`merge fe5f766a`）：首 chunk 建块、之后只 append；事实行用 12B 标记帧，
  块区间仍逐号自描述；封块只剩 run 换人 / 4MiB / close / 崩溃补记账。crc32 走 node:zlib 原生（无原生退表驱动）。
  实测（来源=commit message）：真身 13,177→106 块（124x）、fsync 7,107→5,720、块 p50 26KB→159KB；
  4MiB crc32 43ms→0.5ms（逐位相同）；89,732 条读逐条 sha256 相同，kill -9 零丢失。
- **时间线范围读 + 首屏/翻页接线 + manifest 锚点定位**（`merge 5b04bb9f` / `7c14ab56` / `8174de76`）：
  wal.manifest 二分锚点 + 只开覆盖块 + 覆盖算术自证；manifest 缺失退首帧二分，坏块自动降级整份读并留痕；
  首屏/翻页接上范围读 + wal.log 事实行水位去重（归档副本完整才 trusted，否则退回读两份）；范围读定位改 manifest
  锚点驱动，readdir 每页 1→0（395 页 0 次）；壳存在性校验改一次 stat（exists/loadForRead），不再整份 load。
  实测（来源=commit message）：缺省页 100 条=6 块/热 12ms；首屏 2000 条=116 块/冷 69ms 热 44ms（整份读 6.6s/17s ⇒
  140-540×）；25 case 与整份读逐条等价；sessions.events limit=100 旧 18.3-18.8s→冷 473ms/热 318-403ms，
  limit=500 旧 34-36s→冷 505-530ms；wal.log 解析 133-158ms→14-20ms；limit=100 1,076-1,394→97-164ms、
  limit=500 1,187-2,606→105-254ms；sessions.get limit=1 259.1→72.7ms、limit=200 335.7→78.4ms。
- **发送路径增量投影游标 + 游标落盘 + body spawn 移出关键路径**（`merge 41f87578` / `af5944a8`）：
  发送路径不再整份读时间线：增量投影游标 reuse/tail/full（TAIL_MAX_EVENTS=2000，判据不成立只许放宽回整份读）；
  投影游标落盘 sessions/<id>.projection.json，重启后不再整份读；body spawn 移出 runs.start 关键路径，
  RPC 带 run_id 立刻回，失败 inbox.unhold 回 unread 重投。实测（来源=commit message）：整份读 6,979ms→尾部 116/133ms；
  端到端热态 7.74/8.68s→0.59/0.46s（第 2/3 次发送）；58,645 事件×302 切法逐条相等；重启 998.7ms→尾部续读 12.1ms。
- **sessions.list 摘要侧车 + 首屏 4 趟→1 趟**（`merge 45dbb266`）：`<壳>.info.json`（失效键 size+mtime，读侧自愈；
  点开头防滚动升级期老进程当幽灵会话）；页上限 500→2000（旧 gateway invalid_params 自动回落 500）。
  实测（来源=commit message）：冷 880-1010ms→11-19ms、稳态 21ms→6ms；20.9 万事件会话冷 134ms→55ms；
  listRich 输出 JSON 与改前 cmp 一致。
- **打开会话 33.2s→1.37s（冷）**（`merge 7078b446`）：image_delivery 只在窗口真有 kind=image 引用才折日志
  （338 会话里 337 个无图，原先每会话首次白折整份）。实测（来源=commit message）：打开会话 33.2s→1.37s（冷）、
  1.01s→0.93s（热）；sessions.get 冷 28,943→189ms / 33,095→402ms；338 会话×2 limit=21.8MB JSON 逐字节相同；
  coverage 由 partial 变 complete。
- **上下文占位规划改游标增量**（`merge 58d73191`）：IncrementalClearedToolResultPlanner（context-manager）：
  每轮 O(新增) 非 O(窗口)，窗口没变零重算，压缩按公共尾部对齐，不变量违反退全量重建留痕。
  实测（来源=commit message）：34 轮逐条等价、fallbacks=0；同窗口连问 10 次遍历消息 22310→0 条。
- **实时尾随 25ms 窗口节流/合并**（`merge ac9d4d64`）：发布入队 O(1)、每条记录线上文本只序列化一次
  （同会话连接共用）；仍一事件一帧，协议/能力位一字不动。实测（来源=commit message）：修中途接入客户端重复帧+乱序
  （300 历史+300 尾随：重复 44 帧→0，按住上界 2048）；延迟 median +31ms/p95 +52ms；写者 fsync 段 243→201ms（-17%）。
- **修：归档重放同 seq 重复 + 归档去重执行器**（`merge 9213c411` / `ca76222f`）：读失败被折成空文件 ⇒ 整段重抄；
  修：严格读（只有 ENOENT 算空）/ 只增水位 / 追加前重读尾窗 / append-only 断言 / timeline.archive.lock 跨进程串行；
  新错误码 timeline_archive_failed；archive-audit 检测器：写者 open() 按 8MiB 预算扫 + doctor strict；存量不自动改数据。
  新增 scripts/timeline-dedup-archive.ts：只接受 --dir，按 seq 保留首见整行（原字节切片），内容冲突/审计不 conclusive
  拒写；不动 wal.log/manifest/idx。实测（来源=commit message）：并发 archive duplicate_seqs 20→0（5/5）；
  实修 3 会话：c52a29cc 1095→870 行（删 225 行 217138B，−19.9%），裁后与各自 wal.log 逐字节相同。
- **缺省变化：单页上限收回到 1000**（feat `5f0f5b6b`）：承接 45dbb266/bdde73c0 的 2000 —— 最重会话 4.6KB/事件，
  2000 条一帧约 8.8MB 撞 WS 单帧 8MiB 硬阈值；1000 最坏约 4.4MB，首屏往返 4→2 收益保留。
- **首屏只加载尾部窗口 + 滚顶分段加载（回归修复）**（`merge bdde73c0`）：20 万条会话 segments=1 declared=2000；
  滚顶三次各 2000 直至 seq 1，fetched 7955==wal_head 零 gap；顺带修越界页尾被裁成假缺口。

### 启动与进程生命周期

- **node 启动 16.3s→2.3s + 启动分期观测 + /health 短超时**（`merge e79b9faa`）：trace prune 移出关键路径转后台、
  sweep/resume 有界并发 16、Ink REPL 按需加载；ready≈0.45s+5.3ms×会话数，与 trace 字节数无关。
  新增 node.startup / run.timing / run.llm.gap 观测行。**缺省变化**：/health 家族探活超时 30s→1500ms
  （VESSEL_PROXY_HEALTH_TIMEOUT_MS 可覆盖，其它路径仍 30s）。实测（来源=commit message）：node 启动 16.31s→2.33s
  （空数据根 0.45s；344 会话/1.07GB trace 实测）。
- **gateway 分段启动 + 错误域隔离 + node/hub 生命周期解耦**（`merge a09de72b`）：平台就绪与节点解耦，
  慢节点不拖平台、坏节点只标自己 failed；就绪上界 20s→180s。**缺省变化**：gateway stop 只停平台层，
  node/hub 按 handoff marker 留活、再 start 走 adopt（pid 不变）；`--no-keep-nodes` 才整体关闭。
  实测（来源=commit message）：platform_ready_ms=855，慢节点 61.7s 不拖平台。
- **run-stops：gateway stop 先优雅 drain 再强杀**（`merge 60b5a1a7`，feat `07614bf9`）：根因 —— Windows 上外部
  process.kill 是无条件终止，进程内 drain（fence + 写 resume 标记 + interrupt('shutdown')）从未执行；重启后在跑 run
  无恢复标记、recover 无可重放，全部 agent 冻结。修：新增 canonical RPC `gateway.shutdown`（admin；params {} →
  {stopping:true}；先响应后 defer 一拍跑退出序列）；停止侧四处 graceful-first（node stop / legacy gateway stop /
  stopSpawnedChildren / NodeSupervisor.stop）：先经既有鉴权通道请求优雅关闭，**请求 3s + 等死 10s**，
  超时/失败回退既有强杀+补偿清理。强杀边界：platform/hub 无 run 面不触发；stall-restart force 路径不触发；
  老服务端 not_found 直接强杀；强杀时停止方代打 `node.drain.skipped`，recover_done 附 per-session skip 原因聚合。
  P3：headless 退出不再写 resume 标记；启动经 RunJournal 单写口清「no_member + 会话 completed」僵尸标记。
  **P2（重启自动续跑）按用户裁决暂缓** —— 重启后仍需人工/main 触发续跑。无真机读数（行为验证归用户）。
- **修：重启后「进程在但什么都不动」（adopt 探错进程）**（`merge e2dad934`）：adopt 探活/状态/代理一律以活进程自写
  gateway.pid 为准（preferLiveNodeListen），配置端口只回落；原先无项目配置 cwd 探错进程 ⇒ node_identity_mismatch
  把活节点判 failed。实测（来源=commit message）：健康重启平台端口不可用 580ms、SSE 断流 611ms 重连 191 帧 gaps=0、
  在途 run 不中断；0 实例但有 node 时 status 人话说明 + --stop-nodes 提示。
- **gateway 外部存活看门狗（探活 + 受限重启）**（`merge e0715263`）：2s 探 /health、连续 3 次失败判死 ⇒ 强杀+respawn；
  退避 1s→60s、每小时 5 次重启上限（超了 gave_up 留现场）。新配置 gateway.supervise.*，
  VESSEL_GATEWAY_SUPERVISE=0 / enabled=false 可关；hub 与 node --daemon 未覆盖。
  实测（来源=commit message）：判定 6-8s + 重启就绪 5-7s、空跑 5 分钟零事件。
- **修：run 启动后事件循环僵死（EPIPE 自激）**（`merge 8fb86718`）：stderr 断管 ⇒ uncaughtException ⇒ 处理器再写日志 ⇒
  无界自激饿死事件循环，只能强杀。修：stderrBroken 报废标志（坏一次后写全 no-op）+ 重入门闩挪最前。
  触发条件 = stdout/stderr 句柄会消失（nohup 后 shell 退出 5/5 必僵死、SSH 断开、管道对端先退）。
  实测（来源=commit message）：修后 /health 000→200、主线程 CPU 1.0s/1.0s→0.016s/10s。
- **Bun win32 segfault 结案：代理改原生直通**（`merge 138e30af`，feat `3d31e313`）：触发 = 代理 HTTP 手写流泵 +
  下游中止（10 秒内 panic，同指纹）。**win32 缺省变化**：代理改原生直通（VESSEL_PROXY_HTTP_STREAM=pump|passthrough）、
  crc32 缺省表驱动（VESSEL_CRC32_NATIVE=1 强制原生，代价仅 +0.46ms/164KB 块）。新增每 60s 一行 gateway.resources
  （rss/heap/代理并发/ws）；记档：WS 约 40MB RSS/连接@1MiB 帧，wsMaxConnections 现 32。

### 会话与消息正确性

- **上下文计数改「下一次请求视图的上界」+ 发送前闸（P0 事故根因）**（`merge 8f0f3564`）：事故自报 67%/77%、
  实发 1,048,568 ⇒ 400。现值 = 整窗上界估算×锚点（无锚点×1.15），provider 回报只做地板；锚点落盘；
  发送前闸 ≥maxTokens 直接不发（context_window_exceeded + 卡片）；补认 Volcengine「Input exceeds the context limit」。
  实测（来源=commit message）：修后上界 874,575=87.46%、无锚点×1.15=100.58% ⇒ 拦下，压缩后 51.42% 可发。
- **修：重启后上下文「少了一大截」= compaction 被虚高判据触发**（`merge 16306d86`）：成员体包装层不转发锚点 ⇒
  窗口恒×1.15 高报误触发 compaction（−761 条/−253,745 tokens/−41%）。修：账本口径复核（窗口说过线、账本没过 ⇒
  不压+warn）+ recoverAnchorFromLog 从日志尾部复原锚点写回壳自愈；context.compacted 新增 decision
  （trigger/estimate_upper/anchor_ratio/factor 等）。
- **修：「同一条输入在 messages 里两份」的根**（`merge a719e49d`）：coverageCut 把「带 name」当缓存专属证据 ⇒
  具名输入（A2A/ask/rotate）全跳过对齐 ⇒ 整份投影追加成持久两份。修：具名消息先按内容在投影对齐；
  saveSessionState 同 message_id 最多一条（逐字节相同的后到副本丢弃+warn）；存量 7 会话 7 run 不回填，
  106 会话比对重复增加 0。
- **消息身份 message_id 落地**（`merge 0fba4785`）：core 在消息进会话处盖章 message_id（确定式 runId:user /
  runId:inject:下标），不进 provider 请求体；web 历史 key 改 msg:id:<message_id>，同 id live 让位历史、
  落盘同源重复丢后者+计数+warn。旧数据（无 id）items/kinds 逐项相同；遗留：gateway 直写 message.injected 路径
  未盖章仍走旧判据；存量不回填。
- **修：重复气泡根因 —— 身份认领被 vessel:notice 挤掉**（`merge 2ae75f68`）：inputsByRun 把 BeforeLlm 注入的
  vessel:notice/source 也收进 ⇒ run 唯一输入判据恒失效 ⇒ 只剩正文认领，guardrail 改写正文即失败。
  修：只收人类输入；notice 按 run 去重（环形上限 64 run）。实测（来源=commit message）：userMisses 66→0、
  inputsByRun 长度>1 的 run 79/88→0；真实 1209 条转录逐条不变。
- **杀掉「假运行态」：为过期 run 收口 + 台账不再被抹 + 对账改会话级**（`merge 402569ca`）：切会话回填更早段后
  旧 run 从部分事件重建、永久「正在思考+停止」。修：supersedeStaleRuns（同会话后 run 起始严格晚于我最后事件 ⇒
  我已结束，收口 interrupted + reconciled:superseded，不冒充 completed）。实测（来源=commit message）：
  修后 600s 每 30s 采样 worst_running=0。
- **总量裁剪不再裁掉锚点（有界）**（`merge 8313e690`）：有内容的 run 锚点不裁 + 最新 run 锚点一律不裁 ⇒
  环里不可能「有内容、没终态」；环恒 ≤maxEventsTotal（病态流整组丢最老，MAX_TRIM_SCAN=512）；
  RUN_ANCHOR_EVENT_TYPES 增补 subagent.delegate.*。修超长会话最后一条 run 永久「思考中」。
  实测（来源=commit message）：8.6 万条真实会话终态 2/2、重建 running=0；perf 86k 事件 15→16-22ms。
- **硬错误立闸：该 body 不再自动接单 + blocked 露出**（`merge 5b081820` / `4140d142`）：
  classifyProviderRetry().retryable===false 且 category=provider ⇒ body 落 hardStop{code,reason,at}，
  三处同判不再自动接单；agent 投递不解闸（断「每条报告唤醒重发一次」循环），解闸 = 人类投递/interrupt/换新 body；
  agent.body.blocked/unblocked 留痕。agents.list/get 露出 blocked{code,reason,at}（additive，无闸不写键；
  agents.tree 的 agentCard 顺带受益）；落闸 body state:failed + blocked 原因原文可见。
  实测（来源=commit message）：1 轮 400 后 provider 调用恒 1 次，人类一次投递后 3 条全跑完无重复。
- **假 queued run_id 服务端根治：三条不会起跑的路改 deferred（协议 additive）**（`merge 34a995ab`，feat `6ff81c4a`）：
  admitInternal 的 rotate-quiet/draining/hardStop 三条路改回 {status:deferred, reason:rotate|draining|stopped,
  message_id, retry_after_ms:10000/30000/无}；runs.start result_schema required 从 [run_id,status] 放宽到 [status]，
  run_id 变可选。消息全落 durable inbox 可恢复（stopped 解闸后真重投）；新前端 attachDeferred「服务端已收下」，
  181s defer_timeout，重试先 recall 服务端那份（不会两份）；每条 deferred 一行 session.input.deferred。
- **排队消息生命周期 + 终止态**（`merge 3ac1a2f1` / `15ce2529`）：queued 只渲染在待发送条带、sent 才进会话流；
  失败回流条带「未发送·原因」+重试/编辑；queue_timeout（3 分钟未被取用，181s 命中）同出口；重试/编辑先撤服务端
  排队旧消息（撤不下就不动）。**行为变化**：发送失败不再把正文塞回输入框；屏上最大重复 2 处→1 处。
  queued 气泡终止态：超 3 分钟未认领 ⇒ failed(queued-timeout) + 重试/删除，排队久按分钟显示；
  回显先到/超时后真起来都正确摘除（改前 600s 仍 queued）。

### 客户端（WebUI）

- **修：刷新/重连把整段聊天记录「从前往后」拉一遍直至 node 被看门狗重启**（2026-11-17 事故）。根因是
  **两套 seq 混进同一个游标**：连接级 hello 的回放帧是进程级 `hub seq`，客户端却把它写进时间线游标；
  下一次 subscribe 带着这个越界的值，服务端按 `reset` 从 `seq 1` 堂堂正正重放，客户端的续拉循环便
  `2000 → 4000 → …` 一路追到会话末尾（实测 30,061 帧 / 12.5 MB / 51 次订阅；`timeline.gap_reported`
  13,854 条，node 探活连续 3 次超时后被 supervisor 重启）。同一路径在 `sessions.get` 读游标超时时也成立
  —— 旧 fail-open 会发 `after_timeline_seq: 0`，而这是**合法请求**，服务端没有理由拒绝。修法五条：
  ① 连接级 hello 用客户端内部标记 `connectionLevel` 判形，chat + timeline 下 hub 帧只隔离、不碰游标；
  ② 游标读失败**本轮退到有界 hub 尾窗**（老订阅参数），绝不再发 0；③ 服务端声明 `reset` 时丢弃缓冲、
  锚到尾部窗口（`seqFloor` 挡住 reset 段的 `1..2000`）；④ 重连 `since` 不再复用时间线游标，且连接级回放
  改为不请求（路由订阅自己会收敛）；⑤ 环里只有 hub 帧（左缘 0）时，在时间线落位前先清空。顺带修掉
  `subscribeOnce` 的「没有 `session_id` 也先试 `after_timeline_seq`」分支：服务端按 `invalid_params` 拒，
  非 chat 范围（team / runs）会因此拿不到订阅；现在由调用方显式决定走老参数。
- **删掉「400ms 没新帧 = 这趟发完了」的空闲猜测**（`EPOCH_IDLE_MS` 已删除）：结趟改吃两条**显式事实** ——
  ① 服务端整趟发完后补的 `timeline-epoch-end {end_seq, count, has_more}`（能力位 `timeline.epoch-end`）；
  ② 订阅 `res` 已回（老服务端 0.54 / 服务端撞背压提前停时的兜底，按连续前缀收口续拉）。为什么要删：网络慢一点或
  一次 GC 停顿就误判成「停」并按前缀收口续拉（用户看到的是那条假缺口报告），反过来真没发完时也分不清两件事。
  帧口径见 [gateway-rpc](docs/architecture/gateway-rpc.md)。
- **首屏回填失败时不再从 seq 1 回放**：chat 订阅的 `after_timeline_seq` 夹到**当前尾部窗口**左端
  （`tailWindowStart(target) - 1`，与首屏回填同一预算 `TIMELINE_TAIL_WINDOW_EVENTS = 2000`）。真机（`d813eaea` 只读拷贝、
  同一 0.55 网关、避开 8644）：订阅起点 `0 → 207835`（`wal_head = 209835`），首屏帧数两边都是 2000，但尾部窗口落在
  209835 且 `has_more: false`；旧行为停在 2000（= 会话开头）且 `has_more: true`，会一路续下去。
- **修：时间线 hello 的时间线段是平铺的，客户端却按嵌套对象读** —— `readTimelineHelloSegment(source, info.timeline)`
  拿到的永远是 `undefined`，于是**四条校验与 epoch 记账在真机上从未生效**（一律退化成老 epoch 行为，靠 `truncateAfter`
  硬对齐游标）。现在 wire → 内部形状的映射收敛在 `apps/web/src/gateway/node/protocol.ts#readHelloTimelineSegment`
  一处（`timeline_source === 'timeline'` 且六个键齐全才给），判定与 `packages/serve/src/gateway/frames.ts#helloFrame`
  的平铺形状一致。真机（`eecc5a48`，订阅 `after_timeline_seq: 7000`）：epoch 记账生效、`timeline-epoch-end` 收尾得到声明
  `[7001..7955] count=955 has_more=false`，四条校验通过、零缺口（此前同一路径不会有任何 epoch 结算）。
- **前端乐观渲染**（`merge 59846a4b`）：点发送那一帧气泡上屏（pending 只在内存不落盘），回显按 run_id 认领
  （不许按正文，guardrail 会改写）；15s 无回显 ⇒ failed 留屏 + 重试/删除，重试复用同 id；断线单独钉失败不假装在飞。
- **401/Origin 被拒不再静默 + 待批失败兜底 + connection 档 + rotate 批准超时终态**（`merge ad93e0e0` / `7ae1f87a`，
  feat `62392d5e` / `32ad049b` / `58474db5`）：根因 —— 127.0.0.1:8644 时 POST /v1/rpc 全 401 被当普通失败吞掉，
  rotate 权限卡永远拿不到。现顶栏出 session 档「会话已失效（401）」给「重新登录」、origin 档「来源被拒
  （Origin 不在白名单）」给「连接设置」；只认 401/session_required/platform_unauthorized/csrf_failed 与
  forbidden_origin/invalid_host，权限类 403 不算；30s 冷却防成串 401 每请求一渲；成功即清。PendingView 出 ErrorState
  （含「重新拉取」，会话档再给「重新登录」），不再冒充「没有待批」；ComposerSlot 空位上加提示；失败不删本地卡，
  恢复后补回。connection 档：CORS 挡下的 TypeError 归「连接」不是「会话」——「连不上 node（来源被拒或服务未运行）」；
  仅本 epoch 从未成功过 + 30s 内连续失败 ≥3 次才抬，每 epoch 一次，成功一次即自动清且永不抬；hello（beginEpoch）
  之前不计数，冷启动不误报；同屏去重，token/协议错误永不被吞。rotate 批准超时：等待原无时限 → 缺省 120s
  （`rotateApprovalTimeoutMs` 可覆盖，<=0 回旧行为），超时按 rotate_not_needed / reason=approval_timeout 收口并发
  `tool.permission.expired` → 卡片收起 + toast「请求已过期」；过期 id 记 sessionStorage（上限 500）喂进 settled，
  刷新不再把死卡补回。取消码：用户按停止 → `cancelled: user`，不再说成 invalid_input（模型会误以为参数错而重试）；
  人类拒绝仍 denied_by_human。文案/降级：error 态 hint 渲成第二行小字（原来只喂原生 title 悬停）；hint 改指
  `http.allowed_origins`（不再引到 auth.public_origins）；relogin 先 notify 再 clear；没配登录后端 / /auth/status
  打不通时按钮降级「打开连接设置」。无真机读数（commit 明言真机留给统一验证窗）。
- **前端运行期自动重建 + 产物过期 SSE 推送 + 构建定时自查**（`merge 15ce2529` / `a3bd9d1d` / `4867fad2`）：
  探针 stale ⇒ 后台单飞重建（60s 限频、连续 3 次失败停手+warn）；/build.json 新增 autobuild{enabled,mode,failures,lastError}。
  Web 产物过期改 SSE 推送（GET /web/build/events：首帧立即、25s ping、上限 32 连接），轮询只做兜底
  （10s→30s→60s 自适应）；绝不自动 reload；修 Bun idleTimeout 10s 掐空闲 SSE（平台改 0）。平台低频定时器缺省 60s
  （VESSEL_WEB_AUTOBUILD_CHECK_MS 可配、下限 5s），不开浏览器也自愈；stop 时 clearInterval。开关收口：
  VESSEL_NO_WEB_AUTOBUILD=1 全关 / VESSEL_WEB_AUTOBUILD=startup 只启动时建 / 缺省 always（与旧行为一致）。
  实测（来源=commit message）：旧 8,640 请求/天·标签页≈2.6MB→稳态 27KB/天，提示翻转延迟实测 2.05s；
  touch 后最坏 <60s 自动重建，实测 dur=15.1s。
- **会话 / team 卡片排序：运行中优先 + 稳定位置闸门**（`merge 5ed85cfa` / `890fed8a`）：会话列表按
  running→queued→空闲、同级服务端 updated_at 降序；权威 = health.get 调度器账本（明确排除 SessionInfo.status
  假运行态），零新增请求。位置闸门：滚动中不重排，只在切视图/刷新/新会话等显式时机收敛；运行中徽标 5px amber 圆点，
  run 结束原地失去标记、位置下次才归位。team 卡片与会话共用同一套闸门（useStableOrder）：有成员在跑置顶 +
  max(成员 last_seen, body last_active_at)，徽标「有成员在跑」；复用 health 轮询零新增请求。
- **工具卡把内部 id 换成人能认的名字**（`merge 413ff17a`）：roster 命中 ⇒ 名字、UUID 查不到 ⇒ 前 8 位+…、
  非 UUID 原样；覆盖 agent/inbox/close/subscribe 等 id 字段，>3 名成员只报「N 名成员（a、b 等）」；
  零新增轮询/RPC，展开体入参仍是原始 JSON。
- **长参数改「内容区自己滚」+ 修窄屏槽位 max-height 失效**（`merge 85e9979c`）：permission/ask 长参数新令牌
  `--prompt-params-max-h: min(40vh, 24rem)`，参数块不再穿透吸顶头/吸底按钮条（重叠 33908px²→0）；
  修窄屏（≤680px）槽位 max-height 整条失效（无单位 0 参与 min()；360 宽槽位 2464/4123px→448/448）与
  fieldset 匿名盒不收缩（display:contents，AX 树 role=group 不变）。
- **待确认气泡收敛到既有设计语言**（`merge ab6fe649`）：amber 表达「还没完成」（不透明底、正文对比≥7:1），
  失败档只状态字换 --danger 不换底色；动作键「重试」「删除」常显不藏 hover、窄屏换行不省略。
- **删常驻「默认隐藏 N 个…」banner**（`merge 8811a385`，feat `c1a81883` / `0b7232ef`）：团队页 TeamsListColumn
  「默认隐藏 N 个已归档 Team」常驻 role=status banner 与 AgentsView「默认隐藏 N 个停用 agent」常驻提示删除；
  全隐藏时的空状态说明保留（archive.empty.teams / archive.hidden.teams，i18n 键不删），部分可见时不再提示隐藏数量；
  failed/partialErrors 提示条不受影响。
- **时间线排序 O(n) 单调快路径 + 历史 item 身份去绝对下标**（`merge 98ae56b3`）：ts 排序已是恒等变换，
  真倒退 warn + 退回旧行为；历史 item 身份改 run_id+role+timestamp（模拟裁前 100/300/600 条：旧键 328/284/196 条
  被别的消息接管 ⇒ 新键 0）。chunk 瘦身只出测量数字未实施：逐字段删 −49.8%（省 15.7MB）、按流打包约 −96%
  需改 blocks.ts（未做）。实测（来源=commit message）：105,667 条 ts 倒退 0 次；3.8-5.4ms→1.0-1.9ms。
- **usage 诚实降级 + web 端 serve 残留文案**（`merge c8cb4d54` 新增部分）：i18n 10 处用户可见文案
  serve.port/serve.allowed_origins → node.port/node.allowed_origins（zh/en 各 5）；usage 插件 SourceCoverage 新增
  source_retired/frozen_at，源停写显示「用量无法统计…空数字是数据源没了，不是没有用量」、文件还在显示
  「数据截至 <日期>」，不再渲染「还没有用量」空态。（usage 数据源迁移见「性能 / 语义变更」首条。）

### 日志中枢（gateway 降噪 / 着色 / config / WebUI）

- **进程级日志中枢**（`feat/gateway-log` P1–P6，commits `d64fa589` / `4d371234` / `f2e3d4d7` /
  `bbb97652` / `ff90d071`）：core 新增 `log-hub.ts`（级别阈值 / 按模块级别 / 格式 / 时间 / 颜色，
  运行时可改）与 `log-format.ts`（排版唯一来源，自 `serve/log-event.ts` 搬入 `EVENT_FIELDS`）。
  core Logger、serve `logEvent`、插件注入 Logger 三路汇流 `emitLogLine`：过滤 → 脱敏 → 排版 →
  `writeStderrNotice`（EPIPE 自激防护不变量保留，无裸 `process.stderr.write`）；`logEvent` 首次纳入
  redactor。`createStderrLogger` 改薄封装、阈值实时读取（模块级单例自动跟随配置）。
- **降噪**（降 debug 不删除，`modules` 可单独打开）：`timeline.gap_reported` warn→debug +
  同 session 60s 窗口折叠（`suppressed=N`，诊断面板不折叠）；`gateway.ws.closed` 正常关闭
  （客户端 1000/1001）debug、异常（1006/1011 / 服务端发起）warn、其余 info（审计账不折叠，
  node 与平台代理共用 `wsClosedLevel`）；`agent.bash_job.delivering/delivered/delivery_ready`、
  `basic_tools.bash_job.started`、`run.timing` / `run.llm.gap` 降 debug（`VESSEL_RUN_TIMING=1`
  仍可强制开，`0/false/off` 强制关）；`agent.snapshot.duplicate_name` 每 name 进程内首次 warn；
  provider retry 第 1 次 debug、≥2 次 warn；`update.check.failed` 网络失败 1h 窗口折叠。
  basic-tools 起步行 / plugin-host 默认 logger / proxy 记账出口收口事件行，消灭第三种格式。
- **着色**：`shouldColor`（`NO_COLOR`/`TERM=dumb`/`color:never` 优先关；`always`/`FORCE_COLOR≠0`
  强制开；auto=`stderr.isTTY`）；`COLORTERM` truecolor/16 色两档。配色：INF 海洋绿 `#1EFFC7`、
  WRN 品红+BOLD（不用黄）、ERR RED+BOLD、时间/DBG/事件域/key= DIM、ERR 行 error/reason 值 RED。
  daemon 落盘天然无 ANSI、时间 iso。配色表进宪法第十四条 §2.1。
- **config 热应用**：`observability.log.{level,modules,color,format,time}`（schema / 校验 /
  默认值 / `modules` 键 snake→camel 豁免）；启动应用 + config-watch 热应用（log applier，差异行
  `log: level info→debug` 进 `runtime.notice`，不新增 RPC scope）；优先级 `VESSEL_DEBUG` >
  `VESSEL_LOG_LEVEL` > `VESSEL_RUN_TIMING` 强制 > config > 默认；`config show` / `config.get`
  （新增可选 `logEnvOverrides`）/ WebUI 标注环境覆盖。
- **WebUI**：Settings 新增「日志（gateway）」分组（4 个枚举键走既有 `config.set` write 权限，
  `ui-settings` 支持三层键嵌套写）；`modules` 一期只读展示；被环境变量覆盖的键只读 + 提示。
  口径见 [operations/LOGS §1.1](docs/operations/LOGS.md)、[architecture/config](docs/architecture/config.md)。
- **构建进日志 + 事件日志单行化收口**（`merge 1526befe` / `05eb1432`）：web.build.start / progress（≥30s 才打、
  最多 2 条）/ done（dur/assets/bytes）/ fail（exit/dur/log + 内联最后 ≤15 行、每行 ≤160 字）/ interrupted；
  完整输出写文件保留 7 天；/build.json 新增 build{phase,startedAt,pid,reason,log,last}，gateway status 打
  web.build.running/last；日志单一权威收口：packages/serve console.* 21→10、手拼 event= 行清零；
  Windows 构建中被 stop 由停止方代打 interrupted。事件日志单行 key=value（formatEventLine 统一排版：
  字段序由定义表固定、node 用名字、reason/error 截 60 字、12082ms→12.1s；VESSEL_LOG_JSON=1 出单行 JSON）；
  构建横幅三态（building > builtAt 变了 > stale）；apps/web 用户可见文案清掉全部 vessel/bun/npm 命令。
  实测（来源=commit message）：13 行→1 行。
- **代理层失败日志按 (node, 事件, path/方法) 5s 节流**（`merge d598bd02`）：node_timeout / node_unreachable /
  proxy.failed / rpc_denied 节流，下一行带 suppressed:N（Map 上限 256）；成功路径与 ws.closed 审计不受影响。
  实测（来源=commit message）：10 并发 504 ⇒ 1 行（原 10 行）。

### 治理与内部

- **宪法第三/四条：全部测试 / 探针 / 门禁废除，存量清除**（`40e784db` / `e9c4ea27` / `ea93937f` +
  AGENTS.md 重写 `ca3ab485` / `7e04e183` / `71f0b868`）：`*.test.*` / `*.spec.*` / `__tests__/` / 测试夹具
  一律不进仓库，存量随触碰删除、不补等价物；**「不写测试」= 任何位置都不写测试文件**（2026-11-18 用户裁定，
  仓库外/临时目录同样禁止）；行为验证由用户本人做，不派 verifier/QA 子 agent、不起临时进程/服务/端口/data dir；
  静态门禁由实施切片的 N 跑 typecheck/lint/build（各自独立看 exit code）；`bun run build` 是唯一构建期检查。
- **AGENTS.md worktree 规范**（`merge dace10c3`，feat `6fd88cf0`）：位置 worktrees/<topic>（仓库之外同级）、
  分支 feat|fix|chore/<topic> 从本地 main 起；不共享依赖（本地 bun install，禁 junction/硬链接/共享副本）；
  收尾必删（git worktree remove --force）；删除禁区（不用 rm -rf node_modules/ 尾斜杠或 glob —— 会清空主仓）；
  批量清理按分支是否已合进 main 分类（不用 mtime 判断）；大量删除别在 WSL/git-bash 里跑（用原生 Windows）。
- **build.ts 胜负反射真相**（`merge d7649ffa`，feat `b9bb7eff`）：rc 与证据双判，成功行只在全绿时打印；
  根 typecheck 串上 apps/web。
- **宪法第十二条 · 常设授权**（`merge adea00b0`）：什么不必问，只落文档（docs/constitution/12-autonomy.md）。
- **工具解耦设计（docs-only，target）**（`merge d17e1ff9`）：docs/architecture/0.57-tool-host.md + INDEX 登记；
  结论：工具面不能搬只能搬 handler；推荐先 A 后 B，B 只覆盖 bash/web/MCP，read/edit/write 不搬。
  实测（来源=commit message）：管道往返 1KB 0.15ms / 100KB 0.28ms / 1MB 6.4ms；cache-busting import() 实测
  basic-tools 每次 +1.3MB 常驻、调 GC 不回收（50 次 +66MB）；win32 bun 1.3.9 经 WSL 互操作，Linux 原生三组数待测。
- **版本基线全线对齐 0.56.0**（docs-audit 裁决 1，2026-11-18 用户拍板；本切片执行）：根与 workspace manifests
  经 scripts/version.ts 写模式升 0.56.0（packages/plugin-sdk 独立版本线 1.0.0 不动）；CURRENT/CHANGELOG/versions
  基线口径统一 0.56.0；CHANGELOG 只保留当前版本段，0.54.0 段迁 docs/versions/0.54.0.md，0.52 明细迁 0.53.0.md。
