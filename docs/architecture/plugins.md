---
title: Plugin 架构：能力插件与体验插件
kind: current
triggers: [plugin, plugin host, manifest, contribution, capability plugin, experience plugin, activation, reload, child process, trust, catalog, vessel.catalog]
paths: [plugins/**, src/plugin-loader.ts, packages/serve/src/plugin-host/**, apps/web/src/domains/plugins/**]
---

# Plugin 架构：能力插件与体验插件

> 决策见 [ADR-099](../adr/ADR-099-plugin-contribution-surfaces-and-trust.md)；接口与发现细节见 [extensions](extensions.md)；操作与生命周期见 [agents/plugins](../agents/plugins.md)。

## 一个机制，两种形态

- 只有一套 plugin loader / manifest / 生命周期；`PluginHost` 仍是 core 唯一的运行期注册入口，禁止第二套构造期注册表（`ModuleHost` / `ModuleRegistry`）。
- **能力插件**（capability）：in-process，`install(host)` 往 `PluginHost` 注册 tool / provider / guardrail / hook，直接影响 run 与模型输入。
- **体验插件**（experience）：独立子进程，只经换行分隔的 JSON-RPC / DTO 与宿主通信，贡献 pages / commands / settings / rpc / events / panels / toolbar；UI 在独立 origin 的 iframe 中运行。
- 两者同名 plugin、同一份清单与发现规则；差别只在执行位置与贡献面，不在扩展机制。贡献面由 harness（`packages/serve`、`apps/web`、CLI 装配层）收集，core 不感知。
- **归属级**：默认 Workspace plugin（一家公司）；Platform plugin 仅服务所有公司的基础设施（Hub / registry / marketplace 后端）。Team 是使用范围，不拥有插件。Workspace 插件独立包与 Workspace=公司数据目录仍未实现（target），见 [topology](topology.md) 的「未实现 / target」表与[插件归属](topology.md#插件归属)。
- **宿主面（0.49）**：插件 HTTP/WS 只注册在 **Node API**（`serve.port`；拆分模式缺省 8644，legacy `--serve` 仍 8642）。Platform Gateway 不承载、不反代插件路由，平台 `/plugins/*` 一律 404；插件 iframe 走 `nodeUrl`。settings 与 catalog 只有单份（不按 tenant 合并）。

## Manifest（`package.json.vessel`）

必填 `id / name / version / engines.vessel / entry`；可选 `side / ui / activationEvents / contributes / permissions / dependencies`。清单先于代码，解析或校验失败一律 fail-closed，不加载代码。

```jsonc
{
  "vessel": {
    "id": "usage", "name": "Usage", "version": "0.1.0", "engines": { "vessel": ">=0.43 <0.45" },
    "side": "both", "entry": "src/index.ts", "ui": { "dir": "web" },
    "activationEvents": ["onPage:usage", "onCommand:summary"],
    "contributes": {
      "pages": [{ "id": "usage", "title": "Usage", "nav": "observe", "entry": "usage.html" }],
      "commands": [{ "name": "summary", "title": "Usage summary" }],
      "settings": { "prices": { "type": "object" } }, "rpc": [{ "name": "summary" }],
      "events": ["llm.response", "run.failed"],
      "panels": [{ "slot": "run-detail", "id": "usage-summary", "entry": "panel.html" }]
    },
    "permissions": { "fs": ["data-dir"], "net": [], "process": false, "secrets": false,
      "events": ["llm.response", "run.failed"] },
    "dependencies": { "plugins": [], "ordering": { "after": [], "before": [] } }
  }
}
```

- `id` 全仓库唯一；`contributes.events` 必须是 `permissions.events` 的子集；`rpc[].name` 只能是裸名，宿主注册为 `plugin.<id>.<name>`。`entry` / `ui.dir` 必须在 plugin 目录内（realpath containment）；覆盖内置插件需 `vessel.override: true`。

## 发现与激活

- 发现根优先级（高 → 低）：项目 `./.vessel/plugins` → 用户 `~/.vessel/plugins` → 仓库内置 `plugins/**` → `node_modules`。同 id 高优先级胜出；覆盖内置需 `vessel.override: true`，否则保留内置并告警，以 `plugin_id_conflict` 记录。激活：`onStartup` 立即；`onPage:*` / `onCommand:*` 懒激活（首次页面或 `plugin.<id>.*` 调用时 spawn）；安装 ≠ 激活，禁用 / 卸载与激活对称清理路由、订阅、子进程与定时器。

## 信任与能力边界

- 内置插件可信；外部插件默认不可信，安装时展示声明的 `permissions`（`fs` / `net` / `process` / `secrets` / `events` / `rpc` / `ports`），未声明能力默认拒绝；显式 `plugins:` 条目视为信任确认。子进程只做到崩溃 / 生命周期隔离（约束 cwd / env、回收与重启、宿主 API 调用点检查权限），**不是 OS 沙箱**。
- **宿主作用域（0.51 期 0）**：`vessel.scope: 'node' | 'member'` 决定插件装在节点宿主还是成员身体上；只有 `member` 的 in-process 能力插件能申请 `permissions.ports`（闭集，当前只有 `inbox`），child 插件本期不给端口。端口是「宿主算好、按 body 切好、声明过才给」的值，不是句柄：`agentId` 绑死在端口上，投递状态机留在宿主。契约见 [extensions](extensions.md#plugin-ports)。
- 不做 monkey-patch / 运行时改写 core 或其它 plugin；扩展点不够时先加贡献点。

## 扩展面授权（`expose`）

外部 child 的 HTTP route / CLI command 需在 `config.yaml` 的 `plugins[].expose` 显式授权：
`http` 用 route id，`cli` 用 `path.join('.')`；builtin 启用即全部声明面生效、忽略
`expose`。有效面 = manifest 声明 ∩ `enabled` ∩ `expose`；serve 在启动 / reload /
enable / disable / config watcher 后重建 effective 路由表，catalog 的
`declaredSurface` / `effectiveSurface` 只是派生只读视图。未知 id warning + 忽略，
不接受 `true` 简写。

```yaml
plugins:
  - name: example
    enabled: true
    expose: { http: [directory], cli: [example.start] }
```

- **namespace**：外部插件 path 必须 `/plugins/<own-id>/<段>`，不得占其它 id 或 `/v1/`、`/api/` 等宿主保留面；manifest + serve 双重校验。
- **冲突**：单插件声明非法只排除该插件；只有 effective（已授权）路由跨插件 shape 冲突才整体 fail-closed（`effectiveSurface.http=[]`）；未授权声明不参与，不能 DoS。CLI 未授权按未知命令处理。

## 对 Vessel 与 AI 流的作用

- 能力插件塑造 run：工具进入系统提示与工具表（每轮固定 token 税），provider 决定模型调用，hook / guardrail 在对应阶段改写或拒绝。体验插件是旁路：只接收脱敏、DTO 化后的事件，提供 UI 与 RPC，不进入提示词、不修改事件语义、不写 run 状态。

```
user input
   │
   ▼
Run ── BeforeLlm hooks / guardrails ──► Provider / LLM
   │◄──── response events (redacted DTO) ──┘
   ▼
tool loop ── capability tools (prompt surface = token tax)
   └──► run events ──► experience plugin child ──► iframe UI / plugin.<id>.* RPC
```

## 热重载（E3）

- 体验插件可热重载：gateway 监听 project / user 插件目录与 `config.yaml` 的 `plugins:` 段，变更去抖 300ms；按 `id` diff，新增为 inactive，变更先 deactivate 再替换 descriptor（原 active 的重新激活），删除则 deactivate、注销 RPC 与静态路由。能力插件是 in-process 模块，v1 不做真正卸载：改动后必须重启进程；`plugins.reload` 返回 `restart_required`，不谎报已重载。
- `plugins.reload`（permission `write`）返回 `{added, removed, changed, active, errors[], restart_required?}`；每次 reload 广播 `plugin.changed`（`plugins.list` 贡献快照），Web 重新拉取并增删导航 / 页面。
- **catalog**：`plugins.catalog`（read）返回 `{items}`；每项含 `id/name/version/scope/kind/mode/enabled/supportsToggle/restartRequired/status?/path/entry?/manifest?/declaredSurface?/effectiveSurface?`。`scope` 是发现来源（builtin/user/project/node_modules）；`kind` 推导：in-process+builtin→builtin，child+非 builtin→marketplace，其余非 builtin→dynamic；`supportsToggle` v1 恒 true，`restartRequired = mode==='in-process'`，`status` 取 plugin host manager（无 manager 则缺省）；不含密钥 / registry 更新信息。
- **扩展面两视图**（CONTRACT-0.48 §8）：`declaredSurface` 来自 `contributes.http/cli`，只含 HTTP `id/method/path` 与 CLI `path/description`；没有声明或 in-process 插件时字段缺省。`effectiveSurface` 只在 `declaredSurface` 存在时出现：内置插件为 enabled 时等于声明面，外部插件为声明面 ∩ `enabled` ∩ config `expose`（未授权时数组为空）；HTTP 面冲突 fail-closed 时 `effectiveSurface.http = []`。两字段都是派生只读视图，不新增真相源。
- 宿主在 iframe 加载完成与每次 `plugin.changed` 后调用 `plugins.catalog`，经 `postMessage` 推送 `{ type: 'vessel.catalog', items }`；插件 UI 以最后一条为准。Marketplace 只消费该推送渲染「我的插件」，不再本地扫描 `package.json.vessel`；`updates` 仍查 registry，旧 gateway / 推送失败显示「catalog 不可用」，不保留 A′ fallback。

## 使用

- 命令：`vessel plugin list`、`vessel plugin install <path>`、`vessel plugin enable <id>`、`vessel plugin disable <id>`。Marketplace：浏览 / 安装 / 更新 / 删除走 `marketplace` 体验插件；registry、校验和与发布流程见 [plugin-registry](plugin-registry.md)。
- 配置与数据：`config.yaml` 的 `plugins[].config` 作为 settings 在激活时下发，只保留 manifest `contributes.settings` 声明过的键（未声明告警丢弃，类型不符 → `plugin_config_invalid`）；plugin 私有目录 `<dataDir>/plugins/<id>/`，stderr 写 `<dataDir>/plugins/<id>/logs/plugin.log`（1 MiB 轮转）；全局 dataDir 只读，仅在 `permissions.fs` 含 `data-dir` 时下发。
- 编写：子进程入口用 Bun 直接跑 TS，处理 `plugin.hello` / `plugin.activate` / `plugin.event` / `plugin.rpc` / `plugin.deactivate`，只写 stdout 协议帧；Web 资源放 `ui.dir`，iframe `sandbox="allow-scripts allow-forms"` + CSP，经 `vessel.plugin.rpc` postMessage 调宿主桥，不接触 gateway token。
- 调试：`vessel plugin list` 的 status / error / events_dropped / restarts；崩溃 10 分钟内最多重启 3 次，超出禁用并保留诊断；`plugins.reload` 的 `errors[]` 只影响单个 plugin。

## 版本兼容

- `engines.vessel` 是 semver range，必须覆盖运行中的 Vessel 版本（根 `package.json` 的 `version`），否则 `plugin_version_incompatible` 且不加载代码。`side` 不兼容、缺依赖、依赖循环同样拒绝激活；错误码见 `vessel plugin list` 与 `<dataDir>/plugins/<id>/logs/`。
