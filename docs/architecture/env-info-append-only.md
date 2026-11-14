---
title: 环境信息与 append-only 上下文
kind: current
triggers: [append-only, context, message, notice, env info, environment, self card, tool surface, model change, scope, files, doc-subscription, prompt.system_context, changed, compaction, cleared tool result, 环境信息, 环境块, 增量视图, 占位, 旧工具结果, 追加写]
paths: [packages/core/src/runtime/execution-unit.ts, packages/core/src/context/context-manager.ts, packages/core/src/pii/notice.ts, packages/agent/src/env-info-scope.ts, packages/agent/src/self-card-delta.ts, packages/agent/src/tool-surface-delta.ts, plugins/context/doc-subscription/src/notice.ts, apps/web/src/domains/chat/env-notice.ts, scripts/check-append-only-context.ts]
---

# 环境信息与 append-only 上下文

## 不变量

同一会话的 `SessionState.messages` 落盘序列是 **append-only**：后一份的前 N 条必须与前一份
前 N 条**逐字相同**，尾部只许变长。唯一的「pop」是压缩：整段被摘要替换，且必须能在
`(prev.derived_upto_seq, next.derived_upto_seq]` 里找到 `context.compacted` / `message.compaction`。
鉴于此，**身份 / 工具 / 模型 / 提示词 / 重启**这些变更一律以「追加一条环境信息」表达，
不得改写已落盘消息。

判据与挂接点：`scripts/check-append-only-context.ts`（挂进 `bun run gates`）。三层：
C0 判据自检（证伪用）、C1 真 core 端到端（抓每一次 `SessionState` 落盘逐对比）、
C2 静态钉住（生产者只许尾部追加）、C3 scope 词表对拍。通过时打印跑过的路径。

## 环境信息（唯一一类卡）

一条 `role: 'user'` + `name: 'vessel:notice'` 的尾消息 = 一条环境信息。**不新造事件**，Web 由
`apps/web/src/domains/chat/env-notice.ts` 解析成卡，**唯一渲染入口是 `EnvCard`**（标题「环境信息」），
首行的 scope 词决定卡头标签：

| scope | 含义 | 生产者 |
|---|---|---|
| `restart` | 系统 / body 重启 | （词表已留位） |
| `identity` | 改名 / Team / parent | `self-card-delta` |
| `fields` | 其它基础字段 | `self-card-delta` |
| `model` | 模型变更 | `self-card-delta` |
| `tools` | 工具面变更（含权限档） | `tool-surface-delta`、`self-card-delta` |
| `files` | 文件变更（订阅文件改了；只报 path/id/rev/bytes，不报正文） | `doc-subscription`（插件包） |
| `context` | 系统提示词 / 自卡本身变了 | `self-card-delta`、`prompt.system_context` 的增量视图 |
| `pii` | PII 句柄失效 / 容量耗尽（只列占位符 id + 类别，不含真值） | `packages/core/src/pii/notice.ts`（core 的 `ExecutionUnit.appendPiiDeadNotice`） |

词表唯一真相是 `packages/agent/src/env-info-scope.ts`（`ENV_INFO_SCOPES`）；Web 侧
`ENV_NOTICE_SCOPES` 必须认得出每一个词，另留老词 `config` / `permission` / `mcp` / `update` /
`peer` / `selfcard`（历史消息里都在用）。C3 做对拍：生产者加了词而 Web 没加，门禁红；
插件包里那份**字面量副本**（`plugins/context/doc-subscription/src/notice.ts` 的
`SUBSCRIPTION_NOTICE_SCOPE` / `SUBSCRIPTION_NOTICE_DETAIL_MARK`，插件不依赖本包）以及
每个词的中英卡头标签也一并点对点校验。

`doc-subscription` 以前自己开了一条通道（`vessel:subscription`，只有打开「显示系统信息」才
可见）。并进本表后它**默认可见**、渲染成「文件变更」卡：订阅是用户自己开的，看不到「自己订阅
的文件变了」比多一张卡更坏。历史里那批 `vessel:subscription` 消息不做特判，按未登记
`vessel:*` kind 的兜底渲染成整段 notice（可读、不崩、不是裸 JSON）。

去重口径（三条通道同族）：记住「模型现在相信的值」，注入一次就推进到当前值；下一轮 diff
为空就不再注入。所以同一变更只报一次，而回滚（A→B→A）因为与「相信的值」不同、照样会报。

## 增量视图（不在落盘上做手脚）

`prompt.system_context` 仍把**全量**快照落盘（审计用的真相），additive 加两个字段：
`changed: string[]`（与上一份发布过的快照差在哪，`model: A → B` / `tools: 12 → 14`；
首次与换会话没有可比对象 ⇒ 缺省）与 `previous_hash`。去重键是**整份环境快照**
（两段原文 + 模型 + 工具个数），否则模型 / 工具的变化永远不会被发布。

客户端拿到 `changed` ⇒ 卡头「N 项变更」、摘要只列变了的项、展开仍是全量快照；
**缺省 = 不知道**（首次 / 旧日志），退回全量快照卡，绝不渲成「0 项变更」。

## 旧工具结果的占位（曾经是唯一的例外）

`planClearedToolResults` 只**算**哪些旧工具结果超出保留预算；真正的占位替换发生在
`ExecutionUnit.buildRequestMessages` 的**请求级视图**（`withClearedToolResults` 返回新数组，
被替换的几条是新对象）。因此：发给 provider 的请求照旧省 token，
`SessionState.messages` / 落盘 / `sessions.get` 读回来的**永远是原文**。
审计仍是 `message.compaction.cleared_tool_call_ids`（点名集合），但凭据不是改写许可证 ——
落盘序列上任何幸存消息的内容变化都算重写。

占位改变了请求消息序列 ⇒ `buildRequestMessages` 记一次显式 `context_trim`，
`PromptPrefixGuard` 据此有据可依（不报「莫名前缀变化」）。

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
