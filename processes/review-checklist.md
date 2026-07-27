# 审查清单

> 每次 Code Review 执行本清单。AI Agent 负责自动化检查部分，人类 Reviewer 负责设计和架构判断。

## 自动化检查（AI Agent 执行）

```
[ ] bun run lint         通过？____
[ ] bun run typecheck    通过？____
[ ] bun test             通过？____
[ ] bun run build        通过？____
[ ] 无硬编码密钥/Token    grep 检查通过？____
```

## 架构检查（AI Agent 对照 specs 执行）

```
[ ] 依赖方向：core 未引用 tui/config/plugins
[ ] 能力分层：新代码按 CLAUDE.md §5 决策树正确分类
[ ] 红线检查：未触碰 CLAUDE.md §6 任一条
[ ] 扩展机制：未新增第二套扩展路径（ADR-004）
[ ] 事件类型：未用散落字符串替代 EventType 枚举（ADR-008）
[ ] sync-in-async：异步路径中无同步阻塞调用
[ ] 半成品：无 NotImplementedError / 空实现进 core
[ ] 文档诚实：未声称未实现功能（反幻觉纪律）
[ ] 新能力进 core 则必有 ADR（ADR-012）
```

## 代码质量检查（AI Agent + 人类）

```
[ ] 命名清晰，遵循包内风格
[ ] 错误处理恰当，无吞错误
[ ] 复杂度合理（单函数不超过 ~60 行）
[ ] 无硬编码值（魔法数字进配置）
[ ] 无调试 console.log 残留
[ ] 测试覆盖新增/修改路径
[ ] 公开 API 变更同步更新 docs/api/
```

## 人类 Reviewer 判断

```
[ ] 设计意图：改动是否合理解决原问题
[ ] 副作用：是否影响其他模块
[ ] 可维护性：未来改动是否容易
[ ] 文档更新：docs/ 和 CLAUDE.md 是否同步
```

## 审查结论

```
[ ] APPROVE  — 通过，可合并
[ ] COMMENT  — 小问题，可合并后修（仅限文档/注释）
[ ] CHANGES  — 有严重问题，必须修后重新审查
```

阻断级问题（必须 CHANGES）：
- CI 任一项不通过
- 架构检查任一项不通过
- 发现硬编码密钥
- 破坏已有功能的回归未处理
