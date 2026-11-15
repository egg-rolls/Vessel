# 0.54 B3：投影纯读侧（`derived_upto_seq` → `projection_cache_seq`）

- 分支：`0.54-proj-b3`（基线 `bf22e8a8`）
- 装置：`scripts/check-projection-cache-agnostic.ts`（新增；真 `ExecutionUnit` + 真
  `SessionEventLog` + 真 `FileSessionStore` + 真 `sessions.get` handler）
- 夹具：`os.tmpdir()` 下的临时目录，跑完删；没碰用户层数据
- 依据：ADR-105 §3（I1–I4）/ §6 / §10、计划书 §4 B3、判据 B-2

## 0. 一句话结论

**判据成立**：把会话壳里的缓存水位字段**删掉**（`drop`）、**灌成负数**（`poison-low`）、
**灌成天文数字**（`poison-high`）、**灌成字符串**（`poison-string`）之后，同一批夹具的投影
输出（`loadStoredHistory` 的产物 = 播种窗口 / 落盘会话壳的来源）**逐字节相同**；
`sessions.get` 的出站字节也相同。同一份探针：**改动前 72 红 / 162 绿，改动后 0 红 / 234 绿**
（断言集合逐条相同，只多不少）。

改名按落地口径完成：`SessionState.projection_cache_seq` 是正名，`derived_upto_seq` 降级为
**别名**（读侧回填、写侧同值镜像），因此「旧壳 + 新代码」「新壳 + 旧代码」两种组合都实测可用。

## 1. 先测量（判据不是「跑通了」）

### 1.1 命令

```
$ cd /mnt/d/Application/APP/Vessel/worktrees/proj-b3
$ bun run scripts/check-projection-cache-agnostic.ts        # 改动后：234/234 绿
$ git stash push -- packages scripts                        # 回到基线 bf22e8a8 的源码
$ bun run scripts/check-projection-cache-agnostic.ts        # 改动前：72 红 / 162 绿
$ git stash pop
```

### 1.2 五种壳变体（同一份事件日志、同一份 `messages`，只改缓存水位这一个字段）

| 变体 | 对会话壳做的事 |
| --- | --- |
| `keep` | 原样 |
| `drop` | `derived_upto_seq` 与 `projection_cache_seq` 两个键都删 |
| `poison-low` | 改成 `-7`（旧实现的 `read({sinceSeq: -7})` 会把整份日志再拼一遍） |
| `poison-high` | 改成 `10000000`（远超日志尾 ⇒ 旧实现读到空增量、「壳说覆盖到哪」直接生效） |
| `poison-string` | 改成 `"n/a"`（类型被破坏 ⇒ 旧实现走满投影） |

### 1.3 改动前的实测（`/tmp/proj-b3-before.txt`，72 条红，按成因归类）

| 夹具 | 变体 | 改动前的输出差异（实测） |
| --- | --- | --- |
| `real-simple` / `real-tool` / `syn-notice-tail` / `syn-cleared-frozen` / `syn-masked-cache` / `syn-compact-current` | `drop` | 事件读取条数变了（1 → 7 / 1 → 20 / 0 → 7）：**读什么**由那个字段决定 |
| `real-simple` / `real-tool` / `syn-notice-tail` / `syn-cleared-frozen` / `syn-masked-cache` | `poison-low` | **历史被拼两遍**（3 → 5 / 9 → 17 / 8 → 14 / 7 → 13 / 7 → 13 条） |
| `real-*` / `syn-*` | `poison-high` | 游标被原样上报（`7 → 10000000`）、事件 0 条、「壳说覆盖到日志尾」直接生效 |
| `syn-compact-current` | `drop` / `poison-low` / `poison-string` | 满投影分支**丢掉基底 system**（6 → 5 条，第 0 条不见了） |
| `syn-compact-stale` | `poison-high` | 压缩被无视：壳里压缩前的正文复活、摘要与压缩后的尾部事实全丢（5 → 7 条，内容整体错） |
| `syn-rewind-tail` | `poison-high` | 撤回被无视：被撤回的 4 条**复活**（3 → 7 条） |
| `syn-empty-cache` | （`keep` 也错） | **P7 复现**：壳说覆盖到日志尾、壳里只有基底 system ⇒ 日志里 7 条事实全不可见 |
| 兼容段 7 条 | — | 新名字一个都没有（`want 42/43 got undefined`） |

**这 72 条就是「写侧水位参与可见性判定」的全部入口**。它们与 `replay-gap-findings.md` 的
线上结论（`derived=4 < last_seq=366` ⇒ 刷新只剩 4 条）是同一件事的离线形态。

### 1.4 改动后的实测（`/tmp/proj-b3-after.txt`，234 条全绿）

```
夹具 9 条：real-simple / real-tool / syn-compact-current / syn-compact-stale / syn-notice-tail /
          syn-rewind-tail / syn-cleared-frozen / syn-empty-cache / syn-legacy-no-field / syn-masked-cache
夹具 real-simple
  ok   real-simple：keep 投影 3 条 / 事件 7 条 — hash=93a44af0…（五变体逐字节相同）
  …
投影缓存无关键探针：全部通过（234 条断言）
```

每个夹具在每个变体上都有四条断言：`sha256(规范化 JSON)` / `order·ids·content·ts` 逐条清单 /
`eventCount` / 覆盖游标。再加两条「非真空绿」：keep 投影非空 + 该夹具的事实必须可见
（例如 `syn-empty-cache` 必须看得见 `u0 / injected-0 / RAW-A / u1 / answer-1` —— 改动前这
5 条断言全红，这就是 P7 的修复证据）；替换类夹具另加「被替换的正文必须不出现」
（`syn-compact-stale` 不许有 `u0`，`syn-rewind-tail` 不许有 `u1`）。

## 2. 解耦了什么（逐条 + 断言）

改前 `packages/core/src/runtime/execution-unit.ts#loadStoredHistory` 里那个字段**三处**参与判定，
逐条拆掉：

| # | 改动前 | 改动后 | 断言 |
| --- | --- | --- | --- |
| C1 | `needFullProjection = cached === undefined \|\| typeof derived !== 'number'` 决定读全量还是读增量 | 删。读路径**恒读整份日志**（`read(sessionId)`） | `check-projection-cache-agnostic` 每个夹具的 `eventCount 相同`；`check-append-only-context` 的静态闸（`loadStoredHistory` 里出现 `sinceSeq:` ⇒ 红） |
| C2 | `read({ sinceSeq: derived })` —— 壳落后时尾部事实进不了投影（P7） | 删（见 C1） | `syn-empty-cache：事实可见（u0 / injected-0 / RAW-A / u1 / answer-1）` 五条 |
| C3 | `events.some(compaction\|rewound)` ⇒ 回退满投影 | 删。判据改由「日志形状 + 内容对齐」给：投影头是一条**缓存里没有的**压缩摘要 ⇒ 替换语义生效；日志里有 `session.rewound` ⇒ 替换语义生效 | `syn-compact-stale：事实可见（S1 summary body / u2 / answer-2）` + `替换语义生效（不含 u0 / injected-0）`；`syn-rewind-tail` 同理（不含 `u1` / `answer-1`） |
| C4 | `cursor = max(derived, lastReadSeq)` | 只由日志决定：`cursor = 最后一条事件的 seq`（它经 `lastCoveredCursor` 决定要不要发 `context.changed`，所以这不是纯观测） | 每个夹具的 `游标相同`（`poison-high` 时改动前是 `want 7 got 10000000`） |
| C5 | `logger.warn('session cache is ahead of event log')` | 删（这条告警的存在前提就是「把缓存水位当事实」；见 §5 疑点 3） | — |
| C6 | `if (lastRequestTokens === undefined) … 补读尾部窗口 200 条 / 再全量读` | 删。既然恒读整份日志，`lastRequestTokensFromEvents(events)` 一次到位；`LAST_REQUEST_PROBE_EVENTS` 常量随之删掉 | `check:prompt-context-e2e`（上下文卡跨进程去重）绿；`check:append-only-context` 绿 |
| C7 | 增量分支 `history.push(...projected)`；无水位分支 `mergeHistoryProjection` | 合并成一条：`reconcileCachedProjection(cached, projected, { replacementInLog })` | 探针 234 条；`check:projection-no-materialize` 121 条 |

### 2.1 为什么不是「一律用投影」—— 一条被门禁抓到的反例

第一版实现是「投影 = 事件日志整份 fold，缓存只提供基底 system」。`bun run gates` 当场红在
`check:pii-vault`「历史消息逐条未改（只追加）」：**事件日志里的载荷是脱敏之前的那一份**
（`context.changed` / `tool.call.completed` 发的是 `identified`，脱敏发生在
`ExecutionUnit#maskForAppend` 写上下文那一刻），拿投影顶替缓存会把未中和的正文重新带回
store 与请求。所以最终口径是：

> **缓存在它已经覆盖的范围内是内容权威**（那一份字节是 UI / 模型 / 落盘共用的同一份），
> 日志只用于「补出缓存还没有的尾部」。缓存覆盖到哪**按内容算**（`coverageCut`），不读游标。

`syn-masked-cache` 就是这条的夹具（壳里是 `«pii:neutralized»`、日志里是原文）：断言投影
**保留**壳里那一份、且**不出现**日志里的原文。五变体输出仍然逐字节相同 —— 判据与 PII
不变量同时成立。

## 3. 改名与向后兼容（双向实测）

### 3.1 落地口径

- 正名：`SessionState.projection_cache_seq`；语义只剩一句「`messages` 这份缓存大概覆盖到
  `seq ≤ N`」，**不是**事实水位、**不参与**任何可见性 / 发布 / 覆盖判定。
- 旧名 `derived_upto_seq`：**保留为别名**（`@deprecated`）。读侧 `projection_cache_seq ?? derived_upto_seq`，
  两个键都回填同一个数；写侧两个键写同一个数（`projectionCacheKeysOf`）。
- 载体不变：`<sessions>/<id>.json` 的键、sqlite 的 `derived_upto_seq` 列（**不做 schema 迁移**：
  这一列只是缓存提示，旧版本 core 还在读写它）。
- 不动的两处（都在别人的边界内，见 §5）：`index.json` 的 `derived_upto_seq`（wire 面，
  `sessions.get.event_cursor` 在用）与 `run-journal.ts` 的写入点。

### 3.2 实测（探针 §兼容段，7 条断言）

| 组合 | 断言 | 结果 |
| --- | --- | --- |
| 旧壳（只有 `derived_upto_seq`）+ 新代码 | `load()` 后 `projection_cache_seq` 拿到同一个数、旧名不搬走 | 绿 |
| 旧壳 + 新代码（投影） | 只写旧名字的壳 ⇒ 投影与 `keep` 逐字节相同 | 绿 |
| 新壳（只有 `projection_cache_seq`）+ 旧代码 | 落盘 JSON 里旧键**同值**（旧读者忽略未知键照旧拿到覆盖） | 绿 |
| 新壳 + 新代码 | 两个名字同值 | 绿 |
| 两键冲突（`derived_upto_seq: 1` vs `projection_cache_seq: 合法值`） | 投影仍与 `keep` 逐字节相同（新名字优先，但**两个值都不影响输出**） | 绿 |

改动前这 7 条全红（`want 42/43 got undefined`），因为那时只有旧名字。

## 4. 验证

| 项 | 结果 |
| --- | --- |
| `scripts/check-projection-cache-agnostic.ts`（新增） | 234 / 234 |
| `check-append-only-context --phase=1` | 24 / 24（原 23 条，见 §5.2） |
| `check-prompt-context-e2e` | 36 条断言 0 失败 |
| `check-projection-view` | 64 / 64 |
| `check-projection-no-materialize` | 121 / 121 |
| `check-session-events` | 40 / 40 |
| `check-compaction-segment` | 26 / 26 |
| `bun run typecheck` | 干净 |
| `bunx @biomejs/biome ci .` | 退出码 0（75 warning / 316 info 与基线同量级） |
| `bun run gates` | **exit 0**（含 build / web build / 全部探针；`check-timeline-equality` 仍报 A7/A8 NOT_IMPLEMENTED —— 那是 C 阶段的事，未计入通过） |

## 5. 疑点 / 边界（如实写，不许当已决）

1. **事件日志里的 PII 载荷仍是脱敏前的那一份**（`context.changed` / `tool.call.completed` 的
   `data.message` / `data.result`）。本单的读路径因此**不能**把日志当正文权威，只能让它补尾部；
   崩溃尾部（缓存之后那几条）仍可能把未脱敏正文带进 store —— 这是**改动前就存在**的行为
   （旧的增量分支同样把尾部投影直接 push 进缓存），本单没修、也没扩大。真要修，落点是
   `run-journal.ts` 的 append 侧脱敏（不在本单边界）。
2. **两条既有探针的改动**（都不是放宽，逐条说明）：
   - `scripts/check-append-only-context.ts`（23 → 24 条）：原静态闸断言「`loadStoredHistory`
     里出现 `event.type === 'message.compaction'` 触发串」，那是**旧实现形状**（先按水位裁读、
     再在尾部看到替换事件才回退满投影）。B3 把裁剪删掉后这条不成立，换成了更强的一组：
     ① `loadStoredHistory` 里不许出现 `sinceSeq:` 裁剪（P7 入口）② 必须走
     `reconcileCachedProjection` ③ 投影必须显式 `applyClearedReplacements: false`
     ④ 「替换语义只认压缩/撤回」这条判据钉回它真正的归属地
     （`packages/core/src/session/project-messages.ts` 里两个 `event.type === '…'` 都在）。
   - `scripts/check-projection-no-materialize.ts`（仍是 121 条）：`N0.1` 的调用点数量闸
     4 → 3（原「增量投影 / 满投影」两个调用点被合并成一个，函数没少、判据 `N0.2` 不变）；
     `A3.0` 的夹具改成**两个键都删**（只删旧名时读侧会从正名回填，夹具就不成立了）。
3. **删掉了一条告警**：`session cache is ahead of event log`。它的前提是「缓存水位是对外
   可比的覆盖证明」；现在这个数不再参与任何判定，留着只会误报。若要保留可观测量，建议改成
   「缓存内容与日志内容对不上」的结构化诊断（`coverageCut === undefined` 的计数），属 B1/
   观测单。
4. **`index.json` 的 `derived_upto_seq` 没改名**：它经 `sessions.get.event_cursor` 上 wire，
   消费方在 `packages/serve/**` / `src/**`（不在本单边界）。它与 `SessionState` 的那个
   不是同一个载体：前者是「索引元数据派生到哪」，后者是「消息缓存的提示」。改 wire 名属
   B1 / serve 单。
5. **`coverageCut` 对不上时不动缓存**（返回 `undefined` ⇒ 原样返回缓存）。这是保守选择：
   改写已有正文 = 回改历史（PII + append-only 双破）。代价：壳里的消息**完全不是事件投影的
   产物**（例如夹具里手写的种子窗口，见 `check-tool-result-clear` 的 `ForgetfulStore`）时，
   尾部不会被补。这类壳在真实会话里只出现在「壳被手改 / 事件日志被单独清过」的情形。
6. **性能**：读路径现在恒读整份日志。真实会话实测规模 3.7k 事件（`stock-audit.md`），
   `projectMessages` 是单遍 O(n)，`coverageCut` 是 O(n + m)（签名预计算 + 两个单调指针）。
   比旧的「按水位读增量」多的是 IO 那一段 —— 这条代价换的正是「投影不依赖写侧水位」，
   若要优化，落点应是 `SessionEventLog` 的读缓存（不在本单）。
7. **本单没做**（计划书里属别的单）：卡片（trim / archive）改成 timeline 事件
   （§2 第 2 项）、`sessions.events` 换源（B1）、两阶段回填 / `disk-replay.ts` 删除（B2）。

## 6. 改动清单

| 文件 | 改动 |
| --- | --- |
| `packages/core/src/runtime/execution-unit.ts` | `loadStoredHistory` 去水位耦合（C1–C7）；`StoredHistory.cursor/eventCount` 注释改口径 |
| `packages/core/src/session/project-messages.ts` | 新增 `reconcileCachedProjection` + `coverageCut` / `compactionUnseenByCache` / `isCacheOnlyMessage`；`mergeHistoryProjection` 标 `@deprecated`（保留导出） |
| `packages/core/src/session/index.ts` | 导出 `reconcileCachedProjection` |
| `packages/core/src/session/session-store.ts` | 新增 `projectionCacheKeysOf`（写侧两个键同值） |
| `packages/core/src/session/file-backend.ts` | 读：别名回填两个键；写：两个键同值 |
| `packages/core/src/session/sqlite-backend.ts` | 同上（列名沿用 `derived_upto_seq`，不做 schema 迁移） |
| `packages/core/src/types/session.ts` | `SessionState.projection_cache_seq` 正名 + `derived_upto_seq` 标 `@deprecated` |
| `scripts/check-projection-cache-agnostic.ts` | 新增门禁（234 条断言） |
| `scripts/check-append-only-context.ts` / `check-projection-no-materialize.ts` | 见 §5.2 |
| `docs/dev/reports/0.54/proj-b3.md` | 本报告 |

**待 main 串**：`package.json` 属别人边界，没加 `check:projection-cache-agnostic` 脚本，也没进
`gates` 链。建议加：

```json
"check:projection-cache-agnostic": "bun run scripts/check-projection-cache-agnostic.ts"
```

并接在 `check:projection-no-materialize` 之后（它跑 ~3s）。

