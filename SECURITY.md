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

- 危险工具默认走权限判定（`ask`），由 human 经 TUI / Web / 网关应答；没有 agent 审批人，也不提供 `allow-after`（ADR-058 / ADR-079 / ADR-091）。
- 用 UsageLimits / TerminationPolicy 限制运行预算（请求/工具调用/token/成本/时长）。
- 不向 core 提交任何厂商 API Key / 价格；Key 永远用户自备（ADR-050）。
- 沙箱类能力只能在受限用户 / 容器 / 外层隔离中运行；本仓库不提供内置沙箱。
- Guardrail（PII / 密钥脱敏 / 工具 allowlist）作为插件按需启用。

## 工具路径边界（ADR-055）

`read`、`edit` 与 `bash` 的 `cwd` 受路径边界约束，用于降低**提示注入**导致凭据泄漏的风险：被读取的文件内容、工具输出或外部消息都可能诱导模型去读用户主目录下的密钥。

- **内置 denylist 是硬拒绝**：`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml` 命中即 `deny`，**不会**弹出 `ask` 让用户确认。提示注入无法通过诱导确认获得这些路径。
- **`allowed_roots`（插件 `basic-tools` 配置）**：配置后 `read` / `edit` / `bash cwd` 越界走 `ask`；默认空 = 不限制根，只保留内置 denylist。
- **`deny_paths`**：追加到内置 denylist（不能移除内置项）；同时参与 `bash` 命令文本匹配。
- **真实路径判定**：比较前做 `realpath`；不存在的路径对最近已存在祖先做 `realpath` 再拼回剩余段。`..` 与符号链接不能绕过。
- **这不是沙箱**：`bash` 只校验 `cwd`，命令本身仍可访问其它路径，命令文本检查是 best-effort 字符串匹配。需要真正隔离时使用沙箱类插件，并在受限用户/容器中运行。

## 统一工具执行（ADR-058）

- runtime 与 delegate 子 agent 共用 `ToolPipeline`：ToolCall guardrail → BeforeTool hook → **权限判定（最终工具与参数）** → handler（timeout + signal）→ ToolResult guardrail → AfterTool hook。
- 权限判定发生在 guardrail / hook 改写之后，避免“旧工具/旧参数被放行”；handler 直调不再被允许。
- 权限 `ask` 经 `tool.permission.request` 等待应答；默认不超时，只有显式正数 `timeoutMs` 才超时，abort 优先于超时。
- delegate 子 runtime 继承父级 `default` + `autoApprove`；缺省仍为 `{ default: 'allow' }` 以兼容，但装配层会显式传入 resolved 权限。`permissionMode: 'allow'` 仍可显式覆盖（`withAutoAllow`），`deny` 在注册前过滤工具。
- 交互模式默认 `ask`、headless 默认 `allow`；`ask_user` 始终 auto-approve。关闭管道阶段（`ToolPipelineStages`）是嵌入方的显式选择，会削弱对应检查。

## 持久化与损坏文件（ADR-056）

- session 快照与 run checkpoint 默认 `durable` 写入（temp fsync → rename → 尽力目录 fsync），降低掉电后“文件存在但内容未落盘”的风险；这不等于备份，也不防磁盘损坏。
- 文件存在但不可读或 JSON 损坏时抛 `SessionCorruptError`，**不会**被当成“无会话”覆盖，也不会在 delete 时被删除。损坏文件可能仍包含敏感会话内容；排查时不要把它粘贴到 issue / 日志，必要时离线备份后再人工处理。
- `listRich` 只跳过损坏项以保持列表可用；直接 `load` 仍报错，避免静默数据丢失。
- connect token / CA 统一经配置 loader：`VESSEL_CONNECT_TOKEN`（缺失时回退 `VESSEL_GATEWAY_TOKEN`）与 `VESSEL_CONNECT_CA` 只作为 env 层来源，不在日志、事件或 `config show` 中输出明文。

## 在不可信仓库中运行

仓库内的 `.vessel/plugins/` 与 `node_modules/@vessel-agent/*` 插件会在进程启动时被动态 import，并拥有完整进程权限，早于任何工具权限判定。

- 在克隆来的、未审计的仓库中运行前，设置 `VESSEL_NO_EXTERNAL_PLUGINS=1`（或 `true`）；默认集将只加载仓库内置的 `repo` 插件。
- 只在确认来源可信时，才通过显式 `plugins:` 加载 project / user / node_modules 插件；显式列表不受上述 opt-out 限制。
- 对外部插件默认加载只提供“启动告警 + opt-out”的缓解（**MITIGATED**），并未建立完整的插件信任边界。
