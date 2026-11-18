---
title: 插件内嵌 React UI（embed 档）契约
kind: target
triggers: [plugin embed, ui_trust, ui_bundle_hash, ui.embed, plugin-sdk, import map, vendor shim, PluginEmbed, PluginErrorBoundary, embedded, isolated, trust_ui, 内嵌, 插件 UI, 信任档, 哈希锁, 同源]
paths: [src/plugin-manifest.ts, packages/serve/src/plugin-host/**, packages/serve/src/platform/proxy-config.ts, packages/serve/src/gateway/auth.ts, packages/plugin-sdk/**, apps/web/src/domains/plugins/**, plugins/observability/usage/**]
---

# 插件内嵌 React UI（embed 档）契约

> 决策见 [ADR-102](../adr/ADR-102-host-level-ui-mount.md)（accepted）；插件机制总览见
> [plugins](plugins.md)。本文是 P2（宿主最小闭环）的冻结契约：一期只做 **pages 内嵌**，
> builtin 插件自动 embedded；mounts / 完整 SDK / 模板在 P3，确认流程 UI / 签名在 P4。
> 全部字段 additive：旧插件与旧客户端不受影响。按宪法不写测试 / 探针；行为验证由用户
> 手动完成，构建期检查只有 `bun run build`（typecheck + biome ci）与各构建产物读数。

## 1. 档位与信任（ui_trust）

- 档位只有两个：`embedded`（宿主 import 插件 ESM，同 origin 渲染）与 `isolated`（现状
  opaque iframe）。**服务端计算，前端只消费**，不得自行推断。
- 判定（对声明了 `ui.embed` 的插件）：
  1. builtin（repo 源）→ `embedded`。
  2. 其他来源：config.yaml `plugins[].trust_ui: "embedded"` 且哈希锁一致 → `embedded`；
     否则 `isolated`。`trust_ui` 缺省 = isolated。
- **哈希锁（TOFU）**：锁文件 `<dataDir>/plugins/<id>/ui-bundle.lock.json`，内容
  `{ "sha256": "<ui_bundle_hash>", "recordedAt": "<ISO8601>" }`，宿主侧写（不经插件子进程）。
  - `trust_ui: embedded` 且无锁 → 钉住当前哈希（写锁）→ embedded。
  - 锁存在且等于当前哈希 → embedded；不等 → **isolated，不自动更新锁**（P4 提供重新确认）。
  - 写锁失败（fs 错误）→ isolated（fail-closed）。
- `trust_ui` 是**独立于进程权限**的确认：ADR-099 §5 的 `plugins:` 条目信任只覆盖进程权限。
  一期没有 RPC 写路径（config.set 白名单不含 plugins[]）：用户手改 config.yaml，config
  watcher 触发 reload 后重算。确认流程 UI 在 P4。
- 安全措辞：embedded 等同「授予该插件对 Web 控制台的全部权限（含会话凭据）」；SDK 白名单
  只防误用，**不是沙箱**。

## 2. manifest additive 字段（src/plugin-manifest.ts）

```jsonc
"ui": {
  "dir": "web",
  "embed": {
    "entry": "embed/index.mjs",          // 必填，相对 ui.dir，必须 .mjs 结尾
    "css": "embed/index.css",            // 可选，相对 ui.dir，必须 .css 结尾
    "runtime": { "react": "^19", "sdk": "^0.54" }  // 必填，semver range
  }
},
"contributes": {
  "pages": [{ "id": "usage", "title": "Usage", "entry": "usage.html", "component": "UsageView" }]
}
```

- 类型：`PluginManifest.ui` → `{ dir: string; embed?: { entry: string; css?: string;
  runtime: { react: string; sdk: string } } }`；`PluginPageContribution.component?: string`。
- 校验（fail-closed，`plugin_manifest_invalid`）：
  - `ui.embed` 存在必须有 `ui.dir`；entry / css 走 `isSafeRelativePath`（词法 containment，
    与现状一致；realpath 防逃逸在服务期 static.ts）。
  - `runtime.react` / `runtime.sdk` 必须能被 `parseVersionRange` 解析（支持 `^` / `~`，见 §7）。
  - `component` 是 embed 模块的**具名导出**，形状 `^[A-Za-z_$][A-Za-z0-9_$]*$`；
    声明 `component` 必须同时有 `ui.embed`。
  - `pages[].entry` 保持必填（iframe 回退入口，用户已拍板）。
  - **保留段**：`contributes.http` 的 path 在 `/plugins/<id>/` 之后的第一段不得为 `ui`
    （embed 静态命名空间保留，防动态路由遮蔽 / 被代理误转发）。
- `mounts[]` 一期不解析（P3）。

## 3. wire 字段（plugins.list / plugin.changed，additive）

- `PluginListMetadata`（serve plugin-host/types.ts）与 web `PluginListItem`
  （gateway/types/protocol.ts）各加三个可选字段：

```ts
ui_trust?: 'embedded' | 'isolated';
ui_bundle_hash?: string;
ui_embed?: { entry: string; css?: string; runtime: { react: string; sdk: string } };
```

- `PluginRenderContributions.pages[]` 与 web `PluginContributionPage` 加 `component?: string`。
- 没有 `ui.embed` 的插件：三个字段缺省（不返回）。disabled 项沿用现状（不带 contributions）。
- 落点：manager 在 descriptor 加载 / reload 时计算 trust + hash，挂到 `PluginStatusEntry`
  （内部字段），`pluginListMetadata` 映射到 wire；`renderContributions` 输出 `component`；
  `mergePluginList` 不变；`plugins.list` 的 `result_schema` 同步加 `ui_trust`（enum）/
  `ui_bundle_hash`（string）/ `ui_embed`（object）（pages items 本就是裸 object，component
  无需改 schema）。
- **ui_bundle_hash 算法**：embedRoot = `resolve(uiDir, dirname(entry))`；递归收集其下所有
  文件，按相对路径（`/` 分隔）排序，逐文件 `sha256Hex(bytes)`，再对
  `concat(relpath + "\0" + fileHash + "\n")` 取 `sha256Hex`。embedRoot 不存在 / 不可读 →
  视同无 embed（字段缺省，fail-closed）。哈希覆盖 entry + chunks + css，防 TOFU 后换包。

## 4. 资源 URL 与同源（硬前提）

- **node 静态命名空间**：`/plugins/<id>/ui/<path>` → 服务 `uiDir/<path>`（static.ts
  parsePath 在 segments.length > 1 时剥掉首段 `ui`）。realpath containment、MIME、404
  语义不变。`/plugins/<id>/<path>`（iframe 页）不变。`ui` 段对 contributes.http 保留（§2）。
- **web 侧模块 URL**：`${nodeUrl}/plugins/${id}/ui/${entry}`。直连模式 nodeUrl = node
  origin；代理模式 nodeUrl = `<platformOrigin>/nodes/<nodeId>`（现状 ConnectionProvider）。
  两种模式下模块都与 WebUI **同源**。多 node：URL 天然带 node 前缀，不同 node 视为不同
  模块实例。
- **平台代理白名单**（proxy-config.ts，用户已批准改变「平台不反代 /plugins/*」边界）：
  - `checkProxyHttpPath(rest, method)`：rest 形如 `/plugins/<id>/ui/<...>`（`<id>` 合法段、
    后续段非空）时**仅 GET / HEAD** 放行；其他方法 → 405。 traversal 防护（safeRestPath）
    不变。proxy.ts 调用点传入 `req.method`。
  - 只代理静态资源：动态 http 路由不在 `/ui/` 命名空间（§2 保留段），不会被转发。
  - 平台根 `/plugins/*` 仍一律 404（isNodeOnlyPath 不变）；server.ts 边界注释更新。
  - 拒绝文案更新：embed 静态已可代理，iframe 页仍请直连 node。
- **已知限制**：代理模式下 iframe 页（`/nodes/<id>/plugins/<id>/*.html`）仍被白名单拒绝
  （先于本契约存在）；iframe 回退在代理模式不可用，embed 是代理模式可用路径。

## 5. 静态缓存（static.ts）

- `PluginStaticMount` 加 `embedEntry?: string` / `embedCss?: string`（相对 uiDir）。
- 响应文件的相对路径（相对 uiDir realpath 根，`/` 分隔）等于 embedEntry 或 embedCss →
  `Cache-Control: no-cache`；其余非 HTML 保持 `public, max-age=31536000, immutable`
  （chunk 文件名带哈希）；HTML 保持 no-cache + PLUGIN_CSP。
- 入口必须带 `?v=<ui_bundle_hash>` 加载（双保险，见 §8）。

## 6. React 单例：vendor shim + import map + CSP

- **注册**：apps/web `main.tsx` 在 createRoot 之前：
  `globalThis.__VESSEL_SHARED__ = { React, ReactDOM, ReactDOMClient, JsxRuntime, PluginSdk }`
  （均为 namespace import，与宿主 bundle 同一份模块实例）。
- **shim**：vite 插件在构建期 emitFile 到稳定路径（dev 用 configureServer 中间件同路径服务）：
  `/assets/vendor/react.mjs`、`react-dom.mjs`、`react-dom-client.mjs`、`jsx-runtime.mjs`、
  `plugin-sdk.mjs`。shim 只做静态具名导出 + default，全部取自 `__VESSEL_SHARED__`；
  未注册时 throw 明确错误（fail-closed）。react shim 具名导出覆盖 React 19 导出面
  （Children / Component / Fragment / Profiler / PureComponent / StrictMode / Suspense /
  cloneElement / createContext / createElement / createRef / forwardRef / isValidElement /
  lazy / memo / startTransition / use / useActionState / useCallback / useContext /
  useDebugValue / useDeferredValue / useEffect / useId / useImperativeHandle /
  useInsertionEffect / useLayoutEffect / useMemo / useOptimistic / useReducer / useRef /
  useState / useSyncExternalStore / useTransition / version）；react-dom：createPortal /
  flushSync / preload / preinit / prefetchDNS / preconnect / version；react-dom-client：
  createRoot / hydrateRoot；jsx-runtime：Fragment / jsx / jsxs。
- **import map（冻结常量）**：vite transformIndexHtml 在 `<head>` 内、第一个 module script
  之前注入 `<script type="importmap">` + 下面这串**逐字** JSON + `</script>`（tag 内不得
  添加任何空白）：

```json
{"imports":{"react":"/assets/vendor/react.mjs","react-dom":"/assets/vendor/react-dom.mjs","react-dom/client":"/assets/vendor/react-dom-client.mjs","react/jsx-runtime":"/assets/vendor/jsx-runtime.mjs","@vessel-agent/plugin-sdk":"/assets/vendor/plugin-sdk.mjs"}}
```

- **CSP**：内联 import map 受 script-src 约束。`buildContentSecurityPolicy`
  （gateway/auth.ts，node 与 platform WebUI 共用）的 script-src 改为
  `'self' 'sha256-JsT6ZWwn6/2gf6Vl12MVmyYFCLzmESS0MeB1fBIVxb8='`
  （上面 260 字节 JSON 的 sha256-base64）。不引入 unsafe-inline / unsafe-eval。
  该哈希与 import map 内容互为冻结契约：改一处必须同步改另一处并重算哈希。
- 插件 bundle 不得含 eval / new Function（构建期 guard 在 P3；一期靠 review）。

## 7. SDK（packages/plugin-sdk，一期最小面）

- 新包 `@vessel-agent/plugin-sdk`，version 跟随仓库（当前 0.54.0），exports `"." →
  ./src/index.ts`，peerDependencies react >= 19（照 plugin-ui 模式，按源码消费：apps/web
  vite alias + tsconfig paths；插件构建 external 化）。根 package.json 加 workspace 依赖。
- **semver 工具搬家 + 扩语法**：src/plugin-manifest.ts 的纯 semver 函数（parseSemver /
  isValidSemver / parseRangeVersion / compareSemver / parseVersionRange /
  satisfiesComparator / satisfiesVersionRange 及相关类型）移入
  `packages/plugin-sdk/src/semver.ts`；plugin-manifest.ts 改为 import + re-export
  （scripts/version.ts 等消费方不变）。`COMPARATOR_RE` 扩展支持 `^` / `~`（标准语义：
  `^x.y.z` = `>=x.y.z <(x+1).0.0`（x>0）；`^0.y.z` = `>=0.y.z <0.(y+1).0`（y>0）；
  `^0.0.z` = `>=0.0.z <0.0.(z+1)`；`~x.y.z` = `>=x.y.z <x.(y+1).0`；缺位补 0 规则不变）。
  不支持的语法仍返回 null / false（fail-closed）。
- **P2 类型契约**（P3 再加 router / dialog / actions / iframe transport / vesselEmbedGuard）：

```ts
export interface VesselPluginHost {
  readonly pluginId: string;
  readonly sdkVersion: string;
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>; // 裸名，宿主补 plugin.<id>. 前缀
  events: { subscribe(type: string, cb: (e: { type: string; payload?: unknown }) => void): () => void };
  theme: {
    get(): { mode: 'light' | 'dark'; lang: string };
    subscribe(cb: (t: { mode: 'light' | 'dark'; lang: string }) => void): () => void;
  };
  toast(msg: { kind: 'info' | 'success' | 'error'; text: string }): void;
  i18n: { t(key: string, vars?: Record<string, string | number>): string };
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
  permissions: { has(permission: string): boolean };
}
export interface PluginMountProps {
  host: VesselPluginHost;
  mount: 'page';
  context: { pageId: string; run?: string; session?: string };
}
export type PluginModule = Record<string, unknown> & { dispose?: () => void };
export function createPluginHost(adapter: PluginHostAdapter): VesselPluginHost;
```

- `createPluginHost`：`Object.freeze` 宿主对象；adapter 由 apps/web 提供（rpc 走 gateway
  client、theme 走宿主主题 store、toast 走 MessageBar、i18n 走宿主 t、events 走宿主事件订阅、
  log 走宿主日志面）。**每个方法内部再校验一次白名单**：rpc 裸名必须在 manifest
  `contributes.rpc` 内；events type 必须在 `permissions.events` 子集内。白名单只防误用。
- 不暴露 client / token / eventStore 原对象。
- `sdkVersion` = plugin-sdk package.json version（apps/web 构建期 define 注入，不在源码
  硬编码第二份）。宿主 React 版本直接 `import { version } from 'react'`。

## 8. 加载与 fail-closed（apps/web/src/domains/plugins/）

- **embed-loader**：加载前 `satisfiesVersionRange(React.version, runtime.react)` 且
  `satisfiesVersionRange(SDK_VERSION, runtime.sdk)`；不满足 → `plugin_ui_incompatible`
  卡片 + 「改用隔离模式」动作（iframe）。通过 → `import(url + '?v=' + ui_bundle_hash)`；
  取 `module[page.component]`，不是函数 → `plugin_embed_failed` 卡片 + 隔离动作。
- **PluginEmbed**：effect 内异步加载；loading 占位**固定尺寸**（不顶动布局）；ready 后渲染
  `<div data-vessel-plugin={id} data-mount="page">` 作用域根，内层
  `<PluginErrorBoundary key={id + ':' + hash}>` + `<Suspense>` 包组件。css 用
  `<link rel="stylesheet" href={cssUrl + '?v=' + hash}>` 注入，卸载移除。
- **PluginErrorBoundary**（新文件，class 组件）：渲染错误 → 插件级 ErrorState（插件名、
  错误摘要、重试（重置 state 重挂载）、「改用隔离模式」（本地切换渲染 PluginFrame）），
  上报日志，不影响宿主其它部分。
- **PluginPageView**：`page.component && plugin.ui_trust === 'embedded' && plugin.ui_embed`
  → PluginEmbed；否则 PluginFrame（现状不变）。isolated 档永远有 iframe entry（§2 必填）。
- **热更新**：plugin.changed → 对账得新 ui_bundle_hash → `import(url?v=新hash)` +
  boundary key 变化重挂载；切换前调用旧模块可选 `dispose()`；宿主按 pluginId 追踪 SDK
  订阅，卸载强制回收。旧 ESM 模块无法卸载（泄漏有限次可接受，文档写明）。
- **i18n**：新文案同时进 zh-CN 与 en 两份 catalog（key 集合由 typecheck 强制对齐）：
  loading / 错误标题与正文 / 重试 / 改用隔离模式 / 版本不兼容标题与正文 / 加载失败标题与正文。

## 9. 样式契约（一期：约定 + review，构建期 guard 在 P3）

- 宿主渲染作用域根 `<div data-vessel-plugin={id} data-mount={name}>`。
- 插件 CSS 包在 `@layer plugin.<id>`（位于宿主 utilities 之前）；选择器以
  `[data-vessel-plugin="<id>"]` 或 `.vp-<id>-` 开头；禁 `:root` / `html` / `body` / `*` /
  未作用域元素选择器；禁定义 `--color-*` 宿主 token。
- 主题消费宿主 CSS 变量（tokens.css）；暗色自动生效。插件不自建 portal，统一 host.toast。

## 10. 样本插件（plugins/observability/usage）

- manifest：`ui.embed = { entry: "embed/index.mjs", css: "embed/index.css",
  runtime: { react: "^19", sdk: "^0.54" } }`；pages usage / logs 加 component
  `UsageView` / `LogsView`（iframe entry 保留）。
- `web-src/embed.tsx`：具名导出 `UsageView` / `LogsView`（`PluginMountProps` 组件），
  数据走 `host.rpc('summary' | 'logs' | 'leaderboard')`，复用现有展示组件；不用
  iframe 桥（PluginRpcClient）。同一份 web-src 继续出 iframe 产物（现状 classic-script 流程）。
- `vite.config.embed.ts`：lib 模式 formats ['es']、entry web-src/embed.tsx、fileName
  index.mjs、outDir web/embed、emptyOutDir、cssCodeSplit false、external react /
  react-dom / react-dom/client / react/jsx-runtime / @vessel-agent/plugin-sdk、
  chunkFileNames `chunks/[name]-[hash].mjs`、assetFileNames `[name][extname]`、
  biome-ignore-all 头（照现有 generatedBiomeIgnore）。
- `build:ui` = `tsc -p tsconfig.web.json --noEmit && vite build && vite build --config
  vite.config.embed.ts`。产物（web/embed/**）入库，带 biome-ignore 头。

## 11. 分期边界

- **P2（本契约）**：上述全部。builtin usage 样本在直连模式内嵌渲染；代理模式同源加载。
- **P3**：mounts[] + 宿主动作表 + panels 内嵌；SDK router / dialog / actions / iframe
  transport 迁移（plugin-ui/host.ts）；vesselEmbedGuard 构建期校验；模板。
- **P4**：trust_ui 确认流程 UI（含重新确认 / 哈希锁管理）、marketplace 签名、安全模式。