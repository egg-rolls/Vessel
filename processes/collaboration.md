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
# 通知Reviewer合并                                    # 3. 通知
```

## 三、Reviewer的审查（对照 CLAUDE.md §9）

```
[ ] 自查通过了吗？lint + typecheck + test 全绿？
[ ] 依赖方向正确？core 没引用 tui/config？
[ ] 没有硬编码 Key / console.log / NotImplementedError？
[ ] 没有违反 CLAUDE.md §6 红线？
[ ] 文档同步更新了没？
→ 通过 → git merge fix/xxx → git push → git branch -d fix/xxx → git push origin --delete fix/xxx
→ 不通过 → 标注原因 → Coder修复后重推
```

## 四、禁止

- 直接推 main
- 合并后修复（先修再合）
- Force push main
- 一个分支塞不相关的改动

## 五、创建 Issue 和 PR 的技巧

### 1. 创建 Issue

```bash
# ✅ 使用 --body-file + 绝对路径 + .txt 文件
gh issue create --title "feat(tui): 新功能" --label "enhancement" --body-file "D:/Application/APP/Vessel/issue-body.txt"
```

### 2. 创建 PR

**问题**：中文内容和特殊字符会导致 shell 解析出错。

**解决方案**：分两步创建。

```bash
# 步骤1：先用英文创建 PR（简单 body）
gh pr create --title "feat(tui): new feature" --body "Closes #13" --base main --head feat/my-feature

# 步骤2：再用 gh pr edit 更新中文内容
gh pr edit 13 --body "$(cat D:/Application/APP/Vessel/pr-body.txt)"
```

### 3. 技巧总结

| 技巧 | 说明 |
|------|------|
| 使用绝对路径 | `"D:/Application/APP/Vessel/pr-body.txt"` 而不是 `pr-body.txt` |
| 使用 `.txt` 文件 | `.md` 文件可能有特殊字符 |
| 分两步创建 | 先英文创建，再 `gh pr edit` 更新中文内容 |
| 使用 `$(cat file)` | `--body "$(cat file.txt)"` 比 `--body-file` 更稳定 |

### 4. 示例

```bash
# 创建 Issue
echo "功能描述..." > issue-body.txt
gh issue create --title "feat(tui): 新功能" --label "enhancement" --body-file "D:/Application/APP/Vessel/issue-body.txt"

# 创建 PR
echo "PR 描述..." > pr-body.txt
gh pr create --title "feat(tui): new feature" --body "Closes #13" --base main --head feat/my-feature
gh pr edit 13 --body "$(cat D:/Application/APP/Vessel/pr-body.txt)"
```
