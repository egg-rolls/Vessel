# 架构决策记录（ADR）

> 记录 Vessel 的关键决策与**为什么**。架构事实见 [ARCHITECTURE.md](../ARCHITECTURE.md)。
>
> **本文档是历史存档：只追加、不修改。** ADR-001 ~ ADR-033 写于当时的架构，其中引用的
> `SPEC.md` / `PLUGINS.md` / `ROADMAP.md` / `PRD.md` / `GLOSSARY.md` / `DOC-STANDARD.md` /
> `GIT-WORKFLOW.md` / `legacy/LESSONS.md` / `docs/api/*` / `docs/role/*` 等文件，已在
> [ADR-034](ADR-034-minimal-refactor-unfreeze-core.md) 的重构中删除，这些链接不再有效。
> 保留原文以存真——**其中的架构描述不代表当前实现**，以代码与 ARCHITECTURE.md 为准。
> ADR 一经决策不轻易推翻；如需变更，新增 ADR 标注 supersede 旧者。

> **已迁移为多文件：** 每条 ADR 独立成文，文件位于本目录；下表为完整索引。

## 索引

| 编号 | 标题 | 状态 | 日期 | 标签 | 文件 |
| --- | --- | --- | --- | --- | --- |
| 001 | 实现语言用 TypeScript | accepted | - | - | [ADR-001-typescript.md](ADR-001-typescript.md) |
| 002 | 三层结构（core + config + tui），非单框架/单应用 | accepted | - | - | [ADR-002-three-layer-architecture.md](ADR-002-three-layer-architecture.md) |
| 003 | runtime 构造函数不注入插件 | accepted | - | - | [ADR-003-no-plugin-in-runtime-constructor.md](ADR-003-no-plugin-in-runtime-constructor.md) |
| 004 | 统一声明式扩展（Plugin + PluginHost） | accepted | - | - | [ADR-004-plugin-pluginhost-extension.md](ADR-004-plugin-pluginhost-extension.md) |
| 005 | 双层配置——用户身份与项目行为分离 | accepted | - | - | [ADR-005-layered-config-user-vs-project.md](ADR-005-layered-config-user-vs-project.md) |
| 006 | 分发走 npx，弃单二进制 | accepted | - | - | [ADR-006-npx-distribution-no-binary.md](ADR-006-npx-distribution-no-binary.md) |
| 007 | 流式 = 事件订阅，非独立 runtime | accepted | - | - | [ADR-007-streaming-as-event-subscription.md](ADR-007-streaming-as-event-subscription.md) |
| 008 | 事件类型枚举化 + payload schema | accepted | - | - | [ADR-008-event-type-enum-and-payload-schema.md](ADR-008-event-type-enum-and-payload-schema.md) |
| 009 | 全自研，不依赖 LangChain/LangGraph | accepted | - | - | [ADR-009-no-langchain.md](ADR-009-no-langchain.md) |
| 010 | MVP 延后 workflow/team/durable/evals | accepted | - | - | [ADR-010-defer-workflow-team-durable-evals.md](ADR-010-defer-workflow-team-durable-evals.md) |
| 011 | Skills 作为第三扩展轴，plugin-delivered，core 不加 SkillHost | superseded | - | - | [ADR-011-skills-as-third-extension-axis.md](ADR-011-skills-as-third-extension-axis.md) |
| 012 | Core 稳定性与演化策略 | accepted | - | - | [ADR-012-core-stability-and-evolution.md](ADR-012-core-stability-and-evolution.md) |
| 013 | Linter/Formatter 用 Biome | accepted | - | - | [ADR-013-biome-linter-formatter.md](ADR-013-biome-linter-formatter.md) |
| 014 | CI 用 GitHub Actions，required checks = lint+typecheck+test+build | accepted | - | - | [ADR-014-github-actions-required-checks.md](ADR-014-github-actions-required-checks.md) |
| 015 | 循环通用性——不需要循环策略抽象 | accepted | - | - | [ADR-015-no-loop-strategy-abstraction.md](ADR-015-no-loop-strategy-abstraction.md) |
| 016 | LlmStreamChunk 事件类型——流式增量经事件流 | accepted | - | - | [ADR-016-llm-stream-chunk-event.md](ADR-016-llm-stream-chunk-event.md) |
| 017 | Core 正式冻结 | superseded | - | - | [ADR-017-core-freeze.md](ADR-017-core-freeze.md) |
| 018 | BeforeLlm hook 注入消费--修复 loop 不消费 ctx.system_prompt 的 bug | accepted | - | - | [ADR-018-before-llm-hook-system-prompt.md](ADR-018-before-llm-hook-system-prompt.md) |
| 019 | 代码命名规范--TS 全驼峰，YAML 配置保持 snake_case，loader 做映射 | accepted | - | - | [ADR-019-naming-camel-case-yaml-snake-case.md](ADR-019-naming-camel-case-yaml-snake-case.md) |
| 020 | 双轨命令体系——斜杠命令（人类）与控制台命令（AI） | accepted | - | - | [ADR-020-dual-track-commands.md](ADR-020-dual-track-commands.md) |
| 021 | 工具显示接口——TUI 层定义，不改 Core | accepted | - | - | [ADR-021-tool-display-interface-in-tui.md](ADR-021-tool-display-interface-in-tui.md) |
| 022 | Spinner 状态显示——追踪思考/工具执行状态 | accepted | - | - | [ADR-022-spinner-status-display.md](ADR-022-spinner-status-display.md) |
| 023 | AgentRuntime 构造函数异步反模式修复——改用静态工厂方法 | accepted | - | - | [ADR-023-async-constructor-static-factory.md](ADR-023-async-constructor-static-factory.md) |
| 024 | ToolDefinition.default 过滤——修复 loop 不按 default 字段过滤工具的 bug | superseded | - | - | [ADR-024-tool-definition-default-filter.md](ADR-024-tool-definition-default-filter.md) |
| 025 | 补全 SessionBackend 参考实现——不视为 Core 解冻 | accepted | - | - | [ADR-025-session-backend-reference-implementation.md](ADR-025-session-backend-reference-implementation.md) |
| 026 | 工具自描述对象——权限/暂停/显示/条件启用下沉到工具节点 | accepted | - | - | [ADR-026-self-describing-tool-object.md](ADR-026-self-describing-tool-object.md) |
| 027 | 事件流拓展——事件名+payload 开放 + waitFor 原语 | accepted | - | - | [ADR-027-event-stream-extension-waitfor.md](ADR-027-event-stream-extension-waitfor.md) |
| 028 | 注册系统外推——registry 接口化 + 构建时扫描 | accepted | - | - | [ADR-028-registry-interface-and-build-scan.md](ADR-028-registry-interface-and-build-scan.md) |
| 029 | 交互暂停事件流化——ask-user/permission 用事件流实现 | accepted | - | - | [ADR-029-interactive-pause-via-events.md](ADR-029-interactive-pause-via-events.md) |
| 030 | 事件声明规范——事件名即开放字符串协议，舍弃常量 | accepted | - | - | [ADR-030-event-names-as-open-strings.md](ADR-030-event-names-as-open-strings.md) |
| 031 | 上下文变化事件化——同步写入 + ContextChanged 观测 | accepted | - | - | [ADR-031-context-change-events.md](ADR-031-context-change-events.md) |
| 032 | 事件回放——FileEventStore + replayRun | accepted | - | - | [ADR-032-event-replay-file-event-store.md](ADR-032-event-replay-file-event-store.md) |
| 033 | AgentRuntime 依赖倒置注入 + 编排逻辑外推（解冻 ADR-017 局部） | accepted | - | - | [ADR-033-dependency-injection-and-orchestration.md](ADR-033-dependency-injection-and-orchestration.md) |
| 034 | 极简化重构——解冻 core、三工具集、skills 即消息、拆治理 | accepted | - | - | [ADR-034-minimal-refactor-unfreeze-core.md](ADR-034-minimal-refactor-unfreeze-core.md) |
| 035 | 0.1.0 core loop 级正确性修复 | accepted | - | - | [ADR-035-core-loop-correctness-fixes.md](ADR-035-core-loop-correctness-fixes.md) |
| 036 | Gateway 协议 v1——事件流之上的本地控制面 | accepted | - | - | [ADR-036-gateway-protocol-v1.md](ADR-036-gateway-protocol-v1.md) |
| 038 | thinking 模式 `reasoning_content` 回传 | accepted | - | - | [ADR-038-thinking-reasoning-content.md](ADR-038-thinking-reasoning-content.md) |
| 037 | Vessel as a modular agent runtime | accepted | - | - | [ADR-037-modular-agent-runtime.md](ADR-037-modular-agent-runtime.md) |
| 039 | MCP client 作为插件接入 | accepted | - | - | [ADR-039-mcp-client-as-plugin.md](ADR-039-mcp-client-as-plugin.md) |
| 040 | Durable run——RunStore port、checkpoint 与 resume | accepted | - | - | [ADR-040-durable-run-store-checkpoint-resume.md](ADR-040-durable-run-store-checkpoint-resume.md) |
| 041 | 远程监听与 TLS（显式 opt-in） | accepted | - | - | [ADR-041-remote-listen-and-tls.md](ADR-041-remote-listen-and-tls.md) |
| 042 | workflow 引擎作为插件 | accepted | - | - | [ADR-042-workflow-engine-as-plugin.md](ADR-042-workflow-engine-as-plugin.md) |
| 043 | evals harness（默认离线） | accepted | - | - | [ADR-043-evals-harness-offline.md](ADR-043-evals-harness-offline.md) |
| 044 | 飞书渠道（插件 + 官方 SDK 隔离） | accepted | - | - | [ADR-044-feishu-channel-plugin.md](ADR-044-feishu-channel-plugin.md) |
| 045 | 0.4 可观测性与稳定性 | accepted | - | - | [ADR-045-0-4-observability-and-stability.md](ADR-045-0-4-observability-and-stability.md) |
| 046 | 文件优先存储成为默认后端 | accepted | 2026-10-18 | storage, files, tenancy | [ADR-046-file-first-storage.md](ADR-046-file-first-storage.md) |
| 047 | trace-first 可观测性 | accepted | 2026-10-18 | trace, observability, privacy | [ADR-047-trace-first-observability.md](ADR-047-trace-first-observability.md) |
| 048 | 统一 RPC 方法与 capability manifest | accepted | 2026-10-18 | rpc, api, manifest | [ADR-048-unified-rpc-method-table.md](ADR-048-unified-rpc-method-table.md) |
| 049 | 多租户隔离与单 gateway 多 tenant | accepted | 2026-10-18 | tenancy, isolation, gateway | [ADR-049-multi-tenant-isolation.md](ADR-049-multi-tenant-isolation.md) |
| 050 | YAML 主配置与密钥分层 | accepted | 2026-10-18 | config, secrets, yaml | [ADR-050-yaml-first-config-and-secrets.md](ADR-050-yaml-first-config-and-secrets.md) |
| 051 | 远程控制面（非回环 HTTPS 与 token/CA） | accepted | 2026-10-19 | remote, gateway, tls, client | [ADR-051-remote-control-plane.md](ADR-051-remote-control-plane.md) |
| 052 | 跨节点 transport 与 team 调度 | accepted | 2026-10-19 | transport, multi-node, team, events | [ADR-052-cross-node-transport.md](ADR-052-cross-node-transport.md) |
| 053 | 远程安全基线 | accepted | 2026-10-19 | security, tls, cors, tenancy | [ADR-053-remote-security-baseline.md](ADR-053-remote-security-baseline.md) |

## 编写约定

- **命名**：`ADR-<NNN>-<slug>.md`；编号三位补零，`slug` 为 ASCII kebab-case；编号一经分配不再复用。
- **frontmatter schema**：
  - `adr`（整数，必填）：ADR 编号，不带补零。
  - `title`（字符串，必填）：标题，与正文 `## ADR-NNN：...` 行冒号后的文本一致。
  - `status`（必填）：`proposed` | `accepted` | `superseded`。
  - `date`（必填）：决策日期 `YYYY-MM-DD`；历史 ADR 无可靠日期时写 `null`，不臆造。
  - `supersedes`（可选，整数数组）：本 ADR 取代的旧 ADR 编号。
  - `related`（可选，整数数组）：正文中显式引用的其他 ADR 编号，去重后按数字升序。
  - `tags`（可选，字符串数组）：主题标签；无标签时省略。
- **supersedes 与 related 的区别**：`supersedes` 表示**决策替代**——本 ADR 使旧 ADR 失效，旧 ADR 的 `status` 应改为 `superseded`；`related` 只表示**阅读关联**，不改变任何 ADR 的状态。
- **正文结构**：`## ADR-NNN：<标题>`，其下按需包含 `上下文`、`决策`、`备选`、`后果`、`关联` 五个部分；历史 ADR 保留原有结构与文字，不重排、不改写。
- **历史 ADR 的日期规则**：本次由单文件存档迁移而来的 ADR-001 ~ ADR-045 没有可靠日期，统一 `date: null`；新增 ADR 必须填写真实决策日期。

## 链接策略

- 历史 ADR 正文按存档保留，正文内链（包括指向已删除文档的链接）不参与链接检查；迁移时不改写、不修复。
- 索引、`related` / `supersedes` 与 ADR 之间的链接参与链接检查，目标必须存在。
- README 中的链接一律使用相对路径。
