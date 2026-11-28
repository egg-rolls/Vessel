# 订阅架构权限矩阵：三层分离（q-sub-unify-p1 M7）

> 设计稿：`docs/dev/design/subscription-unify-design.md` §9（外层仓）。
> 本文是 P1 落地后的权限事实登记：**消息层 / 订阅层 / 通知层**各自判定，互不越权。
> 核心原则：**订阅不授予新可见性**——订阅只是「把已可见的事实送到我上下文」的管道。

## 三层矩阵

| 层 | 判定函数（出处） | 判什么 | P1 改动 |
|---|---|---|---|
| 消息层 | `registry.ts#canView`（packages/agent） | 成员间消息投递 / roster 可见性（owner / parent / team / tenant 阶梯） | **零变化**（逐字未动） |
| 订阅层 | visibility 闸（src/runtime/agent-activity-watch.ts `isPublicVisibility`；friend-edges.ts 同口径） | 哪些成员的活动事实可落快照 / 记好友边：仅 `team` / `tenant`；`private` / 未知 **fail-closed** | additive：agent 源快照闸 + 好友边闸（照抄 team-service.ts:1527 口径） |
| 通知层 | hook cadence/channel gate（plugins/context/doc-subscription/src/hook.ts）+ muted 字段 | 已订阅事实是否注入订阅者自己的上下文（ambient）；muted ⇒ 观察推进但不出卡 | additive：agent 分支独立 gate；muted 消费 |

## 逐层细则

### 消息层（canView，零变化）

- 真相源：`packages/agent/src/registry.ts#canView`。private 成员只有 owner 可见；
  team 成员同 team 互见；tenant 全租户可见。rosterFor / listForCaller 同管道。
- P1 **未触碰** canView 及其消费点。agent list 好友区是 canView ∧ friend **双过滤**：
  friend 标记只在已可见条目上 additive（`TeamMemberSummary.friend?: boolean`），
  不扩大可见集。无 friendsOf port / 无好友 ⇒ 输出逐字节不变（probe 对拍）。

### 订阅层（事实落盘闸）

- agent 活动快照（`<stateDir>/agents/<target>.json`）只收 visibility ∈ {team, tenant}
  的成员事实。两条传输各自闸：
  - agent.* 流（AgentService.subscribe）：事件自带 visibility，private 直接跳过；
  - run.* 父流（parentEvents）：事件不带 visibility ⇒ 经 service 成员记录解析，
    private / 未知 fail-closed 跳过。
- tick 权威基线同闸：private 成员即使被订阅也不落快照（插件侧 rev='' 永不通知，
  诚实降级，不泄露存在性以外的事实）。
- 好友边（friend-edges.ts）：同 team ∧ visibility team/tenant 才互记；private 永不记边。
- health / script / file 源：P1 零变化（file 边界闸 evaluatePath 现态不动）。
- 联邦地址目标：P1 只收语法，本地分支不探测（P3 接远端，届时另立闸）。

### 通知层（ambient 注入）

- 通知只进**订阅者自己**的上下文（BeforeLlm ctx.messages / emitFact ui-only），
  不跨成员投递；固定推送（inbox/bus/peer/bash）P1 未触碰（P2/P4）。
- agent 源 cadence 缺省 run（config ENV_CADENCE_TABLE），per-scope 热改；
  channel 缺省 model+ui，ui-only 走事件广播。
- muted（store additive 字段）：观察照常推进游标，不出卡——mute 是「不想看」，
  不是「推迟」（解静音后不补发旧通知）。
- 线格式：裸 `agent: N subscribed agents changed`（★D5），无方括号前缀
  （方括号 legacy 只属固定推送 [inbox]/[runtime]，P2/P4）。

## P1 改动对照表

| 组件 | 动了 | 没动 |
|---|---|---|
| registry.canView / rosterFor | — | 全部 |
| agent-activity-watch（新增） | 订阅层 visibility 闸 | 消息层 |
| friend-edges（新增） | 订阅层记边闸 | canView |
| hook agent 分支（新增） | 通知层 gate/muted | files/health/script 分支 |
| agent list friendsOf | 通知层 additive 标记 | canView 过滤管道 |
| 固定推送内部机器 | — | 全部（P2/P4） |

## 佐证

repo 外 probe（`tmp/probe-sub-p1/`，不提交）：
- m4a-watch：private 事件 / private 成员 run 终态均不落盘；
- m6-friend：private spawned 不记边；list 好友区 canView ∧ friend，无 port 输出逐字节不变；
- m4b-agent：muted 观察推进但不出卡。