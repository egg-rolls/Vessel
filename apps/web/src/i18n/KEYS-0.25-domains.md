# 0.25 Web domains — i18n keys to merge

This file is documentation only. The `0.25-web-domains` branch owns the
Nodes / Teams / Agents domains, but **does not edit the catalogs**
(`messages/zh-CN.ts`, `messages/en.ts` are owned by `0.25-web-shell`).
The merging agent should add the keys below to both catalogs.

Reused existing keys (no action needed): `hub.add.*`, `hub.remove.*`,
`hub.nodes.heartbeat`, `settings.multinode.*`, `team.form.*`, `agents.*`
(existing), `common.*`, `nodes.*` (existing), `teams.*` (existing).

## Nodes

| Key | en | zh-CN |
|---|---|---|
| `nodes.search` | Search nodes | 搜索节点 |
| `nodes.add.commands` | Pair or join | 配对 / 加入 |
| `nodes.add.connect` | Connect from this browser | 从浏览器连接 |
| `nodes.emptyFiltered` | No node matches "{query}" | 没有匹配 "{query}" 的节点 |
| `nodes.lastHeartbeat` | Last heartbeat | 最近心跳 |
| `nodes.advanced` | Advanced details | 高级信息 |
| `nodes.viewTeams` | View teams | 查看 Teams |
| `nodes.viewAgents` | View agents | 查看 Agents |

## Teams

| Key | en | zh-CN |
|---|---|---|
| `teams.form.policy` | Policy (JSON) | Policy（JSON） |
| `teams.form.policyHint` | Optional JSON object; replaces the whole policy. | 可选 JSON 对象；整体替换现有 policy。 |
| `teams.form.policyInvalid` | Policy must be a JSON object. | Policy 必须是 JSON 对象。 |
| `teams.edit.back` | Back to Team | 返回 Team |

## Agents

| Key | en | zh-CN |
|---|---|---|
| `agents.search` | Search agents | 搜索 Agents |
| `agents.create` | Create agent | 创建 Agent |
| `agents.create.title` | Create agent | 创建 Agent |
| `agents.edit.title` | Edit agent | 编辑 Agent |
| `agents.back` | Back to Agents | 返回 Agents |
| `agents.form.model` | Model | 模型 |
| `agents.form.modelHint` | Applies from the next Body; leave blank to keep unchanged. | 从下一个 Body 生效；留空表示不修改。 |
| `agents.form.systemPrompt` | System prompt | System prompt |
| `agents.form.systemPromptHint` | Applies from the next Body; leave blank to keep unchanged. | 从下一个 Body 生效；留空表示不修改。 |
| `agents.form.unbound` | Unbound | 不绑定 Team |
| `agents.form.noChange` | Change at least one field. | 请至少修改一个字段。 |
| `agents.form.created` | Created agent {name} | 已创建 Agent {name} |
| `agents.form.updated` | Updated agent {name} | 已更新 Agent {name} |
| `agents.form.createFailed` | Create failed | 创建失败 |
| `agents.form.updateFailed` | Update failed | 更新失败 |
| `agents.detail.title` | Agent | Agent |
| `agents.detail.advanced` | Advanced details | 高级信息 |
| `agents.detail.agentId` | Agent id | Agent id |
| `agents.detail.membership` | Membership | 成员状态 |
| `agents.detail.visibility` | Visibility | 可见性 |
| `agents.detail.session` | Session | 会话 |
| `agents.close` | Close agent | 关闭 Agent |
| `agents.close.title` | Close agent? | 关闭 Agent？ |
| `agents.close.body` | The agent is archived. Its history and Team logs are kept; this cannot be undone from the Web. | Agent 将被归档；历史与 Team 日志保留，Web 端无法撤销。 |
| `agents.close.success` | Closed agent {name} | 已关闭 Agent {name} |
| `agents.close.failed` | Close failed | 关闭失败 |
| `agents.error.forbidden` | This token cannot create / update / close agents. | 当前 token 无权创建 / 更新 / 关闭 Agent。 |
| `agents.error.notFound` | Agent not found | Agent 不存在 |
| `agents.error.nodeMissing` | The node in this link is not in the page's node list | 链接中的节点不在本页节点列表中 |
