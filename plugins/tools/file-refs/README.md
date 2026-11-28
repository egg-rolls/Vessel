# file-refs（file-ux 插件 · composer 三槽 + toolbar action 贡献）

输入框文件引用 UX 的插件面：refs 槽原子卡片（`FileRefCard`）、link 槽消息卡片
（`FileRefLinkCard`）、drop 槽 OS 文件处理器（`onFilesDropped`）、toolbar action 档
「引用文件」入口（`onAttachClick` → 插件自持弹层：上传 / 粘贴 / 浏览）。设计冻结稿见外层仓
`docs/dev/design/file-ref-ux-plugin-design.md`（v2 A1–A9）；本文档是插件侧文档叶，
只记实现口径，不改冻结稿。

## 归属口径（ADR-099 / main 裁定）

- staging 上传 / preview / TTL GC / 目录浏览是**宿主 attachments 域通用能力**
  （`attachments.stage` / `attachments.preview` / `attachments.list`，
  `src/data/attachment-staging.ts`），不在本插件注册 RPC；插件 node 侧是空安装面。
- refs 尾注 hook（`src/data/refs-notice-hook.ts`）留宿主（refs 数据链路红线）。
- 宿主保留 vessel-ref 渲染（用户气泡 token 原位 chip + 剩余 refs 尾部 chip 行 =
  宿主原生，blocks.md §3.2 裁示①③）；**attach 入口归插件**（file-ref P3 D4：
  宿主 ComposerAttach / AttachDialog / attach-file 动作 id 已原子删除，A7 无断入口窗）。

## P3 入口链路（G9/G10 + GAP-1 裁 (a)）

- toolbar 贡献：`contributes.toolbar[{slot:composer, id:attach, action:onAttachClick}]`
  （0.51 declarative 闭集的 additive `action` 档：embed 具名导出，宿主点击时注入
  `ComposerEditorPort` + `VesselPluginHost`；无导出 / 无端口 ⇒ 不渲染死按钮）。
- 上传档：原生选择框（`showOpenFilePicker` 能力探测，非 Chromium / 非安全上下文
  降级 `input[type=file]`；AbortError 静默、取消不留占位卡）→ 共享暂存链路
  `staging.ts`（与 drop 槽同一条：瞬态占位卡 → `port.stage` → `addRef` → token 落定），
  插入位 = 光标位。
- 粘贴 / 浏览档：节点路径引用模式（无 TTL、不复制）；产物 = `addRef` + `insertAtomic`
  （token 同形，消灭「粘贴 ref 无 token」态）。形状校验 `attach-paths.ts` 自宿主迁入
  （宿主只留发送闸 `ATTACH_PATH_MAX`）；浏览经 `port.listAttachments`（additive 能力
  探测；数据源 = 页面所在节点：会话页当前节点 / 团队页团队节点）；旧 gateway 无
  `attachments.list` ⇒ 降级提示换粘贴。
- 弹层焦点圈 / Esc / 归还焦点 / body 滚动锁插件侧重建（宿主 ModalShell 不可 import）；
  文案走插件私有 i18n（`attach.*`）。

## A1 逐卡「随消息发送图像」开关（inline 生产者链路）

图片卡片落定态带小开关（`role="switch"`，默认**关**）：

```
FileRefCard 开关 → port.updateRef(index, { inline: true })   [sdk additive 契约]
  → 宿主草稿 store 按下标回写（只写 true 键 / false 删键）
  → 发送时 refs[] 随 runs.start / teams.post 透传
  → readRefsParam（只认 inline === true）→ attachment-ingest（inline === true 才入池）
```

- **只写 true 键**：缺省 / false ≡ 不内联（路径-only），与 P1a 契约闸逐字节同口径。
- **图片 ref 不携带 sha256**（staging.ts，drop / picker 共用）：stager 落 blob 去重保留，但 ref 带 sha
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