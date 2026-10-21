---
adr: 83
title: 0.14.2 质量硬化——压缩摘要与 bash 凭据路径
status: accepted
date: 2026-10-21
related: [38, 55, 58]
tags: [compaction, context, provider, anthropic, thinking, tools, security, deny-list]
---

## ADR-083：0.14.2 质量硬化——压缩摘要与 bash 凭据路径

- **上下文**：两个缺陷。其一，压缩摘要写成 `role: 'assistant'` 且没有思维链；thinking 模式（如 DeepSeek）要求历史 assistant 消息回传 `reasoning_content`，压缩后的下一轮请求被 Provider 以 400 拒绝。同一形状还让请求组装把摘要当成基底 system（缺省补回 / hook 改写会覆盖摘要），且多次压缩会堆积多条摘要。其二，`read` / `bash cwd` 有 realpath 边界与内置凭据 denylist，但 `bash` 只要把敏感路径写在命令文本里（如 `cat ~/.ssh/id_rsa`）就不经过任何路径判定。

- **决策**：
  1. **摘要消息契约**：`Message` 增加 additive 字段 `compaction_summary?: boolean`；压缩摘要写成 `role: 'system'` + `compaction_summary: true`，位置固定在基底 system 消息之后、其它消息之前。Provider 适配层忽略该字段。
  2. **同时最多一条**：`applyCompaction` 按对象引用移除摘要范围内消息，并过滤掉已有 `compaction_summary`，再写入新摘要。
  3. **基底 system 与摘要分离**：请求组装只把 `role === 'system' && !compaction_summary` 视为基底 system；上下文缺 system 时补回基底（或 hook 改写后的）system，hook 改写 system 也只改基底 system，摘要内容不被替换。
  4. **Anthropic 合并 system**：Anthropic 请求只有单个 `system` 字段；`AnthropicProvider` 收集全部 system 消息的 content，用空行（`\n\n`）连接，流式与非流式共用；无 system 时传 `undefined`。
  5. **bash 命令文本检查**：`bash` 在 `checkPermission` 中检查命令文本命中内置 denylist 时返回 `deny`（不走用户 `ask`），并在 `runBash` 执行前复查，命中返回带稳定错误码 `path_denied` 的拒绝文本。
  6. **匹配形状**：每条内置 denylist 路径展开为 `~/<suffix>`、`$HOME/<suffix>`、`${HOME}/<suffix>`、`<os.homedir()>/<suffix>`；比较前把 `\` 视为 `/` 并统一小写；命中后要求下一字符不是 `\w`、`.`、`-`，避免 `~/.sshd` 被当成 `~/.ssh`。
  7. **如实标注能力边界**：工具描述与拒绝文本都写明“只匹配命令文本、不是沙箱”；自定义 `deny_paths` 不参与文本匹配，避免任意子串误伤普通命令。

- **冻结契约**：
  - 压缩摘要必须是 `role: 'system'` 且 `compaction_summary: true`，插在基底 system 之后、其它消息之前；不得写回 `role: 'assistant'`。
  - 任意时刻上下文最多一条摘要；应用新压缩必须清除旧摘要。
  - 只有非摘要 system 参与“缺 system 补回”与 hook `system` 改写；摘要内容不被覆盖、不被去重掉。
  - Anthropic 必须发送全部 system 消息合并后的文本；单条 system 时输出与合并前逐字一致。
  - 命令文本命中内置 denylist：`checkPermission` 返回 `deny`，执行路径返回 `path_denied`；该结果不因 `allowed_roots` / `agent.cwd` / 自定义 `deny_paths` 而放宽。
  - `read` / `edit` / `bash cwd` 的 realpath 边界（ADR-055）不变；本决策只增加命令文本维度的检查。
  - 无新增 canonical RPC 方法（仍 40），无新增配置键。

- **非目标**：
  - 不做 shell 解析、不做沙箱、不保证命令文本检查不可绕过。
  - 不把自定义 `deny_paths` 纳入文本匹配。
  - 不迁移旧版本已写入的 `role: 'assistant'` 摘要。
  - 不改变 OpenAI 兼容 provider 的消息组装（system 仍作为普通消息发送）。
  - 不为 Anthropic 合并后的 system 做长度截断或分块。

- **验证**：`packages/core/__tests__/context-manager.test.ts`（摘要形状与位置、旧摘要移除、`reasoning_content` 保留、tool 配对）、`packages/core/__tests__/anthropic-streaming.test.ts`（双 system 合并非流式 / 流式、单 system 原样）、`plugins/tools/basic-tools/__tests__/basic-tools.test.ts`（命中拒绝、`~` / `$HOME` / 绝对路径与分隔符变体、普通命令放行）。文档门禁：`bun run scripts/check-docs.ts`、`bun run scripts/check-rpc-methods.ts`、`bunx @biomejs/biome ci .`。

- **已知绕过面**（best-effort，明确写入文档）：`cd ~` 后用相对路径、变量赋值 / 拼接、引号拆分、通配符、符号链接、`~root`、`%USERPROFILE%`、由子进程自行读取的文件。

- **关联**：ADR-038（thinking `reasoning_content` 回传）、ADR-055（工具路径边界与内置 denylist）、ADR-058（统一工具执行 pipeline）；`packages/core/src/context/context-manager.ts`、`packages/core/src/runtime/agent-runtime.ts`、`packages/core/src/types/provider.ts`、`packages/core/src/provider/providers.ts`、`plugins/tools/basic-tools/src/index.ts`。
