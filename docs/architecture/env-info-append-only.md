---
title: 环境信息与 append-only 上下文
kind: current
triggers: [append-only, context, message, notice, env info, environment, self card, tool surface, model change, scope, files, health, script, doc-lag, code-heaviness, 订阅脚本, doc-subscription, prompt.system_context, changed, compaction, cleared tool result, lock, conflict, cadence, off, channel, ui-only, env_injection, 环境信息, 环境块, 增量视图, 占位, 旧工具结果, 追加写, 写锁, 注入节奏, 通道]
paths: [packages/core/src/runtime/execution-unit.ts, packages/core/src/runtime/runtime.ts, packages/core/src/types/env-cadence.ts, packages/core/src/context/context-manager.ts, packages/core/src/context/model-change-notice.ts, packages/core/src/context/context-notice.ts, packages/core/src/pii/notice.ts, packages/agent/src/env-info-scope.ts, packages/agent/src/self-card-delta.ts, packages/config/src/env-injection.ts, plugins/context/doc-subscription/src/notice.ts, plugins/context/doc-subscription/src/hook.ts, plugins/context/doc-subscription/src/health.ts, plugins/context/doc-subscription/src/script.ts, plugins/context/doc-subscription/src/config.ts, plugins/tools/basic-tools/src/index.ts, src/node/node-resume.ts, src/runtime/runtime-notice-hook.ts, src/plugin/plugin-config.ts, src/runtime/tenant-runtime-factory.ts, src/config/hot-apply-assembly.ts, apps/web/src/domains/chat/env-notice.ts]
---

# 环境信息与 append-only 上下文

## 不变量

同一会话的 `SessionState.messages` 落盘序列是 **append-only**：后一份的前 N 条必须与前一份
前 N 条**逐字相同**，尾部只许变长。唯一的「pop」是压缩：整段被摘要替换，且必须能在
`(prev.derived_upto_seq, next.derived_upto_seq]` 里找到 `context.compacted` / `message.compaction`。
鉴于此，**身份 / 工具 / 模型 / 提示词 / 重启**这些变更一律以「追加一条环境信息」表达，
不得改写已落盘消息。判据与挂接点（原校验脚本已按宪法删除，改动此处时人工核对）：
C0 判据自检、C1 真 core 端到端落盘逐对比、C2 静态钉住（生产者只许尾部追加）、C3 scope 词表对拍。

## 环境信息（唯一一类卡）

一条 `role: 'user'` + `name: 'vessel:notice'` 的尾消息 = 一条环境信息。**不新造事件**，Web 由
`apps/web/src/domains/chat/env-notice.ts` 解析成卡，**唯一渲染入口是 `EnvCard`**（标题「环境信息」），
首行的 scope 词决定卡头标签：

| scope | 含义 | 生产者 |
|---|---|---|
| `restart` | 系统 / body 重启 | `node-resume.ts`（`restartCardText`：run_id + ISO 时刻进明细，兼作启动幂等去重键）；force/崩溃发有疤恢复卡 `abnormalExitCardText`（SIGKILL 无 resume 标记，liveness sweep 对账 running→interrupted 后如实告知非正常退出、工具结果未知；带 continuation 的自重启标记归 node-continuation 无感续作，不发有疤卡） |
| `identity` | 改名 / Team / parent | `self-card-delta` |
| `fields` | 其它基础字段 | `self-card-delta` |
| `model` | 模型变更 | `self-card-delta`、core EU（首 run 指纹比较） |
| `tools` | 工具面变更（含权限档） | core EU（`appendToolSurfaceNotice`，对会话 tools[] 快照 diff live 宿主；文案 `context-notice.ts:renderToolSurfaceNotice`）、`self-card-delta` |
| `lock` | 工作区写锁争用 / 超时（写未执行） | `basic-tools`（`createWriteCoordNoticeHook`） |
| `conflict` | `expected_content` 并发修改冲突（写未执行） | `basic-tools`（同上） |
| `files` | 文件变更（订阅文件改了；元数据为主，line-level 例外见下） | `doc-subscription`（插件包） |
| `health` | node 健康变更（可达性翻转 / 版本 / 重启 started_at；只报元数据，快照在 inspect） | `doc-subscription` health 源（`health.ts`：读宿主落的快照文件，签名 = reachable/version/started_at/node_id；探测在宿主侧 node-health-watch，插件只消费事实） |
| `script` | 订阅脚本检测结果（通用兜底词；空输出不出卡，全文在 inspect） | `doc-subscription` script 源（`script.ts`：用户配置 allowlist 的检测命令 argv 无 shell 异步跑，fire-and-forget kickoff + BeforeLlm drain；空抑制 / diff 去重 / 首次全量；调度 run / request / interval **真 timer**（idle 也跑，单飞保持，remove/dispose/删名/off 四路 disarm）；live getter 热改即时生效） |
| `doc-lag` / `code-heaviness` | 内置检测器专词（案 B 注册制）：文档滞后（doc-sync --quiet）/ 代码厚重（code-size）；精确卡头 + per-scope 节奏/通道 | 同 script 源（`spec.scope` 声明，须 ∈ 已登记词表，未登记回落 `script`）；hook 按 scope 分组出卡（同 scope 折叠一条消息，不同 scope 各一张卡），channel per-scope 解析 |
| `context` | 系统提示词 / 自卡本身变了；run 内上下文超限卡 | `self-card-delta`、`prompt.system_context` 增量视图、core EU（`appendContextOverflowNotice`） |
| `trim` | 工具结果被换成占位 / 被归档（只报条数与 call id，不含工具输出正文） | core EU（placeholder 的 trim 卡 `renderContextTrimNotice`；archive_notice 的归档卡 `renderArchiveNotice`，首词同为 `trim`） |
| `pii` | PII 句柄失效 / 容量耗尽（只列占位符 id + 类别，不含真值） | `packages/core/src/pii/notice.ts`（`ExecutionUnit.appendPiiDeadNotice`） |

**词表单一事实源 = config `DEFAULT_ENV_CADENCE`**（`env-injection.ts`，20 词含 script / doc-lag / code-heaviness；R-10 单源）：
config 侧消费点一律派生（`Object.keys`）——ui-settings `ENV_GRANULARITY_SCOPES` / `SettableConfigKey`、
serve `SETTABLE_KEYS`、Web `settings-registry` / `env-notice` 词表，漂移结构上不可能；类型层用
`EnvScopeWord`（与值表同一对象派生）。agent 词表 `ENV_INFO_SCOPES`（有序子集，顺序即同轮落盘顺序）
与插件字面量副本（依赖方向不能 import config）仍**人工核对**：加词时同步 agent 数组、config 表、
i18n 标签（`chat.env.scope.*`）与插件副本（`SUBSCRIPTION_NOTICE_SCOPE` / `HEALTH_NOTICE_SCOPE` /
`SCRIPT_NOTICE_SCOPE` / `DOC_LAG_NOTICE_SCOPE` / `CODE_HEAVINESS_NOTICE_SCOPE` / `SUBSCRIPTION_NOTICE_DETAIL_MARK` /
`ENV_INFO_DETAIL_MARK` / `NOTICE_DETAIL_MARK` 逐字相同）。生产者加了词而 config 表没加，卡头静默退化「上下文」。
Web 另留老词 `config` / `permission` / `mcp` / `update` / `peer` / `selfcard`（历史消息里都在用）。

**files 的 line-level 例外**：通知默认只列 path / id / rev / bytes；**有 read 引用的条目**走 line-level
观察（内容锚重定位 + 范围 diff，`hook.ts:analyzeReads`），元数据行 additive 带 `lines="a-b"`，且
**第一个（path 序）line-level 变化条目**可带 diff 明细行（`notice.ts:formatSubscriptionNotice`）：
行预算 = 11 −（摘要 + 元数据 + 溢出概括 + inspect 提示），字节预算 = `content.maxBytes`，超预算折成
截断标记；无 content 时输出与旧版逐字节一致。这是「只报元数据」的唯一 additive 例外。
health 源与 files **独立 gate**（files=off 时 health 仍观察，反之亦然）；script 源 **per-scope 独立 gate**
（script / doc-lag / code-heaviness 各词独立 off / request / run，互不拖累；某词 off ⇒ 该词下订阅不 kickoff / drain / 出卡 + disarm timer）。`doc-subscription` 旧通道
`vessel:subscription` 历史消息按未登记 `vessel:*` kind 兜底渲染（可读不崩）。

去重口径（三条通道同族）：记住「模型现在相信的值」，注入一次就推进到当前值；下一轮 diff 为空就不再
注入。同一变更只报一次，回滚（A→B→A）与「相信的值」不同、照样会报。

<a id="cadence"></a>

## 注入节奏与通道：三轴框架

**轴 A 检测节奏**：`request` = 每 LLM 请求前检测；`run` = 每 run 首次请求前检测；`off` = 整段静默
（不观察、不产卡、不记帐）。**轴 C 投递通道**：`model+ui`（缺省 = 事件广播 + 模型注入）/ `ui-only`
（只广播事件落 UI 卡，模型不注入）。**轴 B 抑制去重**（believed-value / 游标 / 签名 / 预算）恒开，
与 A/C 正交，不在配置里。声明层唯一真相 `packages/config/src/env-injection.ts`
（`DEFAULT_ENV_CADENCE` / `resolveEnvCadence` / `resolveEnvChannel` / `finestCadence` / `PINNED_REQUEST_SCOPES`）。

| 环节 | 事实 |
|---|---|
| 配置 | YAML `env_injection`（`default` + per-scope `scopes` + per-scope `channels`）；节奏优先级：显式 per-scope > `DEFAULT_ENV_CADENCE` > `default` > `'run'`；通道：显式 channels > `model+ui`。内置默认 = 今天行为（零回归）：`files` / `trim` / `health` / `script` / `doc-lag` / `code-heaviness` = `run`，其余 env 词与 bus legacy 词 = `request`；缺省表不含 off。三组键均进 `config.set` 白名单（`envInjection.default` / `scopes.*` / `channels.*`） |
| 校验 | `validateEnvInjection`：未知 scope 键拒绝；节奏值只认 request / run / off，通道值只认 model+ui / ui-only；`trim` / `model` 显式配 `request` **报错拒绝**（自然节奏钉死：trim 段起点冻结 = 前缀不变量；model 钉在 EU 首 run 生命周期），**off 允许** |
| core 端口 | core 只认识 `EnvCadence` / `EnvChannel` 叶类型（`types/env-cadence.ts`，领域无关）；`TenantRuntimeProfile.envCadence` / `envChannel` 由装配注入（`tenant-runtime-factory.ts`），缺省不注入 ⇒ 恒 request + model+ui。EU `envCadenceAllows`：off 先于 run gate 整段静默；`run` 时每 run 只放行首次观察（runId 未知放行；记帐环形上限 64 run）；**必须在 producer 观察 / diff 之前调**。`envScopeOff` / `envUiOnly`：pinned scope（model/trim）off 允许；ui-only 走 `emitNoticeFactOnly`（只落 `message.injected` 事实，不写上下文） |
| 整 hook gate | 组内取最细（`finestCadence`：任一 request ⇒ request；**off 组忽略**，全 off ⇒ 'off' 整 hook 不注入）：`self-card-delta`（identity/fields/model/tools/context；混合配置里个别 scope off 由 per-scope off resolver 分组后过滤）、`runtime-notice-hook` bus（config/permission/tools/mcp/update/peer；off 不取通知不推游标；gate 在 `takeStored` 之前 ⇒ 通知不丢）。ui-only 通知按 scope 分组经 `ctx.emitFact` 落 UI 卡，游标已推进 |
| 插件 per-scope | 装配 `plugin-config.ts:applyEnvGranularity` 按词表把解析好的节奏 + 通道注入 install config 的 `envGranularity` / `envChannels`（doc-subscription → files/health/script/doc-lag/code-heaviness；basic-tools → lock/conflict）；插件不 import config resolver，只读字面量（camel/snake 双拼写），缺省不注入 ⇒ 内置默认；显式插件配置已有时不覆盖。doc-subscription 另注入 **live 配置 getter**（`buildPluginConfigMap` 第 6 参 `getLiveConfig`，三消费点同源）：cadence / channel / scripts allowlist 每次 hook run / 工具调用重新解析，成员持父 hook 引用也读活配置（hot-gate 同族修复）。写协调 hook **每请求都跑**，cadence 过滤在 drain 内按条目 scope 生效 |
| 热应用 | `hot-apply-assembly.ts:registerRuntimeNoticeHook` 入参是 **live 配置 getter**：cadence / channel 每次发射实时求值，热改 `env_injection` 即时生效（注册幂等，不靠重注册刷新） |

## 增量视图（不在落盘上做手脚）

`prompt.system_context` 仍把**全量**快照落盘（审计真相），additive 加 `changed: string[]`
（与上一份发布过的快照差在哪；首次 / 换会话无可比对象 ⇒ 缺省）与 `previous_hash`。去重键是
**整份环境快照**（两段原文 + 模型 + 工具个数）。客户端拿到 `changed` ⇒ 卡头「N 项变更」、
摘要只列变了的项、展开仍全量；**缺省 = 不知道**，退回全量快照卡，绝不渲成「0 项变更」。

## 旧工具结果的占位（请求级视图）

`planClearedToolResults` 只**算**哪些旧工具结果超出保留预算；真正的占位替换发生在
`ExecutionUnit.buildRequestMessages` 的**请求级视图**（`withClearedToolResults` 返回新数组）。
发给 provider 的请求省 token，`SessionState.messages` / 落盘 / `sessions.get` 读回来的**永远是原文**；
审计是 `message.compaction.cleared_tool_call_ids`。占位改变请求消息序列 ⇒ 记一次显式 `context_trim`，
`PromptPrefixGuard` 据此有据可依。`context.tool_result_whitelist` 命中的结果抗 trim 不抗 compaction：
消费侧纯后过滤（EU 段起点冻结与 `context-manager` 压缩审计集合两处同一规则，planner 一字不动），
配置见 [operations/config-limits](../operations/config-limits.md)。投射三模式（placeholder /
passthrough / archive_notice）与体积阈值见 [session-length](session-length.md)。

## 两张数据源、一处渲染

`EnvCard` 是环境信息的唯一渲染入口，数据来源两条，形状都归一到 `EnvNoticeCard`：
`vessel:notice` 消息（文本行：首行摘要 + `  · ` 明细，`envNoticeCard` 解析）与
`prompt.system_context` 事件（行 + 原文块，`envCardOfPromptContext`）。原文块是 additive 槽
（`blocks`）：快照原文按行拆会失真、按行数截断会丢事实，与「行」两种粒度各放一处；
卡头 meta / 展开区 footnote 同样是 additive 显示槽（「N 项变更」、hash / 上一份 hash）。

## 边界

- 不重建 body、不改 system 消息、不新增事件类型；
- `packages/agent/**` 只许往 `ctx.messages` 尾部追加（C2 静态钉住）；
- `state.messages` 的唯一写口是 `RunJournal.saveSessionState`（EU 不直连 `SessionStore`）。