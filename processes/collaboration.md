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
gh pr create --base main --head <type>/<slug>     # 3. 创建 PR（CODEOWNERS 自动请求 Reviewer）
gh pr view --head <type>/<slug>                   # 4. 确认 PR 已创建成功（防止推送后忘记 PR）
```

> 人类贡献者可直接通过 GitHub Web UI + PR 模板创建 PR。

⚠️ **AI Agent 注意**：推送分支后如果跳过第 3-4 步，分支会滞留——有代码、有分支、但没有 PR。未经 PR 的分支不会被审查、不会被合并。开始新工作前，用 `gh pr list --state open` 确认没有遗留的孤儿分支。

## 四、PR 合并流程（main 分支保护已开启）

```
1. Coder 创建 PR（Draft → Ready for review）
        ↓
2. Reviewer 审查（对照 docs/guides/REVIEWER.md）
        ↓
3. 审查通过 → Reviewer 在 GitHub 上点击 "Squash and merge"
        ↓
4. 合并时勾选 "Delete branch" 自动删除远程分支
        ↓
5. Coder 本地清理：git checkout main && git pull --ff-only && git branch -d <分支名>
```

**合并必须满足（GitHub 自动检查）：**
- ✅ 至少 1 人审批通过
- ✅ CI 全绿（lint + typecheck + test + build）
- ✅ 无未解决的合并冲突
- ✅ 所有对话已解决

## 五、Reviewer 的审查（对照 docs/guides/REVIEWER.md）

在 GitHub PR 页面进行，检查清单：

```
[ ] CI 全绿？lint + typecheck + test + build？
[ ] 依赖方向正确？core 没引用 tui/config？
[ ] 没有硬编码 Key / console.log / NotImplementedError？
[ ] 没有违反 AGENTS.md §4 红线？
[ ] 文档同步更新了没？
→ 通过 → GitHub 上点击 "Squash and merge"
→ 不通过 → 在 PR 中标注原因 → Coder 修复后重新请求审查
```

## 六、禁止

- 直接 push main（已由分支保护强制阻止）
- 合并后修复（先修再合）
- Force push main
- 一个分支塞不相关的改动
- 不留言直接抢 Issue（先看 Issue 有没有人认领）

## 七、AI Agent 通过 CLI 创建 Issue 和 PR

> AI Agent 无法使用 GitHub Web UI，必须通过 `gh` CLI 操作。
> 人类贡献者建议直接使用 GitHub Web UI + Issue/PR 模板。
> 以下为实践中验证过的 CLI 操作方式。

### 核心原则

**中文内容不要放进 `--title` 和 `--body` 命令行参数**——shell 解析中文/特殊字符会出错（exit 127）。
始终用 `--body-file` 传正文，用变量传中文标题。

### 1. 创建 Issue

```bash
# 步骤1：英文标题创建
gh issue create --title "docs(cross): short English title" --label "P1" --label "documentation" --body "Placeholder"

# 步骤2：用 --body-file 更新中文正文（可靠）
gh issue edit <number> --body-file issue-body.txt

# 步骤3：用变量更新中文标题
TITLE=$(cat issue-title.txt) && gh issue edit <number> --title "$TITLE"
```

### 2. 创建 PR

```bash
# 步骤1：先用英文创建 PR
gh pr create --title "docs(guides): short English title" --body "Closes #<number>" --base main --head <branch>

# 步骤2：用 --body-file 更新中文正文（gh pr edit 支持 --body-file）
gh pr edit <number> --body-file pr-body.txt

# 步骤3：用变量更新中文标题
TITLE=$(cat pr-title.txt) && gh pr edit <number> --title "$TITLE"
```

### 3. 技巧总结

| 技巧 | 说明 |
|------|------|
| 分步创建 | Issue/PR 一律先英文创建，再更新中文内容 |
| `--body-file` 最可靠 | `gh issue create`、`gh issue edit`、`gh pr edit` 都支持 `--body-file`，用文件传中文正文最稳定 |
| 变量传标题 | `TITLE=$(cat file) && gh ... --title "$TITLE"` 处理中文标题 |
| 人类用 Web UI | GitHub Issue/PR 模板已配置，Web UI 对中文和 Markdown 无兼容问题 |

### 4. 实际验证过的命令（本 PR #50 创建过程）

```bash
# 创建 Issue #49
echo "功能描述..." > issue-body.txt
gh issue create --title "docs(cross): missing role entry points - AI agents skip required reading" --label "P1" --label "documentation" --body "Placeholder"
gh issue edit 49 --body-file issue-body.txt
TITLE=$(cat issue-title.txt) && gh issue edit 49 --title "$TITLE"

# 创建 PR #50
echo "PR 描述..." > pr-body.txt
gh pr create --title "docs(guides): add role entry points - DEVELOPER, REVIEWER, DOC-MANAGER" --body "Closes #49" --base main --head docs/role-entry-points
gh pr edit 50 --body-file pr-body.txt
TITLE=$(cat pr-title.txt) && gh pr edit 50 --title "$TITLE"
```
