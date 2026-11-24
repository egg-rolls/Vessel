# q-media-view 调查与机制：media 图片 surfaced 到模型上下文

日期：2026-11-24 · 分支：feat/q-media-view · 承包商：q-media-view

## 用户裁决

模型本身是多模态 provider。media 应能把本地图片**直接加进调用模型上下文**（像用户消息
附图那样），模型原生看图；不需要独立 describe provider / tesseract。

## 调查结论（现有机制盘点）

0.56 视觉基座已具备「图片进模型上下文」的全部机件，缺的只是「工具结果 → refs」一段：

1. **用户消息附图机制**：`Message.refs`（`{kind:'image', path, sha256}`，
   `packages/core/src/types/provider.ts`）。图片字节**永不进 Message**；上传即落 blob
   （`vision/ingest.ts#ingestImageRefs` → `vision/blobs.ts#putImageBlob`，内容寻址
   `<dataDir>/blobs/sha256/xx/<sha>`）。
2. **请求期内联**：`ExecutionUnit.resolveAttachmentPlanFor` → `vision/plan.ts#resolveAttachmentPlan`
   扫**所有角色**消息的 image refs，按 sha256 读冻结 blob，产出 `AttachmentPlan`；
   适配器（`packages/core/src/provider/providers.ts` OpenAI 兼容 chat）命中
   `byMessageIndex` 的消息把 content 升成 `[{type:'text'}, {type:'image_url'}…]`。
   视觉后端挂在 provider 实例上（`plugins/provider/openai/src/vision.ts`，native）。
3. **tool result 现状**：`ToolHandler` 返回 `Promise<string>`；loop 写 `role:'tool'`
   消息（`tool-calling-loop.ts`），**没有** refs 通道。OpenAI 兼容传输的 tool 消息
   content 只能是字符串（图块会 400），所以 refs 不能直接挂 tool 消息。
4. **既有回执先例**：出口闸 `markToolResultBounded` / 执行位置 `markToolTransport`
   都是「handler 在 ctx 上登记 WeakMap 回执 → 管道认领 → 带出结果」，handler 签名不变。
5. **既有注入通道**：`MessageWindowPort.appendInjectedMessages`（loop 的空响应 nudge
   就用它）——身份盖章（`${runId}:inject:hook:<n>`）、`message.injected` 事件、落盘全复用。
6. **media 运行位置**：in-process（tools-engine 白名单只有 read/edit/write/bash），
   ctx 回执可用，无需动 engine 协议。
7. **GC / 投影**：blob GC 按文本扫会话壳 + 事件日志里的 sha256（`src/data/image-blob-gc.ts`）；
   `message.injected` / `tool.call.completed` 事件带 refs 即被覆盖。投影
   （`session/project-messages.ts`）保留 refs 与 sha256。

## 实现机制（最小侵入，全程复用既有通路）

```
media action=view
  → checkPath（边界/体积，既有）
  → ingestImageRefs（core：读文件→sha256→落 blob，既有）
  → attachToolImages(ctx, [ref])          ← 新回执（core/runtime/tool-attachment.ts）
  → 返回文本结果（path/mime/bytes/sha8 + 说明）
管道认领 takeToolAttachments → ToolPipelineResult.refs（additive）
ExecutionUnit.runToolCall → ToolExecutionOutcome.refs（additive）
  + tool.call.completed 事件带 refs（审计/GC）
loop：本批 tool 消息全部写回后
  → appendInjectedMessages 追加一条 role:'user' 消息（content=[tool image] 说明, refs）
请求期：resolveAttachmentPlan 扫到该 user 消息的 image refs
  → 适配器内联图块 → 多模态主模型直接看到图
```

关键取舍：

- **为什么注入 user 消息而不是给 tool 消息挂 refs**：OpenAI 兼容传输 tool 消息 content
  只能是字符串；user 消息附图是三家传输都支持的既有通路（正是「像用户消息附图那样」）。
  注入在整批 tool 结果之后，assistant(tool_calls)→tool*→user(图) 顺序合法；追加在末尾，
  前缀守卫天然满足。
- **为什么是 WeakMap 回执而不是改 ToolHandler 返回类型**：与出口闸回执同一判据——
  返回类型联合化会让所有既有调用点收窄，回归面太大；不用的工具零感知。
- **只 surfaced 已入池（带 sha256）的图**：没入池一定不内联（plan 记 `not_ingested`），
  不为它注入一条撒谎的消息。
- **投递不声称**：是否真内联取决于主模型视觉能力 / kill switch / 预算，事实由
  `image.sent` / `context.image_dropped` 事件表达（GUI 三态 chip 同源）。
- **media 注册门槛放开**：view 不需要任何外部 CLI 后端，插件 enabled 即注册
  （原「零后端不注册」改为「零 CLI 后端仅 read(文本)/view 可用」并告警）。

## 用法

```jsonc
// 工具调用（模型侧）
{ "action": "view", "path": "D:/photos/cat.png" }
```

- 支持后缀：png / jpg / jpeg / webp / gif / tif / tiff / bmp（后两者能否内联取决于
  主模型视觉后端的 formats 闭集；不支持时 plan 明确记 `unsupported_format`，不静默）。
- 单图入池上限 8 MiB（`IMAGE_INGEST_MAX_BYTES`，与视觉后端单图上限同档）；
  路径边界 / deny 目录与 read 同一套。
- 结果文本带 sha8 与说明；图片随下一条 user 消息内联，模型原生看图。
- read / ocr / describe 行为不变（ocr/describe 仍按后端探测进 schema）。

## 行为验证（归用户）

1. config.yaml 启用 media 插件（opt-in）；主模型为多模态（provider 挂 vision 后端）。
2. 让 agent 调 `media {action:'view', path:<本地图片>}`。
3. 观察：工具结果文本 → 随后一条 `[tool image]` user 消息（Web 时间线带附件 chip）→
   `image.sent` 事件（sha8/tokens/backend）→ 模型回答能描述图片内容。
4. 无视觉能力 / kill switch 时：`context.image_dropped`（no_vision / vision_disabled），
   模型看不到图但事件留痕，不静默。

## 门禁

`bun run build`（typecheck root+examples+web + biome lint），读数记
`docs/dev/tmp/q-media-view/gates.log`。