# Changelog

> 版本历史。遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 0.x 阶段：breaking 变更走 minor，新功能走 minor，修复走 patch。

## [Unreleased]

## [0.1.0] - 2026-10-17

### Added

- `@vessel/core`：AgentRuntime 与通用 tool-calling loop（流式、中断、事件、限流、session 恢复）。
- `@vessel/core`：9 个接口（Provider / Context / EventStream / Tool / Session / Limits / Guardrail / Hook / Plugin），唯一扩展机制 `Plugin` + `PluginHost`。
- `@vessel/core`：`FileEventStore` + `replayRun` 事件回放；File / SQLite / Memory 三种 session 后端。
- `@vessel/config`：YAML 配置加载、校验（未知键报错）、snake_case → camelCase 映射。
- `@vessel/tui`：Ink REPL、流式渲染、slash 命令、权限确认、`@路径` 文件引用。
- `@vessel/serve`：常驻 gateway（`--serve`）。
- `@vessel/permission`：共享权限原语（工具经事件流等用户授权）。
- 能力工具 3 个：`bash` / `read` / `edit`；接缝工具 2 个：`ask_user`（仅交互）/ `delegate_task`。
- 插件包：`provider-openai` / `provider-anthropic` / `guardrail-pii` / `redact-secrets` / `tool-policy` / `hook-logging`。
- headless 入口 `--run`：文本、`@file`（`.json` 多轮 seeding）、stdin 管道。
- `VESSEL_MOCK=1` 模拟模式：无 API Key 跑通整条链路。
- `apps/web`：实验性 Web 控制台骨架。
- CI：质量门禁、跨平台矩阵、web 构建、examples 类型检查、mock 冒烟。
- 发布：tag `v*` 驱动，npm 发布 `@vessel/*` 与插件包（provenance、latest/beta dist-tag），生成 `latest.json`。
- 版本工具：`scripts/version.ts`（统一版本 + 一致性校验）、`scripts/latest-json.ts`。

### Changed

- 极简化重构（ADR-034）：工具集收敛为 `bash` / `read` / `edit`；插件发现只保留运行时目录扫描；skills 改为普通文件经 `RunOptions.messages` 注入。
- 事件名统一为开放字符串（ADR-030）；hook / guardrail 按 priority 排序。
- `AgentRuntime` 改为异步静态工厂 `AgentRuntime.create()`（ADR-023）。

### Removed

- `file-ops` / `meta-tools` / `skills-loader` / `mcp-client` / memory 插件。
- `ToolRegistry` 与 `ToolDefinition` 的死字段（`default` / `interactive` / `render` / `isEnabled` / `shouldDefer`）。
- `vessel.yaml` 的 `tools:` 声明段。
- 旧的 `docs/specs/`、`docs/api/`、`docs/guides/`、`docs/dev/`、`docs/role/`、`processes/`、`legacy/` 文档树。

### Known limitations

- MCP 未实现；接外部系统先用 `bash`（`curl` / CLI）。
- workflow / team / durable execution / evals 未实现。
- 0.1.0 **不发布二进制**（ADR-006 继续有效）。
- 根 CLI `vessel` 尚未发布到 npm，`npx vessel` 暂不可用。
- `vessel update` 客户端未实现；`latest.json` 更新清单已由发布流程生成。

---

## 版本命名规则

- `x.y.z` = 语义化版本（Semantic Versioning）。
- pre-1.0 阶段：`0.x.y`，Minor（中间位）= 不兼容变更。
- 发布时打 tag：`git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0`。
