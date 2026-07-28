# 本地开发环境搭建

## 前置条件

- [Bun](https://bun.sh) >= 1.0.0
- Git
- （可选）VS Code + Biome 插件

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/egg-rolls/Vessel.git
cd Vessel

# 2. 安装依赖（monorepo workspaces）
bun install

# 3. 运行测试（不依赖外部 API——用内置 MemoryLLMProvider）
bun test

# 4. 交互式 REPL（mock 模式，不调真实 API）
VESSEL_MOCK=1 bun run src/cli.ts

# 5. 首次真实 API 使用——进入 REPL 自动弹出配置向导
bun run src/cli.ts
# 按提示输入 BaseURL + APIKey + Model → 保存到 ~/.vessel/config.yaml
# 此后所有项目自动可用，无需重复配置。

# 6. Headless 单轮
VESSEL_MOCK=1 bun run src/cli.ts --run "你的 prompt"
echo "..." | VESSEL_MOCK=1 bun run src/cli.ts --run     # stdin
VESSEL_MOCK=1 bun run src/cli.ts --run @file.txt         # 文本文件
VESSEL_MOCK=1 bun run src/cli.ts --run @conv.json         # JSON 多轮 seeding
```

## 项目结构

```
vessel/
├── packages/           # monorepo 包
│   ├── core/           # @vessel/core 运行时（ADR-017 冻结）
│   ├── config/         # @vessel/config 配置加载/校验
│   └── tui/            # @vessel/tui 终端交互
├── plugins/            # 官方插件（2 provider + 10 功能 = 12 个）
│   ├── provider/       # openai（含 google/mistral/ollama/cohere）+ anthropic
│   ├── tools/          # meta-tools / skills-loader / file-ops
│   ├── memory/         # project / auto
│   ├── security/       # guardrail-pii / redact-secrets / tool-policy
│   ├── integration/    # mcp-client
│   └── observability/  # hook-logging
├── docs/               # 文档
│   ├── specs/          # 规格（SPEC/ADR/ROADMAP/PRD）
│   ├── guides/         # 开发指南
│   ├── api/            # API 参考
│   └── dev/            # 审查报告/调试记录
├── processes/          # 协作流程/任务分配
├── src/                # CLI 入口 (cli.ts)
└── examples/           # 示例
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `bun test` | 运行全部测试（152+） |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun run lint` | Biome lint+format 检查 |
| `bun run build` | 构建所有包 + 单二进制 |
| `VESSEL_MOCK=1 bun run start` | Mock 模式 REPL（不调 API） |
| `bun run start` | 真实 API REPL |
| `VESSEL_MOCK=1 bun run src/cli.ts --run "..."` | Headless 单轮（mock） |
| `VESSEL_DEBUG=1 bun run start` | 调试模式（加载 hook-logging） |

## 配置

Vessel **不内置任何厂商 Key/BaseURL/模型列表**（ADR-005 + ADR-019）。

- **API Key** 存 `~/.vessel/config.yaml`（跨项目复用，永不进 git）
- **项目行为** 存 `./vessel.yaml`（跟着仓库走，不含 Key，可安全提交）
- **首启向导**在无 Key 时自动弹出，交互式填写 BaseURL + APIKey + Model
- **Provider** 两个接口：OpenAI 兼容（`/chat/completions`）和 Anthropic（Messages API）；支持 deepseek/lite.lhdeer.com 等自定义端点

## IDE 配置

VS Code + Biome 插件（`biomejs.biome`），settings.json：

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome",
  "[typescript]": { "editor.defaultFormatter": "biomejs.biome" }
}
```
