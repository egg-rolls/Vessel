# 内部 CA 与服务证书（D13）

设计：`docs/dev/design/docker-cd-design.md` v2 §5.2 / §1.4（非回环三重硬门禁）。

多容器形态下 node/hub 绑 `0.0.0.0`（非回环），代码强制 **allow_remote + TLS 证书对 + 显式 token** 缺一不可
（`serve/gateway.ts:1183-1206`、`hub/server.ts:306-320`，DECISION-014 无明文逃生口）。因此 compose 内网必须配 TLS 证书。
本目录用一次性内部 CA 给每个服务签证书，**SAN = compose 服务名**（bridge DNS 即证书 host）+ `localhost` + `127.0.0.1`
（后者供容器内 HEALTHCHECK 回环探活）。

## 生成（一次性）

```bash
cd deploy
bash certs/gen.sh            # 缺省生成 CA + node-1 + hub 证书
bash certs/gen.sh node-2     # 水平扩展时追加 node-2（SAN=node-2）
```

等价手工命令（设计 §5.2）：

```bash
# 内部 CA（离线保管 ca.key）
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout certs/ca.key -out certs/ca.crt -days 825 -subj "/CN=Vessel Internal CA"
# 每服务一张证书，SAN = 服务名 + localhost + 127.0.0.1
for svc in node-1 hub; do
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout certs/$svc.key -out certs/$svc.csr -subj "/CN=$svc"
  openssl x509 -req -in certs/$svc.csr -CA certs/ca.crt -CAkey certs/ca.key \
    -CAcreateserial -out certs/$svc.crt -days 825 \
    -extfile <(printf "subjectAltName=DNS:$svc,DNS:localhost,IP:127.0.0.1")
done
```

## 挂载与互信

- node/hub：`./certs:/certs:ro`（整目录，含各自 crt/key + ca.crt）。
- gateway：`./certs/ca.crt:/certs/ca.crt:ro`（只需 CA，用于代理/出站 join 信任对端）。
- 所有互信容器 env `NODE_EXTRA_CA_CERTS=/certs/ca.crt`（compose 已注入）。

## 轮换与保管

- 轮换 = 删旧 `crt/key` 重跑 `gen.sh` + `docker compose restart`；`ca.crt` 分发到所有互信容器。
- **`ca.key` 离线保管，绝不进 git**（本目录 `.gitignore` 已排除所有生成材料）；镜像构建上下文亦排除 `deploy/`（`.dockerignore`）。
- 内部 CA **仅限 compose 内网**。生产跨主机场景用正式 CA/ACME（设计 §5.2 明示）。

## quick-start 不需要证书

单容器 quick-start profile 全回环（platform/隐式 node/本地 hub 均 127.0.0.1），无非回环 TLS 门禁 ⇒ 零证书零注册。