# file-refs（file-ux 插件 · composer 三槽贡献）

输入框文件引用 UX 的插件面：refs 槽原子卡片（`FileRefCard`）、link 槽消息卡片
（`FileRefLinkCard`）、drop 槽 OS 文件处理器（`onFilesDropped`）。设计冻结稿见外层仓
`docs/dev/design/file-ref-ux-plugin-design.md`（v2 A1–A9）；本文档是插件侧文档叶，
只记实现口径，不改冻结稿。

## 归属口径（ADR-099 / main 裁定）

- staging 上传 / preview / TTL GC 是**宿主 attachments 域通用能力**
  （`attachments.stage` / `attachments.preview`，`src/data/attachment-staging.ts`），
  不在本插件注册 RPC；插件 node 侧是空安装面。
- refs 尾注 hook（`src/data/refs-notice-hook.ts`）留宿主（refs 数据链路红线）。
- 宿主保留 vessel-ref 渲染器与 attach 入口（D3/D4 裁定口径，见审计报告）。

## A1 逐卡「随消息发送图像」开关（inline 生产者链路）

图片卡片落定态带小开关（`role="switch"`，默认**关**）：

```
FileRefCard 开关 → port.updateRef(index, { inline: true })   [sdk additive 契约]
  → 宿主草稿 store 按下标回写（只写 true 键 / false 删键）
  → 发送时 refs[] 随 runs.start / teams.post 透传
  → readRefsParam（只认 inline === true）→ attachment-ingest（inline === true 才入池）
```

- **只写 true 键**：缺省 / false ≡ 不内联（路径-only），与 P1a 契约闸逐字节同口径。
- **图片 ref 不携带 sha256**（drop-handler）：stager 落 blob 去重保留，但 ref 带 sha
  会被 vision plan 直接内联、绕过 inline 闸。开开关 ⇒ 发送时 ingest 读暂存路径入池
  （TTL 60min + 1h 宽限内有效；过期诚实降级 `not_ingested`）。
- chip 无 sha256 ⇒ 宿主 `use-ref-preview` 走 path 寻址 preview 路（既有回落）。
- 能力探测：旧宿主端口无 `updateRef` ⇒ 不渲染开关；过期 / 瞬态态不渲染。
- 已知局限：同路径双引用取 `findIndex` 首条（与 remove 同口径）。

## 兼容

- 历史消息只读渲染（link 槽卡片无开关）；已带 sha256 的历史 refs 幂等透传继续内联，
  前缀逐字节不变。
- 旧草稿无 inline 键 ⇒ 缺省关；草稿恢复保留 inline（`parseRefs` 只认 true 键）。
- 旧 gateway 不识别 inline ⇒ 丢键 ⇒ 不内联（fail-safe 与缺省同向）。

## 构建

```sh
bun run --cwd plugins/tools/file-refs build:ui   # tsc web + vite embed（产物提交）
```