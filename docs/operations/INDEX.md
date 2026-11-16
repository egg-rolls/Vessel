---
title: 运维索引
kind: current
triggers: [operations, 运维, index, 索引, runbook, gateway, 配置, 迁移, 发布, 远程, trace, ci]
paths: [docs/operations/**]
---

# 运维索引

按目标或故障现象命中；命中后只读对应页。架构事实见 [architecture/INDEX.md](../architecture/INDEX.md)。

| 文档 | 一句话 |
|---|---|
| [GATEWAY](GATEWAY.md) | 单点启动 gateway、node 独立 `--daemon` 启动、systemd/launchd/schtasks 常驻、`stop` 与 `stop --no-keep-nodes` 的区别、节点缺席诊断、端口占用/句柄继承/readiness 常见故障 |
| [CONFIG](CONFIG.md) | 配置层序、resolver、执行锁与密钥 |
| [MIGRATION](MIGRATION.md) | sqlite / file-v1 → file-v2 数据迁移 |
| [REMOTE](REMOTE.md) | 远程连接与中继 |
| [TRACE](TRACE.md) | Trace 留存、级别与隐私 |
| [RELEASE](RELEASE.md) | 发版流程 |
| [CI-CD](CI-CD.md) | 流水线与门禁 |
