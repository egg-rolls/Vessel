---
title: 远程 TLS：证书与 CA 运维
kind: current
triggers: [证书, CA, TLS, cert, key, SAN, 自签, openssl, cacert, 信任库, mixed content, 证书过期, PEM]
paths: [src/gateway/serve-config.ts, src/rpc/http-client.ts]
---

# 远程 TLS：证书与 CA 运维

> 规则家：非回环必须 token + TLS、无逃生口、HTTP/1.1 only 等见
> [architecture/gateway.md#tls](../architecture/gateway.md#tls)。本文只讲证书怎么配、怎么验、怎么排障。
> 两机配置全貌见 [remote-connect](remote-connect.md)。

## 服务端证书

非回环 Node API 必须提供 PEM 格式 cert/key，**成对、文件存在且非空**
（`src/gateway/serve-config.ts` 启动前检查；web 真正读取 PEM）：

```yaml
node:
  hostname: 0.0.0.0
  port: 8644
  allow_remote: true
  tls:
    cert_file: /etc/vessel/node-b-cert.pem
    key_file: /etc/vessel/node-b-key.pem
```

- 证书 **SAN 必须包含客户端实际使用的 host / IP**（浏览器与 Node 客户端都校验证书链）。
- 自签示例（只写不跑）：

  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout node-b-key.pem -out node-b-cert.pem \
    -subj "/CN=node-b.example.com" \
    -addext "subjectAltName=DNS:node-b.example.com,IP:192.168.1.20"
  ```

- 证书与私钥属部署凭据：不提交仓库，权限至少 `0600`。不做自动轮换 / ACME，过期后连接直接失败。
- **改证书 / token / 端口必须 restart**：`reload` 会把这些列进 `requires_restart`，不能把 reload
  成功当成新证书已生效（`provider.model` 与 `node.allowed_origins` 才可热应用，见
  [GATEWAY](GATEWAY.md) / [config-reload](config-reload.md)）。

## 客户端 CA

- **CLI / TUI / headless**：`--ca <ca.pem>`（别名 `--connect-ca`）或 `connect.ca_file` 显式提供
  私有 CA / 自签证书；未提供时用运行时默认信任库（`src/rpc/http-client.ts`）。
- **浏览器**：无法按连接指定 CA 文件，必须把 CA 装进操作系统 / 浏览器信任库，否则独立前端报证书错误。

```yaml
connect:
  ca_file: /etc/vessel/ca.pem
```

## 排障

| 现象 | 可能原因 | 处理 |
|---|---|---|
| TLS 校验失败 | 未提供 CA、SAN 不匹配、证书过期 | 用 `--ca` / `connect.ca_file`；重签含正确 SAN 的证书 |
| 浏览器证书错误 | 系统 / 浏览器未信任 CA | 把 CA 装入信任库（不能按连接指定） |
| mixed content | HTTPS 页面连 `http://` node | node 改用 HTTPS（浏览器拦截，无服务端解法） |
| 监听 `0.0.0.0` 时 banner 显示 `http://0.0.0.0:<port>` | 显示层行为 | 实际访问换真实 IP / 域名，并匹配证书 SAN |

## 验证（只写不跑）

```bash
curl --cacert /etc/vessel/ca.pem https://node-b.example.com:8644/health   # 不要用 -k
```

独立前端部署（静态站点 + CSP + Origin allowlist）见 [web-console-deploy](web-console-deploy.md)；
同机反代终结 TLS 的形态见 [public-login](public-login.md)。