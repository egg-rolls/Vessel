---
title: gateway 块配置项
kind: current
triggers: [gateway, supervise, 看门狗, watchdog, proxy_nodes, 平台代理, remote_shutdown, web_dist, VESSEL_STATIC_DIR, VESSEL_GATEWAY_SUPERVISE, stall_restart, node_unreachable, proxy_busy]
paths: [packages/config/src/gateway.ts, packages/config/src/validator.ts, src/shared/port-in-use.ts]
---

# gateway 块配置项

> 平台 gateway 配置键运维手册。生命周期命令（start/stop/restart/status/install-service）见
> [GATEWAY](GATEWAY.md)；架构职责见 [gateway-lifecycle.md](../architecture/gateway-lifecycle.md)；
> 热更新见 [config-reload](config-reload.md)。

## `gateway.supervise`（父进程侧存活看门狗）

```yaml
gateway:
  supervise:
    enabled: true            # 缺省开；false = 关（外部 systemd/k8s 已在做同一件事）
    probe_interval_ms: 2000
    probe_timeout_ms: 2000
    failure_threshold: 3     # 连续失败判僵死（成功一次清零）
    max_restarts_per_hour: 5
    backoff_start_ms: 1000   # 重启后退避，每次翻倍
    backoff_max_ms: 60000
    recovery_probes: 5       # 连续成功退出退避
```

- **为什么在父进程**：`runs.start` 后的整段僵死会让子进程所有定时器停摆、`/health` 超时——
  进程内无自救手段，只能由 gateway 强杀重起。
- **判定纪律（宁可漏杀不许误杀）**：单次探活 2s 超时，连续 3 次失败才判定（≈6–8s 窗口），
  成功一次清零。处置 = `SIGKILL` → 重新 spawn → 记 `event=supervisor.stall_restart`。
- 防抖：退避 1s→2s→4s…（上限 60s），连续 5 次探活成功退出；一小时重启超 5 次**停手**
  （`supervisor.stall_restart_gave_up`），等人工 `gateway restart`。
- 不误伤：`gateway stop/restart` 关停期间看门狗先停；子进程已退出、节点非 ready/adopted 时不动。
- 可观测：`gateway status` 显示每节点最近探活时刻与重启计数；数据源
  `<dataDir>/platform-watchdog[-<instance>].json`（0600、不含 token）。
- 关：`enabled: false` 或 `VESSEL_GATEWAY_SUPERVISE=0`（显式覆盖配置）；关后 status 仍显示「关」。

## `gateway.proxy_nodes`（缺省 true）

- 注册进平台的 node 由平台代理（`/nodes/:nodeId/**`，HTTP + WS），浏览器与 CLI 只连平台端口；
  node token 只在平台进程内使用，**不下发浏览器**。
- `platform.nodes.credentials` 只服务 CLI / 本地自动化（必须 `mode === 'token'`，回环 socket 不豁免）；
  浏览器代理模式下不调用它。`false` = 平台不提供 `/nodes/*`，前端据
  `platform.whoami.proxy.enabled === false` 回老路径（取凭据直连），**只用于本机调试**。
- 上限不可配（`DEFAULT_PLATFORM_PROXY_LIMITS`）：请求体 8 MiB、并发 64、响应头超时 30s（流式不受限）、
  WS 连接 32、WS 水位 1 MiB / 256 KiB、单向硬阈值 8 MiB。
- 失败语义：node 不可达 `502 node_unreachable`；平台超时 `504 node_timeout`；并发满 `503 proxy_busy`；
  白名单拒绝 `403 proxy_method_*` / `404 proxy_path_*`。写操作不重试。
- 记账：代理 WS 关闭写 `gateway.ws.closed`（`via: 'proxy'`），node 侧同名日志按 via 区分避免翻倍。

## `gateway.remote_shutdown`（缺省 false）

只管网关平台 RPC `gateway.shutdown` 的**远程（非回环）**受理；本机停止不受影响。开了也还要：
平台 token 恒要求（浏览器会话 cookie 不构成停止能力）+ 必须经**已配置共享密钥**的 TLS 反代
（`proxy_secret_env` + 密钥头）；非回环未配反代密钥一律拒（fail-closed）。没开：远程停回
`401 remote_shutdown_disabled`，提示 SSH 到主机跑 `vessel stop`。完整形态见
[remote-shutdown.md](remote-shutdown.md)。

## `gateway.web_dist`（静态产物目录）

```yaml
gateway:
  web_dist: D:/Application/APP/Vessel/fleets/canary/apps/web/dist
```

- 平台同源托管的 Web 控制台产物目录（index.html / assets / build.json）。责任链：
  显式 `gateway.web_dist` > `VESSEL_STATIC_DIR` env > 仓库内 `apps/web/dist`（entry 相对解析）。
  空串视为未设置；`~` 展开；相对路径按 cwd 解析。
- **启动期键**：热应用不重接静态目录（改它需重启）；`<web_dist>/index.html` 缺失 fail-fast
  （报错带解析后路径）。自动构建（`ensureWebDist` / `recheckWebDist`）只自愈仓库内默认产物，
  不碰显式目录。`gateway status` / 启动诊断 / `doctor` 的 web 检查同口径按本键优先解析。

## 端口占用

`gateway start` 捕获 `EADDRINUSE` 后以 `port_in_use` 退出 1，不写 PID 文件（`port-in-use.ts`）。
换 `--port` / `--instance`，或先停掉占用进程。