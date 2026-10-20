---
adr: 36
title: Gateway 协议 v1——事件流之上的本地控制面
status: accepted
date: null
related: [7, 27, 29, 30, 34]
---

## ADR-036：Gateway 协议 v1——事件流之上的本地控制面

- **上下文**：0.1.0 需要给浏览器控制台（`apps/web`）提供后端，同时不把网络/会话/权限逻辑塞进 core。core 已有 EventStream（ADR-007/027/030）与事件化的权限、ask_user（ADR-029）；缺的是「事件流 → 网络协议」的适配层，以及运行提交/取消、会话列表、工具列表、同源静态托管。核心问题：控制面放哪、用什么协议、是否动 core。
- **决策**：
  1. 控制面放在 `@vessel/serve`，作为 **EventStream 消费者**；不改 core、不经过 PluginHost。
  2. 协议 `vessel.gateway/1`：HTTP `/v1` + WS `/v1/events`（SSE 作为只读兜底）；服务端分配 `seq`，环形缓冲默认 10000，客户端用 `?since=` 续订，截断发 `gap`。
  3. 运行异步化：`POST /v1/runs` 返回 202，结果经事件流推送；单 runtime / 单 context，串行队列（上限 100），取消用 `AbortController`。
  4. 权限与 ask_user 走事件桥（G1）：gateway 订阅请求事件、发布应答事件，不引入直接回调。
  5. 会话切换（G2）：传入 `context` 时，目标 session 不同则先 `setSessionId` 再 `clear`，由 runtime 从 `SessionBackend` 重载历史。
  6. 可选静态托管：`staticDir` 存在时同源托管 `apps/web/dist`；API 路径永不托管；路径穿越校验。
  7. 安全默认：绑定 `127.0.0.1`；Host / Origin 校验；WS 首帧鉴权（5s 超时，4401）；请求体 1 MiB；HTML CSP；无 `*` CORS。
  8. Agent team 协议延迟到 0.2：`team.*` 在 0.1.0 返回 `method_not_allowed`，类型草案留在 `protocol.ts`。
- **备选**：(a) 每个客户端自定义协议——前端/脚本/未来 peer 各写一套，重复且不一致；(b) 权限/ask 用直接回调桥——回到 ADR-029 之前的耦合；(c) 把控制面放进 core——违反「core 只放领域无关运行时」的能力准入；(d) 只用 SSE——取消与方法应答需要双向，WS 更合适（SSE 保留为只读兜底）。均不取。
- **后果**：Web / TUI / 脚本共享同一条事件流；协议可版本化；gateway 可嵌入其他应用（传 `runtime` / `context` / `staticDir`）。代价：单节点单 runtime，运行与事件历史在内存；跨节点 team 要等 0.2。`--serve` 需装配层传入 `context` / `pluginHost` / `staticDir`，G2 与静态托管才生效。
- **关联**：ADR-007、ADR-027、ADR-029、ADR-030、ADR-034；`ARCHITECTURE.md` §13；`packages/serve/src/protocol.ts`。
