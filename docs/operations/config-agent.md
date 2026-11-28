---
title: agent 块配置项
kind: current
triggers: [agent, 成员, agent.enabled, owner_id, default_visibility, permission_mode, read_only_tools, follow_replies, temporary_ttl, inbox_max_messages, team_member_limit, agent.cwd, 成员配置]
paths: [packages/config/src/types.ts, packages/config/src/validator.ts, src/cli/commands/agent/agent-command.ts, src/cli/commands/agent/agent-inbox-command.ts]
---

# agent 块配置项

> `agent.*` 配置键运维手册。成员机制（Body / rotate / presence / 收件箱语义）家见
> [member-team.md](../architecture/member-team.md)；工具面与装配见 [assembly.md](../architecture/assembly.md)。

```yaml
agent:
  enabled: true                 # 默认 true；显式 false 关闭（交互与 headless 一致）
  owner_id: main                # root owner 成员 id
  default_visibility: private   # private | team | tenant
  follow_replies: false         # 只作为配置/事件字段，不自动续跑父 turn
  permission_mode: bridge       # bridge | allow | deny；缺省交互 bridge、headless allow
  read_only_tools: [read, media, subscribe]   # deny 模式保留的工具（缺省同此）
  model: gpt-4                  # 可选：成员默认模型
  temporary_ttl_hours: 2        # temporary 空闲回收 TTL；0 = 关闭
  inbox_max_messages: 200       # 成员收件箱上限；按最旧裁剪
  team_member_limit: 100        # Team present 成员上限（正整数 ≥1）
  # cwd / limits / termination 见下
```

- **`agent.enabled`**：唯一开关。启用后注册内置 `agent` 工具、启动 AgentService / TeamService，
  并尝试启动 loopback owner 端点。工具面组成不写死数量，实际清单以 `bun run src/cli.ts --tools`
  输出为准（不连 MCP、不展开 ask/inbox）。
- **`agent.default_visibility`**：`create` / `hire` 未显式传 visibility 时的缺省。绑定 Team 且未显式
  指定时缺省 `team`，unbound 保持 `private`；peer 强制 `team`；`private` 仅 owner 可寻址、不写 Team
  日志；单公司下 `team` / `tenant` 等价。
- **`agent.permission_mode`**：`bridge` 把成员权限/ask 弹到父窗口（无父事件流时退化 deny，不死等）；
  `allow` 对成员复制到的工具一律放行；`deny` 只保留 `read_only_tools`（运行时缺省
  `['read','media','subscribe']`，`packages/agent/src/runtime.ts:DEFAULT_READ_ONLY_TOOLS`）。
  有非空 `team_id` 的成员强制 bridge（忽略全局 allow），deny 保持只读不放宽。
- **`agent.model` / `agent.limits` / `agent.termination`**：成员默认模型与限额；limits/termination
  缺省继承顶层，不放大。
- **`agent.cwd`**：全局默认工作目录（支持 `~`，相对路径按进程 cwd 解析）。工具完整优先级：
  参数 `cwd` > `agent.cwd` > 成员 cwd（显式选中 Team 的基础路径）> `process.cwd()`。
  只提供默认目录，不放宽内置 denylist 或 `allowed_roots`；目录不存在时工具调用返回明确错误，
  不静默回退。`vessel config set agent.cwd <path>`（空值拒绝）。
- **`agent.temporary_ttl_hours`**（默认 2，0 = 关）：只回收在册 `role: temporary`；`member`（含 main）
  永不回收；有在跑轮/排队消息/权限等待时跳过。回收复用 `membership='left'` + `state='closed'`，
  可经 `reinstate` 原地复活。
- **`agent.inbox_max_messages`**（默认 200，正整数）：每成员持久化收件箱条数上限，超出按最旧裁剪；
  只影响成员收件箱，不影响会话历史。
- **`agent.team_member_limit`**（默认 100，正整数 ≥1）：Team 内 present 成员上限（peer + contractor
  都计入，口径 `membership === 'present'`）；装配期注入，**修改后重启生效**；
  可 `config set agent.teamMemberLimit`。
- **删除的键**：`team.*` / `delegate.*` 旧配置块不再接受（Team 声明见 [config-team](config-team.md)）。

## owner 端点与 CLI

- owner 端点只由交互 REPL / serve 监听 `127.0.0.1:0`，记录写 `<data_dir>/agent-owner.json`
  （0600，含 pid/host/port/token/started_at 与内部持久 id）；只接受 loopback + Bearer。
  headless 不监听不写记录，但 AgentService / TeamService 进程内仍可用。
- `vessel agent create|send|dispatch|close|list|inbox [--json]` 经该记录 attach（没有 owner 时
  `agent_owner_unavailable`）；命令只做参数映射，生命周期全在 owner。`send` 支持
  `--interrupt | --message-id <id>`；`inbox` 只读。成员 rotate 用 `agent` 工具（模型侧）或
  `sessions.create` / `sessions.restart`（人侧）；CLI `vessel agent rotate` 已删除。