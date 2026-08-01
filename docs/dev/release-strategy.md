# 发布策略

> 状态：2026-07-31 启用。决策记录，不设过期。

## 决策：Trunk-based + Tag 发布（模式 B）

**不自动发布每次 main commit**。发布由人打 tag 触发。

### 为什么？

| 问题 | 如果每次 commit 都发布 | 如果 tag 触发 |
|------|------------------------|--------------|
| 版本号 | 0.1.0 → 0.1.1 → … → 0.1.327，无意义 | 人决定何时发 0.1.0、0.2.0 |
| 频率 | 一个 PR 一个版本，npm 上全是版本 | 攒几个 PR 一起发 |
| 回滚 | 半成品已发布，回滚困难 | tag 就是 checkpoint，回退只需切 tag |
| 内部测试 | main commit ≠ 可发布版本 | tag = 经过内部验证的稳定点 |

### 发布流程

```
开发 → PR → main → CI 测试 → 内部验证 → git tag v0.1.0 → CI 构建 + 发布
         ↑                ↑                   ↑
    分支保护 + 审查    自动冒烟测试        人决定时机
```

### 操作手册

```bash
# 1. 日常开发（不改 main，不走发布）
git checkout -b feat/xxx main
# 编码 → PR → 审查 → 合并

# 2. 准备发布（人在本地执行）
git checkout main
git pull origin main
git tag v1.0.0              # 打版本标签
git push origin v1.0.0       # 推送 tag → 触发 Release workflow

# 3. CI 自动执行
# → 质量检查（lint + typecheck + test）
# → 构建二进制（bun build --compile）
# → 创建 GitHub Release（附二进制文件）
```

### 版本号规范（语义化版本）

| 变更类型 | 版本 | 示例 |
|---------|------|------|
| 不兼容的 API 变更 | MAJOR | v1.0.0 → v2.0.0 |
| 向后兼容的新功能 | MINOR | v0.1.0 → v0.2.0 |
| 向后兼容的 bug 修复 | PATCH | v0.1.0 → v0.1.1 |
| pre-MVP | 0.x.y | v0.1.0、v0.2.0 |

### CI 管道

| 阶段 | 触发条件 | 做什么 |
|------|---------|--------|
| PR CI | PR → main | lint + typecheck + test + build |
| Main CI | merge → main | 上面 + 冒烟测试（headless mock） |
| Release CI | git tag v* | 上面 + 构建二进制 + GitHub Release |

### 参考

- [Trunk Based Development](https://trunkbaseddevelopment.com/)
- [Semantic Versioning](https://semver.org/)
