---
adr: 74
title: Gateway 生命周期：统一命令、daemon 与用户级服务注册
status: accepted
date: 2026-10-20
related: [36, 41, 51, 60, 70]
tags: [gateway, cli, daemon, service, lifecycle, operations]
---

## ADR-074：Gateway 生命周期：统一命令、daemon 与用户级服务注册

- **上下文**：0.1 ~ 0.11 的常驻 gateway 入口只有 `vessel --serve`。它适合前台调试，却没有停止 / 查询 / 重启入口，也没有 PID 与日志约定；后台运行只能由用户自行拼接 `nohup`、`&` 或进程管理器。0.6 引入远程控制面后，运维需要一个可脚本化、可被服务管理器接管的生命周期命令；同时不能破坏既有的 `--serve` 调用方式。

- **决策**：
  1. **统一入口为 `vessel gateway`**：提供 `start [--daemon] [--port] [--host] [--log]`、`stop [--timeout]`、`status [--json]`、`restart [--daemon]`、`reload [--scope]`、`install-service` 与 `uninstall-service`。前台 `start` / `restart` 复用现有 `--serve` 装配管线；`--serve` 保留为前台别名，不新增第二条启动路径。
  2. **daemon 由父进程分离子进程**：`start --daemon` 用 `Bun.spawn` 启动一个前台 `vessel gateway start` 子进程，stdio 追加到 `<dataDir>/logs/gateway.log`；父进程轮询 PID 文件，子进程成功写出实际 host / port 后父进程退出。启动超时、子进程提前退出或已有实例都返回非 0，并 tail 日志作为诊断。
  3. **PID 文件是唯一运行态来源**：路径 `<dataDir>/gateway.pid`，JSON 字段 `{pid, started_at, host, port, version, node_id?}`；同目录临时文件 + rename 原子写入，权限 `0600`。存活判定同时要求 PID 存活与命令行匹配 gateway / serve；死 PID、损坏 JSON、命令行不匹配都按 stale 处理并允许回收。退出时只删除本进程持有的 PID 文件。
  4. **服务注册只做用户级**：Linux 生成 systemd **user** unit（`~/.config/systemd/user/vessel-gateway.service`），macOS 生成 LaunchAgent（`~/Library/LaunchAgents/com.vessel.gateway.plist`），Windows 注册 `ONLOGON` 计划任务 `VesselGateway`。服务运行命令固定为 `vessel gateway start`（不带 `--daemon`，由服务管理器托管）。只在用户显式执行 `install-service` / `uninstall-service` 时写入定义并调用平台命令；不随启动或包安装自动注册。
  5. **平台范围明确**：只支持当前平台；显式指定其它平台或在不支持平台调用时返回明确错误，不静默降级，也不提供 root 级系统服务。
  6. **输出约定**：`status --json` 只输出 JSON；人类输出走 `ui-style`，非 TTY 自动无 ANSI。

- **备选**：(a) 继续只保留 `--serve`，让用户自行后台化——无法统一 stop / status，Windows 上没有可靠 PID 语义；(b) 用第三方进程管理器（pm2 等）——增加重依赖并绑定生态；(c) 直接注册 root 级 systemd 服务——需要提权，违背单用户 CLI 的安装形态；(d) 用 lock 文件代替 PID 文件——仍要判断进程存活，且无法透出实际端口与版本；(e) 让 daemon 父进程常驻监督子进程——父进程退出后监督关系不稳定，交给系统服务管理器更合适。均不取。

- **后果**：gateway 的运维入口收敛为 `vessel gateway`，脚本只依赖退出码与 `status --json`。默认仍是回环监听与前台运行；后台运行必须显式 `--daemon` 或安装服务。daemon 本身不做崩溃重启，需要常驻时由 systemd / launchd / 计划任务负责。PID 命令行探测读不到时按 stale 处理，可能把无法验证的进程当作已退出；这是为避免误杀其它进程而接受的保守取舍。0.12.0 不改变 `--serve` 的协议与启动参数。

- **关联**：ADR-036（gateway 协议）、ADR-041 / ADR-051（远程监听与 TLS）、ADR-060（CLI 命令注册表）、ADR-070（gateway stop 幂等与关闭顺序）；`src/gateway-command.ts`、`src/gateway/{daemon,pid,service,reload}.ts`、`src/cli-args.ts`、`src/cli.ts`。
