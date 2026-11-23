---
title: 超时不可信（bun 1.3.9 的 AbortSignal.timeout 可能不触发）
kind: current
triggers: [超时, timeout, 挂起, 卡住, 不动, 假超时, AbortSignal.timeout, AbortController, setDeadline, 不报错, hung, deadlock, 60s, 探针, 安装卡住]
paths: [docs/operations/TIMEOUTS.md, packages/core/src/timeout.ts, src/config-write-apply.ts, src/dev-command.ts]
---

# 超时不可信：`AbortSignal.timeout()` 在 bun 1.3.9 上可能根本不触发

> 适用：任何「我用一个 `signal` 兜了超时，所以它会自己结束」的判断。
> 结论先说：**在 bun 1.3.9 上，`AbortSignal.timeout(ms)` 不是可靠的时间来源**。
> 它看起来有超时、代码也读得通，但可能一直挂着，进程不报错、也不动。

## 1. 症状长什么样

- 命令**不报错、不退出、CPU 也不忙**：`vessel update --check`、`vessel doctor`、`vessel gateway stop`
  某些情况下就停在那里，没有 stack trace、没有日志。
- 服务端某个请求永远不返回，但进程健康（`/health` 正常）、其它请求正常。
- 「上次还好的」：同一条路径**时灵时不灵**（取决于那一刻事件循环里有没有别的定时器）。
- 打日志能看到「开始」但永远看不到「失败」或「完成」——**超时分支一次都没走到**。

## 2. 为什么会这样

`AbortSignal.timeout(ms)` 内部的定时器是 **unref** 的：它不负责让事件循环保持活跃。
当一个调用点满足下面三条时，事件循环可能没有任何东西推着往前走，定时器回调与 abort
事件都不会到来，而那个挂起的 `await`（通常是 `fetch`）就一直等下去：

1. 用了 `AbortSignal.timeout`；
2. 这个 signal 只喂给**一次**挂起的 `await`，没有别的 `Promise.race` / 显式定时器兜底；
3. 触发路径上进程**没有其它活跃定时器**。

> 实测（auth-strategy 在头像那单）：单个探针挂死 60s；旁边另挂一个 `setTimeout`
> 之后超时立刻恢复触发。差别只在于「有没有别的定时器陪着」。

哪类代码最容易满足第 3 条：**一次性 CLI 命令**（`update --check`、`doctor`、`gateway stop`、
安装脚本、向导）、**启动阶段的探活**（等 node / 等平台 / 等旧实例退出）、**后台补数据**（起标题、
摘要）。长跑的服务通常有别的定时器，所以**恰恰是 CLI 和安装路径最危险**。

## 3. 正确写法

仓里只有一个封装，用它就够了：`@vessel-agent/core` 的 `withDeadline` / `startDeadline`
（实现见 `packages/core/src/timeout.ts`），底下是**普通 ref 定时器** + `AbortController`。

```ts
// 常见形状：整段 await 链都在预算内
const body = await withDeadline(3_000, async (signal) => {
  const res = await fetch(url, { signal });
  return (await res.json()) as unknown;
});

// 需要与调用方的 signal 合并、或把 signal 交给别处
const deadline = startDeadline(3_000);
try {
  const signal = caller ? AbortSignal.any([caller, deadline.signal]) : deadline.signal;
  await fetch(url, { signal });
} finally {
  deadline.dispose(); // 不清就是悬挂定时器：进程会多活 ms 毫秒
}
```

三条纪律：

1. **不要**在需要「一定会发生」的地方用 `AbortSignal.timeout`；它的定时器不保证推进。
2. `startDeadline` 的 `dispose()` 必须在 `finally` 里（或每条退出路径上）调用 ——
   否则定时器会一直挂着，把进程多留一整个 `ms`。
3. 别自己再写一套。已经有 `withDeadline` / `startDeadline`，再加第二个封装只会让下次
   排查多一个分叉。

## 4. 怎么判断自己踩了

- 你的 `signal` 是不是 `AbortSignal.timeout(...)` 的直接产物？（`grep -n AbortSignal.timeout`）
- 它是不是**只**喂给了一次挂起的 `await`，旁边没有 `Promise.race` / `setTimeout`？
- 出错的地方是不是 CLI / 安装 / 启动探活 / 后台补数据这类「事件循环可能空着」的路径？

三条都中 ⇒ 就是它。修法按 §3；改完的验证看 §5。

## 5. 用户手测时该看什么

不需要写脚本，看行为和日志就够：

| 场景 | 修好之后 |
|---|---|
| `vessel update --check`（断网 / 黑洞 IP） | 在超时时间（约 5s）**内**以 `HTTP ...` / 网络错误结束；不会无限等待 |
| `vessel gateway stop`（端口上挂着一个不响应的进程） | 约 1s 内返回「没有在跑」/ 走 kill 分支；不再卡住 |
| `vessel gateway start`（node 起不来） | 在健康检查超时后报 `node_start_failed`；不会永久停在「等待 node 就绪」 |
| `vessel dev`（旧实例半死不活） | 探活失败后继续（清理/另起端口）；不会停在「探测旧实例」 |
| 平台里一次 node 探活 | `platform.health` / 节点状态在探针超时内变 `down`，不挂在 in-flight |
| Marketplace 安装（registry / 大包下载） | 网络断掉后在超时内报 `registry_fetch_failed` / `asset download` 失败 |

反过来说，如果**修改前**能看到「进程健康但某个操作永不返回、日志停在开始那一行」，
而修改后它变成一条明确的超时错误，那这条路径就是被这个 bug 咬过的。

## 6. 现状（0.64）

- 所有「一次性路径」的 `AbortSignal.timeout` 已换成 `withDeadline` / `startDeadline`：
  CLI 探活与命令执行、agent owner 客户端/探测、federation 投递、node supervisor 健康检查、
  平台节点注册探针、update 检查、TUI 向导拉模型列表、marketplace 的 registry 拉取与安装包下载。
- provider 插件（openai / anthropic）早先就带了 `Promise.race` + 显式定时器的兜底，语义正确，
  未改动。
- 仍有 `AbortSignal.timeout` 的地方集中在 auth 策略（`oauth-exchange`、`oauth` 的换取环节），
  由该模块 owner 处理（auth 路径的语义需要 auth 侧确认，不在本次扫描的改动范围）。
- 另有一处**反过来的**坑被顺手修掉：`src/config-write-apply.ts` 的兜底定时器原本是 `unref()`
  的，等于把「超时兜底」自己关掉了；现在改成普通定时器（有界，不会让进程被拖住）。
