# 0.54「刷新时正好有 run 在跑」时间线错乱：复现样本与根因

- 分支：`0.54-timeline-order-bug`（基线 `main` @ `bf22e8a8`）
- 装置：`scripts/probe-midrun-refresh.ts`（新增，**待验收样本，不进 gates**；现在应当**红**）
- 数据：本机 `~/.vessel/data/sessions/d813eaea-…`（= 报告作者所在会话，只读）
- 产品代码：本报告**不含任何修复**。之前合入 main 的 P1–P5（窗口截断骨架闸门）、
  `runtime-kinds` 抽层保持不变；本轮尝试的两处实现改动已全部回退，`git diff main --
  apps/web/src/domains apps/web/src/state` 为空。
- 入库注意：`docs/dev/reports/` 被 `.gitignore` 的 `reports/` 规则忽略，这份报告用
  `git add -f` 入库（与该目录先前的报告一致）。

## 0. 一句话结论

用户报的「刷新时正在跑的那条 run，工具卡丢结果状态、被放到用户消息后、思考全堆在工具后面」
**不是排序比较器的问题**，也不是「ts 丢了」，而是**跨源回放的折叠序 + 身份粒度**问题：

| 现象 | 现状 | 根因位置 |
| --- | --- | --- |
| T1 工具卡丢结果状态 / 按钮变灰 | 本机数据**未复现**（0 例） | 若发生，只可能出在环被截断导致 `tool.call.completed` 没进回放；装配面 `mergeItem` 的 `status` 取 live 是既有契约（`check-transcript-items` G1），不该改 |
| T2 思考全堆在工具之后 | **红**（3 段思考全部 ts ≥ 最后一个工具） | `createFold` 靠「相邻同 kind」成段（`state/events.ts:297` `flushReasoning`）+ `itemTs` 组内按**插入序**单调夹（`domains/chat/transcript-items.ts:1210-1216`）；而 chunk 来自**更晚的 seq 频带**（`state/disk-replay.ts:20` 带图）⇒ 整条 run 的思考被并段并夹到末尾 |
| T3 位置被锚到 run 起点 | **红**（9/9 项的 `seq` 都是组起始 seq） | `buildLiveItems` 每个 push 只披 `seq: group.firstSeq`（`transcript-items.ts:1195`，共 6 处 `...seqMeta`）；真正属于自己的位置在 `anchorSeq`，但没进 `seq` |
| T4 新事件正常在最下面 | 绿（守护） | 增量段本身是好的，病只在回放段 |

**B2 怎么结构性消灭它**：B2 把 item 身份统一成**一个持久全局 seq**（单游标），于是
(a)「思考段被重折叠成一段」这件事失去意义 —— 段边界和位置都由 seq 决定，不再依赖到达序；
(b) 每个 item 自带真实 seq，`seq: group.firstSeq` 这种「临时替身」整体消失，位置不再退回插入序；
(c) 跨源 band（会话日志 / trace / 环）不再需要靠「映射到负数带」来排先后。
本报告的四条断言就是 B2 的验收基线：**B2 落地后 `bun run scripts/probe-midrun-refresh.ts` 应当 exit 0**。

## 1. 用户原话（逐字）

> 对于当前正在运行的 run 的事件来说，所有工具事件**失去结果状态，按钮变灰**，**放置在触发 run 的用户消息后**，
> 所有**思考块放在当前聚堆工具事件后**，然后新事件会正常排在最下面，只有刷新时，已经出现的**当前这一次 run** 的
> 工具事件和思考事件会出现问题

四条现象 → T1（结果状态）/ T2（思考在工具之后）/ T3（位置在用户消息后）/ T4（新事件在最下面）。

另有前一轮的两句线索，同样指向「回放段」而不是「静态数据」：

> 所有会话刷新都这样（包括新开的短会话）
> 两种形态都有 · WEBUI 会显示的思考过程块，我发现好像只对正在运行的 run 里的事件发生，消息落盘后刷新不会有问题

（静态刷新的短会话这一路已在先前的 `check-order-clump.ts` 里量过：D1 重复工具卡 0 例、
D2 非法归堆 0 段 —— 那部分没有 bug，用户的「短会话也坏」应理解为「当时那条 run 正在跑」。）

## 2. 复现装置

`scripts/probe-midrun-refresh.ts` 按**渲染面真实入参**拼一次「中途刷新」：

1. **历史**：`sessions.get` 那一页消息（`TRANSCRIPT_WINDOW = 50`，见 `sessionStore.loadDetail`）。
2. **会话日志频带**：整份 `events.ndjson`（0.54 阶段一 `sessions.events` 是**全量回放**）。
   进行中那条 run 的 `tool.call.*` 就在这里 —— 它的**消息**还没进历史，但事件已落盘。
3. **环频带**：那条 run 的 `llm.stream.chunk`（**不落盘**，只有 hub 环里有），
   按「每个工具调用之前一段思考」造出来，作为**更晚到达**的频带并入。

然后走 app 真实那条路：`LiveItemStore.resume(entries)` → 整表重折叠（`state/events.ts`
`groupEvents` / `state/live-items.ts` `refold`，条目的顺序就是 seq 频带序）→ `buildLiveItems` →
`buildTranscriptItems`。量的就是 T1–T4。

> 频带映射照抄 `state/disk-replay.ts:75-90`：会话日志 → `-2e9+seq`，trace/环 → `-1e9+rank`，
> 所以「环频带」在折叠里**一定晚于**会话日志频带 —— 这就是 T2 的病根。

## 3. 红输出（当前 main，无任何修复）

```
$ bun run scripts/probe-midrun-refresh.ts        # 退出码非 0（红 = 预期）
== 中途刷新复现：d813eaea，进行中的 run = a8c43dbf ==
   历史 841 条消息 / 事件 1933 条（该 run 33 条走环频带）
   折叠后该 run 的 item：run-input tool tool tool tool tool run-reasoning tool run-reasoning tool run-reasoning tool run-reasoning tool run-reasoning tool run-reasoning
  PASS T1 有 tool.call.completed 的工具卡必须保住结果状态（不得停在 running / 灰按钮）
       0 例（检查了 10 张卡）
  FAIL T2 进行中 run 的思考段与工具卡按各自事件时间交错（不许「工具全在前、思考全在后」）
       思考段=6 工具卡=10 思考全在工具之后=true 并成一段=false 逆序相邻对=0
  FAIL T3 run 内每一项的位置由自己的事件 seq 决定（不许集体锚到 run 起点）
       带锚点项=16 seq≠自己的 anchorSeq=16 共用同一个 seq=是（-1999998097）
  PASS T4 回放段与之后新到事件的顺序连续（回放尾巴在最下面，不被新事件插到中间）
       时间线=46 条；该 run 最后一项之后还有 1 条

红：2/4 条现象仍在（B2 落地前这是预期）。把这份输出当作 B2 的验收基线。
```

（数字随会话增长而变：本报告写作时该 run 有 33 条环事件、10 张工具卡、6 段思考；
`思考全在工具之后=true` 这条判据是稳定的 —— 段边界保不保得住随频带切分浮动，位置一定会被
组内单调夹污染。）

T2 的细节值得单独看：`思考全在工具之后=true` 而 `并成一段=false` —— 说明**段边界侥幸保住了**
（本例 chunk 恰好夹在工具之间到达），但**每一段的 ts 都被组内单调夹顶到了最后一个工具之后**，
所以屏幕上就是「工具卡一堵墙，思考块全在下面」。段边界保不保住取决于频带切分，
位置一定会被这条单调夹污染。

## 4. 定位到的两处根因

### 根因 A：live item 的位置身份退化到「组起始 seq」

`domains/chat/transcript-items.ts:1195`

```ts
const seqMeta = group.firstSeq !== undefined ? { seq: group.firstSeq } : {};
```

这个 `seqMeta` 被 6 处 push 原样披上（`:1244 / :1254 / :1267 / :1280 / :1306 / :1327`），
于是**同一条 run 的所有 live item 在比较器眼里 seq 完全相同**；每一项真正的位置在
`item.anchorSeq`（`:1351`）里，却没进 `seq`。

后果：不变量 2「ts 相同用 `seq` 回退」（`domains/chat/timeline-order.ts`）对 live 侧
**等于失效** —— 谁先谁后只能退回**插入序**，也就是「折 run 的顺序」。而折 run 的顺序
（见根因 B）恰恰不是时间顺序。这就是 T3 红，也是「聚堆」一半的来源。

### 根因 B：折叠顺序敏感 + chunk 来自更晚的 seq 频带 ⇒ 思考被并段并夹到末尾

- 折叠靠**相邻性**成段：`state/events.ts:297` 的 `flushReasoning`（一段思考 = 连续的
  `reasoning_delta`，中间被任何非 reasoning 事件打断才收段）。
- 组内时间靠**插入序单调夹**：`transcript-items.ts:1210-1216` 的 `itemTs`
  （`monotonic = max(monotonic, own ?? baseTs)`）。
- 而事件来自**三个不能比大小的 seq 频带**（`state/disk-replay.ts:20` 带图）：
  会话日志 → run trace → hub 环，`resume()`/`refold()` 就按这个顺序折。
  `llm.stream.chunk` 不落盘 ⇒ 只可能来自**后两个频带**。

于是「结构事件（工具）在前、chunk（思考）在后」的到达序把一条 run 折成：
工具卡按真实时间排好、思考被并成一段并被 `itemTs` 夹到最后一个工具之后 —— 正是用户看到的
「所有思考块放在当前聚堆工具事件后」。这就是 T2 红。

### 为什么 T1 没复现

本机数据的「中途刷新」仿真里，**有 `tool.call.completed` 的 6 张卡没有一张停在 running**。
`mergeItem` 里 `status` 取 live 是**既有契约**（`check-transcript-items` 的 G1：
「live 只有 started、历史有结果 ⇒ 一张卡、output 取历史、status 取 live」），本轮试过改成
「终态不回退」，被 G1 直接拦下并已回退。所以「按钮变灰」若真出现，更可能是
**环被截断导致 `tool.call.completed` 根本没进回放**（客户端侧无法自证），
需要一份刷新瞬间的 store `stats`（`replaySkipped` / `holdFloor` / `trim`）或截图对应的
工具卡名字才能继续钉。T1 在本样本里作为**守护断言**保留。

## 5. 为什么不在这里打补丁（用户裁决）

现有装配面上能做的两处补丁都只是「让症状不明显」：

1. 把 `seqMeta` 换成 `anchorSeq`（修 T3）—— 只是给 live 项一把**近似**的尺子，
   而 anchorSeq 来自不同频带的映射值，跨源不可比；
2. 折 run 之前按事件 ts 规整（修 T2）—— 折叠顺序是频带的产物，规整只能掩盖，
   而且会让「折叠 = 到达序」这条隐式假设在别处（去重 / holdFloor / 中断续传）留下新的不确定性。

B2「单游标 + item 身份统一成 seq」一次性把这两件都变成不需要：item 天生带一个持久全局
seq，段边界、位置、跨源先后都由它决定，不再依赖到达序。所以本轮**只交证据**。

## 6. 将来怎么用这份样本

```bash
bun run scripts/probe-midrun-refresh.ts          # B2 之前：exit 非 0（红）= 正常
bun run scripts/probe-midrun-refresh.ts          # B2 之后：exit 0（绿）= 该 bug 已被结构性消灭
bun run scripts/probe-midrun-refresh.ts --session=<其它会话>   # 换样本（只读）
```

它**不进 gates 链**：它是待验收样本，不是门禁。B2 落地时把它转成门禁（改名
`check-midrun-refresh.ts` 并串进 `package.json` 的 gates）即可。
