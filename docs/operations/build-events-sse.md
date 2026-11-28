---
title: 产物变更推送（/web/build/events SSE）与反代缓冲
kind: current
triggers: [SSE, build events, 产物, 推送, 缓冲, proxy_buffering, build.json, 轮询, 心跳, EventSource, 反代]
paths: [packages/serve/src/platform/server.ts, apps/web/src/app/useOutdatedBuild.ts]
---

# 产物变更推送（/web/build/events SSE）与反代缓冲

> 平台用一条 **SSE 长连接**（`GET /web/build/events`）把「Web 产物变了」推给浏览器。
> `/build.json` 仍是唯一事实源——推送的就是它的同一份 payload；推送不可用时前端自动退回轮询。
> 实现：`platform/server.ts:createBuildEventStream`；前端：`apps/web/src/app/useOutdatedBuild.ts`。

## 通道事实

- 产物重建 / 变成「源码比产物新」时，服务端在 **5 秒内**（`BUILD_EVENTS_TICK_MS`）推一帧
  `/build.json` 内容（含 `stale` / `newestSource`）；首帧连上即给当前真相。
- 空闲心跳：每 **25s** 一行 `: ping`（5 tick 一次）；首帧 `retry: 5000`。
- 有界：最多 **32** 条长连接（`BUILD_EVENTS_MAX_CONNECTIONS`），超了回 **503**
  （`Retry-After: 30`）让调用方退回轮询；判定由一个节拍器驱动，连接数再多遍历频率不变。
- 前端回退：自适应轮询 **10s → 30s → 60s**，连续失败到上限（10 次）就停；推送恢复即回到快档。
- 鉴权用 **会话 cookie**（登录后同源自动带）或回环 / Bearer：`EventSource` 带不了
  `Authorization` 头。**token 不进 URL**（会落进反代日志与浏览器历史；`/v1/events` 的
  token-in-URL 例外仅限那一个端点）。
- 没配登录后端（`authEnabled:false`）的部署：本通道与 `/build.json`、静态站点同等开放
  （匿名可读），不比静态文件多泄漏任何东西。

## 反代必须关掉缓冲

缓冲一开，SSE 帧会被攒在反代里、事件不即时（表现：提示等到连接结束才出现，或干脆不出现）：

```nginx
location /web/build/events {
  proxy_http_version 1.1;
  proxy_set_header Connection '';
  proxy_set_header Host              $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Vessel-Proxy-Secret <VESSEL_PROXY_SECRET 的值>;
  proxy_buffering     off;     # 关键：否则事件攒到连接结束才到
  proxy_cache         off;
  proxy_read_timeout  1h;      # 空闲连接有 25s 心跳，别让它被读超时掐掉
  proxy_pass http://127.0.0.1:8642;
}
```

- 平台侧已发 `X-Accel-Buffering: no` 与 `Cache-Control: no-store, no-transform`，nginx 会据此
  不缓冲；但**显式写 `proxy_buffering off` 才是确定行为**（别的反代 / CDN 不一定认这个头）。
- 密钥头注入与受信边缘规则见 [proxy-secret](proxy-secret.md)；公网部署全貌见
  [public-login](public-login.md)。

## 自检（只写不跑）

```bash
curl -N -H 'Host: <公网域名>' -H 'X-Vessel-Proxy-Secret: <值>' \
  http://127.0.0.1:8642/web/build/events
# 应立即看到 retry: 5000 与一帧 data: {...}，之后每 25s 一行 : ping
```