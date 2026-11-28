---
title: 消息块协议（信封规范 / type 注册表 / vessel-block fence）
kind: current
triggers: [block, envelope, quote, session-ref, vessel-block, fence, lift, registry, 块, 信封, 引用, 会话引用, 提升, 注册表, 固定标记, legacy]
paths: [apps/web/src/domains/chat/block-registry.ts, apps/web/src/domains/chat/lift-blocks.ts, apps/web/src/domains/chat/block-views.tsx, apps/web/src/domains/chat/quote-ref.ts, apps/web/src/domains/chat/session-ref.ts, apps/web/src/domains/chat/vessel-block.ts, apps/web/src/domains/chat/file-token.ts, apps/web/src/domains/chat/RefCard.tsx]
---

# 消息块协议

> 块 P0（渲染统一）+ P1（信封规范收敛）+ q-block-cardshell-unify（用户正文
> token lift + CardShell 统一视觉，§3.2）的现态契约。设计依据：外层仓
> `docs/dev/reports/architecture-block-bootstrap-design.md` §2（main 裁示见其 §9）与
> `probe-block-protocol-report.md`。两条产品核心不变量（[message-invariants](message-invariants.md)）
> 是本协议的硬约束：**可见性对等**（块必须有确定性的模型侧文本投影）与
> **请求 append-only**（新格式只对新消息生效，历史逐字节不变，legacy 解析器永久保留）。

## 1. 三层架构：数据层不动，wire 层收敛规范，渲染层统一

```
数据层（保持）   refs[] + blob 池 + attachments RPC + 边界闸 + 投递对账 + notice 总线
wire 层（收敛）  Message.content 内统一信封规范（文本） + Message.refs（文件数据） + name（runtime 上下文）
渲染层（统一）   liftBlocks(message, ctx) → LiftedBlock[] → block-registry[type].component → CardShell/StreamCard/轻量表面
```

- **主 wire = content 内文本信封**：零服务端改动；活过排队/重启/重放/编辑；模型读的
  就是信封 ⇒ 可见性对等天然满足。
- **refs 不扩展**：`Message.refs` 语义是文件附件（绝对路径 + `file|image|document`
  闭集 + 边界闸 + ingest），quote/session-ref 无路径，塞进去污染闭集。
- **结构化 `Message.blocks` 字段 = 远期按需（P3 不承诺）**：仅当非文本 payload /
  交互状态立项时引入，完全照 refs 的 additive 模式（provider 忽略 / 投影保留 /
  读侧 normalize / 旧数据降级），请求侧投影必须与 UI 同构。

## 2. type 注册表（block-registry.ts）

形态照抄 `components/link-enhancers.ts`（外部 Map + version + useSyncExternalStore），
不另造第二套注册机制。一个 type 一条 `BlockTypeSpec`：

| 槽 | 语义 |
|---|---|
| `type` | 宿主原生名（稳定闭集）或插件命名空间 `x:<pluginId>:<scheme>` |
| `surface` | `card`（CardShell 静态卡）/ `inline`（正文内）/ `light`（气泡附属轻量块） |
| `lift` | 识别 + 提升；认不出返回 `[]`（正文原样留给后续/原文渲染） |
| `component` | 经 `block-views.tsx` 薄适配既有组件，不重写组件内部 |
| `compose` | 用户发送序列化（只有文本信封类有） |
| `order` | lift/渲染顺序：quote(10) → session-ref(20) → image(30) → notice(40) → file(50) → vessel-block(60) → body |
| `owner` | `'host'` 或 pluginId；插件禁用/热更新按 owner 整组注销 |

- 宿主原生 type 在 `lift-blocks.ts` 加载时注册（消费点 import liftBlocks 即完成）。
- 插件贡献 type 经 composer-extensions 既有桥映射进同一张表（inline 表面；正文内
  渲染仍走 link-enhancers 查表，注册表只登记治理身份）。manifest 校验 /
  contributionsFor 透传 / embed bridge 加载全复用既有链。
- **未知 type 一律原文渲染**（兜底不变）。
- 表面统一的是 **token 与槽位契约，不是强制一个组件**：静态卡一律 CardShell；
  可折叠时间线块走 StreamCard（EnvCard/AgentMessageCard）；轻量附属块（quote，
  用户裁定）保留自有 class 共享 design token。

## 3. 统一信封规范（收敛既有 5 套）

1. **标记固定、locale 无关**。范本：quote `[引用消息`（刻意固定中文，AI 侧口径
   稳定）。反例已修（P1，main 裁④）：session-ref 头部曾用 `t()` 随 UI locale 漂移。
2. **严格形状 + 失败兜底 null**：完整形状才提升（header 行 + payload 行 + 空行）；
   流式未收全返回 null 原文渲染，语义逐字保留（否则流式闪烁回归）。
3. **既有格式全部保留为 legacy 解析器**（历史消息逐字节不变，不回填不改写）：

   | 信封 | 标记 | 解析器 |
   |---|---|---|
   | quote | `[引用消息 <id>]` / `[引用消息]` + `> snippet` | quote-ref.ts#parseQuoteEnvelope |
   | session-ref | `[引用会话]` / `[Referenced sessions]` 双词 + `- 「title」 · k: v …` 行 | session-ref.ts#parseSessionRefEnvelope |
   | tool image | `[tool image]` 注记 + 结构化 refs | transcript-items.ts#toolImageRefsOf |
   | refs 尾注 | `[refs] N attachments: …` | refs-notice-hook（服务端注入，Web 按 name 识别） |
   | runtime notice | `[runtime] <summary>` + `  · ` details 行 | env-notice.ts#runtimeEnvCard |
   | file token | `vessel-ref:` scheme markdown 链接 | 用户正文：file lift（file-token.ts → RefCard）；助手正文：link-enhancers / 插件 FileRefLinkCard |

4. **新 type 统一 fenced 格式**（见 §5 vessel-block fence spec）。
5. **块与 refs**：块**引用** refs（按 path/sha256），不复制字节、不替代 refs。
   image 块 = refs[kind=image] + 注记的渲染提升；file 块 = 正文 vessel-ref token
   卡 + 剩余 refs chip（occurrence 去重，见 §3.2）。数据通道（ingest/边界/投递）
   一个字不动。
6. **块与 notice**：notice 保持独立 runtime 通道（hook 注入 / scope 词表 /
   cadence / 签名去重），**不并入块 wire**——它是 runtime 事实不是业务内容，
   生命周期不同。统一只发生在渲染层：notice 注册为 block type（lift=runtimeEnvCard）。

### 3.1 session-ref 固定标记（P1 决策记录）

- **canonical（新发送恒写）**：头部 `[引用会话]`；field 固定 key `agent` / `team` /
  `node` / `session_id`。compose 不再走 i18n（`chat.sessionRef.field.*` 三键已删；
  `chat.sessionRef.header` 保留给 SessionRefBlock **显示侧**卡标题——显示侧随
  locale 合规，wire 侧不许）。
- **legacy（永久双认）**：头部 `[引用会话]` / `[Referenced sessions]`；field zh 标签
  `团队` / `节点`（canonical 优先：`team ?? 团队`、`node ?? 节点`；`agent` 双语同形）。
- **只对新发送生效**：照 refs-notice-hook 前缀不变三机制（永远末尾追加 / 历史
  notice 不重新渲染 / 进程内签名去重）的兼容口径——历史消息里 zh/en 两种拼法
  逐字节保留，解析侧双认，零回填。

### 3.2 用户正文 vessel-ref token lift（q-block-cardshell-unify 决策记录）

- **canonical 形状唯一**：`[name](<vessel-ref:path>)`（尖括号目标形，与
  RichComposer `buildAtomicToken` / 插件 drop-handler 同形）。只认完整形状：
  半截 token 正则不命中 ⇒ 原文保留（流式逐字不闪，与信封 null 语义同构）。
- **收进 file lift（order 50）**，不另立 type：单块契约保持（一个 file 块
  payload = `tokens[]` + 剩余 `refs` + 重排后 `imageDelivery`）。`role:user`
  only —— 助手正文的 vessel-ref 链接仍走 Markdown link-enhancers 内联卡
  （用户气泡正文是纯文本渲染，不经 Markdown，两侧零双出）。
- **去重镜像 composer**（`refsToAttachmentsFiltered` 同一口径）：token
  occurrence 按 path 计数消费结构化 ref（先到先配）——被消费的 ref 不再出
  chip（卡即其视图，继承 sha256 / 权威 kind / 投递状态），剩余 refs 照旧
  chip。每个 ref occurrence 恰好渲染一次（卡或 chip）。投递状态按**完整
  refs** 的 image 同序消费后分流（卡 / chip 各得其所）。
- **剥正文**：token 就地移除；整行只有 token 的行整行去掉（不留空行）；
  行内其余文字逐字节保留。正文全被消费时消费点不留空气泡。历史只读：
  只解析投影，不回填不改写 `Message.content`（复制 / 编辑仍拿原文）。
- **统一视觉（用户新 UI 方向③）**：静态文件卡 = CardShell + `RefCardRow`
  （左 ICON 槽 [缩略图 / 骨架 / RefIcon] + 右一行文件名 + 尾部徽标 / 投递
  chip）。ToolImageCard 图条目收敛同一行形（尺寸 / 字节收 hover 元信息）。
  取值两路不合并（§2.6 设计稿裁定）：匹配 ref → `useImageBlob`（sha256 +
  会话闸）；无 ref → `useAttachmentPreview`（既有 `attachments.preview`，
  path 寻址 + 过期探针）。点击：有字节 → ImageLightbox；无字节 → 复制路径
  （FileRefLinkCard 同语义，绝不导航；宿主无 PDF 字节预览通道，非图一律
  图标卡）。插件 bundle 零改动。

## 4. 双向发送路径

**AI→用户**（泛化唯一既有结构化注入通道，不新造工具）：

| type | 路径 | 状态 |
|---|---|---|
| quote | 模仿信封（双向同形已通） | 现态 |
| image | media view → attachToolImages WeakMap 回执 → loop 追加带 refs 的 user 消息 | 现态；泛化为 `attachToolBlocks` 是 P2（本批不做） |
| file | `[name](<vessel-ref:path>)` markdown 链接 | 现态 |
| table/code | markdown 原生；结构化场景 AI 产出 vessel-block fence | fence 试点见 §5 |
| notice | 宿主 hook 注入，**不开放给业务块** | 现态 |

不做 `send_block` 专用工具：media 回执模式已证明「工具结果附带结构化内容 → loop
追加注入消息」是最小侵入路径；新造工具会多出第二套注入语义，且与「owner 回复
文本人类直接可见」既有裁定冲突。

**用户→AI**（composer）：草稿态 composerDraftStore quote/sessionRefs/refs 槽；
发送序列化固定顺序 quote 信封最外 → session-ref 块 → 正文（useChatSubmit）；
refs 走结构化参数不进正文。插入 UX 走 RichComposer 原子 scheme（新 type = 新
scheme 贡献或宿主原生动作），不需要第二套富编辑器。发送闸门（refs 形状校验 /
路径边界 / 条数上限 32）全不动。ComposerBlockBar 泛化本批不做。

## 5. vessel-block fence spec（新 type 统一格式，文档先行）

````
```vessel-block
{"type":"table","caption":"…","columns":[…],"rows":[…]}
```
````

- **info string 精确匹配 `vessel-block`**（不带其他 info 词；与用户手打文本碰撞
  概率极低）。试点只认 ``` 围栏（`~~~vessel-block` 不提升，按原文渲染）。
  markdown 原生：解析器已认 code fence，AI 可直接产出（就是写一段 fenced
  code，无需新工具）。
- **闭合才认**：流式期未闭合围栏不提升——既有保守策略（markdown-parse 把未闭合
  fence 吃到 EOF）按原文降级为 code 块逐字渲染，正文一行不丢。
- **按 type schema 校验**：JSON 解析失败 / type 未注册 / payload 形状不对 ⇒
  不提升，fence 原文渲染（markdown code 块兜底，不猜、不吞字）。
- **模型侧投影 = fence 原文**（可读 JSON），可见性对等天然满足。
- **markdown 原生优先裁定**：Markdown.tsx 已原生渲染 table（横向滚动 + 复制按钮）
  与 code（lang 徽标）——简单场景**不需要** vessel-block，直接写 markdown。
  fence 只用于结构化 payload 场景；**不为 table/code 造独立卡**。

### 5.1 试点范围（P1，最小）

- **整条正文恰为一个闭合 vessel-block fence**（前序信封剥掉后，trim 比较）才
  lift；正文中段 fence 保持 markdown 原生 code 渲染（原生够用裁定的直接推论）。
  这与 lift 契约「一条消息每个宿主 type 至多提升一块」一致。
- **试点 type = `table`**，schema（严格，坏 payload 原文兜底）：

  ```jsonc
  {
    "type": "table",            // 必填，精确匹配
    "caption": "…",             // 可选，非空字符串
    "columns": ["列1", "列2"],  // 必填，非空字符串数组，≥1 列
    "rows": [["a", "b"]]        // 必填，数组；每行是字符串数组且长度 == columns.length
  }
  ```

  单元格只收字符串（数字/嵌套/缺列一律拒收 → 原文渲染）；行可为空数组（空表合法）。
- **渲染复用 Markdown 原生 table**：payload → markdown 表格文本 → 既有 Markdown
  组件（组件复用第一原则，不造新卡）。caption 渲为表格前强调行。
- 注册进 block-registry（`type:'vessel-block'`，order 60，surface card 档但组件
  复用 Markdown），lift 管线见 lift-blocks.ts。

## 6. 兼容与迁移

| 既有资产 | 策略 |
|---|---|
| quote 信封 | 格式不变；lift 已收编注册表 |
| session-ref 信封 | 新消息固定标记（§3.1）；旧消息双词 + zh field legacy 永久 |
| [tool image] 注记 + refs | 不动；ToolImageCard 经注册表消费 |
| vessel-ref token + 插件卡 | 用户正文 token 提升为宿主 RefCard（§3.2）；助手正文 link 槽不动（x:file-refs:vessel-ref 登记不变），插件 bundle 零改动 |
| vessel:notice / [refs] / [runtime] | wire 不动；notice lift 收编 |
| 历史消息（无 message_id / 旧 locale 头部） | 全走 legacy 解析器 + 既有降级；**不回填不改写** |
| 旧 gateway / 旧 node | images.blob not_found ⇒ 元数据 chip（既有）；无 composer 贡献 ⇒ 空注册（既有） |

流式硬约束逐字保留：**信封未收全返回 null / 不提升半截块**（quote / session-ref /
vessel-block fence 同语义）。

## 7. 边界与红线

- **[message-invariants](message-invariants.md)**：可见性对等（§1）与请求
  append-only（§2）是本协议全部决策的推导前提；任何「读侧滤镜」式重解析改写
  历史都违规。
- **[ADR-099](../adr/ADR-099-plugin-contribution-surfaces-and-trust.md)**：数据面
  归宿主（refs/blob/attachments/边界闸/投递对账），UX 面可插件（块的渲染组件与
  composer 插入经 contributes 贡献）；插件 type 带 `x:` 前缀防撞名，信任/加载/
  注销全走既有插件机制，不新造第二套。
- **本批不做（P1 红线）**：wire/服务端结构化字段（Message.blocks，P3）；refs
  扩展；notice 并入块 wire；AI attachToolBlocks（P2）；ComposerBlockBar；历史
  回填改写；为 table/code 造独立卡。