# 协作契约

## 一、分支与提交

```
命名规范见 [conventions.md](conventions.md)
```

## 二、开发到合并（每次必经）

```
git checkout -b fix/xxx main
# 编码...
bun run lint && bun run typecheck && bun test    # 1. 自查
git push -u origin fix/xxx                        # 2. 推送
gh pr create --base main --head fix/xxx           # 3. 创建 PR（CODEOWNERS 自动请求 egg-rolls 审查）
```

> 人类贡献者可直接通过 GitHub Web UI + PR 模板创建 PR。

## 三、Reviewer 的审查（对照 CLAUDE.md §9）

在 GitHub PR 页面进行，检查清单：

```
[ ] CI 全绿？lint + typecheck + test + build？
[ ] 依赖方向正确？core 没引用 tui/config？
[ ] 没有硬编码 Key / console.log / NotImplementedError？
[ ] 没有违反 CLAUDE.md §6 红线？
[ ] 文档同步更新了没？
→ 通过 → GitHub PR 页面点击 "Squash and merge"（勾选 "Delete branch"）
→ 不通过 → 在 PR 中标注原因 → Coder 修复后重新请求审查
```

## 四、禁止

- 直接推 main
- 合并后修复（先修再合）
- Force push main
- 一个分支塞不相关的改动

## 五、AI Agent 通过 CLI 创建 Issue 和 PR

> AI Agent 无法使用 GitHub Web UI，必须通过 `gh` CLI 操作。
> 人类贡献者建议直接使用 GitHub Web UI + Issue/PR 模板。
> 以下为实践中验证过的 CLI 操作方式。

### 1. 创建 Issue

```bash
# ✅ 使用 --body-file + 绝对路径（避免 shell 解析中文/特殊字符）
gh issue create --title "feat(tui): 新功能" --label "enhancement" --body-file "D:/Application/APP/Vessel/issue-body.txt"
```

### 2. 创建 PR

**问题**：`gh pr create --body` 中的中文和 Markdown 特殊字符会导致 shell 解析出错。

**解决方案**：分两步创建。

```bash
# 步骤1：先用英文创建 PR（简单 body）
gh pr create --title "feat(tui): new feature" --body "Closes #13" --base main --head feat/my-feature

# 步骤2：再用 gh pr edit 更新中文内容（gh pr edit 不支持 --body-file，用 $(cat) 替代）
gh pr edit --body "$(cat D:/Application/APP/Vessel/pr-body.txt)"
```

### 3. 技巧总结

| 技巧 | 说明 |
|------|------|
| 使用绝对路径 | `"D:/Application/APP/Vessel/pr-body.txt"` 而不是 `pr-body.txt` |
| 分两步创建 PR | 先英文创建，再 `gh pr edit` 更新中文内容 |
| 使用 `$(cat file)` | `--body "$(cat file.txt)"` 适用于 `gh pr edit`（不支持 `--body-file`） |
| 人类用 Web UI | GitHub Issue/PR 模板已配置，Web UI 对中文和 Markdown 无兼容问题 |

### 4. 示例

```bash
# 创建 Issue
echo "功能描述..." > issue-body.txt
gh issue create --title "feat(tui): 新功能" --label "enhancement" --body-file "D:/Application/APP/Vessel/issue-body.txt"

# 创建 PR
echo "PR 描述..." > pr-body.txt
gh pr create --title "feat(tui): new feature" --body "Closes #13" --base main --head feat/my-feature
gh pr edit --body "$(cat D:/Application/APP/Vessel/pr-body.txt)"
```
