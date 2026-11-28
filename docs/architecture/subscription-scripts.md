---
title: 订阅脚本（doc-subscription script 源）
kind: current
triggers: [subscription script, 订阅脚本, doc-sync, code-size, doc-lag, code-heaviness, allowlist, script source, interval, 真 timer, 空抑制, diff 去重, 首次全量, 单飞, fire-and-forget, ScriptRunner, 检测脚本, 厚重候选, 文档滞后, 确认无需改, doc-lag-marks]
paths: [plugins/context/doc-subscription/src/script.ts, plugins/context/doc-subscription/src/config.ts, plugins/context/doc-subscription/src/store.ts, plugins/context/doc-subscription/src/tool.ts, plugins/context/doc-subscription/src/hook.ts, plugins/context/doc-subscription/src/notice.ts, plugins/context/doc-subscription/src/index.ts, scripts/doc-sync.ts, scripts/code-size.ts]
---

# 订阅脚本（doc-subscription script 源）

> 通用检测脚本订阅机制（q-subscription-script P0 / P1）：被订阅的检测命令异步定时跑，
> 结果差异以环境信息投递（`vessel:notice`，scope 词见 [env-info-append-only](env-info-append-only.md)）。
> 脚本契约：**没问题就不输出，有问题输出差异/清单**；stdout 空 ⇒ 不投递（防消息爆炸）。

## 信任边界（fail-closed）

命令本体**只来自用户配置 allowlist**（`plugins.doc-subscription.config.scripts`）；模型经
`subscribe` 工具只能按名订阅已声明脚本（`source:'script'` + `name`/`names`），不能注入/修改
命令（未声明拒 `not_in_allowlist`，非法名拒 `invalid_script_name`）。argv 数组 spawn，
`shell:false`；cwd 来自用户配置（缺省装配层 agent cwd）；子进程继承 process.env（脚本是
用户信任的命令；env_allowlist 收紧留 P2）。整块配置非法 ⇒ 空清单，单条非法 ⇒ 跳过，不崩插件。

## 配置示例（可粘贴；生产启用归用户）

```yaml
plugins:
  doc-subscription:
    config:
      scripts:
        - name: doc-sync            # 订阅名（唯一键，[A-Za-z0-9_-]{1,64}）
          command: [bun, run, scripts/doc-sync.ts, --quiet]
          cwd: D:/Application/APP/Vessel/Vessel   # 缺省 = agent cwd
          scope: doc-lag            # 内置专词（未登记词回落 script）
        - name: code-size
          command: [bun, run, scripts/code-size.ts]
          cwd: D:/Application/APP/Vessel/Vessel
          scope: code-heaviness
        - name: my-check            # 任意用户脚本：共享兜底词 script
          command: [bun, run, scripts/my-check.ts]
          schedule: { interval_seconds: 300 }   # run（缺省）| request | interval 真 timer
          output: diff              # diff（缺省）| full
          timeout_ms: 30000         # 缺省 30s；stdout 上限 max_output_bytes 缺省 64KiB
```

camelCase/snake_case 双拼写；非法值回落默认；重名首条生效。canary 接线同款两条目
（doc-sync / code-size 带专词）已落 `fleets/canary-config.yaml`（外层仓，应用归 lead sync）。

## 调度与执行（kickoff / drain 分离）

- **kickoff fire-and-forget**（BeforeLlm hook 内，await 路径零子进程等待）：`run` = 每 run
  首请求；`request` = 每请求；`interval` = **真 timer**（P1 裁点变更，推翻 P0 惰性）：
  ScriptRunner 每订阅（session+name 键）setInterval，**idle 也跑**，unref 不独自撑进程；
  hook 每 run 幂等 arm（重启后首 run 重新 arm），tick 内 live 重读 allowlist/cadence，
  周期变更 tick 内幂等重 arm（同周期保留相位；idle 热改 intervalSeconds 下个 tick 即生效）。
- **单飞**：每订阅同时最多一个在飞进程（在飞 ⇒ 跳过本轮）；超时 kill（POSIX 进程组 /
  Windows taskkill /T）；stdout 超上限截断 + 标记；spawn 失败/崩溃/超时全 catch 不阻塞 run。
- **drain 每请求**（只读已完成结果，绝不等待）：结果在完成后下一个 BeforeLlm 投递（ambient）；
  run 结束才完成 ⇒ 下个 run 边界可见。结果队列内存 bounded（pending 持久化未做，重启丢一次
  可接受——检测会重跑）。
- **disarm 四路**：工具 remove / 插件 dispose / allowlist 删名或调度变更 / 本词 cadence off
  （hook 检查点 + tick live 自校验双保险，idle 热改也即时停）。
- **live getter**：cadence / channel / scripts / budgets / cwd / stateDir 每次 hook run /
  工具调用 / **自动订阅入口**（edit/write/read AfterTool）经 `deps.liveConfig()` 重新解析
  （装配 `buildPluginConfigMap` 注入，消费点同源；q-doc-subscription-hot-gate 收口残留：
  工具 add(file/health) 与 auto-sub 曾读 install 快照）；成员持父 hook 引用也读活配置
  （hot-gate 同族修复）。dispose 不永久禁用执行器（成员旧 hook 续活）。

## 降噪与投递（轴 B 实例）

空抑制（trim 空 ⇒ rev='empty' 静默推进、清 snapshot）；diff 模式与上一版成功 stdout 做
unifiedDiff（空 diff 只刷新观察值；超限全文兜底）；**首次全量**（无基线抑制，存量问题立刻
可见）；full 模式每次非空投全文。非零 exit / 超时 / spawn 失败**静默记录**执行事实
（last_exit / last_error 进 list / inspect；连续失败限频错误卡未做，留后续）。通知线格式
`notice.ts:formatScriptNotice`：首行 `<scope>: …` + 元数据行 `<script name exit bytes change/>`
+ 内容行（只跟第一个带内容条目）+ inspect 提示，≤11 行 / 字节预算同 files/health。

## scope 词（案 B 注册制）与 per-scope 热改

`script`（通用兜底）+ 内置专词 `doc-lag`（doc-sync --quiet）/ `code-heaviness`（code-size）。
`spec.scope` 须 ∈ 已登记词表（`REGISTERED_SCRIPT_SCOPES`，未登记回落 script）；登记 5 处
（config 表 / agent 词表 / i18n / 插件字面量 / 装配 ENV_GRANULARITY_SCOPES）。hook 按 scope
分组出卡（同 scope 折叠一条消息，不同 scope 各一张卡）；cadence / channel **per-scope** 解析
（某词 off ⇒ 该词下订阅整段静默 + disarm，词与词互不拖累）。

## 状态与工具面

条目键 `script:<name>`（与 file/health 隔离）；执行事实块 `script`（last_started_at /
last_exit / last_duration_ms / last_error；schedule/output 不落快照，每次 kickoff live 重读）。
`list` 展示执行事实（running/failed/exit N）；`inspect` 返回最近成功 stdout 全文 + XML 信封
（推进 seen_rev）；`remove` 清条目 + disarm。rotate 收养 / 成员指针 / per-session 串行链复用
store 既有机器。

## 检测脚本（scripts/，信息性非 gate）

- `doc-sync.ts --quiet`：仅滞后文档（churnFiles>0 且 lag≥threshold），每行
  `滞后N次 <doc> (churn M)`（lag 降序 / path 字典序稳定排序——diff 模式前提）；无滞后 stdout
  全空 exit 0；`--quiet --json` ⇒ `{"docs":[…]}`；`--doc` 优先于 quiet。**「确认无需改」标记**
  （P1）：`docs/doc-lag-marks.json` 中央登记（语义确认者写入，reason 必填），双向 ancestor
  校验通过后 lag 只数 mark.sha 之后 churn（精确抑制虚高段）——契约见
  [DOC-MANAGEMENT §3.5](../DOC-MANAGEMENT.md)。
- `code-size.ts`：git 跟踪 *.ts/*.tsx（`--ext` 可配），行数 > 阈值（默认 **1000**）⇒
  `<path>: <N> lines`（行数降序 / path 字典序）；排除 node_modules/dist/assets/build/coverage
  目录段 + *.d.ts/*.gen.ts 后缀 + `--exclude` glob 追加；无候选 stdout 全空。
- 两脚本零存储零状态零依赖（Bun 内置 + git），永不 exit 1，不接 CI/hook。