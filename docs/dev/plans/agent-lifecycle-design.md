# Agent 生命周期重构设计（mark-gated 回收 + 持久保留）

- 状态：草案（设计中，纯文档，不含代码改动）
- 分支：`design/q-agent-lifecycle`
- 作者：q-agent-lifecycle（parent: main）
- 日期：2026-07-17
- 读者：main / 人类裁决者 / 后续实现者

## 0. 摘要与用户提案（不可违背的四原则）

用户提案原文语义：

1. **所有 agent 都保留**——不因关机 / 重启释放任何 agent；
2. **agent 工具只能中断（interrupt），不能立即清理 agent**；
3. **只能标注「是否可回收」**（mark-recyclable）；
4. **清理由系统自动回收，且只有标注可回收的才能回收**（mark-gated GC）。

本设计在现有代码基础上扩展（非从零建）：`member` / `temporary` 双角色、
`reinstate` 原地复活、durable inbox、`closedAt` / `closeReason` 审计字段全部复用。
核心变更一句话：**把「立即销毁权」从 agent 工具收走，换成「标注权」；把「按 TTL
自动销毁」换成「按标注 + 安全互锁 + 宽限期自动回收」；重启不再释放 temporary。**

## 1. 现状分析（代码事实）

（待扩充：角色 / 状态机 / 两条释放路径 / 重启丢承包根因 / 可复用资产）

## 2. 目标语义与状态机

（待扩充：规范条款、recyclable 正交标志设计、状态机图、dormant 语义、释放原因扩展）

## 3. API 变更

（待扩充：agent 工具 close→mark-recyclable、interrupt 保留、权限矩阵、RPC 变更、service 层）

## 4. GC 策略（mark-gated）

（待扩充：sweep 改造、安全互锁、宽限期、可选自动标注、保护名单、回收动作）

## 5. 重启持久化

（待扩充：快照 additive 字段、loadSnapshot 变更、再激活路径、shutdown drain）

## 6. 可见性

（待扩充：roster / 看板 recyclable 标志、待回收清单、事件与审计）

## 7. 迁移计划

（待扩充：分阶段落地、旧快照 / 旧配置兼容、回滚策略）

## 8. 风险与权衡

（待扩充：roster 增长与 TEAM_MEMBER_LIMIT、误标注、磁盘泄漏、兼容风险）

## 9. 决策记录与开放问题

（待扩充）

## 附录 A：代码锚点表

（待扩充）