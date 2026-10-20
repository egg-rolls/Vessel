/**
 * CLI zh-CN catalog（默认语言，0.10 R2-20）。
 *
 * 既有中文文案必须与 0.10 之前逐字一致；命令名、工具名、错误码不翻译。
 * @module vessel/i18n/messages/zh-CN
 */

export const zhCN = {
  // ── help ──
  'help.title': 'Vessel CLI — 自组织 Agent Harness',
  'help.section.usage': '用法',
  'help.section.session': '会话',
  'help.section.headless': 'Headless 模式',
  'help.section.serve': '服务模式',
  'help.section.capability': '能力（0.4）',
  'help.section.config': '配置（0.5）',
  'help.section.tenant': '多租户（0.5）',
  'help.section.plugins': '插件（0.6.1）',
  'help.section.migrate': '迁移与 trace（0.5）',
  'help.section.debug': '调试',
  'help.section.other': '其它',
  'help.cmd.repl': '交互式 REPL（直进对话）',
  'help.cmd.demo': '无 Key 演示（真实工具调用与权限确认）',
  'help.cmd.continue': '续接最近的非空会话（--continue）',
  'help.cmd.resume': '恢复指定会话（--resume）',
  'help.cmd.resumeList': '列出当前 tenant 的会话',
  'help.cmd.session': '指定会话（不校验存在）',
  'help.cmd.print': 'headless 单轮（--print / --run 同义）',
  'help.cmd.runFile': 'headless：.json=多轮 seeding，其它=文本 prompt',
  'help.cmd.stdin': 'headless 单轮（stdin）',
  'help.cmd.continueRun': '续接最近会话并运行一轮',
  'help.cmd.resumeRun': '恢复中断的 durable run',
  'help.cmd.serve': '启动 HTTP/WS gateway（Web 控制台后端）',
  'help.cmd.workflowList': '列出 workflow runs',
  'help.cmd.workflowRun': '启动 workflow（workflow.dir 下解析）',
  'help.cmd.workflowShow': '查看步骤状态',
  'help.cmd.workflowResume': '恢复 interrupted/failed/running',
  'help.cmd.workflowCancel': '取消同进程 run',
  'help.cmd.eval': '离线评测',
  'help.cmd.evalOut': '评测输出 JSON / 指定报告',
  'help.cmd.feishu': '附加飞书渠道（可与 --serve / REPL 同用）',
  'help.cmd.tenant': '选择 tenant（也可用 VESSEL_TENANT）',
  'help.cmd.connect': '连接 gateway（非回环必须 https；token 也可用 VESSEL_CONNECT_TOKEN）',
  'help.cmd.origin': '独立 Web 前端的 CORS/WS Origin 白名单',
  'help.cmd.configPath': '打印用户/项目配置路径',
  'help.cmd.configInit': '生成用户配置模板',
  'help.cmd.configShow': '查看脱敏配置与来源',
  'help.cmd.configSet': '写入用户配置（ui.language / ui.showReasoning / agent.cwd）',
  'help.cmd.tenantList': '列出 tenant',
  'help.cmd.tenantGet': '查看 tenant 元数据',
  'help.cmd.tenantCreate': '创建 tenant',
  'help.cmd.tenantUpdate': '更新 tenant',
  'help.cmd.pluginList': '列出仓库/用户/项目/node_modules 插件',
  'help.cmd.pluginInstall': '安装本地插件目录到 ~/.vessel/plugins',
  'help.cmd.pluginRemove': '从 ~/.vessel/plugins 移除插件',
  'help.cmd.migrate': '迁移（默认 dry-run）',
  'help.cmd.migrateApply': '执行迁移',
  'help.cmd.tracePrune': '清理 trace（默认 dry-run）',
  'help.cmd.mock': 'mock 模式（不调 API）',
  'help.cmd.doctor': '本机配置/环境自检',
  'help.cmd.resumeRunList': '列出可恢复的 interrupted run',
  'help.cmd.updateCheck': '检查新版本（只提示，不自替换）',
  'help.cmd.updateBeta': '检查预发布通道',
  'help.cmd.version': '显示版本',
  'help.cmd.tools': '列出已注册工具（不需要 API Key）',
  'help.cmd.help': '显示本帮助',

  // ── common ──
  'common.helpHint': '运行 --help 查看用法。',
  'common.noInput': '没有输入。',
  'common.noApiKey': '未配置 API Key。先交互运行 `vessel` 完成配置。',
  'common.noApiKeyExit': '未配置 API Key，退出。',
  'common.noSessions': '没有可续接的会话。',

  // ── demo ──
  'demo.title': 'Vessel demo（无需 API Key）',
  'demo.line.command': '- 助手会执行一条无害的 bash 命令：echo vessel-demo-ok',
  'demo.line.flow': '- 你会看到工具调用、权限确认和最终回复',
  'demo.line.exit': '- 按 Ctrl+C 退出',
  'demo.line.next':
    '下一步：运行 `vessel config init` 添加 API Key，然后用 `vessel` 开始真实会话。',
  'demo.line.isolated': '本演示使用独立数据目录，不会读取你已有的会话。',
  'demo.needsTty':
    '`vessel demo` 需要交互式终端（TTY）。非交互检查请运行：VESSEL_MOCK=1 vessel --run "hello"',

  // ── cli ──
  'cli.unknownMockScenario': '未知 VESSEL_MOCK_SCENARIO "{name}"；回退到 "echo"。',
  'cli.resumeNeedsLocalStore': '--resume 不带 id 需要本地会话存储（不能与 --connect 同用）。',
  'cli.remoteGateway': '远端 gateway：节点={node} 租户={tenant} ({endpoint})',
  'cli.feishuConnected': '飞书渠道已连接（{appId}）。',
  'cli.gatewayRunning': 'Gateway 运行中… 按 Ctrl+C 停止。',
  'cli.feishuRunning': '飞书渠道运行中… 按 Ctrl+C 停止。',

  // ── connect ──
  'connect.caUnreadable': '无法读取 CA 文件：{path}',
  'connect.caEmpty': 'CA 文件为空：{path}',
  'connect.resumeFailed': '无法恢复会话 "{id}"：{detail}',
  'connect.listFailed': '无法列出会话：{detail}',

  // ── config command ──
  'config.init.exists': '配置已存在于 {path}；使用 --force 覆盖',
  'config.init.next': 'next: 运行 `vessel` 配置 API Key，或运行 `vessel doctor` 验证环境。',
  'config.set.unknownKey': '不支持的配置键 "{key}"；支持 ui.language、ui.showReasoning、agent.cwd',
  'config.set.invalidLanguage': 'ui.language 只支持 "zh-CN" 或 "en"',
  'config.set.invalidBoolean': 'ui.showReasoning 只支持 "true" 或 "false"',
  'config.set.invalidPath': 'agent.cwd 必须是非空路径',
  'config.set.failed': '写入用户配置失败：{detail}',

  // ── update ──
  'update.invalidChannel':
    '无效的更新通道。使用 "latest" 或 "beta"（--channel 或 VESSEL_CHANNEL）。',
  'update.failed': '更新检查失败：{detail}',
  'update.upToDate': 'Vessel 已是最新（{current}，通道：{channel}）。',
  'update.available': '有可用更新：{current} -> {latest}（通道：{channel}）',
  'update.selfDisabled': '0.1.0 起不支持自替换；请用上面的命令安装新版本。',
} as const;

/** CLI catalog 的 key 集合（en 必须一一对应） */
export type MessageKey = keyof typeof zhCN;
