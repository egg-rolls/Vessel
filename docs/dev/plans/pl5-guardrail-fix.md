# ISSUE-PL5-1：插件热应用误删 core guardrail（vessel-bridge）根因审计与修复

- 分支：`fix/q-pl5-guardrail`（base `redblue-dev`）
- 实证：任何插件热应用（`config.set` → `watch.applied` → plugin reload）必触发
  `guardrails removed vessel-bridge` 通知（两次 live 捕获 pid97984 / pid103760，B1 首次
  `config.set` 热应用通知原文）。父宿主 vessel-bridge guardrail 缺席，候 restart 自愈。
- 结论：**热应用注册面差量的「管辖域」初始化把入口注册的 core guardrail 误划入插件管辖域**，
  而旁路目标集只由插件贡献组装 → vessel-bridge 被判 `removed` 并从真实宿主注销。
  与 tools 面 D1 缺陷同构，但 guardrail 面漏了入口注册排除。

## 1. core guardrail 注册源（非插件贡献）

`src/runtime/vessel-meta.ts` L294-300：

```ts
const bridgeGuardrail: Guardrail = {
  name: 'vessel-bridge',          // L295
  stage: GuardrailStage.ToolCall,
  priority: 40,                   // 先于 tool-policy（50）
  check: async (value) => translateVesselCall(value, options.getBridgeDeny?.() ?? []),
};
```

由装配层（bootstrap）注册进真实宿主，`src/runtime/bootstrap.ts` L1434-1439：

```ts
const vesselMeta = createVesselMetaSurface({ ... });
finalPluginHost.registerTool(vesselMeta.vessel);
finalPluginHost.registerGuardrail(vesselMeta.bridgeGuardrail);   // L1439
```

全仓 `src/` 入口侧 `registerGuardrail` 仅此一处 —— **vessel-bridge 是当前唯一 core
（非插件）guardrail**。它承担 vessel `op=call_tool` → 目标 ToolCall 的 fail-closed 翻译
（C-05 配对）；缺席时 `guardrail-runner`（`packages/core/src/runtime/guardrail-runner.ts`
L34 逐调用 live 读 `host.getGuardrails()`）跑不到桥，vessel handler 落 fail-closed 错误文案
（`vessel-meta.ts` L284-288），控制面桥实质瘫痪。

插件贡献的 guardrail（如 `guardrail-pii`）走插件 `install()` 注册，与 vessel-bridge 来源不同。

## 2. 精确移除点（file:line）

热应用链：`config.set` → `applyWrittenConfig` → gateway reload `tools` applier
（`src/cli.ts` L1273-1301）→ `applyRegistrations`。

1. **管辖域误初始化（根因点）**：`src/cli.ts` L1176-1178

   ```ts
   const managedPluginGuardrails = new Set(
     ctx.pluginHost.getGuardrails().map((guardrail) => guardrail.name),
   );
   ```

   注释（L1167-1169）声称「guardrail / masker 只来自插件，全量管辖」——**该假设为假**：
   bootstrap 先于此处注册了 vessel-bridge，启动时宿主 guardrail 面 = 插件贡献 ∪ {vessel-bridge}，
   全量快照把 core guardrail 一并划入插件管辖域。

2. **旁路目标集只含插件贡献**：`src/config/hot-apply-assembly.ts` L167-235
   `assemblePluginRegistrations` 在**全新 `MemoryPluginHost`**（L193）上只 install 选择集内
   插件（L196-226），返回 `host.getGuardrails()`（L230）。vessel-bridge 由入口注册、不经
   插件 install，**永不在目标集**。

3. **removed 判定 + 注销（移除执行点）**：`src/config/hot-apply-appliers.ts`
   - L449-451：`removed = current 名 ∉ target 名 && face.managed.has(name)`
     → vessel-bridge ∈ managed（步骤 1）且 ∉ target（步骤 2）→ 判 removed；
   - L535-539：`face.unregister(name)` → `MemoryPluginHost.unregisterGuardrail`
     （`packages/core/src/runtime/plugin-host.ts` L421-427，连带 purge scope 条目）
     → **vessel-bridge 从真实宿主消失**；
   - L551-552：摘要行 `tools: guardrails removed vessel-bridge` → `watch.applied` 通知
     （即 live 捕获原文）。

4. **为何候 restart 才自愈**：L548 只把 target 名并入 managed（只增不删），vessel-bridge
   留在 managed 但已不在宿主面；后续热应用 current/target 都没有它 → 不再触发任何动作。
   只有冷启动重跑 bootstrap L1439 才重新注册。

## 3. 冷启动 vs 热应用 reconcile 差异

| | 冷启动 | 热应用 |
|---|---|---|
| guardrail 来源 | 插件 install（只增）+ bootstrap L1439 注册 vessel-bridge | 旁路 host 只装配插件贡献 → 目标集 |
| reconcile | **无差量 reconcile**，注册即生效 | `applyRegistrations` 按名差量：`removed = current − target ∩ managed` |
| vessel-bridge | 注册后一直在 | ∈ managed（误）∉ target → 判 removed 注销 |

同链其它注册面早已做入口注册排除，唯独 guardrail 面漏掉：

- **tools 面**（D1 修复先例）：`pluginManagedToolNames`（`hot-apply-appliers.ts` L162-179）
  显式排除 `agent` / `ask` / `ask_user` / `vessel`（VESSEL_TOOL_NAME）与 MCP 工具；
- **hooks 面**：`cli.ts` L1170-1175 排除入口注册的 `RUNTIME_NOTICE_HOOK` / `REFS_NOTICE_HOOK`；
- **guardrail 面**：无排除 ← 本缺陷；
- **masker 面**：全仓入口侧无 `registerReadSideMasker` 调用（唯一注册点是插件
  `plugins/security/guardrail-pii/src/index.ts` L254），全量管辖假设成立，不受影响。

## 4. 任务点名路径排查（无第二移除点）

- `src/plugin/plugin-lifecycle.ts`：只做 per-capability 生命周期推导
  （`HOT_DIFFABLE_SURFACES` 含 'guardrail' 是「可热差量」能力判据），不做 reconcile；
- `src/plugin/plugin-config.ts` L185-211：声明式 `guardrails:` 条目 → 插件配置映射，
  属插件贡献来源，无误；
- `src/runtime/tenant-runtime-factory.ts`：无 guardrail 同步逻辑（成员 runtime 逐调用
  live 读父宿主 guardrail 面，故父宿主被注销即全员失效）；
- `src/runtime/bootstrap.ts`：冷启动注册源（§1），无差量逻辑，不动。

## 5. 修复方案（最小外科手术，与 tools/hooks 面同口径）

1. `src/runtime/vessel-meta.ts`：导出名字常量
   `VESSEL_BRIDGE_GUARDRAIL_NAME = 'vessel-bridge'`，`bridgeGuardrail.name` 改用常量
   （单一真源；check/handler/priority/stage 一律不动 → fail-closed 语义零变化）。
2. `src/config/hot-apply-appliers.ts`：在 `pluginManagedToolNames` 旁新增
   `pluginManagedGuardrailNames(host)`：宿主 guardrail 名排除入口注册的 core guardrail
   （当前即 vessel-bridge），与 tools 面排除 `vessel` 工具同构。
3. `src/cli.ts` L1176-1178：`managedPluginGuardrails` 改用该 helper，并订正
   「guardrail 只来自插件」的错误注释。

效果：热应用管辖域 = 插件贡献 guardrail；vessel-bridge ∉ managed → removed 判定永不命中，
热应用与冷启动 guardrail 集一致。插件 guardrail 的增删改 / 回滚 / fresh 实例采纳 dispose
逻辑一律不动；冷启动路径（bootstrap）不动；node 退出链不动。

## 6. 修复后实证设计（归金丝雀，本分支零测试零探针）

1. 起 node，`config.set` 触发任一插件热应用 → `watch.applied` 通知**不再出现**
   `guardrails removed vessel-bridge`；
2. 热应用后父宿主 `host.getGuardrails()` 仍含 `vessel-bridge`（priority 40 / ToolCall）；
3. vessel `op=call_tool` 仍被翻译成目标 ToolCall（C-05 配对、鉴权落最终目标 + args），
   `bridgeDeny` 热应用活引用语义不变；
4. 对照：disable/enable `guardrail-pii` 插件，其贡献 guardrail/masker 仍正常整体摘除/重建
   （插件管辖域差量不回归）；
5. 连续多次热应用（含 plugins[].config 变更触发 keyChanged 整体刷新）vessel-bridge 恒在。

## 7. 门禁

唯一门禁 `bun run build`（worktree 根，typecheck + lint + 📦，本仓无 bundle，ADR-006）。
结果见最终报告。
