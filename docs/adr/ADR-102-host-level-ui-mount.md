---
adr: 102
title: 宿主级 UI 挂载（插件贡献受控组件，同 origin 渲染）
status: accepted
date: 2026-11-12
accepted: 2026-11-18
related: [34, 43, 46, 48, 99]
tags: [plugin, extension, contribution, trust, ui, web, isolation]
---

## ADR-102：宿主级 UI 挂载

- **状态**：accepted（2026-11-18 用户裁定，实施切片 `feat/plugin-react`）。落地契约见
  [plugin-embed](../architecture/plugin-embed.md)。本 ADR **修订 ADR-099 第 6 条**（禁止
  monkey-patch / 运行时改写；扩展点不够时先加贡献点）。§6 在当时是对的方向，但它把
  「插件参与既有页面的渲染」这条路整体封死了 —— 0.51 的 inbox 插件化发现这是个真实能力缺口。
- **上下文**：
  - 今天插件 UI 只有两条路：manifest 的 pages（独立页）与 toolbar（工具条按钮）；第三方
    组件恒跑在 opaque iframe（sandbox 只给 allow-scripts / allow-forms，没有
    allow-same-origin），因此插件**物理上**拿不到宿主 DOM、拿不到宿主 CSS 变量。
  - 0.51 想把「待处理队列」搬进插件时撞上的具体缺口：条带里的「收回来编辑」需要把正文
    写回**宿主**的输入框草稿槽；列宽变量（--chat-content-w / --content-pad-inline）跨不过
    iframe；iframe 高度变化还会让常驻条带顶得输入框跳动，而高度协商协议今天不存在。
  - 换句话说：**不是插件缺少能力声明，而是宿主没有「让渡渲染位」的契约。**
- **决策**：
  1. 新增贡献点 contributes.mounts[]：插件声明「我要在宿主某个具名挂载点渲染一块」，
     声明里包含挂载点名、组件入口、依赖的端口（端口面见 ADR-099 的第 5 条与 0.51 期 0）。
     **实施分期：mounts 放 P3；一期（P2）只做 pages 内嵌。**
  2. 挂载点是**宿主定义的白名单**（例如 chat.pending、chat.composer.below），插件不能
     自造挂载点。宿主决定挂载点的布局契约（宽高、可滚动、空态）。挂载点集合的版本化
     随 P3 的 mounts 契约一起定。
  3. 渲染方式：插件产出**受控 React 组件**（同 origin 模块，由宿主 import 后渲染），
     而不是 iframe。组件只能通过宿主注入的 props / 端口拿数据与动作，不得直接摸
     window、不得写全局样式。一期实现为：运行时原生 `import()` 加载插件 ESM（lib 模式
     构建、react 等 external），React 单例由宿主 vendor shim（`globalThis.__VESSEL_SHARED__`）
     + import map 保证；iframe 保留为未受信档与兜底。Module Federation 否决；
     Shadow DOM 不作为默认（见决策 7）。
  4. **信任分级（服务端计算，前端只消费）**：`plugins.list` 输出
     `ui_trust: "embedded" | "isolated"`，判定规则：
     - builtin（repo 源，随 release 发布）→ embedded。
     - user / project 来源：默认 isolated；仅当 config.yaml 存在显式
       `plugins[].trust_ui: embedded`（用户确认，**独立于**进程权限的 `plugins:` 条目语义）
       且 sha256 哈希锁一致时 → embedded。哈希锁在首次确认时钉住当前 embed bundle 哈希
       （TOFU），之后 bundle 变化 → 降级 isolated 并要求重新确认，防确认后悄悄换包。
     - marketplace / node_modules 来源：默认 isolated；签名校验（registry 签发、宿主内置
       公钥）放 P4，一期不做。
     - ADR-099 §5「显式 plugins: 条目算信任确认」只覆盖进程权限；内嵌 UI 风险更高
       （等同授予该插件对 Web 控制台的全部权限，含会话凭据），单独要一次确认。
  5. 宿主动作表：挂载组件只能调用宿主显式暴露的动作（例如「回填草稿」「领取消息」），
     动作表与端口面分开维护，避免一个组件顺手就能调用任意 RPC。随 mounts 放 P3。
  6. **样式**：class 前缀约定 + 构建期校验 + 宿主 review，不上 Shadow DOM。插件 CSS 必须
     包在 `@layer plugin.<id>`（层级在宿主 utilities 之前）；选择器必须以
     `[data-vessel-plugin="<id>"]` 或 `.vp-<id>-` 开头；禁止 `:root` / `html` / `body` / `*`
     与未加作用域的元素选择器，禁止定义 `--color-*` 等宿主 token。主题直接消费宿主
     CSS 变量（tokens.css），暗色自动生效。portal 不自建，统一走 host.toast / host.dialog。
  7. **版本契约**：manifest `ui.embed.runtime = { react, sdk }`（semver range）。宿主加载前
     校验，不满足 fail-closed 渲染明确错误卡片（`plugin_ui_incompatible`）并提供 iframe
     回落，不白屏。宿主 React 主版本升级视为破坏性变更：sdk 主版本同步提升并写
     CHANGELOG。sdk 包（`@vessel-agent/plugin-sdk`）版本跟随仓库版本；0.x 阶段每个 minor
     允许破坏，range 应钉住 minor。
  8. **同源前提（改变平台代理边界，用户已批准）**：平台代理新增**只读、仅 GET/HEAD** 的
     `/plugins/<id>/ui/**` 静态白名单（位于 `/nodes/<node_id>/` 代理前缀之下，只代理静态
     资源，不含插件 contributes.http 动态路由）。平台根路径 `/plugins/*` 仍然一律 404。
     由此 embed 资源与 WebUI 同源，CSP `script-src` 保持 `'self'`，仅追加固定 import map
     的 sha256（不引入 unsafe-inline / unsafe-eval）。
  9. **pages 必须提供 iframe 回退入口**：`pages[].entry` 保持必填；`component` 是 additive
     可选字段。isolated 档 / 加载失败 / 版本不兼容时回落 iframe。
- **后果**：
  - 正面：插件能真正参与既有页面；inbox 队列可以「逻辑归插件、渲染在宿主原生位置」；
    不再需要 iframe 高度协商，也不会顶动输入框。一期先让独立页（pages）拿到宿主主题、
    Tailwind utilities 与原生布局。
  - 负面 / 代价：**插件代码跑在宿主 origin**，能读 DOM 与 token —— 这是本 ADR 的核心风险，
    必须靠 trusted 白名单与代码审计承担，而不是沙箱；SDK 白名单只防误用，不防恶意，
    文档与安装文案不得把它说成沙箱（与 ADR-099 §4 同一原则）。样式隔离靠约定 + 构建校验
    + review；被改写页面的回归责任从插件作者转到宿主（挂载点变更 = 破坏性变更，要版本化）。
  - import map 是内联 script：CSP `script-src` 追加其**固定内容**的 sha256 哈希；import map
    JSON 是冻结契约，注入端（apps/web vite）与 CSP 端（serve gateway/auth.ts）必须逐字一致。
  - 缓存：embed 入口 `.mjs` 与未带哈希的 css 改 `no-cache`；带哈希 chunk 保持 immutable。
  - 热更新：`import(url?v=hash)` + ErrorBoundary key 变化重挂载；旧 ESM 模块无法从模块表
    卸载（会泄漏），有限次重载可接受，开发期频繁重载建议手动刷新。
  - 已知限制（先于本 ADR 存在）：代理模式下 iframe 页 URL 走 `/nodes/<id>/plugins/...`
    会被代理白名单拒绝，即代理模式插件 iframe 页今天本就不可用；embed 档是代理模式下
    可用的插件 UI 路径。本 ADR 不修 iframe 的代理可达性。
  - 回退：删除插件的 embed / mounts 声明即回到 iframe / 宿主自带渲染，宿主侧不需要回滚。
- **非目标**：
  - 不做运行时 monkey-patch，不允许插件替换宿主的既有组件实现 —— 只允许**在宿主指定的
    位置插入**。这条保留 ADR-099 第 6 条的原意，只放开「参与渲染」这一半。
  - 不放开第三方（未受信）插件的同 origin 渲染。
  - 本 ADR 不定义具体挂载点的布局，只定义契约与信任分级。
  - 一期不做：mounts / panels 内嵌（P3）、完整 SDK 与模板（P3）、确认流程 UI / 签名 /
    安全模式（P4）、React Fast Refresh 开发期热更（P3 之后再议）。
- **待定 → 已答（2026-11-18 用户裁定）**：
  1. trusted 判定谁来做：**服务端计算 `ui_trust`**。builtin 自动 embedded；其他来源需用户
     显式 `trust_ui: embedded` 确认（独立于进程权限条目）+ sha256 哈希锁；签名放 P4。
  2. 挂载点集合是否版本化：随 P3 mounts 契约一起定；一期 pages 的兼容性由 sdk semver +
     `ui.embed.runtime` range 表达。
  3. 样式隔离第一版：**class 前缀约定 + 构建期校验 + 宿主 review**，不上 Shadow DOM
     （它不是安全边界，且让 Tailwind / 宿主 token 复杂化）。