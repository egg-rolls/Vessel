# 协作契约

> main 分支已启用保护：**所有改动必须通过 PR + 审批才能合并**。禁止直接 push main。

## 一、任务认领（开始工作前必做）

看到想做的 Issue，**先留言宣告，再建分支开 Draft PR**——防止多人同时改同一 Issue。

```bash
# 步骤 1：在 Issue 下留言占坑（立即做，防止撞车）
gh issue comment <issue-number> --body "我来处理这个，预计今天完成。"

# 步骤 2：创建分支开始工作
git checkout -b <type>/<slug> main
# 编码...

# 步骤 3：有代码可看时创建 Draft PR（标记进度，自动关联 Issue）
gh pr create --title "<type>(<scope>): <描述> #<issue-number>" --draft --body "WIP，请勿合并"

# 步骤 4：完成后标记 Ready for review
gh pr ready <pr-number>
```

| 方式 | 作用 | 时机 |
|------|------|------|
| **Issue 留言** | "宣告主权"——别人搜 Issue 就能看到谁在处理 | 开始工作前，立即留言 |
| **Draft PR** | "展示进度"——代码可见，自动关联 Issue，但不触发合并 | 有代码可看时创建 |

## 二、分支与提交

```
命名规范见 [conventions.md](conventions.md)
```

## 三、开发到合并（每次必经）

```
git checkout -b <type>/<slug> main
# 编码...
bun run lint && bun run typecheck && bun test    # 1. 自查
git push -u origin <type>/<slug>                  # 2. 推送
gh pr create ...                                   # 3. 创建 PR
# 请求 Reviewer 审查                                # 4. 通知审查
```

## 四、PR 合并流程（main 分支保护已开启）

```
1. Coder 创建 PR（Draft → Ready for review）
        ↓
2. Reviewer 审查（对照 CLAUDE.md §9）
        ↓
3. 审查通过 → Reviewer 在 GitHub 上点击 "Merge pull request"
        ↓
4. 合并方式：选择 "Squash and merge" 或 "Rebase and merge"
   （不选 "Create a merge commit"——保持 history 线性）
        ↓
5. 合并后自动删除远程分支（GitHub 设置中启用）
        ↓
6. Coder 本地清理：git checkout main && git pull && git branch -d <分支名>
```

**合并必须满足（GitHub 自动检查）：**
- ✅ 至少 1 人审批通过
- ✅ CI 全绿（lint + typecheck + test + build）
- ✅ 无未解决的合并冲突
- ✅ 所有对话已解决

## 五、Reviewer 的审查（对照 CLAUDE.md §9）

```
[ ] 自查通过了吗？lint + typecheck + test 全绿？
[ ] 依赖方向正确？core 没引用 tui/config？
[ ] 没有硬编码 Key / console.log / NotImplementedError？
[ ] 没有违反 CLAUDE.md §6 红线？
[ ] 文档同步更新了没？
→ 通过 → GitHub 上点 "Merge pull request"
→ 不通过 → 标注原因 → Coder 修复后重推
```

## 六、禁止

- 直接 push main（已由分支保护强制阻止）
- 合并后修复（先修再合）
- Force push main
- 一个分支塞不相关的改动
- 不留言直接抢 Issue（先看 Issue 有没有人认领）

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
