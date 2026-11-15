# 0.54 投影卡规格 §1.5 实测：压缩/重启之后那条工具消息正文到底是什么

- 分支：`0.54-proj-readback`（基线 `main` @ `00a29b71`）
- 装置：`scripts/probe-proj-readback.ts`（新增，只测量、不断言；真 `ExecutionUnit` + 真
  `FileSessionStore` + 真 `SessionEventLog` + 真 `sessions.get` RPC handler + 真
  `capToolMessages`）
- 数据目录：`os.tmpdir()` 下的临时目录，跑完删。**没有**碰 `~/.vessel/data`，也没有读用户层 config。
- 入库注意：`.gitignore` 的 Test & Coverage 段有一条 `reports/` 规则，把 `docs/dev/reports/`
  整个忽略了；这份报告是用 `git add -f` 单独入库的（没改 `.gitignore`）。要让后续报告正常入库，
  需要在该段加一条 `!docs/dev/reports/` 例外。

## 0. 一句话结论

| 问题 | 结论 |
| --- | --- |
| **A 重启等价的恢复** | **分两种**：干净重启（会话壳是最新的、`derived_upto_seq` 覆盖压缩事件）走**增量**，正文仍是**原文**；一旦重启时「尾部（`seq > derived_upto_seq`）里有 `message.compaction` 或 `session.rewound`」或「缓存不可用 / 没有 `derived_upto_seq`」，就走 `projectMessages` 满投影，正文变成 **`[cleared ...]` 占位**，并被写回落盘（之后永远粘住）。 |
| **B 压缩当轮（不重启）** | **原文**。压缩只算「请求里会清哪些」的集合，一个字都不改正文；同一条消息在**请求视图里是占位、在落盘/`sessions.get` 里是原文**（同一次 run 内实测同 id 两种正文）。 |
| **C 8 KiB 裁剪** | **吃不掉前缀**。`capToolPayload` 是**保前缀**截断（保留前 8 KiB−标记长度，`... [truncated]` 追加在**尾部**），`[cleared ` 在首部 ⇒ 永远在；`isClearedToolResult` 是 `startsWith('[cleared ')`（+ legacy 全等）⇒ 裁剪后照样认得出；反向也不会误判（截断后的原文 `startsWith` 不是 `[cleared `）。 |

**所以 §1.5 的方向成立、细节要改**：不是「压缩之后落盘里就是占位」，而是「**任何一次全量重投影之后**落盘里才是占位」；压缩当轮和干净重启都还是原文。改写段落见 §4.1。

## 1. 实际跑过的命令与关键输出

### 1.1 环境

```
$ cd /mnt/d/Application/APP/Vessel/worktrees/proj-readback && pwd && git status --short --branch && git log --oneline -1
/mnt/d/Application/APP/Vessel/worktrees/proj-readback
## 0.54-proj-readback
00a29b71 chore(gates): 接 check:timeline-archive(35)；修根 package.json 内部依赖仍指 0.52.0（bun install 会 404）
```

worktree 原来没有 `node_modules`，跑了一次 `bun install`（root + `apps/web`），`bun.lock` 的
改动已 `git checkout --` 还原，`apps/web/bun.lock`（生成物）已删。

### 1.2 探针

```
$ cd /mnt/d/Application/APP/Vessel/worktrees/proj-readback && bun run scripts/probe-proj-readback.ts
```

装置要点（为什么不是纯函数单测）：

- 真 `ExecutionUnit.create(...)` + `contextFactory: MemoryWorkingContext({maxTokens: 20000, autoCompact: true})`；
- 真 `FileSessionStore(dir)` 写会话壳，真 `SessionEventLog({dir})` 写 `events.ndjson`（与真装配同分层：`<dir>/s-xxx.json` + `<dir>/s-xxx/events.ndjson`）；
- 「重启」= 丢掉旧节点（store / 日志实例 / provider / EU 全丢），用**同一个 dir** 再造一个，读的只有盘上的东西；
- `sessions.get` 调的是**真 RPC handler**（`packages/serve/src/gateway/methods/sessions.ts` 的 `createSessionMethods`），出站正文因此真的过了 `capToolMessages`（`sessions.ts:1300`）；
- 本会话没有声明 `context_projection` ⇒ 实测解析为 `placeholder（source=legacy）`（未声明时的默认），不是 passthrough（passthrough 不会有 `cleared_tool_call_ids`，这条打印是为了防假绿）。

### 1.3 阶段 0：造历史 + 真压缩（自动，段起点）

```
阶段 0：真 run × N，直到日志里出现 message.compaction
  压缩发生在第几轮 run = 28
  message.compaction 的 seq = 297
  cleared_tool_call_ids 条数 = 26
  cleared_tool_call_ids = ["call_1","call_2",...,"call_26"]
  压缩事件的 kept（保留的非 system 条数） = 16
  本会话解析出的投射模式 = placeholder（source=legacy）
  压缩当轮落盘 derived_upto_seq = 307
  落盘状态 vs 日志：压缩事件在不在「下次启动要重放的尾部」里 = 不在（derived 307 >= compaction 297）⇒ 下一次启动走增量
```

> 压缩是**真自动触发**的（`compactAtSegmentStart` → `autoCompactAsync`），不是我手工调 `compact()`。
> 这里有个坑值得记下来：请求里的旧工具结果被换成占位后**请求本身很小**，provider 上报的
> `prompt_tokens`（= `realTokens` 真实锚点）涨不上去 ⇒ 0.85 阈值很难触发。第一版探针正是
> 栽在这（跑 20 轮全绿假象，见 §6）。

### 1.4 B：压缩当轮、同一进程（同一条消息两个视角）

```
B 压缩当轮（同一进程、不重启）：sessions.get 的正文
  sessions.get.messages（4 条工具结果）
    call_25    cleared=false   5002 chars  build log line 0 xxxxxxxxxxxxxx\nbuild log line 1 ...
    call_26    cleared=false   5002 chars  build log line 0 xxxxxxxxxxxxxx\nbuild log line 1 ...
    call_27    cleared=false   5002 chars  build log line 0 xxxxxxxxxxxxxx\nbuild log line 1 ...
    call_28    cleared=false   5002 chars  build log line 0 xxxxxxxxxxxxxx\nbuild log line 1 ...
  落盘 state.messages（4 条工具结果）
    call_25    cleared=false   5002 chars  ...
    call_26    cleared=false   5002 chars  ...
    call_27    cleared=false   5002 chars  ...
    call_28    cleared=false   5002 chars  ...
  B:call_25 落盘正文 = cleared=false build log line 0 xxxxxxxxxxxxxx\nbuild log line 1 ...
  B:call_26 落盘正文 = cleared=false build log line 0 xxxxxxxxxxxxxx\nbuild log line 1 ...
  B: 审计集合里有、但已不在窗口里的 id 条数 = 24
  B 压缩当轮最后一条请求里的占位条数 = 2
  B 压缩当轮最后一条请求里的占位 id = ["call_25","call_26"]
  B:call_25 请求视图 vs 落盘 = 请求=[cleared bash: pnpm build -> exit 1, 151 lines] | 落盘=build log line 0 xxxxxxxxxxxxxx...
  B:call_26 请求视图 vs 落盘 = 请求=[cleared bash: pnpm build -> exit 1, 151 lines] | 落盘=build log line 0 xxxxxxxxxxxxxx...
```

⇒ **同一条 `call_25`：模型看到占位，落盘/`sessions.get` 是原文。** 顺带实测了 §1.5 的「陷阱 5」：
审计集合 26 条，窗口里真正被换成占位的只有 2 条，其余 24 条压根不在窗口里 —— 集合 ≠ 谁被换了。

### 1.5 A1：干净重启（新实例，盘上状态是最新的）

```
A1 干净重启（新 ExecutionUnit 实例，盘上状态是最新的）
  重启后 sessions.get.messages（4 条工具结果）
    call_25    cleared=false   5002 chars  ...
    call_26    cleared=false   5002 chars  ...
    call_27    cleared=false   5002 chars  ...
    call_28    cleared=false   5002 chars  ...
  A1:call_25 = cleared=false chars=5002 build log line 0 ...
  A1:call_26 = cleared=false chars=5002 build log line 0 ...
```

⇒ 走的是增量分支（`execution-unit.ts:4090` 的 `if (cached !== undefined && !fullProjectionForReplacement)`），
正文保住了。**「重启」本身不等于满投影。**

### 1.6 A2：重启时尾部含压缩事件（压缩已发事件、会话壳落后一轮 = 崩溃窗口）

做法：把「压缩当轮开始前」的会话壳快照原样写回（`cp -r` 冻结快照后再覆盖 `s-xxx.json`），
日志留着压缩事件 ⇒ `derived 294 < compaction 297`，正是 `loadStoredHistory` 判定满投影的条件。

```
A2 重启时尾部含压缩事件（= 压缩已发事件、会话壳还是上一轮的：崩溃窗口）
  回滚后的 derived_upto_seq（< compaction seq ⇒ 满投影） = 294
  回滚后的落盘正文（工具结果应仍是原文） = ["call_1:cleared=false",...,"call_27:cleared=false"]
  A2 重启一轮之后 sessions.get.messages（5 条工具结果）
    call_24    cleared=true      47 chars  [cleared bash: pnpm build -> exit 1, 151 lines]
    call_25    cleared=true      47 chars  [cleared bash: pnpm build -> exit 1, 151 lines]
    call_26    cleared=true      47 chars  [cleared bash: pnpm build -> exit 1, 151 lines]
    call_27    cleared=false   5002 chars  ...
    call_28    cleared=false   5002 chars  ...
  A2 重建后窗口的非 system 条数（对比压缩事件里的 kept） = 23
  A2:call_24 = cleared=true chars=47 [cleared bash: pnpm build -> exit 1, 151 lines]
  A2:call_25 = cleared=true chars=47 [cleared bash: pnpm build -> exit 1, 151 lines]
  A2:call_26 = cleared=true chars=47 [cleared bash: pnpm build -> exit 1, 151 lines]
  A2 恢复轮之后 derived_upto_seq = 314
```

⇒ 占位进了落盘，且 `sessions.get` 直接吐出 `[cleared ...]`。**原文只剩事件日志。**

### 1.7 A2b：占位落地之后再重启（粘性）

```
A2b 占位写进落盘之后**再**重启一次（增量路径，没触发满投影）
  A2b 再重启一轮之后 sessions.get.messages（5 条工具结果）
    call_24    cleared=true      47 chars  [cleared bash: pnpm build -> exit 1, 151 lines]
    call_25    cleared=true      47 chars  [cleared bash: pnpm build -> exit 1, 151 lines]
    call_26    cleared=true      47 chars  [cleared bash: pnpm build -> exit 1, 151 lines]
    call_27    cleared=false   5002 chars  ...
    call_28    cleared=false   5002 chars  ...
  A2b derived_upto_seq = 319
```

⇒ 一旦写进落盘就**粘住**：`derived` 已经越过压缩事件，后面每次重启都走增量，增量里保存的就是占位。

### 1.8 A3：缓存不可用（没有 `derived_upto_seq`，旧数据口径）⇒ 满投影

```
A3 重启时缓存没有 derived_upto_seq（旧数据 / 缓存缺失）⇒ 满投影
  A3 重启一轮之后 sessions.get.messages（5 条工具结果）
    call_24    cleared=true      47 chars  [cleared bash: pnpm build -> exit 1, 151 lines]
    call_25    cleared=true      47 chars  [cleared bash: pnpm build -> exit 1, 151 lines]
    call_26    cleared=true      47 chars  [cleared bash: pnpm build -> exit 1, 151 lines]
    call_27    cleared=false   5002 chars  ...
    call_28    cleared=false   5002 chars  ...
```

### 1.9 A4：尾部含 `session.rewound`（撤回与压缩是同一分支）

```
A4 重启时尾部含 session.rewound（撤回是「替换」⇒ 与压缩同一分支）
  追加的 session.rewound seq = 309
  落盘 derived_upto_seq（< rewound seq ⇒ 满投影） = 307
  A4 重启一轮之后 sessions.get.messages（5 条工具结果）
    call_24    cleared=true      47 chars  [cleared bash: pnpm build -> exit 1, 151 lines]
    call_25    cleared=true      47 chars  [cleared bash: pnpm build -> exit 1, 151 lines]
    call_26    cleared=true      47 chars  [cleared bash: pnpm build -> exit 1, 151 lines]
    call_27    cleared=false   5002 chars  ...
    call_28    cleared=false   5002 chars  ...
```

> 这条 `session.rewound` 是我往**真日志**里 append 的一条真事件（`keep_projected` = 当前窗口长度，
> 等价于「撤回但没有真的删内容」）。它证明的是「尾部有撤回事件 ⇒ 满投影 ⇒ 占位」，
> **不**证明真实 rewind 的窗口语义（见 §7 疑点）。

### 1.10 C：8 KiB 裁剪（`capToolMessages`）与 `isClearedToolResult`

```
C sessions.get 的 8 KiB 裁剪（capToolMessages）对占位的识别
  用来测裁剪的占位正文 = [cleared bash: pnpm build -> exit 1, 151 lines]
  C1 真实占位（短）：47 → 47 chars，尾部="> exit 1, 151 lines]"，前缀保留=true，isClearedToolResult=true
  C2 原文 6000 字符（未超 8 KiB）：5002 → 5002 chars，尾部="xxxxxxx\nexit code: 1"，前缀保留=false，isClearedToolResult=false
  C3 原文 40 KB（超 8 KiB）：40960 → 8192 chars，尾部="yyyyy... [truncated]"，前缀保留=false，isClearedToolResult=false
  C4 病态：占位本身 9 KB：9036 → 8192 chars，尾部="zzzzz... [truncated]"，前缀保留=true，isClearedToolResult=true
  C5 旧常量正文（精确匹配形态）：33 → 33 chars，尾部="ult content cleared]"，前缀保留=true，isClearedToolResult=true

C 追加：对截断后的原文再跑 formatClearedToolResult（§1.4 的自降级在裁剪后是什么样）
  原文行数（40000 字符单行） = 151
  对 40 KB 原文重跑（未裁剪） = [cleared -> 1 lines]
  对 8 KiB 截断后的正文重跑 = [cleared -> 1 lines]
```

读数：

- **前缀不会被吃掉。** `capToolPayload` 的截断是「保前缀 + 尾部追加 `... [truncated]`」
  （`packages/serve/src/tool-events.ts:75-76`），首部的 `[cleared ` 天然保留；
- **`isClearedToolResult` 裁剪后照样认得出**（C1 / C4 / C5），因为它是
  `content.startsWith('[cleared ')`（`cleared-tool-result.ts:114-116`），不是形状匹配；
- **反向也不会误判**：被截断的**原文** `startsWith` 不是 `[cleared `（C3），
  服务端仍能正确判成「inline_truncated」而不是「已占位」；
- **两个边界必须写进实现约束**：
  1. 占位**本身**超 8 KiB 时（C4 病态构造：工具名极长），尾部的 `]` 与数字会被截掉、还会多出
     `... [truncated]` ⇒ 服务端**只许用 `isClearedToolResult` 判身份**，**禁止**从正文里重算
     行数 / exit code（C 追加的两行就是反例：重算得到 `[cleared -> 1 lines]`，比模型看到的少一段）；
  2. `original_bytes` / `original_lines` 不能从出站正文推，只能从事件日志读（`tool.call.completed`）。

## 2. A / B / C 各一句

- **A（重启等价恢复）**：干净重启 = 原文；只有当重启时「尾部有 `message.compaction` / `session.rewound`」或「缓存不可用」时才满投影 ⇒ 正文变 `[cleared ...]` 并写回落盘，之后永久粘住。
- **B（压缩当轮）**：正文是**原文**；占位只存在于请求视图（同一条 id 实测「请求=占位 / 落盘=原文」）。
- **C（8 KiB 裁剪）**：吃不掉 `[cleared ` 前缀，`isClearedToolResult` 仍认得出，也不会把截断原文误判成占位；但**不许**从裁剪后的正文重算任何数字。

## 3. 「占位写进落盘」的完整触发条件清单

判定点只有一个：`execution-unit.ts:3999` / `:4017-4020`（`loadStoredHistory`）——
`needFullProjection`（缓存缺失）**或** `fullProjectionForReplacement`（尾部有压缩/撤回）⇒
走 `projectMessages(events)`（`:4116`），`project-messages.ts:232-245` 把命中的工具结果换成占位，
再经 `seedTransientContext` → `finalizeSessionState`（`:4255`）/ `saveSessionState`（`:4266`）写回落盘。

**不会写进落盘（正文保持原文）**

| # | 路径 | 实测 |
| --- | --- | --- |
| N1 | 压缩当轮（活窗口 `compact`）：只算 `cleared_tool_call_ids`，不改正文（`context-manager.ts:879`「这里**不改**任何一个工具结果的正文 —— 占位发生在请求构建层」+ `:904`） | §1.4 B |
| N2 | 压缩之后的同进程后续轮次（缓存 + 增量，尾部无压缩/撤回） | §1.4 / §1.5 |
| N3 | 干净重启：会话壳是最新的、`derived_upto_seq >= 压缩事件 seq`（尾部没有替换类事件） | §1.5 A1 |
| N4 | 请求视图本身（`buildRequestMessages` / `withClearedToolResults`）：改的是副本，`SessionState.messages` 不动 | §1.4 B（同 id 两视角） |

**会写进落盘（三种入口，一条出口）**

| # | 触发条件 | 现实对应 | 实测 |
| --- | --- | --- | --- |
| Y1 | 启动时尾部（`seq > derived_upto_seq`）里有 `message.compaction` | 压缩事件已落盘、会话壳还没存到那一版：进程在「压缩后、下一次 `saveSessionState` 前」被杀 / 崩溃 / 断电 | §1.6 A2 |
| Y2 | 启动时尾部里有 `session.rewound` | **撤回 / 分支切换**之后的下一次启动或下一轮 run（这条比 Y1 常见得多，因为撤回事件一定在最近一次保存之后） | §1.9 A4 |
| Y3 | 缓存不可用：`SessionState.messages` 为空 / `derived_upto_seq` 不是 number | 旧版本 sqlite 行、缓存被清、会话壳丢了但日志还在 | §1.8 A3 |

**粘性**：一旦写进落盘，`derived_upto_seq` 就覆盖了压缩事件 ⇒ 之后每次启动都走增量，
增量里就是占位。**原文此后只存在于事件日志**（`tool.call.completed` / `llm.response`），
`messages` 里再也拿不回来。实测 §1.7 A2b。

**对 `scripts/check-append-only-context.ts:804` 那条断言的读法**：它今天绿是**对的**，但它只覆盖
N1/N4 —— 探针（`buildClearingProbe`）是 `new MemoryWorkingContext(...)` + `context.compact(true)` +
读 `context.messages`，根本没有 EU、日志、重启，所以它证明的是「活窗口不改正文」，
**证明不了**「落盘不改正文」。它在 §1.5 语境里被当成后者的证据，是这次张力的一半来源。

## 4. 对 `docs/dev/handoff/projection-card-spec.md` §1.5 的判断

**判断：方向成立（占位确实会进落盘、原文确实可能不在 `messages` 里），但表述有两处需要改写**，
否则 implementer 会按「压缩之后就是占位」去做，在压缩当轮和干净重启后看到原文而误判成 bug；
反过来也可能把「压缩当轮读到的原文」当成不变量去写断言（就是 check 那条断言的处境）。

必须改的两点：

1. §1.5 标题与结论句「压缩之后，落盘里可能就是占位」→ 应改成「**全量重投影之后**落盘里就是占位」，
   并点明满投影的**三个**入口（尾部压缩事件 / 尾部撤回事件 / 缓存不可用），而不是只写压缩；
2. §1.5 的五步链路里第 1 步写的是「尾部事件里出现 `message.compaction` 或 `session.rewound`」——
   这一步是对的，但后面第 5 步「下一次 `sessions.get` 拿到的就是占位」缺了**前提**：
   只有这一次 load 真的走了满投影才成立；干净重启（增量）不成立。另外要补一句
   「一旦写进落盘就粘住，原文只剩事件日志」，因为这决定了 `original_available` 的默认分支。

### 4.1 建议替换后的 §1.5 正文

> ### 1.5 决定性发现：**全量重投影之后**，落盘里就是占位（原文不在 messages 里）
>
> 先划清边界（实测，见 `docs/dev/reports/0.54/proj-readback-15.md`）：
>
> - **压缩当轮（同一进程）正文仍是原文。** 压缩只算「请求里会清哪些」的集合
>   （`context-manager.ts` `plannedClearedToolResults`），一个字都不改正文；同一条工具结果
>   在请求视图里是 `[cleared ...]`、在落盘 / `sessions.get` 里是原文。**「落盘即占位」不是压缩的直接后果。**
> - **干净重启也仍是原文。** 会话壳（`SessionState.messages` + `derived_upto_seq`）是最新的时候，
>   恢复走「缓存 + 增量」，尾部没有替换类事件 ⇒ 不投影。
>
> 真正把占位写进落盘的是 `loadStoredHistory`（`execution-unit.ts:3999`、`:4017-4020`）的
> **满投影**分支，触发条件只有三个（任一）：
>
> 1. 启动时尾部（`seq > derived_upto_seq`）有 `message.compaction` —— 压缩事件已落盘、会话壳落后
>    （进程在「压缩后、下一次 `saveSessionState` 前」被杀 / 崩溃 / 断电）；
> 2. 启动时尾部有 `session.rewound` —— 撤回 / 分支切换之后的下一次启动或下一轮 run；
>    **这是最常见的一条**（撤回事件必然晚于最近一次保存）；
> 3. 缓存不可用：`SessionState.messages` 为空，或 `derived_upto_seq` 不是 number（旧数据 / 缓存被清）。
>
> 走满投影时的链路（每一步都可点开）：
>
> 1. `projectMessages(events)` 全投影（`execution-unit.ts:4116`）；
> 2. 重建到 `message.compaction` 那一刻时，先按 `cleared_tool_call_ids` 把命中的 tool 结果换成
>    `formatClearedToolResult` 的占位（`packages/core/src/session/project-messages.ts:232-245`，
>    有 `isClearedToolResult` 护），再按 `kept` 裁尾；
> 3. `seedTransientContext` 把 `history.messages` 原样塞进工作上下文（`:3123` 起）；
> 4. `finalizeSessionState` / `saveSessionState` 把 `workingContext.messages` 写回 `SessionState.messages`
>    （`execution-unit.ts:4255`、`:4266`）。
>
> ⇒ 这一次 load 之后，`sessions.get` 拿到的这条工具消息**就是占位文本**；而且**粘住**：
> `derived_upto_seq` 从此覆盖压缩事件，之后每次重启都走增量、增量里就是占位。
> 原文此后只剩事件日志（`tool.call.completed` / `llm.response`）。
>
> **实测旁证（陷阱 5 的量化）**：一次压缩的审计集合 26 条，窗口里真正被换成占位的只有 2 条、
> 满投影后落盘里变占位的是 3 条 —— **集合 ≠ 谁被换了**，判定必须看正文（`isClearedToolResult`）。
>
> **对 `scripts/check-append-only-context.ts` 那条「压缩后落盘旧工具结果仍是原文」的断言**：
> 它今天绿是因为它只压**活窗口**（`MemoryWorkingContext.compact()` + 读 `context.messages`），
> 与 EU 的满投影无关；它覆盖的是「压缩当轮」这一档，**不覆盖**上面三个满投影入口。
> 两种事实同时成立，不矛盾，但断言的范围要写清楚。
>
> **无论哪一档，本规格都按最坏情况设计：UI 不得假设 `messages[].content` 是原文；
> 想知道「模型看到的那一字节」，只能由服务端投影派生（§1.7 的 `ProjectionView`）。**

## 5. 「我被什么带偏了」

1. **以为「重启 = 满投影」。** 差一点据此写死「重启后必是占位」。实际干净重启走增量（`derived` 已覆盖压缩事件），原文保得住；满投影要有**尾部替换类事件**或**缓存缺失**这两个前提。这也是 §1.5 五步链路里唯一需要补的前置条件。
2. **以为「压缩后的下一轮」就会写占位。** 压缩当轮、后续增量轮都不写；写占位的是「下一次 **load** 时尾部还有压缩/撤回事件」。第一次实测（B）打出来的就是原文，当时我一度以为自己探针写错了。
3. **被 `sessions.get` 的出站形状骗了一次。** 消息挂在 `session` 下（`{ session: { messages } }`），我第一版取 `result.messages` 拿到空数组，差点把「0 条工具结果」当成结论贴出来。探针里的注释留了这条（`:236` 附近）。
4. **假 provider 的 `prompt_tokens` 写死 10 ⇒ 压缩永远不触发。** `realTokens` 是硬锚点（`context-manager.ts` `tokenCount`），写死小数字时 `shouldCompact()` 永远为假，探针空转 20 轮还全绿。教训有两条：探针的真实 usage 必须跟请求体量走；以及一个产品事实 —— **占位本身把请求变小了，0.85 的 token 阈值因此很难被触发**，真实会话里压缩往往是被「模型自己写出来的内容」顶上去的。
5. **以为 check 那条断言是错的。** 它没错，只是**范围**小：只覆盖活窗口。是「把一条范围明确的断言当成了范围更大的断言」把它变成了张力。
6. **差点把 §1.4 的「再跑一遍会自降级」当成 `capToolMessages` 的锅。** 裁剪是保前缀的，占位短得根本到不了 8 KiB；真正的问题只在「病态长占位」和「从正文重算数字」这两个用法上（§1.10）。

## 6. 疑点 / 未测项（诚实清单）

1. **满投影重建的窗口 ≠ 压缩当时的活窗口。** B 的活窗口工具结果是 `{call_25..28}`，A2 满投影重建后是 `{call_24..28}`（多一条更旧、且已被清的 `call_24`，成了占位）。压缩事件说 `kept = 16`，A2 那轮结束窗口非 system = 23（含恢复轮自己追加的 user/assistant/notice 若干），差额我没有逐条定位。⇒ 结论层面要记住的是「重建出的 messages 不能假设与压缩当时逐条相同」。
2. **A4 的 `session.rewound` 是我手工 append 的真事件**，`keep_projected` 取当前窗口长度（等价于「撤回但不删内容」）。真实 rewind RPC 的窗口语义（是否真的 pop 事件、pop 之后 `derived` 怎么变）我没测；但「尾部有 rewound ⇒ 满投影」这条分支是同一个 `if`（`:4017-4020`），不依赖 rewind 的细节。
3. **只测了一种窗口比例**（`maxTokens = 20000`、单条工具结果 ≈ 1400 tokens、约 28 轮触发）。探针里写明了为什么这几个数是必需的：压缩保留区 = 30%、工具结果保留预算 = 5%，只有单条工具结果落在 (5%, 15%) 区间时，压缩后窗口里才会**同时**有「被清的旧结果」和「保留的新结果」——否则探针会因为「被清的那些已经被压缩删掉」而看不到占位（假绿）。
4. **没测 sqlite backend**（用的是 `FileSessionStore`）。`derived_upto_seq` 在 sqlite 里同样是列（`sqlite-backend.ts:157`），A3 那条「没有 derived」的风险对旧 sqlite 行更真实。
5. **门禁**：`bun run gates` **整条跑过、退出码 0**（含 `biome ci .`、`tsc --noEmit`、根与 `apps/web` 的 build、以及全部 80 项 check）。相关几条的原样输出：

   ```
   OK append-only-context: passed 23 / 23 checks
   投射模式接线探针：全部通过（52 项）
   工具结果占位判据：通过 76 项，0 项红。
   压缩分段判据：通过 26 项，0 项红。
   check:request-append-only 通过（段内只追加或丢尾，换段有登记且可见）
   ✓ check-session-events: 40 项断言通过（...）
   检查项 35 条，失败 0 条
   GATES_EXIT=0
   ```

   注：`apps/web` 的依赖必须单独 `bun install`（它不是 workspace），否则根 `tsc --noEmit` 会在
   `apps/web/src/**` 上因为缺 `react` / `zustand` 类型而红 —— 这与本议题无关，但会让 `gates` 假红。

## 7. 复现

```
cd <worktree> && bun install && (cd apps/web && bun install)   # 只为跑门禁；探针本身只需 root 依赖
bun run scripts/probe-proj-readback.ts
```

临时目录会在结尾被删掉；输出里的 seq / id 每次运行一致（本探针不用随机内容），
只有临时目录名不同。
