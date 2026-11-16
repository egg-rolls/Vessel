# 参与者与提交身份

## 参与者

| 身份 | 账户 | 角色 |
| --- | --- | --- |
| **Egg-rolls** | [@egg-rolls](https://github.com/egg-rolls) | 项目所有者（owner）。做出产品与设计决定、评审、推送，并承担全部责任。 |
| **Vessel Agent** | [@Vessel-agent](https://github.com/Vessel-agent) | 由 owner 运营的机器账户。在 owner 指派下产出代码、文档与实测。**不持有本仓任何凭据**：所有推送均由 owner 执行。 |

除以上两者外，提交还可能来自被 owner 临时指派的子代理（同为 `Vessel Agent` 署名），
以及第三方机器人账户（例如 `dependabot[bot]`）。

## 提交身份约定

- **author** = `Vessel Agent <357356674+Vessel-agent@users.noreply.github.com>`
  —— 真正产出该提交的一方。AI 参与的提交因此可以用 `git log --author` 单独筛出来。
- **committer** = owner —— 因为推送由 owner 执行。
- 每条提交带 `Co-authored-by: Egg-rolls <174765587+egg-rolls@users.noreply.github.com>`
  —— owner 参与了决定、评审与验收。

这样 GitHub 的 Contributors 会把两者都计入默认分支的贡献，同时让「谁产出了什么」在
`git log` 里保持可审计。

## 责任与许可

- 本仓库内容由 owner 负责；AI 参与不等于免责。
- 提交信息里写清**实测读数**与**未验证的部分**；未验证的结论不会写成已验证。
- 若将来开源，请在任何对外声明中保留本文件。
