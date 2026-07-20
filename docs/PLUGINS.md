# 插件 Backlog 目录

> 本文件是行业常见功能的插件化清单，供规划与开发参考。**非承诺全部实现**；按需求与资源取舍。
> 每项标注：责任、重依赖、分期 Tier。架构前提：除 §九 标注的 loop 级项外，**全部经 PluginHost 投放，core 不动**（ADR-011/012）。

## Tier 分级

- **Tier 1（开箱即用，Phase 1–2）**：无基础用户期望开箱即有的基础能力与安全。
- **Tier 2（常用，Phase 2）**：进阶常用能力与可观测。
- **Tier 3（按需，Phase 3）**：高级编排与垂直能力，按真实需求驱动。

---

## 一、能力工具

| 插件 | 责任 | 重依赖 | Tier |
|------|------|--------|------|
| file-ops | 文件读写/搜索/列目录 | 无 | 1（内置参考） |
| shell | 命令执行 | 无 | 1（内置参考） |
| web-search | 网页搜索（Tavily/Brave/Serper） | API key | 1 |
| web-fetch | 抓取 URL + 正文提取（readability） | 无 | 1 |
| code-sandbox | 代码执行（Docker/E2B/Firecracker/本地 REPL） | 重 | 2 |
| browser | 浏览器自动化（Playwright/Puppeteer） | 重 | 2 |
| rag | 向量检索 + 注入（Chroma/Qdrant/pgvector/LanceDB） | 中 | 2 |
| embeddings | 文本向量化 | API key | 2 |
| rerank | 检索重排 | API key | 2 |
| doc-parse | 文档解析（PDF/DOCX/PPTX/Excel） | 中 | 2 |
| db-query | NL2SQL / 数据库查询 | 驱动 | 2 |
| git | Git 操作 | 无 | 2 |
| http | 通用 HTTP/API 调用 | 无 | 2 |
| ocr | 图像文字识别 | 中 | 3 |
| image-gen | 图片生成/编辑（DALL-E/SD/Flux） | API key | 3 |
| speech | STT/TTS（Whisper 等） | 中 | 3 |
| code-intel | LSP/tree-sitter/Repo Map（Aider 式） | 中 | 3 |
| scheduler | 定时任务 | 无 | 3 |

## 二、模型与 Provider

| 插件 | 责任 | 重依赖 | Tier |
|------|------|--------|------|
| provider-openai | OpenAI 兼容适配 | 无 | 1（参考） |
| provider-anthropic | Anthropic 适配 | 无 | 1（参考） |
| provider-google/mistral/cohere | 其他云厂商 | 无 | 2 |
| provider-local | 本地模型（Ollama/llama.cpp/MLX） | 中 | 2 |
| provider-bedrock/azure | 云托管 | SDK | 3 |
| response-cache | 响应/语义/prompt 缓存（provider 包装器） | 可选 | 2 |
| provider-fallback | 故障转移/路由链（provider 包装器） | 无 | 2 |

## 三、记忆与上下文

| 插件 | 责任 | 重依赖 | Tier |
|------|------|--------|------|
| memory-project | 项目记忆（CLAUDE.md 式） | 无 | 1 |
| memory-auto | 跨会话自动记忆 | 无 | 1 |
| memory-longterm | 长期向量记忆 | 向量库 | 2 |
| compact-strategy | 压缩策略（摘要/保最近/重要性） | 无 | 2（钩子点见 §九） |
| repo-map | 代码库 PageRank 选上下文 | 中 | 3 |

## 四、治理与安全

| 插件 | 责任 | 重依赖 | Tier |
|------|------|--------|------|
| redact-pii | PII 脱敏 | 无 | 1 |
| redact-secrets | 密钥脱敏（sk-*、token） | 无 | 1 |
| tool-policy | 工具允许/禁止清单 | 无 | 1 |
| permission-prompt | 危险工具 human-in-the-loop（hook+TUI） | 无 | 1 |
| anti-injection | Prompt 注入防御 | 无 | 2 |
| moderation | 内容审核 | API key | 2 |
| output-schema | 输出结构校验（强制 JSON） | 无 | 2（先 guardrail） |
| sandbox-fs | 文件/命令沙箱（限目录） | 无 | 2 |
| audit-log | 审计日志（事件订阅） | 无 | 2 |

## 五、可观测与评测

| 插件 | 责任 | 重依赖 | Tier |
|------|------|--------|------|
| trace-otel | OpenTelemetry 导出 | SDK | 2 |
| trace-langsmith | LangSmith/Langfuse/Logfire 导出 | SDK | 2 |
| cost-analytics | 成本分析（事件订阅） | 无 | 2 |
| error-sentry | 错误监控（Sentry） | SDK | 2 |
| eval-harness | 评测框架/数据集 | 无 | 3 |
| llm-judge | LLM-as-judge 评测器 | API key | 3 |
| prompt-version | Prompt 版本/AB 测试 | 无 | 3 |

## 六、编排（旧版在 core，新版改插件）

| 插件 | 责任 | 重依赖 | Tier |
|------|------|--------|------|
| team | Multi-agent team/handoff | 无 | 3 |
| workflow | DAG 工作流 | 无 | 3 |
| subagent | Subagent/agent-as-tool/委托 | 无 | 3 |

## 七、协议与集成

| 插件 | 责任 | 重依赖 | Tier |
|------|------|--------|------|
| mcp-client | MCP 客户端（tools/resources/prompts） | 无 | 1 |
| openapi-tools | OpenAPI spec -> 自动工具 | 无 | 2 |
| mcp-server | 把 Vessel 暴露为 MCP server | 无 | 3 |
| bot-slack/discord/telegram | Bot 暴露 agent | SDK | 3 |
| api-server | REST/GraphQL headless agent | 框架 | 3 |
| webhook | Webhook 触发 | 无 | 3 |
| n8n-bridge | n8n/Zapier 集成 | 无 | 3 |

## 八、Skills（行为 know-how）

| 项 | 责任 | 形态 | Tier |
|----|------|------|------|
| skills-loader | 加载/注入/触发 skill | 插件（TS） | 2 |
| skill 内容 | 领域剧本（编码/研究/写作…） | Markdown | 2–3 |
| skill-library | 社区 skill 分发 | 仓库 | 3 |

## 九、需改 core 的 loop 级项（各需 ADR，ADR-012）

| 功能 | 为什么必须动 core | 时机 |
|------|------------------|------|
| 并行工具调用 | loop 现为串行；并行需 `Promise.all`，插件改不了循环 | Phase 3 |
| 流式工具结果 | tool 接口 `Promise<string>` -> `AsyncIterable<string>` + loop 增量注入 | Phase 3 |
| 运行中打断/暂停/恢复 | loop 需轮询 abort 信号；+ TUI 发信号 | Phase 2–3 |

**边缘项（先做插件，必要时才碰 core）**：
- 结构化输出强保证：先 Output guardrail 插件；要 core 级硬保证再议。
- 压缩策略钩子点：策略是插件；若要自定义策略接口，加小 core 扩展面（ADR）。
- 实时成本计入 UsageLimits：限额检查在 core，费率/计算靠插件；尽量用事件 + 共享计数器，不扩 core。

## 十、取舍原则

- 拿不准是否进 core：选插件（ADR-012 + [CLAUDE.md](../CLAUDE.md) §5 决策树）。
- 重依赖（浏览器/沙箱/向量库/OCR/图片）一律独立插件包，不进 core 依赖。
- 垂直能力（RAG/代码审查/客服）永不进 core，只作插件/应用。
- Tier 3 项无真实需求不动（避免 speculative generality，legacy/LESSONS 教训14）。
