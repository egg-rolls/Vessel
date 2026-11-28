# canary-t-msgvis 报告 · 批次5 q-msg-visibility

-  tester: canary-t-msgvis（本轮唯一 config 写者）
-  canary HEAD: `ab58f5bf464dee8ab40ff350273bd8b1934e4820`（git rev-parse 实测）
-  服务 bundle: `index-D_wd18xu.js`（`curl http://127.0.0.1:8652/` 的 index.html 实测引用一致）
-  CDP: 9331（headless Chrome 158.0.8127.36，即席起灭；避开 9332/9333）
-  方法: inline CDP（bun -e 即席脚本，无 harness）+ Page.captureScreenshot → media view 像素复核 + Runtime.evaluate DOM 计数 / computed-style + node RPC `config.get`/`config.set` 对照
-  历史 fixture: 会话 `717be135-4985-4a6a-930a-d14d215296c7`（canary-qa-lead，completed，静态）——timeline 实测含 reasoning 214 行 / tool.call 254 / vessel:notice 21 / vessel:source 44；live 对照用本 tester 会话 `00af0bf0`（running）
-  证据目录: `docs/dev/tmp/q-msg-visibility/`（截图 + baseline-config-get.json）
-  开始: 2026-11-25T13:21+08:00

## 0. 基线 config.get（写前快照，13:20）

`POST http://127.0.0.1:8654/v1/rpc {"v":1,"method":"config.get"}`（回环匿名 admin）→
完整快照 `docs/dev/tmp/q-msg-visibility/baseline-config-get.json`。关键读数：

- `ui.showInternalEvents: false`（存量旧键）
- `ui.messageVisibility`: **absent**（未配置，①的前提）
- `ui.verbosity`: absent（缺省 normal）
- `plugins`: 11 条显式 enabled（basic-tools / doc-subscription / guardrail-pii / hook-logging / media / recall / redact-secrets / tool-policy / web-tools / model-registry / skills）
- version 0.56.1；paths.user = `D:\Application\APP\Vessel\fleets\canary-config.yaml`

## ④ 设置弹窗「消息显示」分组 —— PASS（13:23）

深链 `#/settings?category=display`（用户层）：

- DOM: `h4` 组头文本 = **消息显示**（i18n `settings.group.messageVisibility`），组内连续 5 行
  `data-setting-id = ui.messageVisibility.{reasoning,tools,environment,source,system}`。
- 截图 `02-settings-display-baseline.png`（组头 + 思考过程/工具卡片/环境信息 ✓true）、
  `03-settings-system-off.png`（环境信息/来源卡片 ✓true + 系统信息 ☐false）——media view 像素复核通过。
- 旧键 `ui.showInternalEvents` 行**不在**弹窗（D3 撤下，`oldKeyPresent:false`）；schema/写白名单保留（见 §0 与 gateway config.ts BOOLEAN_KEYS 源码）。
- 输出详略 ui.verbosity radio：minimal / **normal**(选中) / debug，与缺省一致。

## ② 存量 showInternalEvents=false 兼容映射 → 系统信息 toggle 关 —— 显示侧 PASS（13:23）

- config.get：`messageVisibility.system` absent + `showInternalEvents=false`。
- 弹窗系统信息 checkbox `checked:false`（DOM 实测），行描述明示「未配置时沿用旧键 ui.showInternalEvents 的值」。
- 聊天侧系统 raw 事件行隐藏证据见 §①。
- 写侧映射（旧键 true→toggle 开 / 新键显式优先）待 toggle 窗口测试，见 §写日志。

## ① 未配置时观感 = 旧行为 —— PASS（13:24）

前提：config.get `messageVisibility` absent（§0）。历史 fixture 717be135（normal 档）DOM 实测：

| 类别 | 计数 | 旧规则预期 | 判定 |
|---|---|---|---|
| 思考 `.reasoning-block` | 15 | normal 显 | ✅ |
| 工具 `.tool-card` | 24 | normal 显 | ✅ |
| 环境卡 `.env-notice-card` / 标题「环境信息」 | 4 / 4 | 0.51 恒显 | ✅ |
| 来源卡（标题「来自 agent」） | 3 | 0.51 恒显 | ✅ |
| 系统 raw 事件行（llm.*/tool.*/run.* 等标题） | **0** | showInternalEvents=false 隐 | ✅ |
| AI 正文 `.msg-assistant` | 15–28（视滚动窗） | 恒显 | ✅ |

- computed-style：`.reasoning-block` / `.tool-card` = display:block, visibility:visible, opacity:1。
- 截图像素复核（media view）：`04-chat-baseline-normal.png`（正文尾窗）、
  `05-chat-reasoning-tools.png`（思考过程折叠块 + ✓edit 工具卡）、
  `06-chat-source-env.png`（环境信息卡「已裁剪上下文」+ 来源卡「来自 agent main [federation]…」+ 思考块）。
- 全部 stream-card 标题 ∈ {工具, 环境信息, 来自 agent}（otherTitles=[]），无 raw 系统行漏出。
- 口径说明：「逐字节一致」按任务书括号口径（默认值=旧行为）验收——未配置时五类生效值
  （reasoning/tools/environment/source=true，system=false←旧键映射）与旧判定逐类相同，DOM/像素证据如上。
  旧 bundle 不在 git（dist 不跟踪），不能为对照重建 served dist（会扰动并行测试），故不做旧新 bundle 字节 diff。
- 恢复后复测（13:27:13，W1 恢复后）：reasoning=15 / tool=24 / env=4，与基线逐数一致。

## ③ 五 toggle 独立 —— 进行中（W1 reasoning PASS）

**W1 reasoning=false（13:26:27–13:27:13）**：config.set `ui.messageVisibility.reasoning=false` →
config.get 确认 `{showInternalEvents:false, messageVisibility:{reasoning:false}}` → 硬刷新（ignoreCache）DOM：
**reasoning 15→0**，tool=24 / env=4 / source=3 / rawSystem=0 **全部不变**（关思考不影响工具/环境/来源/系统）。
截图 `07-reasoning-off.png`。恢复=删 yaml message_visibility 块 + 同值 config.set 触发热应用 →
config.get `ui={showInternalEvents:false}`、plugins 11 → 硬刷新 reasoning=15 回基线。

（tools/environment/source/system 独立窗口待测）

## ⑤ 历史思考纳入 minimal —— 待测

## config 写日志（每次写后恢复原值 + 复核）

| # | 时间（+08:00） | 写 | 恢复 | 复核 |
|---|------|----|------|------|
| W1 | 13:26:27 set reasoning=false | 13:26:41 快照 reasoning=0 其余不变 | 13:26:5x yaml 删块 + set showInternalEvents=false（同值触发） | 13:27:01 config.get ui 回基线 / plugins 11；13:27:13 UI reasoning=15/tool=24/env=4 |

## 给并行 chatindex 的抖动时间戳

config 写窗口（会广播 config 变更 / runtime notice）：
- W1: 2026-11-25T13:26:27 → 13:27:13（reasoning=false → 恢复）