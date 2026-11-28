# Changelog

> 本文件是 O(1) 当前态：**只保留当前版本的变更摘要**。
> 所有历史版本在 [`docs/versions/`](docs/versions/INDEX.md) 中按版本一文件保存，
> 索引见 [`docs/versions/INDEX.md`](docs/versions/INDEX.md)，当前版本见
> [`docs/versions/CURRENT.md`](docs/versions/CURRENT.md)。
>
> 变更记录遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 标准 SemVer（用户裁决 2026-11-25 终版）：breaking→major / feature→minor / fix→patch。
> 版本 = 代码契约身份，不绑发版节奏。major=2（单一真相源架构 breaking）。
> 管理规则见 [`docs/DOC-MANAGEMENT.md`](docs/DOC-MANAGEMENT.md)。

## [2.2.0] - 2026-11-28

> 功能批（batch8：七 feature + 两接缝修复，canary 全验 PASS，autogc3/webui4 分组验 + R-10/R-11 合轮复验闭合）。

### Added

- 上下文组合内省（q-context-composition）：runtime context composition source + RPC 内省面。
- 配置 set 白名单 + CLI set（q-env-config-set）：SETTABLE_KEYS 派生 + config-command set 三发回读热加载。
- 节点健康订阅（q-health-subscription）：node-health-watch 周期探测 + 订阅快照原子写 + 联邦降级 + node-listen 叶模块。
- Distress 人工兜底（q-distress-message）：parentless distress 路由人类收件箱。
- Peer notice cadence（q-peer-notice-cadence）：envGranularity live resolver 热改（mid-run 生效 pid 不变）。
- 消息工具栏（q-message-toolbar）：hover 工具栏 + 代码块/表格复制（IconButton 共享组件）。
- 消息引用（q-message-quote）：双向确定性文本信封（session-ref 同族）+ 草稿 quote 槽 + 历史/live/pending 三处同形引用块 + 锚点跳转。

### Fixed

- R-10：envInjection scope 词表单源化——三处消费点 Object.keys(DEFAULT_ENV_CADENCE) 派生 + EnvScopeWord 类型层单源（SettableConfigKey 模板字面量），除四份「人工对拍」副本（health 写路径放行）。
- R-11：node-health-watch 链式 re-arm——修单发定时器致启动 20s 后周期探测永停（订阅翻转通知空窗阻断）。

## [2.1.26] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.25] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.24] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.23] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.22] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.21] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.20] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.19] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.18] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.17] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.16] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.15] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.14] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.13] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.12] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.11] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.10] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.9] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.8] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.7] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.6] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.5] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.4] - 2026-11-27

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.3] - 2026-11-26

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.2] - 2026-11-26

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [2.1.1] - 2026-11-26

> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。

## [Unreleased]

> 飞书完善 P1（fix/q-feishu-p1）。含 D6 breaking：按 SemVer「breaking→major」，发版时主版本号递增。

### 变更（breaking）

- **飞书群聊默认 mention-only（D6）**：旧版本开通「全量群消息」权限（`im:message.group_msg`）后，机器人会响应群内任意消息；P1 起默认**只响应 @ 机器人的消息**（依据事件 `mentions[].mentioned_type === 'bot'` 判定）。
  - **兜底配置**：`feishu.mention_policy: all` 恢复旧行为（仍需 `im:message.group_msg` 权限）。
  - **升级提示**：升级后「群里 bot 不说话」先确认是否 @ 了机器人；确需旧行为再设 `mention_policy: all`。详见 [FEISHU.md §8](plugins/im/feishu/FEISHU.md)。

### 新增

- 飞书群聊可用性（A3）：`mapSdkMessage` 增映射 `mentions` / `senderId`（additive）；`@_user_N` 占位符按 mentions 清洗（bot 自身 @ 移除、他人 @ 还原为 `@名字`）；群聊消息喂 agent 前加发言人前缀 `[<open_id>]`（事件无姓名，离线不引通讯录 API）；`message.received` 事件 additive `sender_id`。新配置键 `feishu.mention_policy`（`mention-only` | `all`，默认 `mention-only`）。
- 飞书即时反馈与文案语言（A4，D4）：收到消息即点 👀 reaction 回执（`im.messageReaction.create`，emoji_type `EYES`），无权限/失败**静默降级**不影响回复；新配置键 `feishu.ack_reaction`（布尔，默认 `true`）。busy/超时/错误三态文案双语化（zh-CN/en），语言随节点 i18n（`VESSEL_LANG > ui.language > LANG > LC_ALL > zh-CN`）由装配注入插件，不新增用户语言配置；busy 文案说明排队上限（10）。
- 飞书发言人白名单（A5，D3=a）：新配置键 `feishu.allowed_user_ids`（open_id 数组，默认 `[]` = 不限，向后兼容）；非空时仅列表内 open_id 可驱动 agent，列表外/缺 `sender_id` **静默拒绝**。过滤链：chat 白名单 → 群聊 @ 策略 → 发言人白名单。FEISHU.md §7 安全警告强调「IM 驱动带工具 agent」真实暴露面，建议生产配白名单。
- 飞书同 app 唯一性守卫接线（A7）：`assertUniqueFeishuAppIds` 由「导出零调用」接入装配——gateway `resolveLocalNodes` 解析多节点后校验各节点 feishu `app_id`，重复即 `feishu_duplicate_app_id` **fail loud**（而非带病启动后被平台随机分消息「时灵时不灵」）；`vessel doctor` 增 `feishu_unique_app_id` 检查项，离线扫描本舰队 registry 各节点 config 发现重复（掩码报错）。

### 弃用

- 飞书 `feishu.session_prefix`（A6，D2=b）：标 **deprecated**——无运行时消费（成员寻址由 id `feishu_<chat_id>` 承担），保留校验以兼容旧 yaml（不即删、不炸旧配置）；配置仍写它时加载/doctor 给出警告。**下个大版本删除**，建议尽早移除。

## [2.1.0] - 2026-11-25

> 第四轮批次晋升（红蓝金丝雀验收 14–22 全闭环，ISSUE-CR22-1 / ISSUE-SS2-1 CLOSED）。
> feature→minor（RELEASE §1）；含第五轮四面（thinking-plugin / swr-refresh / context-fix / plugin-lifecycle-impl）搭晋升，金丝雀批次 B 验收候启动。
> 完整明细（合并链 / 验收 / 逐条变更与已知问题）见 [docs/versions/2.1.0.md](docs/versions/2.1.0.md)。

### 新增

- 任务看板（`kanban.get` / `kanban.archive` + 三列视图 + 勾选验收归档）/ 优雅停止·自重启（缺省 drain-to-quiesce + `restart --self` + `vessel ps`）/ 插件生命周期（per-capability + O5 badge + 注销 API）/ 思考强度插件 / SWR 刷新 / 拖拽引用 / inbox 编辑级联消费与撤回真删 / bash async 缺省不限时 / 配置责任链（显式 config > env）。

### 修复

- 卡片健壮性（permission 同构 P-A + PII 按需载体）/ hydration-anon（ISSUE-CR22-1）/ 上下文口径通知虚高 170K / plugin-ui-layer（ISSUE-SS2-1）/ 内置插件恒兼容去版本门禁 / skills-style / empty-state / DR15-1 优雅退出挂起（node 侧 CLOSED✅）/ DR15-2 platform 停 30s 看门狗污染（迭代 2 修复已合并 1aba69c0）。

### 变更

- 内置插件不再受 `engines.vessel` 版本门禁（第三方保护不变）；stop / restart 缺省不限时优雅 drain（用户裁定 #5），`--force` 唯一非优雅退出 + 审计。

### 已知问题（第五轮处置）

- ISSUE-DR15-1 node 侧 CLOSED✅（金丝雀 7 判据全 PASS）；ISSUE-DR15-2 迭代 2 已合并，候金丝雀 cli 修正判据复验闭环；plugin_manifest_invalid thinking-intensity（批次 B 登记）。
