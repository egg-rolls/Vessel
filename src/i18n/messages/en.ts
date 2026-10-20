/**
 * CLI en catalog（0.10 R2-20）。
 *
 * Keys must match `zh-CN.ts` one-to-one; command names / error codes stay literal.
 * @module vessel/i18n/messages/en
 */

import type { MessageKey } from './zh-CN.js';

export const en: Record<MessageKey, string> = {
  // ── help ──
  'help.title': 'Vessel CLI — self-organizing agent harness',
  'help.section.usage': 'Usage',
  'help.section.session': 'Sessions',
  'help.section.headless': 'Headless',
  'help.section.serve': 'Serve',
  'help.section.capability': 'Capabilities (0.4)',
  'help.section.config': 'Configuration (0.5)',
  'help.section.tenant': 'Tenants (0.5)',
  'help.section.plugins': 'Plugins (0.6.1)',
  'help.section.migrate': 'Migration & trace (0.5)',
  'help.section.debug': 'Debug',
  'help.section.other': 'Other',
  'help.cmd.repl': 'interactive REPL (straight into conversation)',
  'help.cmd.demo': 'no-key demo (real tool call and permission prompt)',
  'help.cmd.continue': 'continue the most recent non-empty session (--continue)',
  'help.cmd.resume': 'resume a specific session (--resume)',
  'help.cmd.resumeList': 'list sessions for the current tenant',
  'help.cmd.session': 'select a session (existence not checked)',
  'help.cmd.print': 'single headless turn (--print / --run are synonyms)',
  'help.cmd.runFile': 'headless: .json=multi-turn seeding, anything else=text prompt',
  'help.cmd.stdin': 'single headless turn (stdin)',
  'help.cmd.continueRun': 'continue the latest session and run one turn',
  'help.cmd.resumeRun': 'resume an interrupted durable run',
  'help.cmd.serve': 'start the HTTP/WS gateway (Web console backend)',
  'help.cmd.workflowList': 'list workflow runs',
  'help.cmd.workflowRun': 'start a workflow (resolved under workflow.dir)',
  'help.cmd.workflowShow': 'show step status',
  'help.cmd.workflowResume': 'resume interrupted/failed/running',
  'help.cmd.workflowCancel': 'cancel an in-process run',
  'help.cmd.eval': 'offline evaluation',
  'help.cmd.evalOut': 'write evaluation JSON / choose the report path',
  'help.cmd.feishu': 'attach the Feishu channel (usable with --serve / REPL)',
  'help.cmd.tenant': 'select a tenant (or use VESSEL_TENANT)',
  'help.cmd.connect':
    'connect to a gateway (non-loopback requires https; token via VESSEL_CONNECT_TOKEN)',
  'help.cmd.origin': 'CORS/WS Origin allowlist for the standalone Web frontend',
  'help.cmd.configPath': 'print user/project config paths',
  'help.cmd.configInit': 'generate a user config template',
  'help.cmd.configShow': 'show redacted config and sources',
  'help.cmd.configSet': 'write a user setting (ui.language)',
  'help.cmd.tenantList': 'list tenants',
  'help.cmd.tenantGet': 'show tenant metadata',
  'help.cmd.tenantCreate': 'create a tenant',
  'help.cmd.tenantUpdate': 'update a tenant',
  'help.cmd.pluginList': 'list repo/user/project/node_modules plugins',
  'help.cmd.pluginInstall': 'install a local plugin directory into ~/.vessel/plugins',
  'help.cmd.pluginRemove': 'remove a plugin from ~/.vessel/plugins',
  'help.cmd.migrate': 'migrate (dry-run by default)',
  'help.cmd.migrateApply': 'apply the migration',
  'help.cmd.tracePrune': 'prune trace (dry-run by default)',
  'help.cmd.mock': 'mock mode (no API calls)',
  'help.cmd.doctor': 'local config/environment self-check',
  'help.cmd.resumeRunList': 'list resumable interrupted runs',
  'help.cmd.updateCheck': 'check for a new version (notify only, no self-replace)',
  'help.cmd.updateBeta': 'check the beta channel',
  'help.cmd.version': 'print version',
  'help.cmd.tools': 'list registered tools (no API key needed)',
  'help.cmd.help': 'show this help',

  // ── common ──
  'common.helpHint': 'Run with --help for usage.',
  'common.noInput': 'No input.',
  'common.noApiKey': 'No API key configured. Run `vessel` interactively first to set up.',
  'common.noApiKeyExit': 'No API key configured, exiting.',
  'common.noSessions': 'No sessions to continue.',

  // ── demo ──
  'demo.title': 'Vessel demo (no API key required)',
  'demo.line.command': '- The assistant will run one harmless bash command: echo vessel-demo-ok',
  'demo.line.flow': '- You will see the tool call, the permission prompt, and the final reply',
  'demo.line.exit': '- Press Ctrl+C to exit',
  'demo.line.next':
    'Next: run `vessel config init` to add your API key, then `vessel` for a real session.',
  'demo.line.isolated':
    'This demo uses an isolated data directory and does not read your existing sessions.',
  'demo.needsTty':
    '`vessel demo` needs an interactive terminal (TTY). ' +
    'For a non-interactive check, run: VESSEL_MOCK=1 vessel --run "hello"',

  // ── cli ──
  'cli.unknownMockScenario': 'Unknown VESSEL_MOCK_SCENARIO "{name}"; falling back to "echo".',
  'cli.resumeNeedsLocalStore':
    '--resume without an id requires a local session store (not with --connect).',
  'cli.remoteGateway': 'Remote gateway: node={node} tenant={tenant} ({endpoint})',
  'cli.feishuConnected': 'Feishu channel connected ({appId}).',
  'cli.gatewayRunning': 'Gateway running… press Ctrl+C to stop.',
  'cli.feishuRunning': 'Feishu channel running… press Ctrl+C to stop.',

  // ── connect ──
  'connect.caUnreadable': 'Cannot read CA file: {path}',
  'connect.caEmpty': 'CA file is empty: {path}',
  'connect.resumeFailed': 'Cannot resume session "{id}": {detail}',
  'connect.listFailed': 'Cannot list sessions: {detail}',

  // ── config command ──
  'config.init.exists': 'config already exists at {path}; use --force to overwrite',
  'config.init.next':
    'next: run `vessel` to configure your API key, or `vessel doctor` to verify the setup.',
  'config.set.unknownKey': 'Unsupported config key "{key}"; only ui.language is supported',
  'config.set.invalidLanguage': 'ui.language must be "zh-CN" or "en"',
  'config.set.failed': 'Failed to write user config: {detail}',

  // ── update ──
  'update.invalidChannel':
    'Invalid update channel. Use "latest" or "beta" (--channel or VESSEL_CHANNEL).',
  'update.failed': 'Update check failed: {detail}',
  'update.upToDate': 'Vessel is up to date ({current}, channel: {channel}).',
  'update.available': 'Update available: {current} -> {latest} (channel: {channel})',
  'update.selfDisabled':
    'Self-update is disabled in 0.1.0; install the new version with the command above.',
};
