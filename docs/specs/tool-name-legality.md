---
title: 工具名合法性——内置工具名必须 provider-safe（`pii.reveal` 事故的通用教训）
kind: advisory
applies_to: N
triggers:
  - 工具名带点号
  - pii.reveal 改名 piiReveal
  - tools[].function.name 400
  - 整条会话 400 不可用
  - 注册期 fail-fast 校验工具名
  - provider-safe 工具名 正则
  - 事件名 工具名 命名空间
  - mcp__server__tool 前缀
  - 新增工具怎么命名
paths:
  - packages/core/src/runtime/plugin-host.ts
  - packages/core/src/types/tool.ts
  - packages/core/src/pii/reveal.ts
  - packages/core/src/runtime/execution-unit.ts
  - packages/core/src/provider/providers.ts
  - plugins/mcp/client/src/naming.ts
  - src/runtime/bootstrap.ts
  - src/config/legacy-tool-names.ts
  - src/runtime/tenant-runtime-factory.ts
  - scripts/check-pii-vault.ts
  - scripts/check-tool-name-aliases.ts
---

# 工具名合法性（通用教训）

> 一条能让**整条链路打穿**的约束，被当成命名口味讨论过一次，代价是一次全量 400。
> 本文写成可执行清单，给以后加工具的人；不写历史。
> 已修：代码仓 main `27026979`（`fix(core,plugins): 内置工具名合法性——pii.reveal→piiReveal + 注册期 fail-fast 校验`）。

## 1. 事实（可直接采信）

- **工具名原样进 `tools[].function.name`**：`packages/core/src/runtime/execution-unit.ts:2134-2138`
  用 `tool.name` 拼请求里的 `tools[]`；OpenAI 兼容路径把 `req.tools` 透传
  （`packages/core/src/provider/providers.ts:358` / `:448`），Anthropic 路径
  `providers.ts:725-729` 直接取 `t.function.name`。**中间没有清洗层。**
- **两家的约束是同一个形状**：`^[a-zA-Z0-9_-]{1,64}$`（字母/数字/下划线/连字符，1–64 字符）。
  已落成常量 `PROVIDER_SAFE_TOOL_NAME`（`packages/core/src/runtime/plugin-host.ts:20`，
  `27026979` 之后；本实测分支 `0.53-proj-repro` 早于该 commit，本文引用的行号以 main 为准）。
- **MCP 侧本来就有清洗层**：`plugins/mcp/client/src/naming.ts` 把非 `[A-Za-z0-9_]` 字符换成 `_`，
  加 `mcp__<server>__<tool>` 前缀，超 64 字符按「前 55 + `_` + 8 位 SHA-1」截断
  （`exposedToolName` / `sanitizeSegment` / `MAX_TOOL_NAME_LENGTH = 64`）。
  ⇒ **内置工具以前一条校验都没有**，MCP 从来不会踩这个坑，所以踩坑的必然是内置工具。

## 2. 事故（形状值得记住）

- **触发**：内置工具名 `pii.reveal`（`packages/core/src/pii/reveal.ts` 的 `PII_REVEAL_TOOL_NAME`）带点号。
- **失败粒度不是「调用这个工具时」**，而是**每一个带工具表的请求**：请求体里只要有
  `tools[].function.name = "pii.reveal"`，provider 直接 400 拒**整个请求** ⇒
  **整条会话不可用**，而且报错是 provider 侧的 opaque 400，不看 `tools[]` 根本猜不到。
- **为什么没被门禁拦住**：没有任何工具名合法性判据；`check:pii-vault` 当时只在
  `package.json` 里定义、**从未被跑过**（handoff 却写着「已入 gates」）——「有判据」和
  「判据在跑」是两件事，这次两条都缺。
- **诊断代价**：这类错误出现在「新建任何带工具会话」的第一跳，容易被误判成鉴权 / 配额 / 网络，
  与工具名无关。

## 3. 修法（已合入 `27026979`）

1. **改名**：`pii.reveal` → `piiReveal`。模型可见面同步：`reveal.ts` 工具定义、`pii/notice.ts`
   的提示文案、`pii/rules.ts` 的下一步建议、`src/runtime/bootstrap.ts:1202-1208`（默认 `neverAutoApprove`）、
   `plugins/security/guardrail-pii`；
   唯一真名来源仍是 `PII_REVEAL_TOOL_NAME` 常量（不要在字符串里重复写名字）。
2. **注册期 fail-fast**：`MemoryPluginHost.registerTool`（`plugin-host.ts:69-78`）先跑
   `PROVIDER_SAFE_TOOL_NAME.test(def.name)`，不合就抛错，错误文案直接写清
   「OpenAI-compatible APIs and Anthropic reject other characters in `tools[].function.name`,
   which fails the whole request」。问题从「运行时 opaque 400」提前成「启动/装配/门禁时明确报错」。
3. **类型面也写清**：`packages/core/src/types/tool.ts` 的 `ToolDefinition.name` 加了注释，
   写明「原样进 `tools[].function.name`，必须 `^[a-zA-Z0-9_-]{1,64}$`」——改代码的人在类型提示里
   就能看见，不必翻 provider。
4. **事件名不动**：`pii.reveal.audit` 保持点号，`PII_REVEAL_AUDIT_EVENT` 不变。
   事件命名空间允许点号（`message.compaction` / `tool.call.completed` 全是点号），
   和 `tools[].function.name` 不是同一套规则。**不要为了「一致」去改事件名**——那会动 append-only 事件流。
5. **把判据接进 gates**：`check:pii-vault` 真正进 `gates`（此前只是定义了没跑），并顺手修了它的
   陈旧断言（`PrefixChangeReason` 期望 8 个成员，`R6` 删到 4 个后未同步）。

## 4. 规则（可执行清单）

1. **新增工具名只用** `[a-z][a-z0-9_]*`（snake_case，长度 ≤ 64）。0.55 起这是硬判据
   （`packages/core/src/runtime/tool-name.ts`，注册期抛错 + 装配期全量审计），
   不再接受 camelCase（`piiReveal` 已改名 `pii_reveal`，旧名只作为一版别名存在）。
   仍然 provider-safe 的子集关系不变：snake_case ⊂ `[A-Za-z0-9_-]{1,64}`。
2. **不要为了「看着像命名空间」在工具名里加点**。工具名是给 provider 的**标识符**，不是给人看的
   分级路径；想表达归属就放进 `name` 的**前缀**（下划线）或工具描述里。
3. **需要分层用前缀**：MCP 固定 `mcp__<server>__<tool>`（双下划线），长度超限交给
   `naming.ts` 的截断+hash，不要自己发明分隔符。
4. **事件名 / scope / RPC 方法名 / 工具名是四套不同命名空间，不要互相套规则**：
   - 工具名 → `^[a-zA-Z0-9_-]{1,64}$`（provider 说了算，硬约束）；
   - 事件名 → 允许点号分家族（`tool.call.completed`、`pii.reveal.audit`）；
   - RPC 方法名 → 允许点号（`sessions.get`、`agents.send`，见 `packages/serve/src/gateway/methods/*`）；
   - scope → 另一套（`check:env-scope-parity` 管），与工具名无关。
   一句话：**看到「这里点号没事」不等于「那里点号也没事」，按入口分别查规则。**
5. **门禁靠注册期校验，不靠人记**。已经有的那道正则就是唯一可信的闸：
   新增工具后跑一次任何会 `registerTool` 的路径（启动、装配、探针、gates）即可，
   抛错信息里直接带正则和原因。**不要**再加一份「工具名白名单」之类的第二套真源。
   0.55 起判据收在 `packages/core/src/runtime/tool-name.ts`（snake_case `^[a-z][a-z0-9_]*$`
   + `assertToolNameLegality` 装配期全量审计）；改名只需在 `TOOL_NAME_ALIASES` 补一条
   旧名映射（别名解析 / 配置层换算 / `--tools` 的弃用清单都读这张表，一处改完全链路生效）。

## 5. 边界 / 未验证

- **未在真实 provider 上复现 400**：本次只按两家公开约束与本仓 commit 记录立论，
  没有对线上端点发过 `tools[].function.name = "pii.reveal"` 的请求。
- **连字符**：provider 允许 `-`，但 MCP 清洗层把 `-` 也换成 `_`（`naming.ts` 注释明说
  「连字符也算非法」）。两层规则不完全相同：MCP 更严，取交集就是 `[A-Za-z0-9_]` ——
  想同时安全就用下划线。
- **已存在的历史会话**：改名只影响之后的请求；旧事件 / 旧 transcript 里的 `pii.reveal`
  字符串是历史事实，**不要批量改写**（append-only）。
- **老配置里的旧名换算层（0.53 `legacy-name` 已修）**：原先 `src/runtime/tenant-runtime-factory.ts`
  的 `normalizeLegacyAskToolName` 只把 `ask_user` 换成 `ask`，**不认** `pii.reveal`；而
  `src/runtime/bootstrap.ts` 与 `resolveRuntimePermission` 正是用它做 `autoApprove` / `neverAutoApprove`
  的换算 ⇒ 用户 YAML 里残留 `pii.reveal` 时**静默不匹配**（方向上是安全的一侧：`piiReveal`
  仍在默认 `neverAutoApprove` 里，所以「永远要人批」不丢），但和 L-011 是同一个形状——
  **「注册侧改名了、选择侧不认、还不报错」**。现在：
  - 换算表是**表驱动、单一真源**：`src/config/legacy-tool-names.ts` 的 `LEGACY_TOOL_NAME_ALIASES`
    （`ask_user → ask`、`pii.reveal → piiReveal`），`normalizeLegacyToolName` 只做**精确**
    表查找 —— 不做前缀 / 大小写 / 点号-下划线之类的模糊匹配（那等于允许任意别名，会把
    注册期的名字校验废掉）。旧函数名 `normalizeLegacyAskToolName` 已删，别再加回来。
  - 两处换算点都覆盖：`src/runtime/bootstrap.ts` 的 `permission.autoApprove` + `neverAutoApprove`，
    `src/runtime/tenant-runtime-factory.ts::resolveRuntimePermission` 的同两个字段。
  - 判据：`scripts/check-tool-name-aliases.ts`（零依赖）。它钉 ①别名目标必须是**真实存在**
    的工具名（名字从真 `MemoryPluginHost` 注册表读回，另三个 import 不到 workspace 包名的
    工厂从源码里的 `name: '<literal>'` 取，每个文件必须恰好一条）、②不许映到不存在的工具 /
    自映射 / 链式映射、③**反向**每个内置工具名都过 `^[a-zA-Z0-9_-]{1,64}$`（外加不含点号 /
    长度 1-64）、④`ask_user` 与 `pii.reveal` 都能换算出可达工具、⑤模糊变体必须原样返回、
    ⑥两处换算点的静态接线断言（只改一处是这类修复最典型的漏点）。
- **仍然保留的 `pii.reveal` / `ask_user` 字样（不是漏改，别顺手清理）**：
  - 事件名 `pii.reveal.audit`（`PII_REVEAL_AUDIT_EVENT`）：事件名允许点号，且 append-only；
  - 读侧「双认」旧名：`packages/agent/src/runtime.ts`（`PARENT_ANSWERED_TOOL_NAMES`、ask 转发）、
    `packages/tui`（`ToolDisplay` / `tool-input-summary` / `AskUserDialog`）、
    `packages/serve`（interactions 兜底）、`src/config/hot-apply-appliers.ts`（旧名工具不算插件工具）、
    `apps/web` 的 `[ask_user answer ` 历史正文前缀 —— 这些都是读历史数据，改成只认新名会让旧记录失明；
  - YAML 键 `ui.ask_user`（`src/config/ui-settings.ts`）：**配置键**，与工具名是两套命名空间，未随改名而变。
- 内置工具名的全量反向扫描现在是判据（上面的探针 ③，清单 9 个：`agent` / `ask` / `bash` /
  `edit` / `media` / `piiReveal` / `read` / `subscribe` / `web_fetch`）。覆盖边界要说清：
  MCP 工具名是**动态**的（`mcp__<server>__<tool>`，由 `naming.ts` 清洗 + 注册期校验兜底），
  不在探针的静态清单里；插件从项目 / 用户目录加载的工具同理，靠 `registerTool` 的 fail-fast。

