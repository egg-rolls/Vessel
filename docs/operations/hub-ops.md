---
title: Hub 运维（独立目录进程 / 出站加入 / NAT）
kind: current
triggers: [hub, 目录, join, join-code, 加入码, pairing, 出站, NAT, public_url, 吊销, node remove, hub-node.json, 8643]
paths: [src/cli/commands/hub-command.ts, src/hub/node-state.ts, src/hub/server.ts]
---

# Hub 运维（独立目录进程 / 出站加入 / NAT）

> Hub 是**独立前台目录进程**（`vessel hub start`），不在 gateway 内；`gateway start` 在
> `hub.auto_start`（缺省 true）时自动拉起本地 hub（已有活实例 adopt），`gateway stop` 缺省只停
> 平台层（见 [GATEWAY](GATEWAY.md)）。控制面只有 **node → hub** 出站方向；协议 / join 判定 /
> 派生来源的事实家见 [federation-hub](../architecture/federation-hub.md)，配置键见
> [CONFIG §2.13](CONFIG.md)。

## 命令（只写不跑）

```bash
# hub 侧（独立 dataDir，必须与节点 dataDir 不同）
vessel hub start --data-dir /srv/vessel-hub --host 127.0.0.1 --port 8643
vessel hub join-code --data-dir /srv/vessel-hub --ttl 300 --json
vessel hub directory --hub-url https://hub.example:8643 --json
vessel hub node list --hub-url https://hub.example:8643 --json
vessel hub node remove <pairing_id> --hub-url https://hub.example:8643

# node 侧：一次性 code 出站加入，token 只进 SecretStore
vessel hub join https://hub.example:8643 --code <CODE> \
  [--public-url <url>] [--ca <file>] [--data-dir <nodeDir>] [--json]
```

- join code 缺省 300s、只存 `sha256`、单次消费；hub 签发 `scope: node` token，只用于 WSS
  `/v1/hub/node-control`，绑定 `hub_id` / `node_id`，不进 canonical RPC。有效期
  `hub.tokenTtlDays`（1–365，缺省 30 天）只影响新签发。
- 非回环 hub 监听必须 `hub.allow_remote: true` + TLS cert/key + 非空 `hub.token_env`
  （`src/hub/server.ts` 启动守卫）。配了 `hub.proxy_secret_env` 后回环判定收紧，CLI 会从同一
  环境变量读值自带密钥头（见 [proxy-secret](proxy-secret.md)）。
- 旧 `hub pair` / `hub node add` / `hub token *` / `hub data-token` 已删除，调用失败并提示改用
  `hub join-code` / `hub join`。

## 文件布局（0600）

| 文件 | 内容 |
|---|---|
| `<nodeDataDir>/hub-node.json` | join 结果**非秘密**字段（`hub_url` / `hub_id` / `node_id` / `pairing_id` / `token_id` / `expires_at`）；`node-state.ts` 白名单写入 |
| `<nodeDataDir>/hub-node-status.json` | 出站连接状态（advisory，`last_error` 稳定错误码） |
| `<hubDataDir>/hub-join.json` / `node-tokens.json` | 只存 `sha256`，无明文 |

**明文 node token 只进 SecretStore**（平台密钥库 / 加密文件回退），不写 YAML / JSON / 日志。

## 目录与 NAT 数据面

- 目录主键 `pairing_id = node_id`；hub 只维护目录并推送 `{node_id, team_id, request_id?, reason, ts}`
  指针；消息 / 事件 / 工具结果 / 权限正文**始终由浏览器直连节点**，hub 不代理、不落盘。
- **一个 node 进程 / dataDir 只加入一个 hub**；多 hub 需要多个 dataDir / 进程。
  离开 = 删除 `hub-node.json`（及 SecretStore 条目）。
- 出站只保证控制面元数据 / 指针。除非节点有浏览器可达地址（隧道 / 反代）并声明 `public_url`，
  否则正文不可达；目录 `data_plane: direct|unreachable` 由 `public_url ?? url` 派生。
- 吊销：`hub node remove <pairing_id>` 关闭该节点控制 WS、吊销 token hash、删目录记录；
  旧 token 重连 4401，节点需重新 `hub join`。

## 已知限制

跨节点 A2A 走 federation（不走 hub）；多 hub 联邦、远程管理 hub、hub daemon / 系统服务注册
未实现；NAT 正文数据面需隧道 / 反代。federation 接入见 [federation-pairing](federation-pairing.md)。