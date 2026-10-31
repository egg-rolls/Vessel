# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**0.31.0（2026-10-31）** — 未 tag、未 publish。版本号以根 `package.json` 为唯一来源；
manifest 与 `CHANGELOG.md` 一致。

## 已合入

- **Body 热重载**：reload 后在同一具 body 上重做工具/权限快照（`refreshTools`），
  session / epoch / 上下文不变；有 active run 时延迟到 turn 边界。
- **rotate 权限确认**：模型自换必须人类批准，确认卡带上下文比例；`<90%` 提示通常不需要、
  `≥90%` 建议换；拒绝 / 无人类通道 fail-closed 为 `rotate_not_needed`。owner / CLI 不变。
- **删除 `limits.toolCallsLimit`（breaking config）**：工具调用不再有软预算；循环由
  `max_iterations` 与 `max_runtime_seconds` 兜底。旧配置带该键仍可加载但不再生效。
- **上下文阈值**：提示 0.9、自动压缩 0.95，temporary body 同步。
- **Web IA**：团队成员面板收敛到 agents 域；智能体页改响应式卡片网格，点卡片即打开成员；
  用户面 Body / epoch 统一为会话 / 第 N 次会话（wire 字段不变）。
- **Chat 三缺陷**：新会话首发送、Stop 真实 run id、队列占位瞬闪。
- **热应用**：不再抛 `tools_hot_apply_unsupported`；`TenantToolHost` 转发 unregister；
  scope 相互隔离，工具失败不再连坐权限。
- **门禁**：零测试文件；每片一次性探针红绿 + typecheck / biome / web tsc / web build / mock smoke。

## 下一步

- **0.32 上下文管理系统**（`PLAN-0.32-context-management.md`）：第一目标是持久化收件箱 +
  未读通知，其次是压力闭环、可观测、检索与术语一致性。
- **headless ask 异步队列**未做，建议单独开「人类通道」周期。
- 已知边界：模型可经 `bash` 调 CLI owner 端点绕过 rotate 确认（bash 非沙箱的既有边界）；
  bridge 在 `humanApproval=true` + 自定义 `auto_allow` 时存在 latent 挂死。
- 剩余 536–550 行 Web 文件、诊断页 `doctor --deep` 覆盖、计费价格表等候选顺延。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 当前版本变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)
