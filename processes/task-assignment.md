# 当前任务分工

> 基线：main（feature/phase-1 已合并，含已知问题见 [phase-1-review.md](../docs/dev/reviews/phase-1-review.md)）
> 原则：一人做设计决策，一人做落地实现，交叉 Review；AI Agent 辅助编码执行
> 更新：一项完成即更新文档、划线标记

## 协作约定

### 分支命名

```
fix/<issue-slug>       # 修复性任务
feat/<feature-slug>    # 新功能
```

### 工作流（每人每个任务）

```
切分支 → AI 辅助开发 → 自查门禁 → 推送 → 对方 Review → 合并
```

### Review 规则

- egg-rolls 的分支 → emma Review（检查实现是否与设计意图一致）
- emma 的分支 → egg-rolls Review（检查架构合规、红线、门禁）
- 每人每天最多 2 个分支待审查，避免堆积

---

## 分工表

### egg-rolls — 架构与设计决策

核心职责：守住 SPEC/ADR 边界、做需要全局判断的设计选择、最终合并审批。

| ID | 任务 | 类型 | 说明 |
|----|------|------|------|
| A1 | 统一工具注册路径 | 架构重构 | 决定 ToolRegistry 与 PluginHost 如何合并；产出设计方案后emma实现 |
| A2 | mock assistant → Hook 插件 | 设计决策 | 决定 AfterTool Hook 接口；决定 provider messageAdapter 能力边界 |
| A3 | 消除 cli.ts/start.ts 重复 | 设计决策 | 决定入口文件结构（cli.ts 作为唯一正式入口，start.ts 作为开发 wrapper） |
| A4 | 设计 AgentRuntime 生命周期 | 架构设计 | `dispose()`/`close()` 接口设计，资源清理规范 |
| A5 | 合并门禁执行 | 流程 | 审查emma的所有分支，确保过门禁；维护 CLAUDE.md 与 specs 一致性 |

### emma — 实现与重构

核心职责：代码落地、测试覆盖、干净提交。

| ID | 任务 | 类型 | 优先级 |
|----|------|------|--------|
| B1 | 移除/守卫 debug 日志 | 代码清理 | 🔴 高 |
| B2 | installPlugin 改为 async + fail-fast | Bug 修复 | 🔴 高 |
| B3 | 硬编码值 → 配置注入 | 重构 | 🔴 高 |
| B4 | 替换 YAML 解析器（js-yaml） | 基础设施 | 🟡 中 |
| B5 | 合并 ToolCall 类型定义 | 类型整理 | 🟡 中 |
| B6 | new Function() → 安全方案 | 安全修复 | 🟡 中 |
| B7 | 执行 A1-A4 的设计方案 | 实现 | 🟡 中（等设计方案就绪） |
| B8 | 补充 config / TUI / plugin 包测试 | 测试覆盖 | 🟢 可延后 |

---

## 执行顺序建议

```
第一轮（本周，独立并行）：

  egg-rolls A1              emma B1 + B2 + B3
  （出设计文档）        （3 个小修复，可独立推送）


第二轮：

  egg-rolls A2 + A4          emma B4 + B5 + B6
  （出设计文档）        （3 个中等修复）


第三轮：

  egg-rolls Review A1-A4    emma B7
  （审查设计方案）      （执行所有设计方案，建真正的统一工具路径）


第四轮：

  emma B8
  （补测试，可穿插在前三轮的空隙中）
```

---

## 轻量敏捷约定

1. **任务看板**就是这份文档——打勾即完成，划线即废弃
2. **沟通**通过即时通讯通知 + Commit message，不额外开会
3. **AI Agent 职责**：执行编码、跑检查清单、生成测试用例；不替代人类做架构决策
4. **文档更新随代码**：改行为 → 改 spec；改接口 → 改 SPEC.md；改决策 → 写 ADR
5. **每周同步一次**：看看文档上的进度，调整分工
