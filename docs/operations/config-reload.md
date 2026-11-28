---
title: 热更新与配置生效
kind: current
triggers: [reload, 热更新, 热应用, hot-apply, requires_restart, config-watch, gateway reload, node reload, /reload, scope, 生效, 重启]
paths: [src/config/config-watch.ts, src/config/hot-apply-appliers.ts, src/config/hot-apply-assembly.ts, src/gateway/gateway-reload-wiring.ts]
---

# 热更新与配置生效

> 「改了这个键要不要重启」的运维手册。hot-apply 机制（applier 注册 / fail-closed / config-watch
> 竞态加固）家见 [architecture/config.md](../architecture/config.md#config-model)；
> gateway 生命周期命令见 [GATEWAY](GATEWAY.md)。

## 命令与入口

```bash
vessel gateway reload [--scope config,plugins]   # 平台层热更新
vessel node reload --scope config                # 单 node
```

- TUI `/reload` 只重载配置文件并刷新 provider 信息，**不重扫插件目录**；新增插件需重启进程
  （与 `gateway.reload` 的 reloadConfig 同源）。
- `config-watch`（`fs.watch` 用户配置）：写入抖动 debounce 合并；校验通过后应用，差异行按行首
  scope token 分组、每组独立一条 notice；`config.set` 写盘有同步 trigger + 迟到 fs.watch 去重
  （同一次写入不双应用）。
- 未知 scope 或读取失败返回非 0；请求未注册的 scope → `unknown reload scope`（不静默忽略）；
  单 scope applier 抛错不中断其余 scope（失败写进该 scope 摘要）。

## 热生效面（config scope 内）

| 域 | 生效行为 |
|---|---|
| `node.allowed_origins` | 经 web `gateway.reconfigure({ allowedOrigins })` 生效 |
| `provider.*` / `models.*` | 重建 registry 快照 + 清 provider 缓存 + 替换**节点缺省模型**（owner profile + 成员宿主缺省）：新 body / 新 EU 立即用新值；live body / EU 的 model 是构造期只读快照（前缀不变量），本具仍旧值、下一具才生效；续接 run 真正换模型时追加模型环境卡。凭证轮换经 delegating wrapper 下一请求生效 |
| `federation` | `applyFederation` 原地更新入站/出站 peer |
| `kanban` | `applyKanban` 重解析 boardPath 原地更新 deps（下一次 `kanban.get` 即用新板） |
| `auto_prune` | `applyAutoPrune` 喂活配置引用 + **reschedule 立即重排**挂起定时器（enabled/interval/olderThan/dryRun 全活生效；enabled=false 只跳过趟、链不断） |
| `env_injection` | live resolver：cadence/channel 每次发射实时求值，热改即时生效（不靠重注册） |
| `observability.log` | 启动应用 + config-watch 热应用（差异行进 runtime.notice） |
| permission 规则 / 插件工具面 / MCP | 独立 scope（`permission` / `tools` / `mcp`），由装配注入 applier；MCP 有控制面时才注册 |

- **缺省模型热应用的守门**：比较与写入用**缺省身份**（ref + wire 分离，`DefaultModelIdentity`）；
  `previewDefaultModel` 按运行期同口径解析新配置缺省身份，解析不出 / `ModelRefError` ⇒ 变化域进
  `requires_restart`——不把不可重解析的裸 wire 名热应用进宿主缺省。env 优先级冻结：
  `VESSEL_MODEL` 赢 `models.default`。
- 未注入对应 applier 的部署：该域进 `requires_restart`（不假装生效）。

## 必须重启（requires_restart）

`provider`（不含 model 的传输面）/ `agent`（含 `agent.model` / `agent.cwd` / `team_member_limit`）/
TLS / token / port / `gateway.web_dist` / `vision` 预算 / `context.tool_result_whitelist` /
`context.composition_record` / engine 双开关等构造期键。`plugins` scope 只清扫描缓存，
**新增/移除插件仍需重启**。

## 平台层 restart（handoff）

`gateway restart` 是平台层重启：旧 Gateway 退出时**不终止**自己 spawn 的 node/hub，新 Gateway
按 `gateway.pid` 三元组 / hub lock adopt 接管，在跑的 run 不中断。保留语义经
`<dataDir>/platform-handoff[-<instance>].json`（TTL 120s，消费即删）传递。`stop` 缺省真停
（连 node/hub）；`stop --keep-nodes` 只停平台层；`restart --no-keep-nodes` 冷重启（升级二进制后
让 node 换新代码）。node 行末尾 `(adopted)` = 接管来的进程。详见 [GATEWAY](GATEWAY.md)。