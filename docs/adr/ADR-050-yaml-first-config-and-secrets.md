---
adr: 50
title: YAML 主配置与密钥分层
status: accepted
date: 2026-10-18
related: [5, 19]
tags: [config, secrets, yaml]
---

## ADR-050：YAML 主配置与密钥分层

- **上下文**：0.4 已有用户级与项目级两层 YAML，但文档与示例长期把 `.env` 当作首选配置方式；密钥字段既可以直接写值，也可以走环境变量，来源不透明。0.5 要求固定位置的 YAML 主配置、可查询的来源、以及不会把密钥打印到输出或事件中的分层规则。
- **决策**：
  1. **配置层（冻结）**：用户默认 `~/.vessel/config.yaml`（provider、默认模型、`data_dir`、`tenant.default`、quota 模板；可含密钥但推荐 `_env`）；项目 `./vessel.yaml`（session、context、plugins、trace、tenant 覆盖；**禁止密钥**）；部署覆盖 `.env` / 进程环境（只放密钥与部署相关覆盖，不是主配置）；代码 `DEFAULT_CONFIG`（所有缺省值）。
  2. **优先级（冻结）**：`CLI > env > tenant overlay > project > user > default`。tenant overlay 不得覆盖 CLI/env；它叠加在项目/用户之上。层级来自 ADR-005，YAML snake_case ↔ TS camelCase 映射来自 ADR-019；本 ADR 不取代两者。
  3. **tenant overlay 合并**：对象深合并；数组整体替换；map（`mcp_servers`、`plugins`）按 key/name 合并；`null` 拒绝。允许/禁止块与 `data_dir` 全局约束见 ADR-049。
  4. **`_env` 间接引用**：所有接受密钥的字段支持 `<field>_env`（如 `api_key_env`、`provider.api_key_env`、`feishu.app_secret_env`、`serve.token_env`、`serve.admin_token_env`）。规则：字段显式值优先；否则读 `<field>_env` 指向的环境变量；两者都没有则报错。`_env` 与 `VESSEL_*` 按层解析、按层合并：同层显式值 > `_env`；`VESSEL_API_KEY`（env 层）覆盖项目层 `api_key_env`，来源记为 `env`，可选附 `env_ref`。
  5. **token 解析顺序**：`serve.tokens` map → `serve.admin_token` → `serve.token` / `serve.token_env` → `transport.token` → `VESSEL_GATEWAY_TOKEN` → 自动生成。服务端“期望 token”的优先级为 `serve.token` > `serve.token_env` > `transport.token` > `VESSEL_GATEWAY_TOKEN` > 自动生成；存在 `serve.tokens` / `admin_token` 时它们也是可接受 token。principal 映射见 ADR-049。
  6. **固定命令**：`vessel config path` 打印两个 YAML 路径；`vessel config init` 从模板生成用户配置（不写真实密钥）；`vessel config show [--sources] [--json] [--tenant <id>]` 输出合并后的脱敏配置。`config show` 有校验错误时 exit 1。`config.get` / `config.sources` 永不输出解析后的密钥值，只输出 `"<set>"` / `"<unset>"`；来源标注为 `cli | env | project | user | default`，tenant overlay 命中单独列 `tenant_overlay_keys`。
  7. **不做字符串插值**：0.5 不支持 `${VAR}`，避免 YAML 解析歧义；需要间接引用时使用 `_env`。
  8. **严格校验**：用户配置未知键 → error，不静默忽略；legacy 白名单仅 `default_provider` / `default_model` / `providers`（及 camelCase 等价）。项目 `vessel.yaml` 出现密钥 → error。`VESSEL_TENANT` 只参与 tenant 解析，不写入 config。`data_dir` 是全局键，tenant overlay 不得修改。
  9. **web 侧**：`ConfigSnapshot` 由 web 使用结构镜像或注入，不 import `packages/config`。
- **备选**：(a) 继续以 `.env` 为主配置——来源不可查、项目配置不可提交、tenant 覆盖难表达；(b) 引入 `${VAR}` 插值——与 YAML 类型/转义冲突，解析歧义大；(c) 允许项目 YAML 写密钥——容易误提交。均不取。
- **后果**：用户配置可提交、可审查，密钥集中在 env；`config show --sources` 能解释每个键的来源，但只显示是否设置，不显示值。显式值仍可写在用户 YAML 中，部署方需自行保证文件权限。项目配置出现密钥会直接失败，迁移时需要把密钥移到 env 或 `_env`。
- **关联**：ADR-005（双层配置）、ADR-019（命名映射）；DECISION-010 §2.4；Addendum A-1（优先级出处更正）、A-3 §10.4 / §10.6；A-4 §11.4 / §11.5。

## Addendum（0.6.1，已实现）

- **`permission.autoApprove: string[]`（additive）**：按工具名精确匹配；装配层读取该块，替代硬编码的 `['ask_user']`。TUI 权限弹窗选 `always` 时写回用户 YAML。缺省为空，交互仍逐个询问。配置层级与优先级不变。
- **`plugins[].config`（additive）**：`Record<string, unknown>`，通过 `Plugin.install(host, options?: { config?: Record<string, unknown> })` 传入；旧 `install(host)` 继续合法。不引入第二套扩展机制。
- **合并语义更正**：`plugins` 是数组，配置层按整层替换，不按 `name` 合并；`mcp_servers` 仍是 map，按 key 合并。上文“map（`mcp_servers`、`plugins`）按 key/name 合并”的表述以本 addendum 为准（仅更正文档描述，不改变实现语义）。
- **env 覆盖（additive）**：`VESSEL_PLUGINS`（逗号分隔插件名）、`VESSEL_SESSION_BACKEND`（`file|sqlite|memory`）、`VESSEL_MODEL`（覆盖 `provider.model`）属于 env 层，优先级仍为 `CLI > env > tenant overlay > project > user > default`。
- **插件目录（additive）**：仓库 `plugins/`、用户 `~/.vessel/plugins/`、项目 `./.vessel/plugins/`；启动时各扫描一次，仍需重启生效。`plugins[].config` 与目录扩展不改变“唯一运行期扩展机制”的边界。
