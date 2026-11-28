---
title: 事件系统（导航）
kind: guide
triggers: [event, event stream, trace, replay, observability, seq, redaction, 事件, 事件流, 事件回放, 回放, 重放, 可观测, 脱敏, 续传, 可见性]
children: [event-catalog.md, event-visibility.md, event-trace.md, event-subscribe.md, event-log-policy.md, session-replay.md]
---

# 事件系统（导航）

<a id="events"></a>

事件流是**跨组件的唯一异步沟通总线**：runtime → 观测（TUI / 日志 / 审计 / 回放）、
工具 ↔ TUI（权限确认、ask 交互暂停）。本页只导航，事实在下列叶子（一个事实只有一个家）。

| 模块 | 回答什么 |
|---|---|
| [event-catalog](event-catalog.md) | 命名约定（开放字符串 / 命名空间）、核心与约定事件名 payload 目录、三种机制边界、交互暂停与 ask 题级协议 |
| [event-visibility](event-visibility.md) | 可见性三档（content / internal / observe）、entry 级环境信息判据、三条硬约束、注册表与前缀家族 |
| [event-trace](event-trace.md) | core 回放（FileEventStore / replayRun）、trace 落盘（seq / 级别 / 留存 / 脱敏 / 读取重建 / 取消 / 归属） |
| [event-subscribe](event-subscribe.md) | gateway wire 回放有界、出站归属补齐、全局流缺省拒绝、`sessions.get.system_context` 派生 |
| [event-log-policy](event-log-policy.md) | 会话事件日志落盘口径（哪些事件成为事实 / 每条留多少正文 / 时间序） |
| [session-replay](session-replay.md) | 会话重放总架构：单游标 + 单区间回填 + 四条硬校验、`timeline.hello`、尾部窗口与结趟 |

<a id="event-names"></a>
<a id="event-visibility"></a>
<a id="event-log-policy"></a>
<a id="trace"></a>
<a id="事件回放"></a>

## 主题入口

- **事件名 / payload / ask 协议** → [event-catalog](event-catalog.md)
- **档位 / 登记 / 折叠兜底** → [event-visibility](event-visibility.md)
- **回放 / trace 落盘 / 脱敏** → [event-trace](event-trace.md)
- **gateway 订阅 / 出站归属 / 全局流 / 模型上下文卡** → [event-subscribe](event-subscribe.md)
- **落盘形态 ≠ 发布形态** → [event-log-policy](event-log-policy.md)
- **刷新丢事件 / 时间线游标 / 缺口污点条** → [session-replay](session-replay.md) · [unacked-queue-closure](unacked-queue-closure.md)

> 登记与文档-表一致性靠评审核对（原 `check:event-visibility` 脚本已按宪法删除，见
> [DOC-MANAGEMENT §3.4](../DOC-MANAGEMENT.md)）。相关：[interfaces](interfaces.md)（`EventStream` 契约）、
> [gateway-rpc](gateway-rpc.md)（`events.subscribe` / `events.list` 方法）。