# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**2.1.18**（2026-11-27 收口）— manifest 根 `package.json` = `2.1.18`（workspace manifests 同线；
`packages/plugin-sdk` 独立版本线 `1.0.0`，仅 SDK 契约变更时 bump）。
版本号以根 `package.json` 为唯一来源。tag 状态见 `git tag -l 'v*'`（tag push 触发 release.yml）。
当前变更摘要见 [CHANGELOG](../../CHANGELOG.md)；版本记录见 [INDEX.md](INDEX.md)。

## 已合入（现态，均在 main）

- **架构基座**：单一真相源（2.0.0 breaking）；认证与登录（argon2id + TOTP + 引导码、HKDF 根密钥、
  多 provider 登录页 + 策略注册表、头像三级降级）；models 注册表 + 凭证库 + 多厂商路由/热应用。
- **工具与运行时**：核心工具/MCP engine 子进程外置执行；vessel 元工具（fail-closed + guardrail）；
  tools[] per-session 冻结快照；write 工具 + expected_content 逐字节比对 + 工作区写锁；
  compaction 可逆视图 + recall；bash 异步缺省不限时 + 作业自起 run；工具结果出口闸 ≤16k token。
- **蜂群协作**：edit/write 自动订阅 + read line-level 订阅；env_injection per-scope 可配 + 环境卡；
  inbox read 即拿走 + 编辑级联消费 + 撤回级联真删；message_id 身份 + 假运行态收口。
- **第四轮批次（2.1.0）**：任务看板（kanban.get/archive + 三列视图 + 勾选验收归档）；
  优雅停止/自重启（缺省 drain-to-quiesce + `restart --self` + `vessel ps`）；
  插件生命周期（per-capability + O5 badge + 注销 API）；思考强度插件；SWR 刷新；拖拽引用；
  卡片健壮性（permission 同构 P-A + PII 按需载体）；hydration-anon 闸门对齐 canConnect；
  上下文口径统一（消通知虚高 170K）；内置插件恒兼容去版本门禁；配置责任链（显式 config > env）。
- **插件面**：ADR-102 插件内嵌 React UI（embed/iframe 双档 + 信任哈希锁 + plugin-sdk 独立线）；
  内置插件不受 engines.vessel 门禁（第三方保护不变）。
- **搜索与多模态**：web_search/web_fetch 声明式 custom 后端；原生视觉直通 + image_delivery 四态 + blob GC。
- **时间线与性能**：run 级可追加块 + 范围读 + 增量投影游标；打开会话 33.2s→1.37s；node 启动 16.3s→2.3s；
  gateway 分段启动 + 外部存活看门狗 + run-stops 优雅 drain。
- **客户端**：乐观渲染 + 排队消息生命周期 + 前端自动重建；日志中枢；usage 迁时间线 + SWR 去闪烁。
- **治理**：宪法零测试（行为验证归用户）；build.ts rc+证据双判；AGENTS worktree 规范。

## 未实现 / 下一步

- 本版无真机读数的条目：行为验证归用户本人（宪法第四条）；不派 verifier/QA、不起临时服务。
- 已知问题（第五轮处置）：ISSUE-DR15-1 node 侧 CLOSED✅；ISSUE-DR15-2 迭代 2 已合并（1aba69c0），
  候金丝雀 cli 修正判据复验闭环；plugin_manifest_invalid thinking-intensity（defaultLevel 大写 L，批次 B 登记）；
  O7 stop.forced 审计持久化已补（DR15-1 收口）。
- 版本收口自动化（q-release-script）：`version.ts --bump` + `release.ts` 双模式收口 + CI main push 门禁；
  workspace manifests 0.56.1 漂移候收口修复。
- 已知边界：write.lock 合作式协议；run-stops P2 重启自动续跑暂缓；plugin-embed 代理模式 iframe 回退先存不可用；
  Anthropic/Responses VisionBackend 适配与 Files API 未做；env_injection bus cadence 热更需重启。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)
- 版本记录：[2.1.18](2.1.18.md)、[2.1.17](2.1.17.md)、[2.1.16](2.1.16.md)、[2.1.15](2.1.15.md)
- 发布手册：[../operations/RELEASE.md](../operations/RELEASE.md)