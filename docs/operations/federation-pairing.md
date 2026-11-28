---
title: Federation 自动配对（join / discover / pair-code）
kind: current
triggers: [federation, 配对, join, pair-code, discover, 自动配对, 共享 token, token_secret, SecretStore, 回环免码, 跨机, 金丝雀]
paths: [src/federation/federation-pairing.ts, src/federation/federation-pair-store.ts, src/federation/federation-secrets.ts, src/cli/commands/federation-pair.ts]
---

# Federation 自动配对（join / discover / pair-code）

> **一条命令完成两侧接入**：握手验证 → 共享 token 自动交换（存节点密钥库，零手工 env_file）→
> 两侧自动写 peer 配置 → 热应用，**不重启**。数据面 node 直连 node（不经平台端口）；token 是
> 独立共享秘密，与两舰队各自的 node token / root-secret 无关。手工 env_file 兜底见
> [federation-token-env](federation-token-env.md)；peer 配置与拓扑见 [federation-peers](federation-peers.md)；
> 协议与失败顺序的事实家见 [federation-hub](../architecture/federation-hub.md)。

## 同机（回环）：免码一条命令

```bash
# initiator 侧（带与舰队启动一致的 --user-config / --data-dir）
vessel --user-config D:/Application/APP/Vessel/fleets/canary-config.yaml \
  federation join http://127.0.0.1:8644
# 期望：paired with <node_id>:vessel at http://127.0.0.1:8644；running gateway reloaded
```

- 目标节点在握手内**自动写好它那一侧**的 peer（含 token）；initiator 收到响应后写自己这一侧
  并 best-effort `gateway.reload`。两侧 `token_secret: true`（`federation-pairing.ts`）。
- 无码放行**仅限回环 socket**（`srv.requestIP` 判定）：信任边界 = 同机同用户，与
  `/v1/local/token` 既有拍板同口径。非回环无码 → 400 `code_required`。
- 缺省 team 两侧都是 `vessel`；不同名用 `--team-id <本机> --peer-team-id <对端>`（自动写
  `local_team_id` 映射）。对端 team 不存在 → 404 `federation_unknown_team`（校验在消费之前，不烧码）。
- 重复 join = **轮转 token**（幂等修复）：secret 覆盖写、peer 条目整条替换。
- 可选：`--allow-directory`（开放入站目录查询）、`--url <本机 node base URL>`（对端出站 peer url）。

## 同机发现：不用记端口

```bash
vessel federation discover            # 离线读本地 hub registry.json，不要求 hub 在线
vessel federation join <node_id>      # node_id 经同一份 registry 解析回环 url
```

discover 只列**回环入口**的节点（`classifyOrigin` 重算，不信声明）；没有 hub / 没 join 过 hub
的节点不出现——此时用显式 URL join。

## 跨机：一次性配对码

```bash
# target 侧（能读该 dataDir 的本机壳层）
vessel federation pair-code           # 明文只打印一次；默认 300s、单次消费、只存 hash
# initiator 侧（跨机必须 https）
vessel federation join https://node.example.com:8644 --code ABCD-EFGH
```

码语义与 hub join-code 同范式（`pairing_expired` / `pairing_used` → 410；校验失败不烧码）。
pair 端点独立限流（全局 12 次/分钟，`packages/serve/src/federation.ts`）。

## token 存哪 / 安全红线

- 共享 token 存 **node SecretStore**（复用 hub 适配器：Windows DPAPI / macOS keychain /
  Linux secret-tool；平台不可用时回退 AES-256-GCM 0600 文件 `<dataDir>/federation/`，
  `federation.allow_file_secrets` 缺省 true，显式 false 则 fail-closed）。keychain service
  `vessel-federation`，与 gateway 用户 / hub node / peer-env 三套 token 命名空间不交叉。
- 配置只写 `token_secret: true`（与 `token_env` 二选一，validator 强制）；token 值不进配置 /
  日志 / CLI 输出 / argv；明文只在 pair 响应出现一次。
- 解析点（启动 / 热应用 / CLI）预加载 secret 进内存后仍走同步 resolver；缺 secret 的 peer
  照旧 fail-closed 丢弃（`missing_token`）。`vessel federation peers` 对 secret peer 显示
  `secret-store` + set/missing，绝不打印值。

## 失败分流（join 的 stderr）

| code | 含义 / 下一步 |
|---|---|
| `federation_peer_unreachable` | 目标不可达：确认对端 **node 端口**（不是平台端口）与监听 |
| `code_required` | 跨机无码：target 侧 `federation pair-code` 后带 `--code` |
| `pairing_expired` / `pairing_used` / `pairing_invalid` | 码过期 / 已用 / 不匹配：重新出码 |
| `federation_unknown_team` | 对端没有该 team：先建 team 或改 `--peer-team-id` |
| `federation_secret_write_failed` | 本机密钥库不可用：修密钥库或 `federation.allow_file_secrets: true` |
| `federation_peer_write_failed` | 用户配置写失败：看路径权限 / 配置形状 |
| `federation_discover_unknown_node` | node_id 不在本地 hub registry：用显式 URL |