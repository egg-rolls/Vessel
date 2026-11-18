---
title: Bun 运行时坑位（版本相关）
kind: current
triggers: [AbortSignal.timeout, 超时, timeout, 定时器, timer, 挂起, hang, 假超时, bun 1.3.9]
paths: [docs/operations/BUN-QUIRKS.md]
---

# Bun 运行时坑位

> **这是总目**：每条只留「现象 → 判据 → 一句话处置」，细节一律指向专项文档。
> 一件事只有一种说法 —— 坑的完整机制、正确写法、手测要点都在专项里，这里不复述。
> 崩溃类问题不在这里，见 [BUN-WIN32-SEGFAULT](BUN-WIN32-SEGFAULT.md)。

## 1. `AbortSignal.timeout()` 可能根本不触发

- **现象**：把它当该处唯一超时保证时，调用方不是「ms 后失败」，而是**永久挂起**，
  且不报错、不打日志。
- **判据**：只 `await` 一次挂起、进程里没有别的活跃定时器 → abort 事件不来；
  同一段代码旁边恰好有别的 `setTimeout` 在跑 → 又「灵」了。时灵时不灵就是它。
- **处置**：需要真超时就用 `@vessel-agent/core` 的 `withDeadline(ms, run)` 或
  `startDeadline(ms)`（`dispose()` 必须进 `finally`），不要自己再包第二套。
- **细则**（机制、正确写法、自查口径、手测要点）→ [TIMEOUTS](TIMEOUTS.md)。

## 2. （预留：下一条踩到再补，不预先罗列猜测）
