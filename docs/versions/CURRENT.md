# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**0.56.0 未发布** — 0.54.0 收口（基线 `main @ c31dba42`，2026-11-16）后的开发线；
2026-11-18 用户拍板全线升 0.56.0。manifest 根 `package.json` = `0.56.0`
（workspace manifests 同线；`packages/plugin-sdk` 独立版本线 `1.0.0`，仅 SDK 契约变更时 bump）。
版本号以根 `package.json` 为唯一来源。未 tag、未 publish（tag 等 1.0.0）。
当前变更摘要见 [CHANGELOG](../../CHANGELOG.md)；版本记录见 [INDEX.md](INDEX.md)。

## 已合入（现态，均在 main）

- **认证与登录**：口令 argon2id + TOTP + 一次性引导码（`#token=` 退场）；单一根密钥 HKDF
  派生 token + `--data-dir`/`--user-config` 全族；github/microsoft/gitee 多 provider 登录页 + 策略注册表
  + `/auth/whoami`；头像三级降级 + `/auth/avatar` 代取缓存；node 自动加入 + 注册表派生来源集；
  `http.allowed_origins` 与 `auth.public_origins` 拆职；回环匿名改 opt-in。
- **模型管理**：models 注册表（vendors/aliases/default，legacy 字节等价）+ 官方 in-process 插件
  + AES-256-GCM 凭证库 + 多厂商路由/热应用；`plugin.model-registry.*` 十方法 + `vessel model` CLI
  + WebUI 管理页/ModelPicker/成员模型切换；record.model 只存显式 pin（快照 v5 一次性全清）
  + 跨重启模型变更通知；OpenAI 兼容端点 claude prompt cache 断点。
- **工具与运行时**：核心工具/MCP engine 子进程外置执行（有状态工具 callback 留 host，
  permission/session 留 host）；vessel 元工具（call_tool/rpc/set_config，fail-closed + guardrail 改写按目标授权）；
  tools[] per-session 冻结快照 + 工具面变更环境卡；write 工具；compaction 可逆视图 + recall；
  bash 异步 opt-in + 作业自己起 run 送结果；工具结果出口闸 ≤16k token 上移 core。
- **蜂群协作与订阅**：write expected_content 逐字节比对 + edit/write 自动订阅（subscribe:false opt-out）
  + `.vessel/write.lock` 工作区写锁（合作式）；read line-level 订阅 + placeholder 引用归零过期
  （origin 梯 manual>edit>read）；env_injection per-scope request/run 可配 + lock/conflict 环境卡。
- **插件面**：ADR-102 插件内嵌 React UI（embed/iframe 双档 + 信任哈希锁 + plugin-sdk 独立版本线）；
  宿主裸指定符解析缝（白名单软链单实例）。
- **搜索与多模态**：web-tools 默认加载，web_search/web_fetch 声明式 custom 后端
  （deepseek/tavily/serper/bocha 预设 + filters_ignored 披露 + 缺凭据三形态文案）；原生视觉直通
  （内容寻址 blob）+ image_delivery 四态 + blob GC + [refs] 三档。
- **时间线与性能**：run 级可追加块 + 范围读（manifest 锚点）+ 发送路径增量投影游标落盘
  + sessions.list 摘要侧车 + 打开会话 33.2s→1.37s；node 启动 16.3s→2.3s + gateway 分段启动
  + 外部存活看门狗 + run-stops 优雅 drain；win32 代理原生直通 + EPIPE 自激僵死修复。
- **会话与消息正确性**：上下文计数改下一次请求视图上界 + 发送前闸；message_id 身份
  + 重复输入/重复气泡根因修；假运行态收口 + 总量裁剪保锚点；硬错误立闸 + blocked 露出；
  假 queued run_id 改 deferred；inbox read 即拿走；事件订阅缺省作用域收紧（全局流显式 allow_global）。
- **客户端**：乐观渲染 + 排队消息生命周期 + 401/Origin 可见化 + rotate 批准超时终态；
  前端自动重建（SSE 推送 + 定时自查）+ 构建进日志；会话/team 运行中优先稳定排序；
  usage 迁时间线 + 诚实降级；日志中枢（降噪/着色/config 热应用/WebUI）+ 工具名 snake_case。
- **治理**：宪法第三/四条全部测试/探针/门禁废除（行为验证归用户）；build.ts rc+证据双判；
  AGENTS worktree 规范与非对称权威顺序。

## 未实现 / 下一步

- 本版无真机读数的条目：行为验证归用户本人（宪法第四条）；不派 verifier/QA、不起临时服务。
- 已知边界：write.lock 是合作式协议（bash/IDE/git 不受约束）；run-stops P2 重启自动续跑按用户裁决暂缓；
  model-registry P3 解析收紧待用户 P2 验证后另批；plugin-embed 代理模式 iframe 回退先存不可用；
  Anthropic/Responses VisionBackend 适配与 Files API 未做；env_injection bus cadence 热更需重启。
- tag / publish 等 **1.0.0**（用户决定：0.x 一律不 tag、不 publish）。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)
- 版本记录：[0.54.0](0.54.0.md)、[0.53.0](0.53.0.md)、[0.51.0](0.51.0.md)、[0.50.0](0.50.0.md)