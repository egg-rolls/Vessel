# 飞书连接指南（FEISHU）

> 适用：`@vessel-agent/feishu` 插件（官方 `@larksuiteoapi/node-sdk` WebSocket 长连接）。
> 本指南覆盖从零到「发消息收到回复」的全路径：**申请 → 权限 → 配置 → 连接 → 验证**，末尾附安全警告、升级说明与故障排查。
> 配置键速查见 [config.md](../../../docs/architecture/config.md)；配置层序与密钥规则见 [CONFIG.md](../../../docs/operations/CONFIG.md)。

## 0. 能力与边界

- 文本消息进、文本回复出（回复到原消息）；卡片 / 图片 / 文件输出为 P2 规划，当前不做。
- 每个 chat（单聊或群聊）对应一个独立临时成员（id `feishu_<chat_id>`），上下文互相隔离；事件 run_id 为 `feishu:<chat_id>`。
- 群聊默认**只响应 @ 机器人的消息**（mention-only，P1 行为变更，见 §8）；`mention_policy: all` 可退回旧行为。
- 即时反馈（P1）：收到消息先给原消息点 👀 reaction（需权限，未开通静默降级）；busy / 超时 / 错误三态文案随节点语言（zh-CN / en）。

## 1. 申请：开放平台创建应用

1. 打开[飞书开放平台](https://open.feishu.cn/)（Lark 国际版：[open.larksuite.com](https://open.larksuite.com/)）→ 开发者后台 → **创建企业自建应用**。
2. 「添加应用能力」中启用 **机器人**。
3. 「凭证与基础信息」页记录 **App ID**（`cli_` 前缀）与 **App Secret**。
   - App Secret 是凭据：**不要写进代码仓库 / 项目配置**，推荐用环境变量注入（见 §3 `app_secret_env`）。
4. 「版本管理与发布」创建版本并发布（企业自建应用需管理员审批）；**权限与事件订阅发布后才生效**。测试阶段可先把可用范围设为自己。

## 2. 权限：开通权限与订阅事件

「权限管理」中按 scope 名搜索并开通：

| 权限（scope） | 用途 | 必需性 |
|---|---|---|
| `im:message` | 获取与发送单聊、群组消息（基础收发） | 必需 |
| `im:message:send_as_bot` | 以应用的身份发消息 | 必需 |
| `im:message.p2p_msg` | 读取用户发给机器人的单聊消息 | 单聊必需 |
| `im:message.group_at_msg` | 接收群聊中 @ 机器人的消息 | 群聊必需（默认 mention-only） |
| `im:message.group_msg` | 获取群组中**所有**消息（敏感权限，需审批） | 仅 `mention_policy: all` 需要 |
| 消息表情回复（reaction）相关权限 | 👀 收到确认（权限列表搜「表情回复 / reaction」） | 可选：未开通静默降级，不影响回复 |

「事件与回调」中：

1. 订阅事件 **`im.message.receive_v1`**（接收消息）。
2. 订阅方式选择 **长连接（WebSocket）模式**——插件走官方 SDK 长连接，**不需要公网回调地址 / 内网穿透**。
3. 可用范围：发布版本时把要使用机器人的用户 / 部门纳入可用范围；群聊还需**把机器人拉进群**（群设置 → 群机器人 → 添加机器人）。

> 权限 / 事件变更后必须**发布新版本**才生效。「改了权限没发布」是「收不到消息 / 报无权限」的最常见原因。

## 3. 配置：Vessel 的 feishu 块

配置文件：用户级 `~/.vessel/config.yaml`、项目级 `vessel.yaml`（层序 `CLI > env > project > user > default`，见 CONFIG.md）。最小示例：

```yaml
feishu:
  enabled: true
  app_id: cli_xxxxxxxxxxxxxxxx
  app_secret_env: FEISHU_APP_SECRET   # 从该环境变量读 App Secret（推荐）
  # app_secret: xxxxxxxx              # 或直接写（不推荐：勿入项目配置 / 仓库）
  domain: feishu                    # feishu（默认）| lark（国际版）
```

在启动进程的环境里设置该变量（PowerShell `$env:FEISHU_APP_SECRET = "..."`；bash `export FEISHU_APP_SECRET="..."`；服务部署写进服务环境）。

凭据优先序（与 `vessel doctor` 同口径，P1 统一）：`VESSEL_FEISHU_APP_SECRET` > `env[app_secret_env]` > 显式 `app_secret`。`VESSEL_FEISHU_APP_ID` / `VESSEL_FEISHU_APP_SECRET` 两个环境变量也可直接覆盖 app_id / app_secret。

全部键（YAML 用 snake_case，loader 自动映射为 camelCase，直接写 camelCase 也接受；未知键严格拒绝）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关；`true` 且无凭据 → 启动失败（exit 2） |
| `app_id` | `''` | App ID（`cli_` 前缀） |
| `app_secret` | `''` | App Secret（推荐走 `app_secret_env`） |
| `app_secret_env` | `''` | 读取 app_secret 的环境变量名 |
| `domain` | `feishu` | `feishu` \| `lark` |
| `allowed_chat_ids` | `[]` | chat 白名单；空 = 不限。见 §7 安全 |
| `allowed_user_ids` | `[]` | **（P1 新增）** 发言人 open_id 白名单；空 = 不限。见 §7 |
| `mention_policy` | `mention-only` | **（P1 新增，行为变更）** 群聊响应策略：`mention-only` 只响应 @ 机器人；`all` 响应全部群消息（需 `im:message.group_msg`）。见 §8 |
| `ack_reaction` | `true` | **（P1 新增）** 收到消息是否点 👀 reaction；权限错误静默降级 |
| `session_prefix` | `feishu` | **（P1 起 deprecated，下个大版本删除）** 历史会话前缀，无运行时作用，仅保留兼容；新配置勿用，旧配置建议移除 |
| `reply_timeout_ms` | `300000` | 单次回复超时（ms），超时发超时文案 |
| `max_reply_chars` | `4000` | 回复截断长度（超长带 `…(truncated)` 后缀） |
| `max_members` | `8` | 保留的 chat 成员上限（1..64） |

> `reply_format`（text / card）为 **P2 规划**字段：当前仅文本回复，card 是可选增强不是替换，落地前写入会被按未知键拒绝。
> 表中 P1 新增 / deprecated 标记随本次升级生效；旧版本写入新字段会被按未知键拒绝。

## 4. 连接：启动长连接

```bash
vessel doctor          # 预检：feishu_credentials 等（离线检查，不做网络探测）
vessel start --feishu  # 启动飞书渠道（可与 --serve / REPL 同用）
```

- 连接成功输出：`飞书渠道已连接（cli_***）。`（App ID 掩码）。
- 配置错误（enabled 但缺凭据等）→ **exit 2**；doctor 与启动同口径，doctor 绿则启动门控绿。
- 长连接由官方 SDK 维护；连接 / 断开产生 `channel.feishu.connected` / `channel.feishu.disconnected` 事件。
- **同一个 app 同一时间只应有一条长连接**：同 App ID 起多个进程，消息会被随机分到其中一条（现象「时灵时不灵」）。P1 在装配 / doctor 增加唯一性守卫；手动多部署请确保一 app 一进程。

## 5. 验证：发消息收回复

1. **单聊**：飞书里搜索机器人名称 → 发送「你好」→ 应收到文本回复（回复到原消息）。
2. **群聊**：把机器人拉进群 → 发送「@机器人 你好」→ 收到回复。**不 @ 默认不响应**（mention-only，见 §8）。
3. **观测点**（Web 控制台事件流 / 事件历史）：
   - `channel.feishu.message.received`：data 含 `chat_id` / `message_id` / `message_type`；
   - `channel.feishu.reply.sent`：回复已发出；
   - `channel.feishu.error`：渠道错误（已脱敏）。
4. **取白名单所需 ID**：
   - `chat_id`：先给机器人发一条消息，再从 `channel.feishu.message.received` 事件的 `chat_id` 字段读取，填 `allowed_chat_ids`。
   - 发言人 `open_id`：开放平台「事件与回调」调试页查看 `im.message.receive_v1` 原始 JSON → `sender.sender_id.open_id`；或经开放平台 API 调试台通讯录接口查询。填 `allowed_user_ids`。

## 6. 反馈与文案（P1）

- **收到**：👀 reaction（`ack_reaction`；未开权限静默降级，不影响正常回复）。
- **排队 busy**：同一 chat 有任务在跑且队列已满（上限 10）时回 busy 文案，说明排队上限。
- **超时**：超过 `reply_timeout_ms`（默认 300s）回超时文案。
- **错误**：回脱敏后的错误文案（凭据一律掩码）。
- 三态文案随节点语言：`VESSEL_LANG` / `ui.language`（默认 zh-CN，可 en），由装配注入插件，不新增插件侧配置。

## 7. 安全警告（生产必读）

- **机器人 = 带工具的 agent**：任何能给机器人发消息的人都能驱动你的 agent（执行工具、读取上下文）。默认不限发言人——**强烈建议配置白名单**：
  - `allowed_user_ids`：只响应指定 open_id（P1 新增）；非空时列表外发言人**静默拒绝**（不回复、不驱动 agent）；事件缺 `sender_id` 无法核验时也拒绝。空 = 不限（向后兼容）。
  - `allowed_chat_ids`：只响应指定 chat；
  - 两者可叠加，过滤链：chat 白名单 → 群聊 @ 策略 → 发言人白名单（任一不满足即静默丢弃）。
- **凭据红线**：App Secret 只走环境变量（`app_secret_env` / `VESSEL_FEISHU_APP_SECRET`），不入项目 `vessel.yaml` / 仓库；错误输出统一掩码。
- **群暴露面**：`mention_policy: all` + `im:message.group_msg` 意味着机器人读取群内全部消息——只在可信群开启，并叠加白名单。
- **一 app 一连接**：同 app 多连接不仅随机分消息，也扩大凭据暴露面（见 §4 / §9）。

## 8. 升级说明（P1 行为变更）

- **群聊默认 mention-only（breaking）**：旧版本若开通了「全量群消息」权限，机器人会响应群内任意消息；P1 起默认**只响应 @ 机器人的消息**。
  - **兜底配置**：`feishu.mention_policy: all` 恢复旧行为（需 `im:message.group_msg` 权限）。
  - 升级后「群里 bot 不说话」：先确认是否 @ 了机器人；确需旧行为再设 `mention_policy: all`。
- **app_secret_env 口径统一（bug 修复）**：旧版本启动路径「显式 app_secret 优先」与 doctor「env[app_secret_env] 优先」分裂——两者并存时 doctor 全绿但启动用了另一个 secret。P1 统一为 doctor 优先序：`VESSEL_FEISHU_APP_SECRET` > `env[app_secret_env]` > `app_secret`。
- **session_prefix deprecated（下个大版本删除）**：无运行时作用（成员寻址由 id `feishu_<chat_id>` 承担）；保留校验以兼容旧 yaml（不炸旧配置），配置仍写它时 `vessel doctor` / 加载会给出 deprecated 警告；新配置勿用，建议移除。
- **新增字段**：`allowed_user_ids` / `mention_policy` / `ack_reaction`（见 §3）；旧版本写入会被按未知键拒绝。

## 9. 故障排查

| 现象 | 先查 |
|---|---|
| doctor 全绿但启动失败（`feishu_invalid`） | 旧版 app_secret_env 口径 bug（§8）；升级，或临时改用 `VESSEL_FEISHU_APP_SECRET` |
| 时灵时不灵 / 消息丢失 | 同 App ID 多进程多连接（§4）；一 app 一连接。`vessel doctor` 的 `feishu_unique_app_id` 检查项可离线发现本舰队重复 app_id；gateway 启动装配期重复即 fail loud |
| 群聊收不到消息 | ① 是否 @ 了机器人（mention-only 默认）② `im:message.group_at_msg` 权限且已发布版本 ③ 机器人在群里 ④ `allowed_chat_ids` / `allowed_user_ids` 白名单拦截 |
| 单聊无响应 | `im:message.p2p_msg` 权限；可用范围含该用户；`enabled: true` |
| 没有 👀 | reaction 权限未开通——正常静默降级，不影响回复 |
| 回复 busy | 同 chat 任务在跑且队列满（上限 10）；等上一任务完成 |
| 启动 exit 2 | 配置校验失败：`vessel doctor` / `vessel config explain` 查 feishu 块 |
