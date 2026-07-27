# Changelog

> 版本历史。遵循 [Keep a Changelog](https://keepachangelog.com/) 格式。

## [Unreleased]

### Added
- `@vessel/core`：AgentRuntime 核心 tool-calling loop
- `@vessel/config`：YAML 配置加载/校验/合并
- `@vessel/tui`：REPL 交互终端 + 流式渲染
- PluginHost + 7 个插件（provider-openai/anthropic、file-ops、meta-tools 等）
- 完整单元测试套件（8 文件）

### Known Issues
- 10 个已知问题，详见 [docs/dev/phase-1-review.md](docs/dev/phase-1-review.md)

---

## 版本命名规则

- `x.y.z` = 语义化版本（Semantic Versioning）
- pre-1.0 阶段：`0.x.y`，Minor（中间位）= 不兼容变更
- 发布时打 tag：`git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0`
