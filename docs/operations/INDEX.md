---
title: 运维索引
kind: guide
triggers: [operations, 运维, index, 索引, runbook, gateway, 配置, 迁移, 发布, 远程, trace, ci]
children: [LOGS.md, GATEWAY.md, TROUBLESHOOTING-401.md, BUN-WIN32-SEGFAULT.md, BUN-QUIRKS.md, TIMEOUTS.md, CONFIG.md, MIGRATION.md, version-isolation-blue-green.md, federation-setup.md, REMOTE.md, REVERSE-PROXY.md, TRACE.md, RELEASE.md, CI-CD.md]
---

# 运维索引

按目标或故障现象命中；命中后只读对应页。架构事实见 [architecture/INDEX.md](../architecture/INDEX.md)。

> 本表 current 模块均为需同步文档（契约见 [DOC-MANAGEMENT §3.5](../DOC-MANAGEMENT.md)）。

| 文档 | 一句话 |
|---|---|
| [LOGS](LOGS.md) | **日志口径**：一件事只有一种说法（同一事实的权威来源表）、`web.build.*` 构建日志怎么读、`console.*` 判定标准 |
| [GATEWAY](GATEWAY.md) | 单点启动 gateway、node 独立 `--daemon` 启动、systemd/launchd/schtasks 常驻、`stop` 与 `stop --no-keep-nodes` 的区别、节点缺席诊断、端口占用/句柄继承/readiness 常见故障、会话时间线修复（删 `timeline.idx` 再 open） |
| [TROUBLESHOOTING-401](TROUBLESHOOTING-401.md) | **数据面 401 分流**：`Missing or invalid token`（直连了 node API 端口）vs `session_required`（会话不在当前 host）；8642/8643/8644 各管什么、cookie 按 host 区分、应访问的入口是 `<platform>/nodes/<node_id>/…` |
| [BUN-WIN32-SEGFAULT](BUN-WIN32-SEGFAULT.md) | gateway 崩在 `panic(main thread): Segmentation fault` 之后：收集哪五样、`/metrics` 资源指标怎么读、两个环境开关（`VESSEL_PROXY_HTTP_STREAM` / `VESSEL_CRC32_NATIVE`）、已定位的代理流式转发最小复现与加固 |
| [BUN-QUIRKS](BUN-QUIRKS.md) | Bun 运行时坑位**总目**（非崩溃类）：每条只留「现象 + 判据 + 一句话处置」，专项细节指向对应文档。§1 是假超时，细则见 [TIMEOUTS](TIMEOUTS.md) |
| [TIMEOUTS](TIMEOUTS.md) | **超时不可信（专项）**：bun 1.3.9 上 `AbortSignal.timeout()` 可能不触发（进程不报错、也不动）；哪些路径最容易踩、正确写法（`withDeadline` / `startDeadline`）、用户手测时该看什么 |
| [CONFIG](CONFIG.md) | 配置层序、resolver、执行锁与密钥 |
| [FEISHU](../../plugins/im/feishu/FEISHU.md) | 飞书连接引导：开放平台申请 / 权限与事件 / 长连接配置 / 启动验证 / 白名单安全与 mention-only 升级 |
| [MIGRATION](MIGRATION.md) | sqlite / file-v1 → file-v2 数据迁移 |
| [version-isolation-blue-green](version-isolation-blue-green.md) | 两版本并行（红蓝双行）：A 行留默认根、B 行 `--user-config`+`--data-dir`+独立端口+`engine_pool.instance` 搬出；缺省 stop 只停平台层、`--stop-nodes` 才整舰队真停；切换=新会话宇宙、回退=换回入口 |
| [federation-setup](federation-setup.md) | 双舰队 federation 接入（production × canary）：拓扑/端口事实、共享 token 可靠注入（env_file 为准 + setx/export 四环断点诊断）、`federation peer add/list/remove` 动态管理 + 热应用、`--stop-nodes` 冷重启序列、验证与 missing_token 排障 |
| [REMOTE](REMOTE.md) | 远程连接与中继 |
| [REVERSE-PROXY](REVERSE-PROXY.md) | 公网暴露与同机反代的安全边界：回环=本机=可信判定失效、共享密钥 opt-in、默认收紧项 |
| [TRACE](TRACE.md) | Trace 留存、级别与隐私 |
| [RELEASE](RELEASE.md) | 发版流程 |
| [CI-CD](CI-CD.md) | 流水线与门禁 |
