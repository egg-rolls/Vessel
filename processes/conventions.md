# 命名与消息规范

> 分支名、Commit、Issue 的格式约定。人类和 AI Agent 共同遵守。
> CI/Lint 不强制格式，但 Reviewer 审查时检查，不合规退回重写。

## 一、Commit Message

### 格式

```
<type>(<scope>): <subject>
```

### type（必填）

| type | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档变更 |
| `refactor` | 重构（不改行为） |
| `test` | 测试 |
| `chore` | 杂务（CI、依赖、构建配置） |

### scope（必填）

| scope | 对应路径 |
|-------|----------|
| `core` | `packages/core/` |
| `config` | `packages/config/` |
| `tui` | `packages/tui/` |
| `plugins` | `plugins/` |
| `docs` | `docs/` |
| `ci` | `.github/` |
| `processes` | `processes/` |

### subject

- 中文或英文均可，≤ 72 字符
- 动词开头，不加句号
- 说清楚做了什么，不要模糊词（"优化"、"改进"、"更新"）

### 正确示例

```
feat(core): AgentRuntime 支持 tool-calling loop
fix(config): loadConfig 空文件不再抛异常
docs(specs): 添加 DOC-STANDARD 文档书写规范
refactor(plugins): 统一工具注册路径为 PluginHost
test(core): 补充 ContextManager 压缩场景测试
chore(ci): CI 添加 Biome lint 检查
```

### 错误示例

```
工具持久化                        ← 无 type/scope
update code                      ← 模糊，不知道改了啥
feat: 新功能                      ← 无 scope
fix(core): 改了一下               ← 说不清做了什么
```

## 二、分支命名

```
<type>/<slug>
```

- `<type>`：与 Commit type 一致（`feat` / `fix` / `docs` / `refactor` / `test` / `chore`）
- `<slug>`：短横线小写英文，2-5 个词

### 示例

```
feat/tool-registry-unify
fix/remove-debug-logs
docs/add-doc-standard
refactor/merge-tool-paths
```

## 三、Issue 命名

```
<type>: <简短描述>
```

- `<type>`：`Bug` / `Feature` / `Docs` / `Refactor`
- 标题一句话说清——不要让人点进去才知道是什么

### 示例

```
Bug: ContextManager.clear() 不清除同一会话的多轮消息
Feature: 支持 Anthropic Provider 插件
Docs: 补充插件开发指南
```
