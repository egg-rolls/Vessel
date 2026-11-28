---
title: 配置与密钥（导航）
kind: guide
triggers: [配置, 配置项, 配置文件, 配置优先级, 密钥, 令牌, 环境变量, 用户级配置, 项目级配置, 默认值, vessel.yaml, 数据目录, 覆盖, secrets, config]
children: [config-files.md, config-models.md, config-model-migration.md, config-command.md, config-secrets.md, config-auth.md, config-origins.md, config-ui.md, config-permission.md, config-limits.md, config-runtime.md, config-agent.md, config-team.md, config-hub.md, config-gateway.md, config-reload.md, config-data.md]
---

# 配置与密钥（导航）

> 本页只导航，不落事实。配置域运维手册已按模块拆成下列窄叶子；命中后只读对应页。
> 架构事实家：合并模型 / hot-apply 机制见 [architecture/config.md](../architecture/config.md#config-model)，
> env 注入 append-only 不变量见 [env-info-append-only](../architecture/env-info-append-only.md)。
> 同步契约见 [DOC-MANAGEMENT §3.5](../DOC-MANAGEMENT.md)。

| 叶子 | 一句话 |
|---|---|
| [config-files](config-files.md) | 配置位置 / 优先级 / `--data-dir` / `--user-config` / 合并规则 / serve→node / 配置写锁 |
| [config-models](config-models.md) | models 块 YAML 形状 / 校验规则 / 凭证磁盘 / model CLI / provider 新旧键 |
| [config-model-migration](config-model-migration.md) | vendors/aliases 一次性迁移：顺序 / 映射 / 失败语义 / 报告 / doctor 检查 |
| [config-command](config-command.md) | `config path/init/show/set/explain` / config.set 白名单 / RPC 读面 |
| [config-secrets](config-secrets.md) | 根密钥派生 / token 命令 / `_env` 规则 / env_file / 反代密钥 / 部署示例 |
| [config-auth](config-auth.md) | WebUI 登录：策略注册表后端 / 口令 / TOTP / 引导码 / 会话 / CSRF |
| [config-origins](config-origins.md) | public_origins 与 redirect_uri / http.allowed_origins / 回环免登录开关 |
| [config-ui](config-ui.md) | 语言 / 思考流 / 状态栏 / 可见性 / messageVisibility / depthColor / 指示器 |
| [config-permission](config-permission.md) | auto_approve / never_auto_approve / 权限等待 / interactions 持久化 |
| [config-limits](config-limits.md) | limits / termination / pricing 合并视图 / 压缩配置 / 白名单 / 组成快照 |
| [config-runtime](config-runtime.md) | empty_response / kanban / vision / tools_engine + engine_pool 双开关 |
| [config-agent](config-agent.md) | agent.* 配置键 / owner 端点 / agent CLI |
| [config-team](config-team.md) | teams 声明 / policy 校验 / 预算与环检测 / 默认 Team / team CLI |
| [config-hub](config-hub.md) | hub 块 / 配对 / attention.nodes / hub CLI |
| [config-gateway](config-gateway.md) | supervise 看门狗 / proxy_nodes / remote_shutdown / web_dist / 端口占用 |
| [config-reload](config-reload.md) | 热更新命令 / 热生效面 / requires_restart / 平台 handoff |
| [config-data](config-data.md) | 根布局 / 写意图锁 / session 锁 / 租约 / prune / auto_prune |

相关运维页：[GATEWAY](GATEWAY.md)（生命周期命令）· [REVERSE-PROXY](REVERSE-PROXY.md)（公网边界）·
[TROUBLESHOOTING-401](TROUBLESHOOTING-401.md)（401 分流）· [LOGS](LOGS.md)（日志口径）·
[TRACE](TRACE.md)（留存策略）· [version-isolation-blue-green](version-isolation-blue-green.md)（双版本并行）。