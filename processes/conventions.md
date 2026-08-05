# 命名与消息规范

> 分支名、Commit、PR 的格式约定。人类和 AI Agent 共同遵守。
> CI/Lint 不强制格式，但 Reviewer 审查时检查，不合规退回重写。
> Issue 类型与优先级体系的完整定义见 `docs/specs/ISSUE-SPEC.md`。

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
| `perf` | 性能优化 |
| `security` | 安全加固 |
| `design` | 设计/架构改进（不改行为） |
| `chore` | 杂务（CI、依赖、构建配置） |

> 完整定义与示例见 `docs/specs/ISSUE-SPEC.md` §1。

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
| `src` | `src/` |
| `cross` | 改动涉及多个 scope（跨包） |

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
perf(core): applyGuardrails 按 stage 分桶索引减少数组分配
security(plugins): guardrail-pii 补充身份证号脱敏规则
design(core): EventStream.publish 异步 handler 错误处理改为结构化报告
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

- `<type>`：与 Commit type 一致
- `<slug>`：短横线小写英文，2-5 个词

### 示例

```
feat/tool-registry-unify
fix/remove-debug-logs
docs/add-doc-standard
refactor/merge-tool-paths
perf/hook-stage-bucket-index
security/pii-redact-id-card
```

## 三、Issue 命名

```
<type>(<scope>): <简短描述>
```

格式与 Commit 一致。标题一句话说清——不要让人点进去才知道是什么。

> Issue 类型定义、优先级体系（P0-P3）、Type→优先级映射见 `docs/specs/ISSUE-SPEC.md`。

### 示例

```
fix(core): ContextManager.clear() 不清除同一会话的多轮消息
feat(plugins): 支持 Anthropic Provider 插件
docs(plugins): 补充插件开发指南
refactor(config): mergeConfig 改用通用深合并
```

## 四、PR 命名

```
<type>(<scope>): <简短描述> #<issue-number>
```

- `<type>` / `<scope>`：与 Commit、Issue 一致
- 关联 Issue：标题末尾加 `#<issue-number>`（GitHub 自动建立链接）
- 无关联 Issue 时可省略编号（但建议先建 Issue 再提 PR）

### 示例

```
fix(core): AgentRuntime 改用静态工厂方法 #17
refactor(src): 拆分 cli.ts Bootstrap 模块 #16
docs(processes): 统一 Issue/PR 命名规范
```
