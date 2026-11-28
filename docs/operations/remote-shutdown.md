---
title: 远程停（vessel stop --connect）与 gateway.shutdown 闸
kind: current
triggers: [远程停, stop --connect, gateway.shutdown, remote_shutdown, 等死, 不强杀, shutdown_token_required, remote_shutdown_disabled, 平台停]
paths: [packages/serve/src/platform/rpc.ts, src/cli/commands/fleet/stop-command.ts]
---

# 远程停（vessel stop --connect）与 gateway.shutdown 闸

> CLI **直连**平台 `/platform/rpc` 的 `gateway.shutdown`（params `{}` → `{stopping:true}` 只受理），
> 不经浏览器→node 代理。代理 DENIED 闸门零改动：经代理转发 `gateway.shutdown` 到 node 仍 403；
> 平台 RPC 绝不透传 node。命令面与本地停止语义见 [GATEWAY §4](GATEWAY.md)；配置键见
> [CONFIG §2.20.1](CONFIG.md)。

## 平台 RPC 六闸（fail-closed，platform/rpc.ts）

顺序承重，闸 3/4 先于闸 5（不向未授权远程调用者泄露 token 是否有效）：

1. **未注入** ⇒ 与未知方法完全相同（`not_found` 200，零表面，不打日志）。
2. **params** 省略或空对象通过；非对象 → `invalid_params` 400。
3. **远程分类**：`isRemote` = 原始 socket 非回环 ∨（**已配置**反代密钥 ∧ 本次密钥头成立）。
   不用合取后的 `auth.loopback`——否则经反代的远程会被判成回环绕过 opt-in。
4. **opt-in**：非回环必须 `gateway.remote_shutdown: true`（缺省 false），否则 401
   `remote_shutdown_disabled`，提示 **SSH 到主机跑 `vessel stop`**（零实体兜底）。
5. **必须经已配置密钥的 TLS 反代**：非回环而未配置 `proxy_secret_env` ⇒ 一律拒
   （401 `remote_shutdown_requires_proxy`，防「opt-in = 裸公网停」误配）。
6. **token 恒要求**：`mode === 'token'`（`gateway.token` / `gateway.token_env` 的值）；
   回环匿名 / 浏览器会话 cookie 一律拒（401 `shutdown_token_required`），无迁移豁免。

通过后：`platform.shutdown.accepted` 日志（无 token）→ defer 一拍执行进程内退出序列 →
响应先发出。重复调用幂等。退出序列与 SIGTERM 完全相同（含 owned engine 池 terminate，
关闭 Windows owned engine 孤儿缺口，见 [GATEWAY §4](GATEWAY.md)）。

## 停止方行为（fleet/stop-command.ts:stopRemoteFleet）

- 只认**显式 `--connect` flag**，不认 `VESSEL_CONNECT` env；token 优先级
  `--connect-token` > `connect.token(_env)`——必须是**平台 token**，不是 node token。
- 远程清点是 **registry 级**（`platform.health.get` + `platform.nodes.list`）：读不到远端
  manifest / 池文件，命令会如实警示这一局限；确认规则与本地停相同（`--yes` 跳过）。
- **等死确认**：受理后每 500ms 轮询 `platform.health.get` 至请求失败（不再可达）≤ `--timeout`
  （远程缺省 10s）。措辞是「平台已不可达（shutdown 已受理）」，**不声称进程已死**
  （反代自身故障不可区分）；超时如实 exit 1。
- **远程不强杀**：生命周期强杀恒本机。本地 `vessel stop` 的 `--force` / 不限时 drain 语义
  不传播到远程（见 [GATEWAY §4](GATEWAY.md)）。
- 本机停止不受 `gateway.remote_shutdown` 影响。

## 配置与自检（只写不跑）

```yaml
gateway:
  remote_shutdown: true                 # 缺省 false
  proxy_secret_env: VESSEL_PROXY_SECRET # 远程停必须经已配置密钥的反代
  token_env: VESSEL_PLATFORM_TOKEN
```

```bash
vessel stop --connect https://<域名> --connect-token <平台 token> --ca <ca.pem>
# 未开 opt-in → 401 remote_shutdown_disabled；缺密钥头 → remote_shutdown_requires_proxy
```

反代密钥机制见 [proxy-secret](proxy-secret.md)；入口凭据矩阵见 [exposure-hardening](exposure-hardening.md)。