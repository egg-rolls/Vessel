---
adr: 44
title: 飞书渠道（插件 + 官方 SDK 隔离）
status: accepted
date: null
related: [4, 30, 34, 37, 39]
---

## ADR-044：飞书渠道（插件 + 官方 SDK 隔离）

- **上下文**：0.4 需要第一个真实 IM 入口，验证“人 ↔ Vessel”；WebSocket 长连接无需公网 IP。飞书官方 Node SDK 是重依赖，只能进插件包；core 的 `dependencies` 必须保持为空。个人微信无官方 API；公众号需要认证账号与公网 HTTPS，0.4 不做。
- **决策**：
  1. **形态**：工厂式插件 `plugins/im/feishu/`，包名 `@vessel/feishu`；加入 `FACTORY_PLUGINS`（短名 `feishu`）。官方 SDK 依赖只出现在该插件包。
  2. **传输抽象**：所有网络交互藏在 `FeishuTransport` 后；测试与 CI 使用 mock transport，零网络。SDK 只负责长连接与事件接收，业务语义在插件内。
  3. **配置**：`feishu.enabled / app_id / app_secret / domain / allowed_chat_ids / session_prefix / reply_timeout_ms / max_reply_chars / max_members`；**`feishu.agent_id` / `agentId` 已删除**，严格校验按未知键拒绝。环境变量 `VESSEL_FEISHU_APP_ID` / `VESSEL_FEISHU_APP_SECRET` 优先于配置。`reply_timeout_ms` 1..86400000；`max_reply_chars` 1..100000；`session_prefix` 非空且不含 `:` / 路径分隔符；`max_members` 1..64，默认 8。
  4. **专用 Host**：飞书渠道**自建专用 `InProcessRuntimeHost`**（core 公开类），`maxMembers = feishu.max_members`；不占用主 Host 的成员名额，**不改 core**。per-chat 懒 spawn 一个成员：`sessionId = feishu:<chat_id>`；agent id = `feishu_<sanitized chat_id>`（只保留 `[A-Za-z0-9_-]`，超过 64 字符时取前 55 + `_` + 8 位 hash）。同一 chat 串行；不同 chat 并行，受专用 Host 的 Scheduler 上限约束。
  5. **注入面**：asm 注入 `provider` / `model` / `pluginHost` / `session` / `events` / 可选 `contextFactory` / 可选 `runStore`；渠道把专用 Host 的事件转发到注入的 `events`（供 metrics / TUI / gateway 观测），不注入主 Host。
  6. **行为**：只处理 `im.message.receive_v1` 的 **text**；忽略机器人自己、非文本、重复 `message_id`（LRU 1000）。去重先于业务过滤；非文本消息也登记 `message_id`。单 chat 队列上限 10（只计 pending，running 不占名额），超出立即回复 `busy`；达到 `max_members` 时新 chat 立即回复 `busy`，不逐出已有成员（LRU 留 0.5）。
  7. **回复**：`im.message.reply` 到原消息；最终回复长度 ≤ `max_reply_chars`（含 `…(truncated)` 后缀）；`reply_timeout_ms` 到期取消该 run 并回复超时提示；`busy` 与超时提示文案稳定。
  8. **凭据**：任何日志 / 事件 / 错误不得输出 `app_secret` 或完整 `app_id`；只允许前 4 位 + `***`。凭据、token 不得出现在代码、测试、日志、报告或提交中。
  9. **控制面**：`FeishuStatus` / `FeishuChannel` 按 DECISION-009 §5.3.4；稳定错误 `channel_disabled` / `channel_not_connected` / `channel_auth_failed`；事件 `channel.feishu.*` 为开放字符串。
  10. **CLI 语义与运行模式**：`--feishu` 是**附加开关**。运行模式：
      - TTY + 无 `--serve`：REPL + 渠道同时运行；
      - 非 TTY + 无 `--serve`：**仅渠道前台**，不启动 REPL，阻塞到 SIGINT/SIGTERM；
      - `--serve [port]`：gateway + 渠道（无论 TTY）。
      仍与 `--run` / `--pipe` / `--resume-run` / `--tools` / `--version` / `--help` 互斥（退出码 2）。只有显式 `--feishu` 才启动渠道；`feishu.enabled: true` 单独不会启动。`--session` 允许，但只影响 REPL / serve，不影响飞书 session（始终 `feishu:<chat_id>`）。
  11. **失败语义**：配置错误 → 退出码 2；运行期连接/SDK 失败 → 退出码 1；错误必须明确，不静默降级；`start()` 失败不得被吞掉。运行中断线由 SDK 重连，状态事件如实上报。前台收到 SIGINT → 130，SIGTERM → 143。
  12. **非目标**：富媒体、卡片、@ 解析、thread 区分、多机器人、OAuth、个人微信；微信公众号/企业微信 0.5 再评估。
- **备选**：(a) 进 core——重 SDK 与渠道语义污染 core；(b) Webhook / 轮询——需要公网 HTTPS 或额外基础设施；(c) 个人微信——无官方 API；(d) 多渠道抽象层——0.4 只有一个真实渠道，抽象会变成 speculative generality。均不取。
- **后果**：core 零改动；飞书默认关闭；离线测试可用。只支持文本与单 chat 单 session；富媒体与 thread 留待后续。凭据处理成为硬门禁；`--feishu` 必须显式开启。
- **关联**：ADR-004、ADR-030、ADR-034、ADR-037、ADR-039；DECISION-009 §5.3 / §5.5 / §5.6 / §5.7 / §5.10 / §9 / §10.1 / §11.3 / §11.4 / §12.1 / §13.3 / §13.5。
