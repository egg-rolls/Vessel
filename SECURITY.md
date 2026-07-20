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
