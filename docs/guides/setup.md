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

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 API Key（开发时可用 MemoryLLMProvider，无需真实 Key）

# 4. 运行测试
bun test

# 5. 启动开发 REPL
bun run start.ts
```

## 项目结构

```
vessel/
├── packages/           # monorepo 包
│   ├── core/           # @vessel/core 运行时
│   ├── config/         # @vessel/config 配置
│   └── tui/            # @vessel/tui 终端
├── plugins/            # 官方插件
├── skills/             # 内置 Skills
├── docs/               # 文档
│   ├── specs/          # 规格（PRD/SPEC/ADR/ROADMAP）
│   ├── guides/         # 开发指南
│   ├── api/            # API 参考
│   └── dev/            # 审查报告/调试记录
├── processes/          # 标准化工作流程
├── src/                # CLI 入口
└── examples/           # 示例
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `bun test` | 运行全部测试 |
| `bun run lint` | Biome lint+format 检查 |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun run build` | 构建所有包 |
| `bun run start.ts` | 启动开发 REPL |
| `bun run examples/demo.ts` | 运行示例 |

## IDE 配置

VS Code + Biome 插件（`biomejs.biome`），settings.json：

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome",
  "[typescript]": { "editor.defaultFormatter": "biomejs.biome" }
}
```
