---
title: 双舰队 federation 接入（指针页）
kind: guide
triggers: [federation, peer, 双舰队, canary, 金丝雀, token, env_file, missing_token, 跨节点, 自动配对, join, pair-code, discover, token_secret]
children: [federation-pairing.md, federation-peers.md, federation-token-env.md]
---

# 双舰队 federation 接入（指针页）

> 本页只导航，不落事实。原 federation-setup 长文已按主题拆为下列窄叶。
> 场景：同一台机器上两条版本线（生产 main checkout × 金丝雀 fleets/canary）互发 federation
> 消息；数据面 node 直连 node（不经平台端口）。协议事实家见
> [federation-hub](../architecture/federation-hub.md)。

| 叶子 | 回答什么 |
|---|---|
| [federation-pairing](federation-pairing.md) | **自动配对（推荐）**：`federation join / discover / pair-code` 一条命令两侧接入、回环免码边界、SecretStore 存储、失败分流 |
| [federation-peers](federation-peers.md) | production × canary 拓扑事实（node_id / 端口 / dataDir）、`peer add/list/remove`、YAML 键、热应用、用户配置隔离、验证与拒绝码 |
| [federation-token-env](federation-token-env.md) | 手工共享 token 兜底：env_file 注入、四环 env 快照断点（setx/export 为何不可靠）、冷重启序列（`vessel restart`）、missing_token 决策树 |

## 旧章节去向（供既有入链定位）

- 原 §0（自动配对）→ [federation-pairing](federation-pairing.md)
- 原 §1–§2 / §4–§5 / §7–§8（拓扑 / 机制 / peer 配置 / 验证 / 红线）→ [federation-peers](federation-peers.md)
- 原 §3 / §6 / §9（env_file / 重启序列 / missing_token 排障）→ [federation-token-env](federation-token-env.md)

## 相邻文档

- 指定 node 建 agent/team/session：[cli-node-targeting](cli-node-targeting.md)
- 双版本并行配方：[version-isolation-blue-green](version-isolation-blue-green.md)
- 密钥 / env_file 机制：[config-secrets](config-secrets.md) · 生命周期命令：[GATEWAY](GATEWAY.md)
- 跨机远程连接：[REMOTE](REMOTE.md)（指针页）→ [remote-connect](remote-connect.md)