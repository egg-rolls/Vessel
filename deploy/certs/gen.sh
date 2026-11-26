#!/usr/bin/env bash
# Vessel 内部 CA + 服务证书生成（D13；设计 docs/dev/design/docker-cd-design.md v2 §5.2）。
# 用法：bash certs/gen.sh [额外服务名 ...]   缺省生成 node-1 hub；扩 node-2 时：bash certs/gen.sh node-2
# ★ca.key 离线保管，绝不进 git（certs/.gitignore）；内部 CA 仅限 compose 内网，生产跨主机用正式 CA/ACME。
# 证书 SAN = compose 服务名 + localhost + 127.0.0.1（后者供容器内 HEALTHCHECK 回环探活）。
set -euo pipefail

CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$CERT_DIR"
DAYS=825

SERVICES=(node-1 hub)
for extra in "$@"; do SERVICES+=("$extra"); done

if [[ ! -f ca.key ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout ca.key -out ca.crt -days "$DAYS" -subj "/CN=Vessel Internal CA"
  echo "[gen] CA created: ca.crt（ca.key 离线保管，勿提交/勿分发）"
else
  echo "[gen] reuse existing CA: ca.crt / ca.key"
fi

for svc in "${SERVICES[@]}"; do
  if [[ -f "$svc.crt" && -f "$svc.key" ]]; then
    echo "[gen] skip $svc（crt/key 已存在；轮换请先删除旧文件）"
    continue
  fi
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$svc.key" -out "$svc.csr" -subj "/CN=$svc"
  openssl x509 -req -in "$svc.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "$svc.crt" -days "$DAYS" \
    -extfile <(printf "subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1" "$svc")
  rm -f "$svc.csr"
  echo "[gen] cert created: $svc.crt（SAN=$svc,localhost,127.0.0.1）"
done

echo "[gen] done. 轮换证书 = 删旧 crt/key 重跑 + docker compose restart；ca.crt 分发到所有互信容器。"