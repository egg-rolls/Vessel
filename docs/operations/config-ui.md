---
title: UI 与可见性配置项
kind: current
triggers: [ui, 语言, VESSEL_LANG, language, showReasoning, status_bars, verbosity, showInternalEvents, showArchived, errorLevel, askUser, expandCards, messageVisibility, depthColor, 深度配色, indicator, clearOnStart, 状态栏, 可见性]
paths: [packages/config/src/types.ts, packages/config/src/validator.ts, src/config/ui-settings.ts]
---

# UI 与可见性配置项

> `ui.*` 与相关可见性键的运维手册。写入命令与白名单见 [config-command](config-command.md)；
> 环境信息卡的注入框架见 [env-info-append-only](../architecture/env-info-append-only.md)。

## 语言与启动（`ui.language` / `VESSEL_LANG`）

- 默认 **zh-CN**；`VESSEL_LANG=en` 或 `ui.language: en` 切英文。优先级
  `VESSEL_LANG > ui.language > LANG > LC_ALL > zh-CN`；每值独立归一化（`zh*` → zh-CN，`en*` → en），
  非法值跳过该层不报错。
- TUI `/settings language <zh-CN|en>` 写回用户配置（原子写、0600、保留其它键），成功即重渲染；
  `VESSEL_LANG` 显式设置时当前显示以 env 为准。CLI `--help` / 一次性命令错误 / 空状态 / demo banner
  跟随同一 locale；命令数据输出保持英文。
- Web 壳层 `apps/web/src/i18n/`：locale 取 `localStorage['vessel.ui.language']` > `navigator.language`，
  Settings → Appearance 切换立即生效；未收录页面回退中文（不是全量本地化）。
- `ui.clearOnStart`（默认 true）：TTY 进 REPL 前清可视区；非 TTY / headless 不清屏。

## 思考流与状态栏

- `ui.showReasoning`（默认 false）：显式 true 才把 provider `reasoning_content` 转 `reasoning_delta`
  发布；TUI / Web 折叠展示。`trace.includeStreamChunks` 仍默认 false（思考增量默认不落 trace）。
- `ui.status_bars`（TS `statusBars`）：`top | bottom | both | none`，缺省按终端高度自动。
  上栏：状态/模型/context 用量/时长/压缩次数/路径+branch；下栏：`perm ask · N auto` / `waiting`、
  `bash N`、`sub N`、`sess · Ctrl+R`、queue（<40 列不渲染、<18 行默认隐藏；超宽按
  queue→session→sub→auto 丢弃）。`Ctrl+T` / `Ctrl+G` 切换并写回用户配置；`Ctrl+R` 打开 /resume。
  优先级 `VESSEL_STATUS_BARS`（只作启动初值）> `ui.statusBars` > 自动规则。
- TUI 指示器 `VESSEL_INDICATOR`：`unicode | ascii | emoji | kaomoji`（缺省 unicode，非法回退）；
  只影响 thinking/tool 态前缀帧（帧间隔 80/100/600/2500ms）；挂载时读一次，改需重启 REPL。

## 可见性（Web / TUI /errors）

```yaml
ui:
  verbosity: normal            # minimal | normal | debug；缺失/非法回退 normal
  show_internal_events: false  # 存量键；未配 message_visibility.system 时继续生效
  error_level: user            # user | all；all 追加 internal/process 级错误
  ask_user: true               # 入口默认；显式 false 关闭 ask 工具
  expand_cards: false          # Web 时间线卡片默认展开；可操作卡片始终展开
  show_archived: false         # 列表展示已归档 Team / 已停用 agent
  show_retired_sessions: false # 会话卡片列表展示退休会话（默认隐藏；搜索/直链仍可访问）
  message_visibility:          # 五类消息独立 toggle（缺省 = 现行默认）
    reasoning: true            # 思考过程；minimal 档仍隐藏
    tools: true                # 工具卡；关闭后失败卡仍显（失败永不静默）
    environment: true          # 环境信息卡（vessel:notice）
    source: true               # 来源卡（vessel:source）
    system: false              # 系统信息；未配置回退 show_internal_events；debug 档一并放开
observability:
  show_process_errors: false   # process/shutdown 错误进入 vessel errors
```

- `verbosity: debug` 等同 `showInternalEvents: true` + `expandCards: true` 并显示 L3 原始事件。
- `messageVisibility.system` 接管 `showInternalEvents`（解析口在 Web `state/message-visibility.ts`，
  消费方不各自读旧键）；旧键保留给存量配置与脚本写路径。
- `show_archived`：**隐藏不是删除**——直接 URL 始终能打开归档对象（带待移除提示）；会话列表不受
  此键影响（用户历史永不隐藏），只给归属已停用 agent 的会话加标记。
- `show_retired_sessions`（默认 false）：会话卡片列表是否显示退休会话（子标题灰色）。默认隐藏；
  搜索态绕过此过滤（退休会话仍搜得到），直接 URL/命令面板照常。判据与灰色子标题同源
  （`session.agent.primary===false` + roster 回落，`primary===true` 现役护栏）。Web `state/retired-visibility.ts`。
- `ui.ask_user`（键名未随工具改名，工具现名 `ask`）：交互 REPL（TTY）或 gateway/serve 才注册；
  headless/管道不注册，显式 true 也不能让无客户端入口注册。提问卡默认无限等待（见
  [config-permission](config-permission.md)）。
- 枚举/布尔非法由 validator 拒绝，不静默回退；以上键都支持 `vessel config set`。

## 深度配色（`ui.depth_color`，Web 会话卡树）

七键：`enabled`（默认 true；false = 全部地址档回 accent-ink）、`rootHue`（[0,360)，默认 172.6）、
`hueStep`（[0,360]，默认 137.508 ≈ 黄金角；0/360 = 不轮转）、`lightnessLight`（[0.30,0.51]，默认
0.4714）、`chromaLight`（[0,0.37]，默认 0.0887）、`lightnessDark`（[0.73,0.95]，默认 0.85）、
`chromaDark`（[0,0.37]，默认 0.13）。值域 = 对比度护栏（gamut 映射只降 C 不动 L）；
越界由 validator 报带值域的错误。RPC 键 camelCase（`ui.depthColor.*`），落盘 YAML `ui.depth_color`。