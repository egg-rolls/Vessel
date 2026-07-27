# docs/dev/ — 开发产物

> 这里是所有临时性、时间性文档的家。与 `docs/specs/` 不同，**这里可以自由使用时间、状态、进度描述**。

## 目录

```
docs/dev/
├── README.md              ← 你正在看的文件
├── reviews/               # 审查报告
│   └── <phase>-review.md  #   命名：阶段-审查.md
├── debug-notes/           # 调试/故障记录
│   └── <主题>.md          #   命名：自由，描述性即可
```

## 写什么

| 子目录 | 内容 | 例子 |
|--------|------|------|
| `reviews/` | 代码审查报告、架构审计、质量评估 | `phase-1-review.md` |
| `debug-notes/` | Bug 修复记录、踩坑笔记、故障复盘 | `bug-fix-experience.md` |

新增文件时直接放入对应子目录，不需要审批和模板。

## 规则

- 命名自由，git 历史已记录时间和作者
- 内容无限制——可以有日期、进度、TODO、临时结论
- 可以引用 `docs/specs/`、`docs/guides/`、`docs/api/`
- 反过来不行：永久文档不能引用本目录
- 不再需要时删除（或移入 `archive/`）
