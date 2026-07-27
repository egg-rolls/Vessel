# 标准开发流程

> 从拿到任务到代码合并的完整生命周期。
> 本流程适用于所有贡献者（人类 + AI Agent）。

## 一、任务生命周期

```
Backlog → 分派 → 开发 → 自查 → PR → Review → 合并 → 归档
```

### 1. 任务来源

- [ROADMAP.md](../docs/specs/ROADMAP.md) — 路线图任务
- [phase-1-review.md](../docs/dev/phase-1-review.md) — 代码审查发现的问题
- Issue — Bug 报告或功能请求

### 2. 分派

- 见 [task-assignment.md](task-assignment.md)
- 一人一个关注点，不交叉

### 3. 开发

```
git checkout main
git pull
git checkout -b <type>/<slug>   # 见分支命名
# 编码 + 测试
git add -A && git commit -m "<type>(<scope>): <subject>"
git push -u origin <branch>
```

### 4. 自查（提 PR 前必须）

```bash
bun run lint          # 必须通过
bun run typecheck     # 必须通过
bun test              # 必须通过
bun run build         # 必须通过
```

### 5. 提 PR

- 填写 PR 模板检查清单全部项
- 关联相关 Issue/文档
- 指定 Reviewer

### 6. Review → 合并

- Reviewer 执行 [review-checklist.md](review-checklist.md)
- CI 四灯全绿 + Reviewer approve → Merge
- 合并后删除远程分支

## 二、分支命名

```
feat/<slug>      # 新功能（feature）
fix/<slug>       # 修复（bug fix）
docs/<slug>      # 纯文档变更
refactor/<slug>  # 重构
test/<slug>      # 测试补充
chore/<slug>     # 杂务（CI、依赖升级等）
```

`<slug>` 用短横线小写英文，如 `fix/merge-tool-paths`。

## 三、Commit 格式

```
<type>(<scope>): <subject>

scope: core | config | tui | plugins | docs | ci
subject: ≤ 72 字符，中文或英文
```

示例：
```
feat(core): AgentRuntime 支持 tool-calling loop
fix(config): loadConfig 空文件不抛异常
refactor(plugins): 统一工具注册路径为 PluginHost
```

## 四、Review 规则

- 李瑞 → 审查架构合规和红线
- 贾斯涵 → 审查实现正确性
- AI Agent → 执行 [review-checklist.md](review-checklist.md) 自动化检查
- 优先当天 Review，不超过 24h

## 五、不允做的事

| 禁止 | 理由 |
|------|------|
| 直接推 main | 必须走 PR + Review + CI |
| 合并后修复 | 先修再合（[GIT-WORKFLOW.md](../docs/specs/GIT-WORKFLOW.md)） |
| 跳过 CI | 红灯不合并 |
| Force push main | 永远禁止 |
| 一个 PR 改多个不相关的东西 | 难审查、难 revert |
