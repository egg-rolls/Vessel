# 发布流程

> `[plan]` pre-MVP 阶段暂不启用。MVP 后执行本流程。

## 版本号规则

`x.y.z` = MAJOR.MINOR.PATCH

- MAJOR：不兼容的 API 变更
- MINOR：向后兼容的新功能
- PATCH：向后兼容的 Bug 修复

pre-1.0 阶段：`0.x.y`，MINOR = 不兼容变更。

## 发布步骤

### 1. 准备

```bash
# 确认 main 最新
git checkout main && git pull

# 确认 CI 全绿
# 确认 CHANGELOG.md 已更新

# 更新版本号（package.json）
# 打 tag
git tag -a v0.1.0 -m "v0.1.0 - Phase 1 原型"
git push origin v0.1.0
```

### 2. 构建

```bash
bun run build
bun run build:binary    # 出单二进制
```

### 3. GitHub Release

- 在 GitHub Releases 页面创建新 Release
- 选择对应 tag
- 附上 CHANGELOG 条目的 Release Notes
- 上传 `dist/vessel` 二进制

### 4. npm（以后考虑）

```bash
# 仅发布 @vessel/core
cd packages/core && npm publish
```

## 回滚

如果发现严重问题：

```bash
# 不删除 tag（已发布的不撤回）
# 在新 commit 上 hotfix，打新 tag
git checkout -b hotfix/xxx main
# 修复 → PR → merge
git tag -a v0.1.1 -m "v0.1.1 - hotfix"
```
