---
title: teams 块与 Team policy
kind: current
triggers: [teams, team policy, workspace, budget, max_hops, max_turns, cycle, cooldown, deny-after, unattended, allow_auto_create, team.json, 默认 Team, team create, team freeze, spawnFrozen]
paths: [packages/config/src/team-policy.ts, packages/config/src/validator.ts]
---

# teams 块与 Team policy

> Team 声明 / policy 校验 / 预算配置运维手册。Team 机制（roster / 日志 / 寻址 / CRUD 语义）家见
> [member-team.md](../architecture/member-team.md)；RPC 清单以 [gateway-rpc.md](../architecture/gateway-rpc.md) 为准。

## 声明与校验

```yaml
teams:
  - name: alpha                  # 可选；缺省由装配层决定
    workspace: ~/work/alpha      # 必填；归一化后精确匹配
    policy:
      allow_auto_create: false   # dispatch resume 失败后允许自动创建；默认 false
      permission:
        unattended: deny-after   # hold（默认）| deny-after
        deny_after_seconds: 300  # deny-after 时必填，1..86400
      budget:
        max_hops: 20             # >= 1；缺省不限
        max_turns: 40
        max_tokens: 200000
        max_wall_clock_seconds: 3600
        warning_threshold: 0.8   # 0 < x < 1；缺省 0.8
        cycle:
          max_repeats: 2         # 每 cooldown 窗口同一有向边重复上限；缺省 2
          cooldown_seconds: 60   # 滑动窗口秒数（也是越界重试间隔）；>= 1；缺省 60
```

- `teams` 是顶层块；密钥字段禁止。必须是数组、每项对象、`workspace` 非空；归一化（展开 `~`、
  `path.resolve`，Windows 忽略大小写）后重复声明 → validation error。
- **拼写**：规范 camelCase（config 对象 / 手改 `team.json` / 运行时）；YAML 可写 snake_case，
  loader 递归转换。**手改 `team.json` 写 snake_case 不会被转换**（`allow_auto_create` 别名例外被接受）。
- **严格校验**（`team-policy.ts`）：`policy.permission` / `policy.budget` 内部白名单；
  `allow_after` 报错（`allow-after is not supported; use hold or deny-after`）、`max_cost` 报错
  （Usage 没有 cost 字段）、未知键报错；`policy` 顶层其它键仍允许。
- 预算挂 team policy，**不复用 `limits.*`**；未配置维度不限；环检测默认开启且**不可关闭只能调阈值**
  （`cooldown_seconds` 下界 1）。非法配置声明 → validation error；手改 `team.json` 非法预算 →
  warning 并忽略该子结构（Team 仍可用）。
- 声明只**补写缺失**的 `<dataDir>/teams/<id>/<team_id>/team.json`；不创建 Agent、不覆盖已有
  name/policy，冲突只 warning。

## 环检测与预算运行态

- 环检测计**同一有向边（from→to）在最近一个 `cooldown_seconds` 窗口内的重复**；越界只拒绝本次
  投递（错误带 `retry after`），不落持久 blocked、不需人工 override。放宽配 Team policy（持久），
  单条会话放行用 `budget override`（临时，只抬高或清除）。
- `budget --json` 的 `edges[].count` 是落盘累计值，不是窗口余量；「现在能不能发」看 `blocked_until`。
- 预算唯一写者是 AgentService 的 `ConversationBudget`；状态写 `<dataDir>/conversations/<id>.json`
  （0600 原子写、1000 条按 last_activity 有界淘汰、损坏 fail-closed、重启不清零）。发送侧入队前与
  接收侧 turn 开始各查一次；事件 `team.budget.warning|blocked|override` 必带 team_id。

## 默认 Team 与绑定

- 交互 / serve 入口无声明命中、也没配 `agent.cwd` 时，用 `<dataDir>/default` 作默认 Team workspace
  （不是进程 cwd）；显式 `agent.cwd` 优先；headless 的 main 绑独立 `<dataDir>/headless` 锚点。
- `create` / `hire` 无显式 workspace 时只有带 name 的 Agent 才绑定；workspace 归一化后精确相等；
  多声明命中 → 不绑定 + warning；显式 `--workspace` 无 name → `invalid_input`。
- 绑定后默认 visibility `team`；Team 只是分组，**不是 cwd 或安全边界**。

## CLI

```bash
vessel team list|get|show|mine [--json]
vessel team create <workspace> [--name N] [--description D] [--policy JSON | --policy-file FILE]
vessel team update <team_id> [--name N] [--description D | --clear-description] [--policy ...]
vessel team archive|freeze|unfreeze <team_id>
vessel team post <team_id> <content...> [--mention <name|id>]...
vessel team members <team_id> add|remove <member>
```

经 owner 端点（from = ownerId）。`show` 参数非 id 时按名字/workspace 目录名唯一匹配；`mine` 按
cwd 包含关系反查（多命中取最深）。`--policy` / `--policy-file` 互斥，JSON 对象整体替换不 merge。
`archive` 有 present 成员 exit 1（`team_not_empty`）；`freeze`/`unfreeze` 写 `teams.spawnFrozen`
（冻结只拦增长 `team_frozen`，不暂停现有成员）。`teams.create` 只允许 human/admin。