# 鉴权决策备忘 · P1（服务器迁移前）

状态：待 owner 拍板 ｜ 分支 `0.52-auth-review` ｜ 本文档只给决策，不改产品代码
采信前提（用户刚告知）：腾讯云单机尚未配置；将用 Nginx 反代；有安全组；**无 CDN/WAF**；
上一台 Django 只有 admin 需登录、用复杂随机字符串 ⇒ **单用户，无账号体系、无 IdP**。
上游：ADR-103（8642 职责与票据新能力项）、`gateway-plan.md` §4 P1 / §8 风险 / §9 拍板 / §10 未核实。

## 1. 结论先说

| # | 结论（一句话） | 选定值 |
|---|---|---|
| **D1** | TLS 归 Nginx，8642 **不**内置 TLS；8642/8644 只 bind 回环，并新增 fail-closed 反代信任 | `proxy.trusted: false`（默认）；Nginx 同机时显式 `true` + `proxy.trusted.peers: ["127.0.0.1/32"]` |
| **D2** | 票据用**非对称 Ed25519**，8642 持私钥签、8644 只持公钥验 | `ticket.alg=Ed25519`、TTL 60s、单次使用、`aud`+`org` 双绑定、`kid` 多代 |
| **D3** | 浏览器**今天**确实拿到 per-node token 原文；反代下等于公网任何人可拿 ⇒ **P0，阻塞上公网** | 先票据、后收口：`platform.legacy_credentials` 默认 true → false → 删端点 |
| **D4** | 登录用**服务端 session + HttpOnly cookie + 一次性配对码**；不上 JWT、不上 OIDC | `__Host-vessel_sid`；配对码 8×base32、TTL 10min、一次性、5 次错即作废 |

## 2. 关键事实（D3 的证据链，逐行可核对）

1. `packages/serve/src/platform/server.ts:105` — `address` 取自 **socket**（`srv.requestIP(req)?.address`）；全仓 grep `X-Forwarded-For`/`X-Real-IP` 无解析命中。
2. `platform/server.ts:108-110` — `if (!auth.loopback && !auth.ok)` 才 401 ⇒ **loopback 免鉴权**。
3. `platform/auth.ts:53-62` — 未配 `platformToken` 时匿名主体按 `loopback` 授予（:59-61）。
4. `platform/rpc.ts:157` — `if (!ctx.auth.loopback)` 才拒 `nodes.credentials`；同文件 `:200-206` 把 `{ token, mode:'token' }` **原样返回给浏览器**。
5. 结论（**推断，但链路每步有代码依据**）：Nginx 与 8642 同机 ⇒ socket peer = `127.0.0.1` ⇒ `loopback=true` ⇒ 公网 `curl https://<domain>/platform/rpc -d '{"method":"platform.nodes.credentials","params":{"nodeId":"..."}}'` 拿到全部 node token ⇒ 接管数据面。
6. 现有缓解**挡不住**：`hostAllowed` 在通配绑定时直接 `true`（`gateway/auth.ts:184`）；`originAllowed` 无 `Origin` 头即放行（同文件 `:191`），curl 天然无 Origin；同 Host 也直接通过（`:201`）。
7. 可复用的正确范式：node 侧 `/v1/local/token` 已同时校验「回环 socket + 回环 Host + 同源」（`gateway.ts:2848-2884`，注释明写「反代 / 通配监听时客户端 IP 仍可能是回环」）；node 侧非回环且无 token 时**拒绝启动**（`src/serve-auth.ts:114-121`）。8642 侧两者皆缺。
8. 平台网关无任何 TLS 字段（`platform/types.ts:41-66` 无 `tls`）⇒ D1「内置 TLS」是净新增，不是改写。
9. ADR-103:76 已写死终态：`platform.nodes.credentials` 必须停止返回 token 原文，「新旧两条路并存等于没修」——D3 的过渡窗口必须因此**默认关闭**，见 §4.3。

## 3. 威胁清单（按「攻击者能做什么」）

| 攻击者能力 | 现状 | 缓解 | 验证方式 |
|---|---|---|---|
| **公网扫描** 发现 8642/8644 | 安全组未配；8642 默认对外可用且只有 `/health`（ADR-103:46-48） | 安全组只放 443；8642/8644 bind `127.0.0.1` | `ss -lntp` 只显示 `127.0.0.1:8642`；`nmap -Pn -p 8642,8644 <公网IP>` 全 filtered |
| **反代后回环误判** 借 Nginx 假扮本地 | **成立且零凭据**：`server.ts:105-110` + `auth.ts:61`（正是 gateway-plan.md:128 风险 6） | D1 的 R1–R4（见 §4.1） | `curl -H 'X-Forwarded-For: 1.2.3.4' http://127.0.0.1:8642/platform/rpc` → **403** |
| **token 泄漏** 从浏览器取 node token | `rpc.ts:200-206` 明文下发，前端落 sessionStorage（`gateway/nodes.ts:164-172` 写入、`ConnectionProvider.tsx:223-236` 调用） | D3 五步迁移；票据不出 8642 | `nodes.credentials` 响应体匹配 `[A-Za-z0-9_-]{32,}` 命中数 **0**；`sessionStorage` 键集合无 token |
| **CSRF** 借用户会话打 `/platform/rpc` | `originAllowed` 仅带 Origin 时比对（`gateway/auth.ts:189-203`）；无 CSRF token | D4 清单：SameSite=Lax + Origin 必须存在且严格相等 + 双提交 | `-H 'Origin: https://evil.com'` 的写请求 → **403**；无 Origin 的写请求 → **403** |
| **暴力破解** 撞配对码 | 今天无登录端点（无会话概念） | 8×base32=40bit + 5 次错即作废并重生成 + 指数退避 + `/login` 5 req/min/IP | 连错 5 次后提示作废；第 6 次**即使正确**也 **401** |
| **票据重放** 抢一张票刷 RPC | 无票据（今天只有长期 token） | 60s TTL + `jti` 原子单次消费 + 缓存 TTL=exp+60s | 同票据第二次 → **401 `replayed`**；审计 `ticket_replayed` 计数 = 1 |

## 4. 四件事的决策细节

### 4.1 D1 · TLS 归属 = 强制前置 Nginx 终止

**结论**：8642/8644 不内置 TLS，只 bind 回环；TLS 全部在 Nginx 终止，并新增 fail-closed 反代信任开关。
**依据**：`gateway-plan.md:132` 给出 (b) 建议且工作量 0.5–1 人日；8642 无 TLS 字段（`platform/types.ts:41-66`）；node 侧已确立「远程必须 TLS + 显式 token」（`gateway.ts:2848-2856` 注释）。

**fail-closed 规则（五条，全部可判定）**

- **R1（默认拒绝）** `proxy.trusted=false`（默认）时，请求出现 `X-Forwarded-For` / `X-Real-IP` / `Forwarded` 任一 ⇒ 判 `loopback=false` 并**直接 403 `proxy_headers_untrusted`**。选 403 而非「降级成 401」：降级会静默表现为鉴权失败，运维会误判成 token 配错，不可判定。
- **R2（信任才解析）** `proxy.trusted=true` 时，仅当 socket peer ∈ `proxy.trusted.peers` 才采信头部；客户端 IP 取 `X-Forwarded-For` **最右一跳**；`loopback` 判定改用该解析值（`isLoopbackAddress`，`gateway/auth.ts:23-29`）。
- **R3（启动断言·令牌）** bind 非回环 且 `proxy.trusted!==true` 且未配 platformToken ⇒ **拒绝启动**，非 0 退出，错误码 `platform_requires_token`（照搬 `src/serve-auth.ts:114-121` 形态）。
- **R4（启动断言·自相矛盾）** `proxy.trusted=true` 但 `peers` 为空 ⇒ 拒绝启动，`proxy_peers_required`。
- **R5（收口）** 反代只暴露 443，`/platform/rpc` 是唯一写入口；静态兜底（`platform/server.ts:147-150` 落 `index.html`）不豁免鉴权。

**取舍**：0.5–1 人日，纯配置 + 一个 preflight 函数，零新依赖。
**若选「8642 内置 TLS」的代价**：+1.5–2 人日（`gateway-plan.md:132`）；且 Nginx→8642 仍需一条 TLS 连接（自签校验），证书生命周期进入进程内 ⇒ 与 ADR-103:85「票据私钥热态即违规」同性质，配置面翻倍而安全增益≈0（前端已由 Nginx 终止）。

### 4.2 D2 · 票据密钥 = 非对称 Ed25519（`kid` 多代）

**结论**：8642 持私钥签发，8644 只持公钥验签。
**依据**：ADR-103:69-72 已把「8642 签发短时节点票据（TTL 60s、`aud=node_id`、单次使用、绑定 Origin）」列为 8642 的**新能力项**，且要求签发在 gateway、校验在 node；`gateway-plan.md:134` 建议 (b) 非对称。
**文档冲突需同步修**：`gateway-plan.md:74`（B1 行）写的是「HMAC」，与 §9 建议 (b) 矛盾——本备忘采信 (b)，B1 表里的 HMAC 记号作废。

**票据字段**（`base64url(JSON body)` + 分离 64B 签名，不引 JWT 库）

| 字段 | 值 | 用途 |
|---|---|---|
| `v` | `1` | 结构版本 |
| `kid` | 公钥代际 id | 轮换 |
| `alg` | `"Ed25519"` | 固定串，禁 `none`/降级 |
| `aud` | `<node_id>` | 防跨节点搬运 |
| `sub` | `"owner"`（单用户） | 审计主体 |
| `iat` / `exp` | `exp = iat + 60000` | 60s |
| `jti` | 16B 随机 → b64url | 单次使用 |
| `org` | 规范化 `scheme://host:port` | Origin 绑定 |

**校验顺序（8644 侧；任一步失败即 401 并落 `reason`）**
1 结构解析 `bad_format` → 2 `v==1` `bad_version` → 3 `kid` 在公钥集 `unknown_kid` → 4 签名 `bad_sig` → 5 `exp>now` 且 `iat<=now+5s`（钟偏 5s）`expired`/`bad_iat` → 6 `aud==本 node_id` `bad_aud` → 7 Origin 规范化值 `== org` `bad_origin` → 8 `jti` 原子消费 `replayed`。
**`jti` 必须排在 4/6 之后**：否则未鉴权请求可灌满重放缓存（DoS）。

**重放缓存**：进程内 `Map<jti, exp+60s>`，上限 10k；超限 **fail-closed 拒新票**（`replay_cache_full`），不淘汰有效项。进程重启后缓存清空 ⇒ 重放窗口 ≤ 票据剩余 TTL ≤60s，可接受。

**密钥轮换（`kid` 多代）**：8642 侧 `ticket.keys: [{kid, priv_path, not_after}]`，签发永远用「最新且未过期」；8644 侧 `ticket.pubkeys` 同时含多代（未知 `kid` → `unknown_kid`）。流程：① 新 kid 公钥分发到所有 8644 → ② 等 ≥180s（TTL 60s + 缓存 120s）→ ③ 8642 切签发到新 kid → ④ 观察审计 `kid=old` 计数归零 → ⑤ 删旧私钥。
**验收**：旧私钥签出的固定测试票据 → 401 `unknown_kid`；审计 `kid=old` 计数在新窗口内为 0。

**取舍**：+1 人日（`gateway-plan.md:134`）；撤销清晰（node 沦陷 ≠ 得签名能力）。
**若选共享 HMAC 的代价**：任一 node 沦陷即可伪造**任意**节点票据（即 `gateway-plan.md:125` 风险 2「伪造=拿到公司钥匙」），且轮换必须同步改所有节点、无 `kid` 区分 ⇒ 无法灰度。

**施工坑（产品侧须知）**：单次使用 + 浏览器直连 8644 ⇒ 每调一次 node RPC 就要回 8642 换票；多节点引导是 N 张（`apps/web/src/gateway/bootstrap.ts:103-120` 已并行取 N 份凭据，正好对应）。建议 `POST /platform/ticket` 单张签发，前端在 401 `expired`/`replayed` 时**透明重取一次且只一次**。

### 4.3 D3 · 明文 token 下发的暴露面与迁移

**事实已确认**（§2 第 4 条）：`platform/rpc.ts:200-206` 明文返回，门只有 `rpc.ts:157` 的 `loopback`。
**暴露面评估（Nginx 反代 + 单用户）**：不是「已登录用户多拿一份 token」，而是「**未鉴权的公网访客直接拿到全部 node token**」——同一份 `loopback` 同时放过了 `server.ts:108-110` 的鉴权和 `rpc.ts:157` 的凭据门。故 **D1 是 D3 的前置**：D1 未修时，D3 的迁移毫无意义。
即使 D1 修好、攻击者必须持 platform token，明文 token 仍会进 sessionStorage（`gateway/nodes.ts:164-172`）⇒ 任何 XSS/浏览器扩展可读 ⇒ 换票据后 token 永不离开 8642。

**迁移五步（不一步断，但默认关闭）**
1. 新增 `POST /platform/ticket`（需鉴权），**保留** `nodes.credentials` 原样（此步纯新增，风险 0）。
2. 前端走票据路径，失败回退 credentials，开关 `ticket.enabled`（默认 false）。
3. `ticket.enabled=true` 设为默认；`nodes.credentials` 每次调用落审计（origin/ua/ip）。
4. `nodes.credentials` 仅在 `loopback===true` **且** `proxy.trusted===false` **且**无转发头时可用，否则 `410 gone`。
5. 一个发布周期后 `platform.legacy_credentials=false` 默认关闭 → 404 → 删代码。

> 与 ADR-103:76「新旧两条路并存等于没修」的关系：本方案的过渡窗口**默认关闭**（第 3 步起 `ticket.enabled` 为 true、legacy 路径被 D1 的回环判定收紧且带审计），不是并列双活；第 5 步是硬截止，写进发布检查单。

**验收**：`nodes.credentials` 响应体匹配 `[A-Za-z0-9_-]{32,}` 命中数 **0**（第 4 步起 410，第 5 步起 404）；`sessionStorage` 键集合不含 node token；审计出现 `credentials_legacy` 条目。

### 4.4 D4 · 登录方式 = 服务端 session + 一次性配对码

| 方案 | 单用户 + 无 IdP 下的评价 | 结论 |
|---|---|---|
| ① session + HttpOnly cookie + 一次性配对码 | 凭据不落 JS、可即时吊销、审计天然有主体、零新依赖 | **推荐** |
| ② JWT 自签 session | 无法即时吊销；单用户下 session 表成本≈0，JWT 只换来 `alg` 混淆类坑 | 否 |
| ③ OAuth2/OIDC | 需要 IdP + 回调域名 + 密钥托管；单用户是纯负债 | 否（见升级触发） |

**选定值**：cookie `__Host-vessel_sid`（`HttpOnly` + `Secure` + `SameSite=Lax` + `Path=/`，`__Host-` 前缀强制后三项）；会话表落 `<dataDir>/platform/sessions.json`（0600，重启失效可接受）；配对码启动时打印 stdout，8×base32（40bit）、TTL 10min、一次性。

**升级到 OIDC 的可判定触发（任一命中即升级；建议 1+3 同时命中才动）**
1. 需要第二个人访问同一实例（用户表长度 > 1）。
2. 需要按人分权（只读观众 vs 可执行 run 的操作者）。
3. 审计要求「谁」来自**外部权威**（公司目录、离职即失效）。
4. 需要分发到无 shell 的实例（SaaS / 多租户）。

**最小清单（每条带验证）**
- **CSRF**：写请求必须「带 `Origin` 且严格等于 `platform.origin`」+ 双提交 token。注意现状 `originAllowed` 无 Origin 即放行（`gateway/auth.ts:191`），登录态端点必须**额外**要求 Origin 存在。验证：`-H 'Origin: https://evil.com'` → 403；无 Origin 的 POST → 403。
- **限流**：`/login` 5 req/min/IP、`/platform/rpc` 60 req/min/IP，带 `Retry-After`。IP 取 R2 解析值（否则全部按 127.0.0.1 计成一个桶）。验证：20 并发第 6 个起 429。
- **登录审计**：jsonl `{ts,event,ip,origin,ua,result,reason}`，覆盖 `login_ok`/`login_fail`/`ticket_issue`/`credentials_legacy`/`ticket_replayed`/`deny`。验证：审计条数与注入事件数相等。
- **暴力破解**：5 次失败即作废当前码并重生成 + 指数退避（1,2,4,8…s，上限 60s）。验证：第 6 次**即使输入正确**也 401。

## 5. 施工顺序（P1 拆 7 步，每步可验收）

| 步 | 内容 | 人日 | 验收判据 |
|---|---|---|---|
| **P1-1** | D1 反代信任 R1–R5 + 启动断言 | 1–2 | 四断言成测试：带 `X-Forwarded-For` 的本地请求 **403**；`trusted=true` 时同请求 **401**；bind `0.0.0.0`+无 token 启动 **非 0 退出**；无转发头本地请求 **200** |
| **P1-2** | 8642 票据签发 + `kid` + `POST /platform/ticket` | 1–1.5 | 固定向量测试（同私钥同 body 票据字节稳定）；响应含 `kid`；60s 后同票 **401 `expired`** |
| **P1-3** | 8644 校验顺序 1–8 + 重放缓存 | 1–1.5 | 每条 `reason` 有单测（逐字段篡改）；同 `jti` 二次 **401 `replayed`**；`aud` 改他家 node → **`bad_aud`** |
| **P1-4** | 前端票据路径 + `ticket.enabled` 开关 | 1 | 开关 false 行为与今天一致（回归绿）；true 时 `sessionStorage` 无 node token |
| **P1-5** | 明文 token 收口（410 → 404） | 0.5 | 响应体 token 正则命中 **0**；审计出现 `credentials_legacy` |
| **P1-6** | 登录/会话 + CSRF + 限流 + 审计 | 1.5–2 | 错码 5 次作废；第 6 次 **429 + `Retry-After`**；跨站 Origin **403**；审计条数对账相等 |
| **P1-7** | `/platform/metrics` + `REMOTE.md` 检查单 | 0.5–1 | 指标含 `ticket_issued_total`、`ticket_rejected_total{reason}`、`remote_ip_loopback_ratio`（`gateway-capabilities.md:57`）；`REMOTE.md` 增「安全组只放 443 / 8642·8644 bind 回环」勾选项 |

合计 ≈ **6.5–9.5 人日**（+0.5 来自 D2 选非对称），与 `gateway-plan.md:40` 的 6–9 基本对齐。

**顺序不可换**：P1-1 必须先于 P1-2/P1-3（否则票据在回环误判下形同虚设）；P1-5 必须晚于 P1-4（否则前端断）。
**另需**在 `docs/operations/CONFIG.md` 登记新键 `proxy.trusted`、`proxy.trusted.peers`、`ticket.*`、`rate_limit.*`、`platform.origin`、`platform.legacy_credentials`（`gateway-plan.md:117`：未登记 = 隐形配置）。

## 6. 待用户确认（3 条）

1. **单机还是多机？** 单机（Nginx 与 vessel 同机）⇒ R2 只需信 `127.0.0.1`；多机 ⇒ `peers` 要含内网网段、XFF 跳数变化，且 8644 也必须前置 TLS。这是 `gateway-plan.md:141-143`「腾讯云形态未知」的关闭方式。
2. **域名 + 证书形态**：Let's Encrypt/certbot 自动续期，还是云托管证书？决定 `__Host-` 的 `Secure` 语义与 Nginx 配置片段。
3. **是否接受硬约束**「8642/8644 只 bind `127.0.0.1`、安全组只放 443」并写进启动断言（R3/R5）？代价是「临时直连调试」失效，换来可判定的 fail-closed。

> **未核实（保留 `gateway-plan.md:141-145`）**：8642 冷启 0.2–0.6s 目标机未复测；S1a–c 拆分仓库无据。另：本文的 loopback 结论依赖 `srv.requestIP` 返回 socket peer 的语义（Bun 行为，未在腾讯云目标机实测）——P1-1 落地时以 §3 威胁表第二行那条 `curl -H 'X-Forwarded-For'` 实测确认后才算结案。
