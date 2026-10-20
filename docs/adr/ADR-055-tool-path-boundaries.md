---
adr: 55
title: 工具路径边界
status: accepted
date: 2026-10-19
related: [26, 29, 34, 49]
tags: [security, tools, permissions, filesystem]
---

## ADR-055：工具路径边界

- **上下文**：0.8 以前，`read` 对任意可读文件返回 `allow`，`bash` 只校验 `cwd` 是否存在；权限判定是唯一关口。模型可能被文件内容中的提示注入诱导读取用户凭据（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`），而这类访问本身不应由“用户确认”来决定是否放行。另一方面，完全限制根目录会破坏既有用法，默认必须保持兼容。

- **决策**：
  1. **内置 denylist 始终生效**。`read` 的 `path` 与 `bash` 的 `cwd` 一开始就拒绝 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`（按路径段包含判定，命中目录即包含其下所有文件）。命中返回 `deny`，**不是 `ask`**——提示注入无法通过确认弹窗获得凭据访问。
  2. **可选的 `allowed_roots`**。插件配置（`plugins[].config`）可声明允许的根目录；配置非空后，`read` / `bash cwd` 越界返回 `ask`，进入既有的交互授权流程。默认空数组 = **不限制根**，仅内置 denylist 生效，保持 0.7 及以前的行为。
  3. **可追加的 `deny_paths`**。配置项与内置 denylist 合并（不是替换）；同样按路径段前缀判定，命中直接 `deny`。`allowed_roots` 不能把 denylist 中的路径重新放行：判定顺序是 **deny 优先于 allow**。
  4. **真实路径语义**。比较前先做规范化：路径存在时用 `realpath` 解析；不存在时对最近的已存在祖先做 `realpath` 再拼回剩余段。因此 `..` 与符号链接都不能绕过边界，符号链接目录下尚不存在的目标也会落在真实父目录下判定。
  5. **配置形态**。同时接受 camelCase 与 snake_case（`allowedRoots` / `allowed_roots`、`denyPaths` / `deny_paths`），未知键忽略；`~` 在配置值与工具参数中均展开为 home。边界在工具构造时固定，避免每次调用重复解析。
  6. **纵深防御**。除 `checkPermission` 外，`read` 的 handler 与 `runBash` 的 handler 各自再做一次 denylist 检查；即使调用方绕过权限判定（例如 workflow 直接调 handler），敏感路径仍被拒绝。`allowed_roots` 的越界只走 `ask`，不在 handler 重复拦截。
  7. **默认兼容**：不传插件配置时，`createBasicTools()` 与旧行为一致（只多出内置 denylist）；权限模式、事件与工具 schema 不变。

- **备选**：(a) 默认把根限制在 cwd——会破坏“读取工作区外的日志/配置”这类常见用法，且需要用户先配置；不取。(b) denylist 命中返回 `ask`——提示注入可以诱导用户点确认，等于没有边界；不取。(c) 只做词法路径前缀比较——`..` 与 symlink 可直接绕过；不取。(d) 把边界下沉到 core 的 `PermissionPolicy`——core 不认识“凭据目录”这类领域概念，且工具自描述（ADR-026）已提供正确的落点；不取。

- **后果**：读取内置敏感目录从“允许”变为“硬拒绝”，需要这些文件的场景必须改用不经过 `read` 的方式（例如用户显式提供内容），这是有意的行为变化。`allowed_roots` 是 opt-in 的收紧，配置后越界访问从 `allow` 变为 `ask`。**这不是沙箱**：`bash` 只校验 `cwd`，命令自身仍可访问其他路径；`edit` 未纳入本次边界（仍按 `ask` 授权）。真正的隔离需要沙箱类插件。

- **关联**：ADR-026（工具自描述 / `checkPermission`）、ADR-029（交互暂停事件流）、ADR-034（三工具集）、ADR-049（多租户隔离）；`plugins/tools/basic-tools/src/index.ts`。
