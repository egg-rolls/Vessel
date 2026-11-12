# Workflows

只有两个：

| 文件 | 触发 | 作用 |
|---|---|---|
|  | push tag  | 发布（npm 包 + GitHub Release）。发布前会跑一遍 。 |
|  | PR opened/edited/reopened | 把关联 Issue 的 labels 复制到 PR。 |

## CI 已移除（2026-11）

 被删除，原因见 [docs/operations/CI-CD.md](../../docs/operations/CI-CD.md) §1：

- 本项目是「agent 直接提交」的开发范式，CI 按 PR / 推送触发、每次失败都发邮件，
  而失败项几乎从不影响功能或产物 —— 噪声远大于收益；
- 真正把关的是**本地门禁** ；
- 发布链路不依赖 CI： 在 tag 时自己跑 。

 **保留**（ 在用），不要因为 ci.yml 删了就顺手删它。

恢复办法： 取回旧文件，但请先算清噪声与收益。
