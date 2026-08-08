# 插件 Backlog 目录

> 本文件是行业常见功能的插件化清单，供规划与开发参考。**非承诺全部实现**；按需求与资源取舍。
> 每项标注：责任、重依赖、Tier 优先级。架构前提：除 §九 标注的 loop 级项外，**全部经 PluginHost 投放，core 不动**（ADR-011/012）。

## Tier 分级

- **Tier 1（开箱即用）**：无基础用户期望开箱即有的基础能力与安全。
- **Tier 2（常用进阶）**：进阶常用能力与可观测。
- **Tier 3（按需）**：高级编排与垂直能力，按真实需求驱动。

---

## 〇、用户工具扩展层（#95）

用户加工具**运行时生效**，不碰源码、不跑构建（ADR-028）。两种注册 Provider，与 MCP（mcp-client）并列：

- **DirScanner**：扫描 `~/.vessel/tools/`（用户级）与 `./tools/`（项目级），运行时加载自描述工具文件（#91）。放一个 `.ts`/`.js` 文件即被识别。
- **ConfigDeclared**：读 `vessel.yaml` 的 `tools` 声明（命令/url），启动即连接注册。

bootstrap 用 `CompositeProvider` 组合内置 StaticRegistry + 用户 DirScanner/ConfigDeclared，三类来源并存。详见 [SPEC §6.2.4](SPEC.md)。

---

## 一、能力工具

> **默认工具**（`default: true` = 启动时自动在 system prompt 中列出）：`file-ops`、`grep`、`web-search`、`web-fetch`。
> **按需工具**（`default: false` = 通过 `search_assets` 发现）：`shell`（危险，必走 permission-prompt）、`browser`、`rag` 及以下其余工具。详见 [SPEC §4.2/§6](SPEC.md)。

| 插件 | 责任 | 重依赖 | Tier | 默认 |
|------|------|--------|------|------|
| file-ops | 文件读写/搜索/列目录 | 无 | 1（内置参考） | true |
| grep | 文本搜索 | 无 | 1 | true |
| web-search | 网页搜索（Tavily/Brave/Serper） | API key | 1 | true |
| web-fetch | 抓取 URL + 正文提取（readability） | 无 | 1 | true |
| shell | 命令执行（危险） | 无 | 1（内置参考） | false |
| todo-list | 任务进度跟踪 | 无 | 1 | true |
| ask-user | 向用户提问/确认选择 | 无 | 1 | true |
| code-sandbox | 代码执行（Docker/E2B/Firecracker/本地 REPL） | 重 | 2 | false |
| browser | 浏览器自动化（Playwright/Puppeteer） | 重 | 2 | false |
| rag | 向量检索 + 注入（Chroma/Qdrant/pgvector/LanceDB） | 中 | 2 | false |
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
| asset-introspection | Agent 认知启动：如何查询资产、节俭上下文、CRUD 自己的工具/Skill/MCP/Plugin | Skill（内置，启动自动加载） | 1 |
| tool-discovery | 引导 Agent 用子 agent 查询工具而非 dump 全部 schema 进上下文 | Skill | 1 |
| skill 内容 | 领域剧本（编码/研究/写作…） | Markdown | 2–3 |
| skill-library | 社区 skill 分发 | 仓库 | 3 |

### 8.1 asset-introspection：认知检查循环

asset-introspection 是 Vessel 的 BIOS——Agent 启动时自动加载，定义了"怎么了解自己、怎么发现缺口、怎么补救"的认知模式。其核心逻辑直接来源于两个适配器模型：

**完成任务的两个条件**（任一不满足 = 不要猜、不要装）：
1. **入适配器（知识）**：你是否充分理解这个任务？
2. **出适配器（工具）**：你是否有执行这个任务所需的全部工具？

**认知检查循环**——每个任务动手前执行：

```
1. 知识检查
   不确定 → search_assets(query, type="skill")
   没有 → web-fetch / web-search 获取外部知识
   仍然不清楚 → ask_user("我没有足够的知识做 X，你能提供吗？")

2. 工具检查
   不确定 → search_assets(query, type="tool")
   没有 → 评估三选一：
     a) 现有工具组合能否实现？→ 继续
     b) 能否通过 MCP 获取？→ 提示用户 connect_mcp
     c) 能否自己创建？→ add_skill / add_tool（危险操作需用户确认）
   全不行 → ask_user("我需要工具 X 才能完成，现在没有。你要我创建它吗？")

3. 绝对不做
   不要猜测你不知道的东西
   不要假装拥有某个能力
   不要在工具不够时"勉强完成"
   不要在不确定时给出看起来很确定的答案
```

**缺口升级路径**：

```
自己能补 → 补（search_assets → add_skill / connect_mcp）→ 继续
自己能找 → 问（web-search 获取线索 → 回来再尝试）→ 继续
自己不能 → ask_user（诚实报告：缺什么、为什么缺、建议怎么补）
```

**与 tool-discovery 的协作**：tool-discovery 负责"别 dump 全部工具"（搜索策略），asset-introspection 负责"发现缺口后怎么办"（修复策略）。两者共同构成 Agent 的元认知层。

## 九、为什么 core 不需要长大

§二至§八 的插件分类背后有一个更深的前提——以下看似"必须改 core"的能力，实际上**同一个循环换种用法**就解决了：

| 能力 | 插件解法 | 说明 |
|------|---------|------|
| 并行工具调用 | 工具 handler 内部 `Promise.all`；或循环中 `for each` → `Promise.all`（一行代码） | 循环骨架不变 |
| 流式工具结果 | `EventStream.publish(tool.progress)` → TUI 订阅增量渲染 | 流的是观测层，循环仍等最终结果 |
| 打断 / 暂停 / 恢复 | `options.signal?.aborted` → `break` | 循环加一行 abort 检查 |
| 树搜索 | 子 agent 工具（继承母 agent 知识）→ 探索分支 → 母 agent 选择 → 切分支 | A2A 用工具表示 |
| A2A / 多 agent 协作 | 工具 handler 内部 spawn 子 runtime | 一个工具的事 |
| Self-correction | Guardrail 或 Hook 注入修正提示 → 循环自然继续 | Hook 的事 |
| Plan-then-execute | Agent 自己按计划逐轮调工具 | Agent 自己的推理 |
| Debate | 工具 handler 内部并行调多个 runtime，聚合返回 | 一个工具的事 |

**结论**：Vessel 的工具调用循环是通用的。所有"看起来像新范式"的东西——Harness Engineering、Loop Engineering、树搜索、多 agent 协作——都是**同一个 while 循环挂不同的工具/Hook/Guardrail 组合**。core 不需要为它们长大。见 [SPEC.md §1.1](SPEC.md) 与 [ADR-015](ADR.md)。

## 十、取舍原则

- 拿不准是否进 core：选插件（ADR-012 + [CLAUDE.md](../../CLAUDE.md) §5 决策树）。
- 重依赖（浏览器/沙箱/向量库/OCR/图片）一律独立插件包，不进 core 依赖。
- 垂直能力（RAG/代码审查/客服）永不进 core，只作插件/应用。
- Tier 3 项无真实需求不动（避免 speculative generality，legacy/LESSONS 教训14）。
- 能力优先用工具/Hook/Guardrail/事件实现；碰 core 是所有方法都用尽后的最后选项（ADR-012/015）。
