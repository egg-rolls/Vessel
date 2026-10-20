---
adr: 68
title: 配置与首启硬化（统一 Key 解析、provider 优先级与 fail-fast）
status: accepted
date: 2026-10-20
related: [19, 50, 57, 64]
tags: [config, provider, first-run, validation, security]
---

## ADR-068：配置与首启硬化（统一 Key 解析、provider 优先级与 fail-fast）

- **上下文**：0.9 之前，配置层同时存在 legacy 顶层 `default_provider` / `providers` 与新版 `provider:` 块，不同入口（bootstrap / eval / doctor / serve）各自决定读哪一个，API Key 也有 provider 级、`*_env` 与顶层多条路径。后果是：(a) 同一个配置文件在不同入口可能解析出不同 provider；(b) 未注册的 provider 被静默当成某个厂商默认，或缺少 model 时全局回退 `gpt-4`，用户只看到远端 404 / 401；(c) YAML 重复键与解析失败被吞成 `{}`，首启表现为“配置没生效”；(d) `config show --sources` 会输出 token 键与解析后的密钥。首启体验因此不可预测，也多处存在密钥泄露面。

- **决策**：
  1. **Key 解析单源**。新增 `resolveEffectiveApiKey(config)`：provider 级 `apiKey`（含 `*_env` 解析）优先，其次顶层 `apiKey`；所有装配入口（bootstrap、eval、doctor）一律调用它，不再自行读字段。
  2. **legacy 只读兼容**。`default_provider` / `providers` 仍可读，但新版 `provider:` 块优先级更高；两者并存时使用新版，并对 legacy 键发 deprecation warning（不阻止启动）。legacy 不参与写入，也不作为新功能的目标形态。
  3. **未知 provider fail-fast**。未注册 provider 且没有 `provider.baseUrl` 时抛 `ProviderConfigError`（`provider_invalid`），不猜厂商默认端点；提供了 `baseUrl` 时按 OpenAI 兼容端点构造，并只向 stderr 打一次 info。已知 provider 缺少 model 同样 fail-fast，不再全局回退 `gpt-4`。
  4. **YAML 错误显式化**。解析失败、重复键、根节点类型错误转为带文件路径（YAML 错误还带行号）的 validation error；只有文件不存在 / 空文档才视为缺省。不得把损坏配置静默降级为默认配置。
  5. **首启模板可启动**。`config init` 生成的模板可直接启动并打印下一步提示；`--json` 下错误是结构化对象；CLI 统一错误 formatter，退出码区分参数错误（2）与运行失败（1）。
  6. **来源脱敏**。`config show --sources` 对 `serve.tokens.<token>.*` 的 token 段与值输出 `<set>` / `<set#N>`，对 `*.apiKey` / `*.token` 的来源值输出 `<set>`；任何路径都不输出解析后的密钥。
  7. **配置默认值对齐运行时**。`context.maxMessages` 不再提供默认值；缺省时由 core 按 `context.maxTokens` 推导安全条数上限（见 ADR-069 的运行时部分与 ARCHITECTURE §29）。显式配置仍优先。

- **备选**：(a) 继续兼容两套 provider 写法且不告警——行为差异会长期存在；(b) legacy 直接报错——破坏已有配置，且 0.x 阶段没有必要；(c) 未知 provider 回退到 openai 默认端点——会把配置错误伪装成网络错误；(d) YAML 解析失败回落默认配置——首启更难诊断，且可能覆盖用户意图；(e) 保留 `context.maxMessages` 默认值——与 1M 上下文预算冲突，条数上限会绕过 token 预算。均不取。

- **后果**：配置行为在入口之间一致；错误在首启时暴露，而不是在第一次模型请求时以远端错误出现。依赖“未知 provider 自动可用”的旧配置必须补 `provider.base_url` 或改用已注册 provider；依赖 `default_provider` 的配置仍能启动，但会看到 deprecation warning。`ProviderConfigError` 的退出码由入口决定（0.3 入口 1、新子命令 2）。密钥脱敏只覆盖 `config show --sources` / doctor 等诊断输出，不能据此宣称所有日志与事件都不含密钥——日志侧的行为见 ADR-069。

- **关联**：ADR-019（YAML snake_case 与 TS camelCase 映射）、ADR-050（YAML 主配置与密钥分层）、ADR-057（配置单一 resolver）、ADR-064（上下文默认预算）；`packages/config/src/secrets.ts`、`packages/config/src/loader.ts`、`packages/config/src/validator.ts`、`packages/config/src/sources.ts`、`src/provider-factory.ts`、`src/config-command.ts`。
