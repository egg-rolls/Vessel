---
adr: 19
title: 代码命名规范--TS 全驼峰，YAML 配置保持 snake_case，loader 做映射
status: accepted
date: null
related: [5, 13]
---

## ADR-019：代码命名规范--TS 全驼峰，YAML 配置保持 snake_case，loader 做映射

- **上下文**：Biome（ADR-013）的 `useNamingConvention` 规则要求 TS 对象属性用 `camelCase`。但 Vessel 的配置类型（`VesselConfig`、`ProviderConfig`、`UsageLimits` 等）全部用了 `snake_case`（如 `api_key`、`base_url`、`request_limit`），因为它们在 YAML 文件中面向用户。YAML 中 `snake_case` 更可读，不应该改动。但 TS 代码中的 `snake_case` 属性导致 CI lint 持续报警（506 条 warning + 部分 error），且与 Biome 规则对立，每次修改文件都需 biome-ignore。
- **决策**：
  1. **TS 代码层禁用 `snake_case`**：所有 TS 接口、类、变量使用 `camelCase`。`packages/config/src/types.ts` 的 `VesselConfig` 等类型字段全部改为 `camelCase`（如 `api_key` → `apiKey`，`base_url` → `baseUrl`，`max_tokens` → `maxTokens`）。
  2. **YAML 用户层保持 `snake_case`**：`vessel.yaml`、`~/.vessel/config.yaml` 中的键名不变（仍为 `api_key`、`base_url`）。用户面向的 YAML 采用 snake_case 更符合 YAML/YAML 惯例，不牺牲可读性。
  3. **config loader 做映射**：`@vessel/config` 的 `loadConfig()` 在解析 YAML 后，自动将 `snake_case` 键映射为 `camelCase` 字段（`api_key` → `apiKey`，`tool_calls_limit` → `toolCallsLimit`，以此类推）。**嵌套对象递归映射**。配置 validated 之后任意下游代码（core、tui、cli、plugins）看到的是全 camelCase 的 `VesselConfig`，不再需要处理 snake_case。
  4. **biome.json 移除 `useNamingConvention: "warn"`**：当前 `warn` 级别被 Biome 1.9 部分误报为 `error`（见 defaults.ts DEFAULT_CONFIG 的 `max_tokens`/`max_history` 等字段）。修完 snake_case 后改为**推荐规则默认级别或移除显式 warn**——因为全部 camelCase 之后自然合规，不需要手动压制。
  5. **Core 类型例外**：`@vessel/core` 中与 LLM API 协议直接对应的字段（如 `ChatRequest` 的 `max_tokens`、`ToolCall` 的 `tool_call_id`）保持 `snake_case`，因为这些字段名由 OpenAI/Anthropic API 规范定义，**不能改**。对这类字段，在文件中使用 `// biome-ignore-file lint/style/useNamingConvention: LLM API protocol fields` 压制整个文件的规则。这是 Biome 规则与外部 API 协议的合法冲突，不是 Vessel 自身的设计问题。
- **备选**：(a) 放弃 Biome 的 naming convention 规则——退回到无规则状态，代价是没有统一的 TS 命名约束。(b) 在 `biome.json` 中全局关闭 `useNamingConvention`——简单但失去 lint 保护，且其他 `snake_case` 滥用不会被检测。(c) 不改 TS 类型，对每个字段加 biome-ignore 行级注释——维护成本高、代码丑。均不取。
- **后果**：下游代码（cli、tui、core、plugins）需要使用 `config.provider.baseUrl` 而非 `config.provider.base_url`。YAML 文件语法不变，用户无感知。Core API 协议相关文件需要少量 biome-ignore 压制。`@vessel/config` 增加 `snakeToCamel` 映射函数，配置加载逻辑稍增但不影响运行时性能（只在加载时执行一次）。
- **关联**：ADR-005（双层配置）、ADR-013（Biome）；[DOC-STANDARD.md](DOC-STANDARD.md) §四；[SPEC.md §6](SPEC.md)。
