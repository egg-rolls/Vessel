# 安全策略（SECURITY）

## 报告漏洞

发现安全漏洞请**不要**开公开 issue。通过以下方式私密报告：

- GitHub Security Advisories（仓库 Security 标签 → Report a vulnerability）
- 或私下联系维护者

报告请包含：影响范围、复现步骤、受影响版本。收到后我们会尽快确认，并协调修复与披露时间。

## 支持版本

pre-MVP 阶段仅支持最新分支。

## 安全考量

Vessel 是 Agent Harness，会执行工具（文件 / shell / 代码）。使用与开发时注意：

- 危险工具须经 TUI 权限弹窗确认（permission-prompt 插件，Cline 式 human-in-the-loop）。
- 用 UsageLimits / TerminationPolicy 限制运行预算（请求/工具调用/token/成本/时长）。
- 不向 core 提交任何厂商 API Key / 价格；Key 永远用户自备（ADR-005）。
- 沙箱类能力（code-sandbox / sandbox-fs）作为插件按需启用，不进 core 默认。
- Guardrail（PII / 密钥脱敏 / prompt 注入防御）作为插件按需启用。

## 工具路径边界（0.8，ADR-055）

`read` 与 `bash` 的 `cwd` 受路径边界约束，用于降低**提示注入**导致凭据泄漏的风险：被读取的文件内容、工具输出或外部消息都可能诱导模型去读用户主目录下的密钥。

- **内置 denylist 是硬拒绝**：`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml` 命中即 `deny`，**不会**弹出 `ask` 让用户确认。提示注入无法通过诱导确认获得这些路径。
- **`allowed_roots`（插件 `basic-tools` 配置）**：配置后 `read` / `bash cwd` 越界走 `ask`；默认空 = 不限制根，只保留内置 denylist。
- **`deny_paths`**：追加到内置 denylist（不能移除内置项）。
- **真实路径判定**：比较前做 `realpath`；不存在的路径对最近已存在祖先做 `realpath` 再拼回剩余段。`..` 与符号链接不能绕过。
- **这不是沙箱**：`bash` 只校验 `cwd`，命令本身仍可访问其它路径；`edit` 未纳入该边界。需要真正隔离时使用沙箱类插件，并在受限用户/容器中运行。

## 在不可信仓库中运行

仓库内的 `.vessel/plugins/` 与 `node_modules/@vessel` 插件会在进程启动时被动态 import，并拥有完整进程权限，早于任何工具权限判定。

- 在克隆来的、未审计的仓库中运行前，设置 `VESSEL_NO_EXTERNAL_PLUGINS=1`（或 `true`）；默认集将只加载仓库内置的 `repo` 插件。
- 只在确认来源可信时，才通过显式 `plugins:` 加载 project / user / node_modules 插件；显式列表不受上述 opt-out 限制。
- 0.7.1 对外部插件默认加载只提供“启动告警 + opt-out”的缓解（**MITIGATED**），并未建立完整的插件信任边界。
