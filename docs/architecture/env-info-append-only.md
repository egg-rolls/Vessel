---
title: 环境信息与 append-only 上下文
kind: current
triggers: [append-only, context, message, notice, env info, environment, self card, tool surface, model change, scope, files, doc-subscription, prompt.system_context, changed, compaction, cleared tool result, lock, conflict, cadence, env_injection, 环境信息, 环境块, 增量视图, 占位, 旧工具结果, 追加写, 写锁, 注入节奏]
paths: [packages/core/src/runtime/execution-unit.ts, packages/core/src/runtime/runtime.ts, packages/core/src/context/context-manager.ts, packages/core/src/context/model-change-notice.ts, packages/core/src/context/context-notice.ts, packages/core/src/pii/notice.ts, packages/agent/src/env-info-scope.ts, packages/agent/src/self-card-delta.ts, packages/config/src/env-injection.ts, plugins/context/doc-subscription/src/notice.ts, plugins/context/doc-subscription/src/hook.ts, plugins/tools/basic-tools/src/index.ts, src/node-resume.ts, src/runtime-notice-hook.ts, src/plugin-config.ts, src/tenant-runtime-factory.ts, apps/web/src/domains/chat/env-notice.ts]
---

# 环境信息与 append-only 上下文

## 不变量

同一会话的 `SessionState.messages` 落盘序列是 **append-only**：后一份的前 N 条必须与前一份
前 N 条**逐字相同**，尾部只许变长。唯一的「pop」是压缩：整段被摘要替换，且必须能在
`(prev.derived_upto_seq, next.derived_upto_seq]` 里找到 `context.compacted` / `message.compaction`。
鉴于此，**身份 / 工具 / 模型 / 提示词 / 重启**这些变更一律以「追加一条环境信息」表达，
不得改写已落盘消息。

判据与挂接点（**原来那份校验脚本已按宪法删除，下面是它当年守的四层判据，改动此处时人工核对**）：
C0 判据自检（证伪用）、C1 真 core 端到端（抓每一次 `SessionState` 落盘逐对比）、C2 静态钉住（生产者只许尾部追加）、C3 scope 词表对拍。

## 环境信息（唯一一类卡）

一条 `role: 'user'` + `name: 'vessel:notice'` 的尾消息 = 一条环境信息。**不新造事件**，Web 由
`apps/web/src/domains/chat/env-notice.ts` 解析成卡，**唯一渲染入口是 `EnvCard`**（标题「环境信息」），
首行的 scope 词决定卡头标签：

| scope | 含义 | 生产者 |
|---|---|---|
| `restart` | 系统 / body 重启 | `src/node-resume.ts`（`restartCardText`：run_id + ISO 时刻进明细，兼作启动幂等去重键） |
| `identity` | 改名 / Team / parent | `self-card-delta` |
| `fields` | 其它基础字段 | `self-card-delta` |
| `model` | 模型变更 | `self-card-delta`、core EU（`ExecutionUnit` 首 run 指纹比较） |
| `tools` | 工具面变更（含权限档） | core EU（`ExecutionUnit.appendToolSurfaceNotice`，对会话 tools[] 快照 diff live 宿主；文案 `context-notice.ts` 的 `renderToolSurfaceNotice`）、`self-card-delta` |
| `lock` | 工作区写锁争用 / 超时（写未执行） | `basic-tools`（`createWriteCoordNoticeHook`） |
| `conflict` | `expected_content` 并发修改冲突（写未执行） | `basic-tools`（同上） |
| `files` | 文件变更（订阅文件改了；元数据为主，line-level 例外见下） | `doc-subscription`（插件包） |
| `context` | 系统提示词 / 自卡本身变了；run 内上下文超限卡 | `self-card-delta`、`prompt.system_context` 的增量视图、core EU（`appendContextOverflowNotice`） |
| `trim` | 工具结果被换成占位 / 被归档（只报条数与 call id，不含工具输出正文） | core EU（placeholder 的 trim 卡 `renderContextTrimNotice`；archive_notice 的归档卡 `renderArchiveNotice`，首词同为 `trim`） |
| `pii` | PII 句柄失效 / 容量耗尽（只列占位符 id + 类别，不含真值） | `packages/core/src/pii/notice.ts`（core 的 `ExecutionUnit.appendPiiDeadNotice`） |

词表唯一真相是 `packages/agent/src/env-info-scope.ts`（`ENV_INFO_SCOPES`，顺序即同轮落盘顺序）；
Web 侧 `ENV_NOTICE_SCOPES` 必须认得出每一个词，另留老词 `config` / `permission` / `mcp` / `update` / `peer` / `selfcard`（历史消息里都在用）。
**对拍是人工核对**（旧 C3/parity 脚本已按宪法删除，不重建）：加词时同步 Web `ENV_NOTICE_SCOPES`、i18n 标签（`chat.env.scope.*`）、
config `DEFAULT_ENV_CADENCE` 与插件字面量副本；生产者加了词而 Web 没加，卡头会静默退化成「上下文」。
插件包里的**字面量副本**（`plugins/context/doc-subscription/src/notice.ts` 的 `SUBSCRIPTION_NOTICE_SCOPE` / `SUBSCRIPTION_NOTICE_DETAIL_MARK`，
插件不依赖本包）、`ENV_INFO_DETAIL_MARK` 与 `src/runtime-notice-hook.ts` 的 `NOTICE_DETAIL_MARK` 逐字相同，也在人工对拍范围内。

**files 的 line-level 例外**：通知默认只列 path / id / rev / bytes；**有 read 引用的条目**走 line-level 观察（内容锚重定位 + 范围 diff，`hook.ts` 的 `analyzeReads`），
元数据行 additive 带 `lines="a-b"`，且**第一个（path 序）line-level 变化条目**可带 diff 明细行（`notice.ts` 的 `formatSubscriptionNotice`）：
行预算 = 11 −（摘要 + 元数据 + 溢出概括 + inspect 提示），字节预算 = `content.maxBytes`，超预算折成截断标记；无 content 时输出与旧版逐字节一致。
这是「只报元数据」的唯一 additive 例外——预算内的 diff 行，不是全文。

`doc-subscription` 以前自己开了一条通道（`vessel:subscription`，只有打开「显示系统信息」才可见）。并进本表后它**默认可见**、渲染成「文件变更」卡。
历史里那批 `vessel:subscription` 消息不做特判，按未登记 `vessel:*` kind 的兜底渲染成整段 notice（可读、不崩、不是裸 JSON）。

去重口径（三条通道同族）：记住「模型现在相信的值」，注入一次就推进到当前值；下一轮 diff 为空就不再注入。所以同一变更只报一次，而回滚（A→B→A）因为与「相信的值」不同、照样会报。

<a id="cadence"></a>

## 注入节奏（cadence）：两轴框架

**轴 A 检测节奏**：`request` = 每 LLM 请求前检测；`run` = 每 run 首次请求前检测。**轴 B 抑制去重**
（believed-value / 游标 / 签名 / 预算）恒开，与轴 A 正交，不在配置里。声明层唯一真相在
`packages/config/src/env-injection.ts`（`DEFAULT_ENV_CADENCE` / `resolveEnvCadence` / `finestCadence` / `PINNED_REQUEST_SCOPES`）。

| 环节 | 事实 |
|---|---|
| 配置 | YAML `env_injection`（`default` + per-scope `scopes`）；优先级：显式 per-scope > `DEFAULT_ENV_CADENCE` > `default` > `'run'`。内置默认 = 今天行为（零回归）：`files` / `trim` = `run`，其余 env 词与 bus legacy 词（config / permission / mcp / update / peer）= `request` |
| 校验 | `validateEnvInjection`：未知 scope 键拒绝（必须在 `DEFAULT_ENV_CADENCE` 里）；值只认 request / run；`trim` / `model` 显式配 `request` **报错拒绝**（不静默钳制）——两者自然节奏钉死（trim 段起点冻结 = 前缀不变量；model 钉在 EU 首 run 生命周期），不经 cadence gate |
| core 端口 | core 只认识 `EnvCadence` 类型（领域无关）；`TenantRuntimeProfile.envCadence`（core `runtime/runtime.ts`）由装配注入（`src/tenant-runtime-factory.ts` 调 `resolveEnvCadence`），缺省不注入 ⇒ 恒按 request 观察。EU `envCadenceAllows`：`run` 时每 run 只放行首次观察（runId 未知放行；记帐环形上限 64 run）；**必须在 producer 的观察 / diff 之前调**，否则 believed-value 已推进而卡被吞 = 变更永丢 |
| 整 hook gate | 组内取最细（`finestCadence`：任一 request ⇒ request）：`self-card-delta`（identity / fields / model / tools / context）、`runtime-notice-hook` bus（config / permission / tools / mcp / update / peer；gate 在 `takeStored` 之前，游标不推进 ⇒ 通知不丢，下一 run 首请求照常取） |
| 插件 per-scope | 装配 `src/plugin-config.ts` 按 `ENV_GRANULARITY_SCOPES` 把解析好的节奏注入 install config 的 `envGranularity`（doc-subscription → files；basic-tools → lock / conflict）；插件不 import config resolver，只读字面量，缺省不注入 ⇒ 用内置默认（lock / conflict = request）；显式插件配置已有 `envGranularity` 时不覆盖。写协调 hook **每请求都跑**，cadence 过滤在 drain 内按条目 scope 生效（整 hook 早退会吞掉另一 scope 的卡） |

## 增量视图（不在落盘上做手脚）

`prompt.system_context` 仍把**全量**快照落盘（审计用的真相），additive 加两个字段：
`changed: string[]`（与上一份发布过的快照差在哪，`model: A → B` / `tools: 12 → 14`；
首次与换会话没有可比对象 ⇒ 缺省）与 `previous_hash`。去重键是**整份环境快照**
（两段原文 + 模型 + 工具个数），否则模型 / 工具的变化永远不会被发布。

客户端拿到 `changed` ⇒ 卡头「N 项变更」、摘要只列变了的项、展开仍是全量快照；
**缺省 = 不知道**（首次 / 旧日志），退回全量快照卡，绝不渲成「0 项变更」。

## 旧工具结果的占位（请求级视图）

`planClearedToolResults` 只**算**哪些旧工具结果超出保留预算；真正的占位替换发生在
`ExecutionUnit.buildRequestMessages` 的**请求级视图**（`withClearedToolResults` 返回新数组）。
发给 provider 的请求照旧省 token，`SessionState.messages` / 落盘 / `sessions.get` 读回来的**永远是原文**；
审计是 `message.compaction.cleared_tool_call_ids`（点名集合），凭据不是改写许可证——落盘序列上
任何幸存消息的内容变化都算重写。占位改变了请求消息序列 ⇒ 记一次显式 `context_trim`，
`PromptPrefixGuard` 据此有据可依。投射三模式（placeholder / passthrough / archive_notice）与
体积阈值见 [session-length](session-length.md)。

## 两张数据源、一处渲染

`EnvCard` 是环境信息的唯一渲染入口，数据来源有两条，形状都归一到 `EnvNoticeCard`：

| 来源 | 形态 | 谁装配 |
|---|---|---|
| `vessel:notice` 消息 | 文本行（首行摘要 + `  · ` 明细） | `envNoticeCard`（解析） |
| `prompt.system_context` 事件 | 行（摘要 / 增量）+ 原文块（全量快照） | `envCardOfPromptContext` |

原文块是 `EnvNoticeCard` 的 additive 槽（`blocks`）：快照原文按行拆会失真、按行数上限
截断会丢事实，所以它与「行」是两种粒度、各放一处；卡头 meta / 展开区 footnote 同样是
additive 显示槽（增量视图的「N 项变更」、hash / 上一份 hash）。

## 边界

- 不重建 body、不改 system 消息、不新增事件类型；
- `packages/agent/**` 只许往 `ctx.messages` 尾部追加（C2 静态钉住）；
- `state.messages` 的唯一写口是 `RunJournal.saveSessionState`（EU 不直连 `SessionStore`）。