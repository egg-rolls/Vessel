# q-msg-visibility ①调研 + schema 设计（消息显示设置整合）

任务：7 种消息显示类型整合为一组「消息显示」设置（归显示 tab），每类独立 toggle。
用户消息 / AI 正文恒显不给开关。旧 `ui.showInternalEvents` 兼容映射 → 系统信息 toggle。

## 1. 现状全链（调研结论）

### 1.1 七类消息的现行可见性判定

| 类型 | 现行判定 | 默认 | 判定点 |
| --- | --- | --- | --- |
| 用户消息 | 恒显 | 显 | transcript-items（无开关） |
| AI 正文 | 恒显 | 显 | transcript-items / StreamItems text item |
| 思考过程 | `verbosity !== 'minimal'` | 显 | `chat-visibility.reasoningVisible`（live：StreamItems.tsx:504/523；历史：Transcript.tsx `historyReasoning` 无条件渲染） |
| 工具卡片 | `verbosity !== 'minimal' \|\| status === 'error'`（失败永不静默） | 显 | `chat-visibility.toolVisible / historyToolVisible / filterTimelineItems`；minimal 补偿行 `runningToolHint` |
| 环境信息（`vessel:notice`） | **恒显**（硬编码 `ENV_MESSAGE_KINDS`） | 显 | `runtime-kinds.runtimeVisibilityFor`：`shown \|\| isEnvMessageKind(kind)` |
| 来源卡片（`vessel:source`） | **恒显**（同上）；被 agent 卡吸收的折叠路径（`MessageItem.sourceText`）与可见性无关 | 显 | 同上 + transcript-items.ts:1075 吸收扫描 |
| 系统信息（`subscription/limit/compaction/other` + 底层原始事件行） | `ui.showInternalEvents \|\| verbosity === 'debug'` | **隐** | `visibility.showsInternalEvents` → `useRuntimeVisibility`（runtime-visibility.ts）+ `useChatTranscript` 的 `eventStore.setItemVisibility(showInternal, errorLevel)`（event-visibility.ts 三档表） |

结论与任务书一致：一个键管环境+系统的时代已部分演进（0.51 用户裁决把 notice/source 放开为恒显卡片），
但「恒显」是硬编码，没有独立开关；思考/工具只跟 verbosity 档位，没有独立开关。

### 1.2 `showInternalEvents` 全链清单

- **schema**：`packages/config/src/types.ts:1083`（UiConfig）；validator.ts:1072 布尔校验 + :4021 KNOWN_BLOCK_KEYS.ui。
- **写路径（两条，白名单各自一份）**：
  - gateway：`packages/serve/src/gateway/methods/config.ts` BOOLEAN_KEYS（config.set，支持三层点键，先例 `observability.log.level`）；
  - CLI：`src/config/ui-settings.ts` SettableConfigKey + CONFIG_SET_TARGETS（支持 subBlock 三层键）+ `src/cli/commands/config-command.ts` 解析分支。
- **Web 读**：`state/visibility.ts`（resolveShowInternalEvents，snake_case 回退）→ `state/runtime-visibility.ts`
  useRuntimeVisibility（React 绑定；纯函数半在 `state/runtime-kinds.ts`，**零 import 约束**，根 tsconfig 无 DOM lib）
  → ChatView.tsx:117 / BodyTranscripts.tsx:21 / useChatTranscript.ts:478/501（isHidden 回调）。
- **设置 UI**：`state/settings-registry.ts` CORE_SETTING_SPECS（单一事实源）→ display-settings.ts DISPLAY_SETTINGS
  反向派生 → SettingsDialog.tsx（分类平铺行，无子分组机制）+ SettingRow.tsx；i18n `settings.item.showInternalEvents.*`。
- **其他消费方**：TUI `errors-command.ts`（internal 级错误放开）；event-visibility.ts / events.ts / runtime-kinds.ts 注释。
- **注意**：`ui.showReasoning`（默认 false）是 **TUI/历史遗留键**——Web 渲染侧从不读它
  （runs.ts:20 注释已过时：reasoning 现走 `llm.stream.chunk` reasoning_delta，core 不再按该键门禁发布）。
  Web 思考可见性实际只跟 verbosity。本任务**不动 showReasoning 键**（避免 TUI 行为回归），
  新「思考过程」toggle 是渲染侧开关，默认开，与 Web 现行为一致。

### 1.3 设置弹窗结构（q-settings-impl 落的）

SettingsDialog：搜索 + 左分类树（SETTINGS_CATEGORIES）+ 右按分类平铺 SettingRow。
**没有分类内子分组机制**——「消息显示」分组需要给 SettingDef 加可选 `group` 字段 + 渲染侧组头。
写路径 useSettingsWriter（scope user/project 分流）→ config.set，乐观 overlay 在 uiStore.settingsPending。

## 2. Schema 设计（config types 新增）

```ts
/** 消息显示（q-msg-visibility）：每类消息独立 toggle；缺省值 = 现行默认行为。 */
export interface MessageVisibilityConfig {
  /** 思考过程（默认 true）。渲染侧开关；minimal 档仍隐藏（档位语义保留）。 */
  reasoning?: boolean;
  /** 工具卡片（默认 true）。关闭 ≡ minimal 对工具的处理：失败卡仍显（失败永不静默）。 */
  tools?: boolean;
  /** 环境信息卡 vessel:notice（默认 true）。 */
  environment?: boolean;
  /** 来源卡 vessel:source（默认 true）。被 agent 卡吸收的折叠路径不受影响（单一表示裁决不变）。 */
  source?: boolean;
  /** 系统信息（默认 false）。未配置时回退旧键 ui.showInternalEvents（兼容映射）。 */
  system?: boolean;
}
// UiConfig 新增：messageVisibility?: MessageVisibilityConfig（YAML: ui.message_visibility）
```

**兼容映射（唯一解析口，Web 侧纯函数 `state/message-visibility.ts` 新增）**：
- `system = ui.messageVisibility.system ?? ui.showInternalEvents ?? false`（新键显式值优先；存量配置无损）；
- 生效 system 再 `|| verbosity === 'debug'`（保留既有「或」语义，raw 事件行同口径）；
- reasoning/tools/environment/source 缺省 true；`verbosity === 'minimal'` 仍隐藏思考/成功工具（档位 ∧ toggle）。

**决策记录**（可否决，默认按此实施）：
- D1：工具 toggle 关闭时**失败卡仍显**——沿用「失败永不静默」不变量（与 minimal 同口径），且复用
  `runningToolHint` 紧凑行补偿「工具被藏时 run 看似卡住」（hint 触发条件从 minimal 扩为「工具被藏」）。
- D2：来源 toggle 只管**单独成行的来源卡**；吸收进 agent 卡的 sourceText 折叠路径不变
  （0.51 裁决「别丢信息」优先，且 transcript-items 吸收扫描零改动）。
- D3：旧键 `ui.showInternalEvents` 保留 schema/validator/gateway/CLI 白名单（存量与脚本不破坏），
  但从设置弹窗 UI 撤下（CORE_SETTINGS 移除、CORE_COMMON 换成 system 键）；系统信息 toggle 写新键。
  弹窗回显兼容：system 未配置时读旧键值作显示值（display-settings 读路径特判）。
- D4：TUI errors-command 的 internal 放开改读「新键 ?? 旧键」（一行兼容，不改 TUI 其他行为）。

## 3. 实施面（②③步清单）

**② config + 渲染侧统一**
1. `packages/config/src/types.ts`：MessageVisibilityConfig + UiConfig.messageVisibility。
2. `packages/config/src/validator.ts`：validateUi 五布尔校验 + KNOWN_BLOCK_KEYS 增 `ui.messageVisibility` 子表 + ui 列表加键。
3. gateway `config.ts` BOOLEAN_KEYS + CLI `ui-settings.ts`（SettableConfigKey/CONFIG_SET_TARGETS subBlock='message_visibility'/布尔校验）+ `config-command.ts` 分支。
4. Web 新增 `state/message-visibility.ts`（纯函数，零 React）：类型 + resolveMessageVisibility（含兼容映射）。
5. `state/runtime-kinds.ts`：`runtimeVisibilityFor(showSystem)` → 接收 `{environment, source, system}` 结构型参数
   （保持零 import）；notice=environment、source=source、其余=system。**ENV_MESSAGE_KINDS 分类不变**。
6. `state/runtime-visibility.ts`：useRuntimeVisibility 选择器改读 resolveMessageVisibility；
   **hook 签名 {visibility, isVisible} 不变** → ChatView / BodyTranscripts 零改动（避开 q-chat-index 的 ChatView 滚动容器改动）。
7. `domains/chat/chat-visibility.ts`：toolVisible / historyToolVisible / reasoningVisible / filterTimelineItems /
   runningToolHint 增 messageVisibility 入参（缺省 true，调用点未传时行为不变）。
8. `domains/chat/useChatTranscript.ts`：resolveMessageVisibility 一次解析，showInternal 改读 mv.system（|| debug）；
   mv 沿既有 verbosity props 链下传 TranscriptWindow → StreamItems / Transcript。
9. `domains/chat/StreamItems.tsx` / `Transcript.tsx` / `TranscriptWindow.tsx`：消费 mv（思考历史块、工具卡、hint）。
10. TUI `errors-command.ts`：includeInternal 读「mv.system ?? showInternalEvents」（D4）。

**③ 设置 UI 分组 + 兼容映射**
1. `state/settings-registry.ts`：CORE_SETTING_SPECS 增 5 键（ui.messageVisibility.*，category=display，
   default/fallback：true×4 + system false）；SettingDef 增可选 `group`；CORE_COMMON 换键（D3）。
2. `state/display-settings.ts`：readDisplayValue 对 system 键未配置时回退读 ui.showInternalEvents（回显兼容）。
3. `SettingsDialog.tsx`：display 分类内按 def.group 渲染「消息显示」组头（i18n settings.group.messageVisibility）；
   5 键在键表相邻登记保证连续成组。
4. i18n zh-CN / en：5 键 title/desc + 组头；旧 showInternalEvents 文案保留（深链/搜索别名不破坏）。

**④ build 门禁**：`bun run build`（typecheck root+examples+apps/web + biome ci；exit code + 输出证据双判）。

## 4. 并发避让

- q-inbox-ux：PendingStrip / pending-sends —— 不碰。
- q-chat-index：ChatView 滚动容器 —— 不碰 ChatView.tsx（hook 签名不变使其零改动）；
  TranscriptWindow 只加 visibility props，不动滚动/容器结构。
- 本 agent 领地：runtime-visibility / runtime-kinds / visibility 消费链 / chat-visibility /
  useChatTranscript / StreamItems / Transcript / settings-registry / display-settings / SettingsDialog /
  config types+validator / gateway+CLI 写白名单 / i18n。

## 5. 风险

- runtime-kinds 零 import 约束：新参数用结构型内联类型，不 import message-visibility（避免纯函数半被拖进依赖图）。
- `runtimeVisibilityFor` 签名变更：调用点仅 useRuntimeVisibility 一处（grep 确认），脚本无引用（check-order-clump 已不存在）。
- 三层 config.set 键先例存在（observability.log.level），gateway/CLI 写路径无需新机制。
- 存量 `show_internal_events: true` 配置：system 未配置 → 回退 true，行为不变（兼容映射核心验收点）。## 6. 交付记录（②③④）

- ② `899d7f9e`：config schema（MessageVisibilityConfig + validator + KNOWN_BLOCK_KEYS 子块收口）、
  gateway/CLI 写白名单（5 布尔键，三层点键）、Web 解析口 state/message-visibility.ts、
  runtime-kinds 查表改读 {environment, source, system}（分类不变）、useRuntimeVisibility 加回
  messageVisibility（签名 additive，ChatView/BodyTranscripts 零改动）、chat-visibility 五函数加
  toggle 入参（缺省 true = 旧行为）、TranscriptWindow/Transcript/StreamItems/SubagentTranscript
  消费（历史思考块首次纳入档位判定——此前 minimal 不藏历史思考，属既有缺口，随本次一并收口）、
  TUI errors-command 兼容映射（D4）。16 文件 +358/-65。
- ③ `7978ad74`：settings-registry 五键登记（group=messageVisibility，常用旗舰键换 system）、
  SettingDef.group + SettingsDialog 组头渲染、display-settings system 回显兼容旧键、
  i18n 双语（组头 + 5 键 title/desc；旧键文案保留）。5 文件 +125/-10。
- ④ build 门禁：`bun run build` exit 0；Type check（root + examples + apps/web）✅、
  Lint（biome ci .）✅、📦 Build complete!；工作树干净。
- 实施备注：主时间线工具被藏时的补偿沿用既有 ThinkingHint（showThinking 判据已计入 tools toggle）；
  子 agent 侧 runningToolHint 扩为「工具被藏」触发（D1）。来源吸收路径零改动（D2）。