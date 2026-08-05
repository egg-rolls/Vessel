# Issue 类型与优先级规范（ISSUE-SPEC）

> 本文档定义 Vessel 项目中 Issue 的类型枚举、优先级体系、Type→优先级映射。
> 永久规范：只描述设计是什么，不描述做到哪了。
> 状态/进度/阶段信息见 `docs/dev/DEVELOPMENT-PLAN.md`。

---

## 一、Issue 类型枚举

Issue 标题格式：

```
<type>(<scope>): <简短描述>
```

### 1.1 type

| type | 用途 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat(core): AgentRuntime 支持 tool-calling loop` |
| `fix` | Bug 修复 | `fix(config): loadConfig 空文件不再抛异常` |
| `docs` | 文档变更 | `docs(specs): 添加 DOC-STANDARD 文档书写规范` |
| `refactor` | 重构（不改行为） | `refactor(plugins): 统一工具注册路径为 PluginHost` |
| `test` | 测试 | `test(core): 补充 ContextManager 压缩场景测试` |
| `perf` | 性能优化 | `perf(core): applyGuardrails 按 stage 分桶索引` |
| `security` | 安全加固 | `security(plugins): guardrail-pii 补充身份证号脱敏规则` |
| `design` | 设计/架构改进（不改行为） | `design(core): EventStream.publish 异步 handler 错误处理改为结构化报告` |
| `chore` | 杂务（CI、依赖、构建配置） | `chore(ci): CI 添加 Biome lint 检查` |

### 1.2 scope

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

---

## 二、优先级体系

### 2.1 Label 定义

| Label | 含义 | 判定标准 |
|-------|------|----------|
| `P0` | 阻断——立即修复 | 用户被阻塞、数据丢失、安全漏洞、构建/CI 中断 |
| `P1` | 高——本周处理 | 影响正确性但不阻断、核心功能缺陷 |
| `P2` | 中——本月处理 | 质量加固、核心交互完善、必要但非紧急的新功能 |
| `P3` | 低——有空再做 | 体验打磨、内部重构、文档补充、锦上添花 |

### 2.2 Type → 默认优先级映射

借鉴 Hermes 项目的六层贡献优先级体系，Vessel 按 Issue type 预设默认优先级。
Reviewer 可根据实际情况上下调整一档。

| 默认优先级 | type | 说明 | Hermes 对应 |
|-----------|------|------|------------|
| **P0** | `fix`（数据丢失/崩溃/CI中断）、`security`（注入/提权/密钥泄漏） | 阻断性，立即修复 | Bug fixes / Security hardening |
| **P1** | `fix`（行为错误但不阻断）、`feat(core)` | 影响正确性或核心功能 | Bug fixes |
| **P2** | `test`、`perf`、`feat(plugins)`、`feat(tui)`（核心交互）、`feat(config)`、`feat`（无 scope 或 scope 未单独列出时默认 P2） | 质量加固与核心能力 | Performance and robustness |
| **P3** | `refactor`、`design`、`docs`、`feat(tui)`（体验细节）、`feat(cross)`、`feat(docs)`、`chore` | 锦上添花，不阻塞发布 | Documentation / New skills |

### 2.3 核心判断标准

给 Issue 标优先级时，依次问两个问题：

```
1. "不做这个，用户会被阻塞吗？"
   → 是 → P0/P1（按严重程度定）
   → 否 → 继续问第二个问题

2. "这是功能正确性还是体验细节？"
   → 正确性 → P1/P2（按影响面定）
   → 体验细节 → P3
```

### 2.4 TUI Issue 分类：核心交互 vs 体验细节

TUI 类 Issue 需区分功能交互与体验打磨：

| 核心交互（默认 P2） | 体验细节（默认 P3） |
|---------------------|---------------------|
| 用户**必须**通过这个交互才能完成任务 | 用户**已经**能完成任务，只是体验不够好 |
| 缺少它流程就断了 | 缺少它只是"不够顺手" |
| 例如：流式渲染、权限确认弹窗、slash 命令执行 | 例如：仪表盘美化、双击 Esc、spinner 动画 |

判断标准：

```
这个改动是让用户"能做之前做不到的事"（功能），
还是让用户"更舒服地做已经能做的事"（体验）？

功能 → 按优先级正常排期
体验 → 默认 P3，除非 Reviewer 判断为核心交互
```

### 2.5 Issue 生命周期

```
创建（带默认优先级 label）
  → Reviewer 确认/调整优先级
    → 认领（Issue 下留言宣告 + 关联分支）
      → 开发 → PR → 审查 → 合并 → 关闭 Issue
```

---

## 三、关联规范

- 命名与消息规范（commit/branch/PR）：`processes/conventions.md`
- 需求治理模型（五层存储、外部贡献流程）：`docs/specs/GOVERNANCE.md`
- 开发阶段计划（当前阶段、候选模块）：`docs/dev/DEVELOPMENT-PLAN.md`
- 模块开发流程（PRD → SPEC → Epic → Issues）：`processes/development.md`
