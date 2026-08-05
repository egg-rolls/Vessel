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
| `perf` | 性能优化 |
| `security` | 安全加固 |
| `design` | 设计/架构改进（不改行为） |
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

- `<type>`：与 Commit type 一致（`feat` / `fix` / `docs` / `refactor` / `test` / `perf` / `security` / `design` / `chore`）
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

- `<type>`：与 Commit type 一致
- `<scope>`：可选，与 Commit scope 一致
- 标题一句话说清——不要让人点进去才知道是什么

### 示例

```
fix(core): ContextManager.clear() 不清除同一会话的多轮消息
feat(plugins): 支持 Anthropic Provider 插件
docs(plugins): 补充插件开发指南
refactor(config): mergeConfig 改用通用深合并
test(plugins): 补充 mcp-client 单元测试
perf(core): applyGuardrails/runHooks 按 stage/type 分桶索引
security(plugins): redact-secrets 增加 AWS Access Key 检测
design(core): EventStream.publish 异步 handler 错误处理改进
```

## 四、Issue 优先级映射

Issue 的 type 前缀决定**默认优先级**。Reviewer 可根据实际情况上下调整一档。

### 4.1 优先级定义

| Label | 含义 | 判定标准 |
|-------|------|----------|
| `P0` | 阻断——立即修复 | 用户被阻塞、数据丢失、安全漏洞、构建/CI 中断 |
| `P1` | 高——本周处理 | 影响正确性但不阻断、核心功能缺陷 |
| `P2` | 中——本月处理 | 质量加固、核心交互完善、必要但非紧急的新功能 |
| `P3` | 低——有空再做 | 体验打磨、内部重构、文档补充、锦上添花 |

### 4.2 Type → 默认优先级

参照 Hermes 项目的贡献优先级体系，Vessel 按 issue type 预设默认优先级：

| 默认优先级 | type | 说明 | Hermes 对应 |
|-----------|------|------|------------|
| **P0** | `fix`（数据丢失/崩溃/CI中断）、`security`（注入/提权/密钥泄漏） | 阻断性，立即修复 | Bug fixes / Security hardening |
| **P1** | `fix`（行为错误但不阻断）、`feat(core)` | 影响正确性或核心功能 | Bug fixes |
| **P2** | `test`、`perf`、`feat(plugins)`、`feat(tui)`（核心交互） | 质量加固与核心能力 | Performance and robustness |
| **P3** | `refactor`、`design`、`docs`、`feat(tui)`（体验细节）、`feat(cross)`、`chore` | 锦上添花，不阻塞发布 | Documentation / New skills |

### 4.3 核心判断标准

给 issue 标优先级时，依次问两个问题：

```
1. "不做这个，用户会被阻塞吗？"
   → 是 → P0/P1（按严重程度定）
   → 否 → 继续问第二个问题

2. "这是功能正确性还是体验细节？"
   → 正确性 → P1/P2（按影响面定）
   → 体验细节 → P3（pre-MVP 阶段默认降级）
```

**TUI issue 特别注意**：pre-MVP 阶段，核心对话流程未稳定前，任何"让已有功能更好看/更顺手"的需求默认为 P3。区分方式：

| 核心交互（P2） | 体验细节（P3） |
|---------------|---------------|
| 用户**必须**通过这个交互才能完成任务 | 用户**已经**能完成任务，只是体验不够好 |
| 缺少它流程就断了 | 缺少它只是"不够顺手" |
| 例如：流式渲染、权限确认弹窗、slash 命令 | 例如：仪表盘美化、双击 Esc、spinner 动画 |

### 4.4 Issue 生命周期

```
创建（带默认优先级 label）
  → Reviewer 确认/调整优先级
    → 认领（Issue 下留言宣告 + 关联分支）
      → 开发 → PR → 审查 → 合并 → 关闭 Issue
```

无 PR 的 Issue 超过 30 天无人认领时，Reviewer 重新评估优先级或关闭。

## 五、PR 命名

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
