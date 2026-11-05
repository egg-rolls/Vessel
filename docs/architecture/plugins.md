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
- **体验插件**（experience）：独立子进程，只经换行分隔的 JSON-RPC / DTO 与宿主通信，贡献 pages / commands / settings / rpc / events / panels；UI 在独立 origin 的 iframe 中运行。
- 两者同名 plugin、同一份清单与发现规则；差别只在执行位置与贡献面，不在扩展机制。贡献面由 harness（`packages/serve`、`apps/web`、CLI 装配层）收集，core 不感知。

## Manifest（`package.json.vessel`）

必填 `id / name / version / engines.vessel / entry`；可选 `side / ui / activationEvents / contributes / permissions / dependencies`。清单先于代码，解析或校验失败一律 fail-closed，不加载代码。

```jsonc
{
  "vessel": {
    "id": "usage", "name": "Usage", "version": "0.1.0",
    "engines": { "vessel": ">=0.43 <0.45" },
    "side": "both", "entry": "src/index.ts", "ui": { "dir": "web" },
    "activationEvents": ["onPage:usage", "onCommand:summary"],
    "contributes": {
      "pages": [{ "id": "usage", "title": "Usage", "nav": "observe", "entry": "usage.html" }],
      "commands": [{ "name": "summary", "title": "Usage summary" }],
      "settings": { "prices": { "type": "object" } },
      "rpc": [{ "name": "summary" }],
      "events": ["llm.response", "run.failed"],
      "panels": [{ "slot": "run-detail", "id": "usage-summary", "entry": "panel.html" }]
    },
    "permissions": { "fs": ["data-dir"], "net": [], "process": false, "secrets": false,
      "events": ["llm.response", "run.failed"] },
    "dependencies": { "plugins": [], "ordering": { "after": [], "before": [] } }
  }
}
```

- `id` 全仓库唯一；`contributes.events` 必须是 `permissions.events` 的子集；`rpc[].name` 只能是裸名，宿主注册为 `plugin.<id>.<name>`。
- `entry` / `ui.dir` 必须在 plugin 目录内（realpath containment）；覆盖内置插件需 `vessel.override: true`。

## 发现与激活

- 发现根优先级（高 → 低）：项目 `./.vessel/plugins` → 用户 `~/.vessel/plugins` → 仓库内置 `plugins/**` → `node_modules`。同 id 高优先级胜出；覆盖内置需 `vessel.override: true`，否则保留内置并告警，以 `plugin_id_conflict` 记录。
- 激活：`onStartup` 立即激活；`onPage:*` / `onCommand:*` 懒激活，首次页面访问或 `plugin.<id>.*` 调用时 spawn。安装 ≠ 激活；禁用 / 卸载与激活对称，清掉路由、订阅、子进程与定时器。

## 信任与能力边界

- 内置插件可信；外部插件默认不可信，安装时展示声明的 `permissions`（`fs` / `net` / `process` / `secrets` / `events` / `rpc`），未声明能力默认拒绝；显式 `plugins:` 条目视为信任确认。
- 子进程是崩溃 / 生命周期隔离：约束 cwd / env、负责回收与重启，并在宿主 API 调用点检查权限；它**不是 OS 沙箱**，不限制子进程拥有的用户权限。
- 不做 monkey-patch / 运行时改写 core 或其它 plugin；扩展点不够时先加贡献点。

## 对 Vessel 与 AI 流的作用

- 能力插件塑造 run：工具进入系统提示与工具表（每轮固定 token 税），provider 决定模型调用，hook / guardrail 在对应阶段改写或拒绝。
- 体验插件是旁路：只接收脱敏、DTO 化后的事件，提供 UI 与 RPC；不进入提示词，不修改事件语义，也不写 run 状态。

```
user input
   │
   ▼
Run ── BeforeLlm hooks / guardrails ──► Provider / LLM
   │                                      │
   │◄──── response events (redacted DTO) ─┘
   │
   ▼
tool loop ── capability tools (prompt surface = token tax)
   │
   └──► run events ──► experience plugin child ──► iframe UI / plugin.<id>.* RPC
```

## 热重载（E3）

- 体验插件可热重载：gateway 监听 project / user 插件目录与 `config.yaml` 的 `plugins:` 段，变更去抖 300ms；按 `id` diff，新增为 inactive，变更先 deactivate 再替换 descriptor（原 active 的重新激活），删除则 deactivate、注销 RPC 与静态路由。
- 能力插件是 in-process 模块，v1 不做真正卸载：改动后必须重启进程；`plugins.reload` 返回 `restart_required`，不谎报已重载。
- `plugins.reload`（permission `write`）返回 `{added, removed, changed, active, errors[], restart_required?}`；每次 reload 广播 `plugin.changed`（`plugins.list` 贡献快照），Web 重新拉取并增删导航 / 页面。
- **catalog**：`plugins.catalog`（read）返回 `{items}`；每项含 `id/name/version/scope/kind/mode/enabled/supportsToggle/restartRequired/status?/path/entry?/manifest?`。`scope` 是发现来源（builtin/user/project/node_modules）；`kind` 推导：in-process+builtin→builtin，child+非 builtin→marketplace，其余非 builtin→dynamic；`supportsToggle` v1 恒 true，`restartRequired = mode==='in-process'`，`status` 取 plugin host manager（无 manager 则缺省）；不含密钥 / registry 更新信息。
- 宿主在 iframe 加载完成与每次 `plugin.changed` 后调用 `plugins.catalog`，经 `postMessage` 推送 `{ type: 'vessel.catalog', items }`；插件 UI 以最后一条为准，iframe → 宿主方法面不变。
- Marketplace 只消费 `vessel.catalog` 渲染「我的插件」，不再本地扫描 `package.json.vessel`；`updates` 仍查 registry。旧 gateway / 推送失败显示「catalog 不可用」，不保留 A′ 本地扫描 fallback。

## 使用

- 命令：`vessel plugin list`、`vessel plugin install <path>`、`vessel plugin enable <id>`、`vessel plugin disable <id>`。
- Marketplace：浏览 / 安装 / 更新 / 删除走 `marketplace` 体验插件；registry、校验和与发布流程见 [plugin-registry](plugin-registry.md)。
- 配置：`config.yaml` 的 `plugins[].config` 作为 settings 在激活时下发；只保留 manifest `contributes.settings` 声明过的键，未声明键告警丢弃，类型不符 → `plugin_config_invalid`。
- 数据与日志：plugin 私有目录 `<dataDir>/plugins/<id>/`；stderr 写入 `<dataDir>/plugins/<id>/logs/plugin.log`（按 1 MiB 轮转）。全局 dataDir 只读，仅在 `permissions.fs` 含 `data-dir` 时下发。
- 编写：子进程入口用 Bun 直接跑 TS，处理 `plugin.hello` / `plugin.activate` / `plugin.event` / `plugin.rpc` / `plugin.deactivate`，只写 stdout 协议帧；Web 资源放 `ui.dir`，iframe `sandbox="allow-scripts allow-forms"` + CSP，经 `vessel.plugin.rpc` postMessage 调宿主桥，不接触 gateway token。
- 调试：`vessel plugin list` 的 status / error / events_dropped / restarts；崩溃 10 分钟内最多重启 3 次，超出禁用并保留诊断；`plugins.reload` 的 `errors[]` 只影响单个 plugin。

## 版本兼容

- `engines.vessel` 是 semver range，必须覆盖运行中的 Vessel 版本（根 `package.json` 的 `version`；当前 0.33.0）。不满足 → `plugin_version_incompatible`，不加载代码。
- `side` 不兼容、缺依赖、依赖循环同样拒绝激活；错误码见 `vessel plugin list` 与 `<dataDir>/plugins/<id>/logs/`。
