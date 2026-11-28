---
title: 权限配置与持久化
kind: current
triggers: [permission, auto_approve, never_auto_approve, 权限, 自动放行, 审批, interactions, pending, orphaned, permission_timeout, permission_mode, always, 权限持久化]
paths: [src/gateway/interactions-dir.ts, src/data/permission-store.ts, src/config/permission-defaults.ts]
---

# 权限配置与持久化

> 权限规则配置与交互记录持久化的运维手册。成员权限模式（bridge/allow/deny）见
> [config-agent](config-agent.md)；权限生命周期机制见 [runtime-lifecycle](../architecture/runtime-lifecycle.md)。

## 规则配置

```yaml
permission:
  auto_approve: [bash, edit]         # 工具名精确匹配；缺省空（交互逐个询问）
  never_auto_approve: [agent.close]  # 自动放行的例外键（工具名或 tool.action）
```

- `permission.auto_approve`（TS `autoApprove`）：`string[]`，按工具名精确匹配；TUI 权限弹窗选
  `always` 时写回用户 YAML（经 `config.yaml` 写锁，见 [config-files](config-files.md)）。
  `ask` 由装配层始终放行；历史旧工具名 `ask_user` 归一化成 `ask`，不失效。
- `permission.never_auto_approve`（TS `neverAutoApprove`）：命中时只把来自 `autoApprove` / 默认
  放行的 allow 降级为 ask；工具 `checkPermission` 的显式 allow/ask/deny 不受影响。
  **未配置时有效值 = `DEFAULT_NEVER_AUTO_APPROVE` = `['agent.close', 'pii_reveal']`**
  （`src/config/permission-defaults.ts` 单一真源：关闭成员不可逆、PII 真值解锁永远人批）；
  显式配置（**含空数组**）整体替换默认，不合并。headless 无审批通道时仍 fail closed。
- 规则存储（`permission-store.ts`）：list/add/remove/set/setPolicy 均 async，写走 `withConfigLock`
  （与 `config.set` 同一把跨进程单写锁，读改写整体在锁内）；读侧不加锁（原子 rename，读到的
  永远是旧/新完整文件之一）。

## 权限等待与超时

- 交互模式应用层默认策略 `ask`，请求**一直等待**（不设 `timeoutMs`），直到应答、取消或 abort。
  只有宿主（core 嵌入方）显式传正数 `RuntimePermissionConfig.timeoutMs` 才抛
  `PermissionTimeoutError`（`permission_timeout`）让 run 失败；abort 抛 `PermissionAbortedError`
  （`permission_cancelled`）。`ask` 提问卡同样默认无限等待，不倒计时。
- `tool.permission.request` 带 `session_id` / `tool_call_id` / `source`；只有显式超时才带 `deadline_at`。

## 交互记录持久化（`interactions-dir.ts`）

- 文件：default 实例 `<dataDir>/interactions-<id>.json`；命名实例
  `<dataDir>/instances/<instance>/interactions-<id>.json`（目录 0700），0600 原子写。
  `<id>` 是持久化单 id（缺省 `default`），不是 wire 字段。同 dataDir 多实例不互相覆盖。
- 记录 `pending` / `answered` / `orphaned`；gateway 启动时加载，重启后仍 pending 的转 orphaned
  （本进程没有对应 run）。文件损坏/不可读只向 stderr 报错并按空集处理，不删原文件。
- **终态与幂等**：run 进 completed/failed/cancelled 时同 run pending 清出并持久化为 orphaned。
  重复应答返回首次结果（`duplicate: true`）；不同决定 `conflict`；orphaned `run_ended`；
  不存在 `not_found`。有界清理只淘汰最旧 answered/orphaned，pending 不淘汰。
- **已知限制**：core 只读 `remember`（等价 always），`allow session` 目前等同 once；
  `interactions.list` 可只读查询 pending/answered/orphaned 权限与内存 pending ask，
  但 pending ask 仍只在内存。