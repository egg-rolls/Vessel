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
  'help.note.askSuspended':
    '--run exits 3 when the model calls ask and suspends the run; answer with ' +
    '`vessel attention respond <id> --answers <json>` (offline when no gateway), then ' +
    '`vessel --resume-run <runId>`.',
  'help.section.gateway': 'Gateway lifecycle (0.12)',
  'help.section.capability': 'Capabilities (0.4)',
  'help.section.config': 'Configuration (0.5)',
  'help.section.plugins': 'Plugins (0.6.1)',
  'help.section.migrate': 'Migration & trace (0.5)',
  'help.section.debug': 'Debug',
  'help.section.other': 'Other',
  'help.cmd.repl': 'interactive REPL (straight into conversation)',
  'help.cmd.demo': 'no-key demo (real tool call and permission prompt)',
  'help.cmd.continue': 'continue the most recent non-empty session (--continue)',
  'help.cmd.resume': 'resume a specific session (--resume)',
  'help.cmd.resumeList': 'list sessions in the current data directory',
  'help.cmd.session': 'select a session (existence not checked)',
  'help.cmd.print': 'single headless turn (--print / --run are synonyms)',
  'help.cmd.runFile': 'headless: .json=multi-turn seeding, anything else=text prompt',
  'help.cmd.stdin': 'single headless turn (stdin)',
  'help.cmd.continueRun': 'continue the latest session and run one turn',
  'help.cmd.resumeRun': 'resume an interrupted durable run',
  'help.cmd.status': 'local runtime / attach / gateway instances at a glance',
  'help.cmd.stop':
    'stop the fleet gracefully (waits for active runs to finish, unlimited + progress; --force cuts runs with audit); --connect for remote stop',
  'help.cmd.restart':
    'fleet cold restart (stops nodes; default waits for runs to finish); for platform code updates prefer vessel gateway restart (keeps nodes, runs uninterrupted); [name] targets an instance or registered node (default: whole fleet); --force propagates to stop; --self reserves a self-restart (returns immediately; orchestrator restarts after the triggering run finishes; --prompt carries the continuation)',
  'help.cmd.agents': 'list agents via agents.list (local gateway or --connect)',
  'help.cmd.errors': 'recent run/tool errors (diagnostics in errorLevel: all)',
  'help.cmd.rpcList':
    'list RPC methods with params/result schema summaries (--node targets via platform proxy)',
  'help.cmd.fleetStatus': 'this fleet at a glance: identity / peers / nodes / gateway (read-only)',
  'help.cmd.ps': 'list fleet processes (gateway/node/hub), docker ps style',
  'help.cmd.gatewayPs': 'list gateway (platform) processes, docker ps style',
  'help.cmd.nodePs': 'list node processes, docker ps style',
  'help.cmd.hubPs': 'list hub processes, docker ps style',
  'help.cmd.modelList': 'list the model registry (vendors / aliases / default / effective)',
  'help.cmd.modelVendorSet': 'create or replace a vendor entry (--entry is the vendor JSON)',
  'help.cmd.modelVendorRemove': 'remove a vendor (refused while aliases / default reference it)',
  'help.cmd.modelAliasSet': 'create or replace an alias (alias -> vendor/model)',
  'help.cmd.modelAliasRemove': 'remove an alias',
  'help.cmd.modelSetDefault': 'set the default model ref (models.default)',
  'help.cmd.modelCredentialSet':
    'store or rotate an encrypted credential (value via env / stdin / hidden prompt; never echoed)',
  'help.cmd.modelCredentialRemove': 'remove a credential (refused while vendors reference it)',
  'help.cmd.modelCredentialsList': 'list credential metadata (no values)',
  'help.cmd.modelTest':
    'connectivity test against a saved vendor (sends a real request; may incur cost)',
  'help.cmd.gatewayStart':
    'start detached and exit once the platform is up (default); --foreground keeps it in front; --instance names it',
  'help.cmd.gatewayList': 'list gateway instances and PID files',
  'help.cmd.gatewayStop':
    'stop the platform process gracefully (waits for active runs to finish, unlimited + progress; --force kills with audit); default keeps node/hub, --stop-nodes stops them too',
  'help.cmd.gatewayStatus':
    'pid/port/uptime/version/service state (--rpc is deprecated; use node status --rpc)',
  'help.cmd.gatewayRestart':
    'restart the platform process (handoff: node/hub stay alive and are adopted, runs uninterrupted) — preferred for platform code updates; keeps --daemon; use vessel restart for a fleet cold restart; --stop-nodes is deprecated',
  'help.cmd.gatewayReload': 'hot-reload config/plugins without restarting',
  'help.cmd.gatewayInstall': 'register login autostart (systemd / launchd / schtasks)',
  'help.cmd.gatewayUninstall': 'remove the system service registration',
  'help.cmd.tokenList': 'list token purposes with fingerprints only (never prints values)',
  'help.cmd.tokenShow': 'print one token value (loopback + interactive terminal only)',
  'help.cmd.tokenRotate': 'rotate the root secret: every derived token changes',
  'help.cmd.nodeToken': 'show where this node token comes from; --print prints the value',
  'help.cmd.gatewayNodesList': 'list local nodes from nodes.json with health (never prints tokens)',
  'help.cmd.gatewayNodesAdd': 'register a local node; takes effect on the next gateway start',
  'help.cmd.gatewayNodesRemove':
    'remove a node from nodes.json; takes effect on the next gateway start',
  'help.cmd.nodeStart': 'start only the Node API (default 8644; shares the gateway instance lock)',
  'help.cmd.nodeStatus': 'show the Node API listener and health (--rpc for health/queue)',
  'help.cmd.nodeStop':
    'stop only the Node API gracefully (waits for active runs to finish, unlimited + progress; --force kills with audit); gateway-managed nodes point to gateway stop',
  'help.cmd.nodeRestart':
    'docker-style stop then start only this node ([name] selects a registered node); managed nodes point to vessel restart',
  'help.cmd.nodeReload': 'hot-reload Node API config (same operation as gateway reload)',
  'help.cmd.eval': 'offline evaluation',
  'help.cmd.evalOut': 'write evaluation JSON / choose the report path',
  'help.cmd.feishu': 'attach the Feishu channel (usable with gateway start / REPL)',
  'help.cmd.connect':
    'connect to a gateway (non-loopback requires https; token via VESSEL_CONNECT_TOKEN)',
  'help.cmd.configPath': 'print user/project config paths',
  'help.cmd.configInit': 'generate a user config template',
  'help.cmd.configShow': 'show redacted config and sources',
  'help.cmd.configExplain': 'explain one key: per-layer values and which layer wins',
  'help.cmd.configSet':
    'write a user setting (ui.language, ui.showReasoning, ui.statusBars, ui.verbosity, ui.showInternalEvents, ui.errorLevel, ui.askUser, observability.showProcessErrors, agent.cwd)',
  'help.cmd.pluginList': 'list repo/user/project/node_modules plugins',
  'help.cmd.pluginInstall': 'install a local plugin directory into ~/.vessel/plugins',
  'help.cmd.pluginRemove': 'remove a plugin from ~/.vessel/plugins',
  'help.cmd.pluginEnable': 'enable a plugin in ~/.vessel/config.yaml',
  'help.cmd.pluginDisable': 'disable a plugin in ~/.vessel/config.yaml',
  'help.cmd.migrate': 'migrate (dry-run by default)',
  'help.cmd.migrateApply': 'apply the migration',
  'help.cmd.tracePrune': 'prune trace (dry-run by default)',
  'help.cmd.mock': 'mock mode (no API calls)',
  'help.cmd.doctor':
    'local config/environment + fleet self-check (env hygiene, locks, ports, peers, node; --deep queries the gateway)',
  'help.cmd.logsTail': 'tail gateway logs',
  'help.cmd.dataDir': 'override the global data directory',
  'help.cmd.resumeRunList': 'list resumable interrupted runs',
  'help.cmd.updateCheck': 'check for a new version (notify only, no self-replace)',
  'help.cmd.updateBeta': 'check the beta channel',
  'help.cmd.update': 'self-update (npm/bun global installs; --yes skips confirmation)',
  'help.cmd.version': 'print version',
  'help.cmd.tools': 'list registered tools (no API key needed)',
  'help.cmd.completion': 'print a shell completion script (bash / zsh / fish / powershell)',
  'help.cmd.team': 'team messages and members (owner)',
  'help.cmd.teamList': 'list teams',
  'help.cmd.teamGet': 'show team members and recent messages',
  'help.cmd.teamShow':
    'show team basics (absolute workspace path / policy / frozen / member count)',
  'help.cmd.teamMine': 'find the team that contains the current directory (with the basis)',
  'help.cmd.teamPost': 'post a team message (without mentions it is logged only)',
  'help.cmd.teamMembers': 'add or remove a team member',
  'help.cmd.teamBudget': 'show conversation budget and blocked state',
  'help.cmd.teamBudgetOverride': 'raise or clear the budget limit of one conversation',
  'help.cmd.teamFreeze': 'freeze spawning new members in a team',
  'help.cmd.teamUnfreeze': 'allow spawning new members in a team again',
  'help.cmd.federationPost':
    'deliver a message to one member address on an allowlisted peer (principal@node:team)',
  'help.cmd.federationPeers': 'list federation peers and whether their tokens are set',
  'help.cmd.federationTeamInfo':
    'query an allowlisted peer team directory (requires allowDirectory)',
  'help.cmd.federationPeerAdd':
    'add a federation peer to user config and hot-reload the running gateway (no restart)',
  'help.cmd.federationPeerList': 'list configured federation peers (tokens are never printed)',
  'help.cmd.federationPeerRemove':
    'remove a federation peer by label (<nodeId>:<teamId>) or node id, then hot-reload',
  'help.cmd.help': 'show this help',
  'help.cmd.helpCommand': 'show one command in place (same as `vessel <command> -h`)',
  'help.cmd.globalDataDir': 'data directory only (isolated instance); CLI > env > config',
  'help.cmd.globalUserConfig':
    'user config only (must exist); the project config and its precedence stay untouched',
  'help.cmd.agentCreate': 'create a member (name / model / visibility / system prompt / workspace)',
  'help.cmd.agentSend': 'deliver one message to a member; --interrupt preempts the active run',
  'help.cmd.agentInbox': 'show a member inbox (unread / pending counts and messages)',
  'help.cmd.agentDispatch': 'dispatch a message to a target member; --allow-auto-create on demand',
  'help.cmd.agentClose': 'close a member (releases session and run state)',
  'help.cmd.agentList': 'list members (filter by visibility / state)',
  'help.cmd.teamCreate': 'create a team in a workspace (optional name / description / policy)',
  'help.cmd.teamUpdate': 'update team name / description / policy',
  'help.cmd.teamArchive': 'archive a team (no new messages accepted)',
  'help.usage': 'Usage',
  'help.flags': 'Flags',
  'help.subcommands': 'Subcommands',
  'help.groupHelpHint': 'Run a subcommand with --help for its usage and flags.',
  'help.tryCommand': "Try '{command} --help'",
  'help.unknownCommand': 'Unknown command: {command}',
  'help.group.agent': 'member lifecycle and message delivery',
  'help.group.config': 'read / write user configuration',
  'help.group.dev': 'development-only maintenance commands',
  'help.group.federation': 'cross-node team delivery and directory queries',
  'help.group.federationPeer':
    'manage federation peers in user config (add / list / remove, hot-reload)',
  'help.group.gateway': 'gateway lifecycle and instance management',
  'help.group.gatewayNodes': 'local nodes in nodes.json',
  'help.group.hub': 'hub service and node joining',
  'help.group.hubNode': 'hub-side node pairings',
  'help.group.logs': 'log reading',
  'help.group.model':
    'model registry: vendors / aliases / default / credentials / connectivity test',
  'help.group.node': 'node API lifecycle',
  'help.group.plugin': 'plugin install / enable / disable',
  'help.group.rpc': 'RPC capability discovery (capabilities.list wrapper)',
  'help.group.fleet': 'fleet overview (identity / peers / nodes / gateway)',
  'help.group.team': 'team messages, members and budgets',
  'help.group.trace': 'trace maintenance',
  'help.group.session': 'session maintenance (legacy migration)',
  'flag.json': 'emit JSON (data lines stay plain text)',
  'flag.daemon': 'detach to the background (log path via --log)',
  'flag.foreground': 'keep running in the foreground (debugging; default is detached)',
  'flag.keepNodes':
    'handoff: stop the platform layer but keep node/hub alive (adopted by the next start)',
  'flag.noKeepNodes': 'cold restart: stop node/hub together with the platform layer',
  'flag.force': 'overwrite existing files / force install',
  'flag.yes': 'skip confirmation (-y alias)',
  'flag.check': 'only check for a newer version, do not self-replace',
  'flag.channel': 'release channel',
  'flag.deep': 'deep self-check (queries the gateway)',
  'flag.rpc': 'also query RPC health / queue',
  'flag.sources': 'show the source of every config item',
  'flag.dryRun': 'only list pending changes, write nothing',
  'flag.apply': 'actually apply (dry-run by default)',
  'flag.interactive': 'interactive selection (requires a TTY)',
  'flag.allNodes': 'aggregate every configured node',
  'flag.all': 'apply to every target',
  'flag.all.ps': 'include stopped processes (docker ps -a style)',
  'flag.allow': 'allow (permission interaction)',
  'flag.deny': 'deny (permission interaction)',
  'flag.remember': 'remember this decision for the session',
  'flag.interrupt': 'preempt the active run and handle this first',
  'flag.allowAutoCreate': 'create the member on demand when missing',
  'flag.allowNetwork': 'allow real provider calls (also needs config.evals.allowNetwork)',
  'flag.allowRemote': 'allow non-loopback listening (TLS required)',
  'flag.noAutoStart': 'do not start it with gateway start',
  'flag.systemd': 'register a systemd user service',
  'flag.launchd': 'register a launchd service',
  'flag.schtasks': 'register a Windows scheduled task',
  'flag.clearDescription': 'clear the description',
  'flag.out': 'write the result to this path',
  'flag.filter': 'only run cases matching the tag (repeatable)',
  'flag.source': 'migration source path (defaults to the configured data dir)',
  'flag.from': 'source',
  'flag.to': 'target',
  'flag.from.address': 'sender member address',
  'flag.to.address': 'peer member address',
  'flag.from.migrate': 'source format',
  'flag.to.migrate': 'target format',
  'flag.name': 'name',
  'flag.model': 'model (provider/model)',
  'flag.visibility': 'visibility',
  'flag.systemPrompt': 'system prompt',
  'flag.startupPrompt': 'first task message, delivered at creation (starts the first run)',
  'flag.startupPromptFile': 'read the first task message from a file',
  'flag.workspace': 'member working directory',
  'flag.messageId': 'deliver to an existing inbox message (requires --interrupt)',
  'flag.state': 'filter by state',
  'flag.limit': 'maximum number of rows',
  'flag.members': 'maximum number of members (1-100)',
  'flag.mention': 'notify by name after delivery (repeatable)',
  'flag.description': 'description',
  'flag.policy': 'policy JSON object',
  'flag.policyFile': 'read the policy JSON from a file',
  'flag.conversation': 'conversation id',
  'flag.conversationId': 'peer conversation id (derived from --to by default)',
  'flag.dimension': 'budget dimension',
  'flag.max': 'limit value (unlimited clears it)',
  'flag.hubUrl': 'hub URL (defaults to config hub.url)',
  'flag.tokenEnv': 'environment variable holding the token',
  'flag.ttl': 'validity (60-3600 seconds)',
  'flag.code': 'one-time join code',
  'flag.codeEnv': 'environment variable holding the join code',
  'flag.publicUrl': 'publicly reachable URL of this node',
  'flag.ca': 'CA PEM path (--connect-ca alias)',
  'flag.connect': 'connect to a remote gateway',
  'flag.connectToken': 'control-plane token (never echoed; VESSEL_CONNECT_TOKEN works too)',
  'flag.dataDir': 'override the data directory',
  'flag.instance': 'gateway instance name',
  'flag.port': 'port',
  'flag.host': 'listen address',
  'flag.log': 'background log path',
  'flag.timeout': 'wait limit (e.g. 10s / 500ms)',
  'flag.waitTimeout':
    'self-restart orchestrator budget to wait for the triggering run (e.g. 120s; aborts on timeout)',
  'flag.self':
    'reserve a self-restart: returns immediately; orchestrator restarts gracefully after the triggering run finishes',
  'flag.prompt': 'self-restart continuation prompt (delivered as the first input after restart)',
  'flag.session': 'triggering session id (defaults to VESSEL_SESSION_ID)',
  'flag.run': 'triggering run id (defaults to VESSEL_RUN_ID)',
  'flag.scope': 'reload scope (comma separated: config,plugins)',
  'flag.config': 'config file path',
  'flag.lines': 'number of lines (1-10000; -n alias)',
  'flag.select': 'pick by row index on this page (1,3,...)',
  'flag.answers': 'answers array for ask (JSON)',
  'flag.node': 'configured node name (mutually exclusive with --connect)',
  'flag.team': 'team id (derived from --to by default)',
  'flag.agent': 'agent name (derived from --to by default)',
  'flag.status': 'status filter',
  'flag.order': 'sort order',
  'flag.cursor': 'pagination cursor',
  'flag.tlsCert': 'TLS certificate PEM',
  'flag.tlsKey': 'TLS private key PEM',
  'flag.entry': 'vendor entry (JSON object: protocol / baseUrl / credential / apiKeyEnv / models)',
  'flag.valueEnv': 'read the credential value from this environment variable (never in argv)',
  'flag.valueStdin': 'read the credential value from stdin (never in argv)',
  'flag.nodeId': 'peer node id (the other node, never this node)',
  'flag.teamId': 'peer team id (slug on the other node)',
  'flag.url': 'peer node base URL (node port; loopback may use http)',
  'flag.direction': 'allowed delivery direction: in | out | both (default both)',
  'flag.localTeamId': 'map the peer team to a different local team id',
  'flag.peerTeamId': 'the team on the target node to pair with (defaults to --team-id)',
  'flag.allowDirectory': 'allow inbound team-info directory queries from this peer',
  'flag.caFile': 'CA bundle path for the peer TLS connection',
  'flag.help': 'show usage for this command',

  // ── common ──
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
  'cli.remoteGateway': 'Remote gateway: node={node} ({endpoint})',
  'cli.feishuConnected': 'Feishu channel connected ({appId}).',
  'cli.gatewayRunning': 'Gateway running… press Ctrl+C to stop.',
  'cli.feishuRunning': 'Feishu channel running… press Ctrl+C to stop.',
  'cli.serveDeprecated':
    '--serve is deprecated; use `vessel gateway start` (foreground) or `vessel gateway start --daemon`.',

  // ── connect ──
  'connect.caUnreadable': 'Cannot read CA file: {path}',
  'connect.caEmpty': 'CA file is empty: {path}',
  'connect.resumeFailed': 'Cannot resume session "{id}": {detail}',
  'connect.listFailed': 'Cannot list sessions: {detail}',

  // ── config command ──
  'config.init.exists': 'config already exists at {path}; use --force to overwrite',
  'config.init.next':
    'next: run `vessel` to configure your API key, or `vessel doctor` to verify the setup.',
  'config.set.unknownKey':
    'Unsupported config key "{key}"; supported keys: ui.language, ui.showReasoning, ui.statusBars, ui.verbosity, ui.showInternalEvents, ui.errorLevel, ui.askUser, observability.showProcessErrors, agent.cwd',
  'config.set.invalidLanguage': 'ui.language must be "zh-CN" or "en"',
  'config.set.invalidBoolean': '{key} must be "true" or "false"',
  'config.set.invalidStatusBars': 'ui.statusBars must be "top", "bottom", "both" or "none"',
  'config.set.invalidVerbosity': 'ui.verbosity must be "minimal", "normal" or "debug"',
  'config.set.invalidErrorLevel': 'ui.errorLevel must be "user" or "all"',
  'config.set.invalidEnum': '{key} must be one of: {allowed}',
  'config.set.invalidPath': 'agent.cwd must be a non-empty path',
  'config.set.invalidNumber': '{key} must be an integer in [{min}, {max}]',
  'config.set.invalidNudge': 'emptyResponse.nudge must be a non-empty string',
  'config.set.failed': 'Failed to write user config: {detail}',

  // ── update ──
  'update.invalidChannel':
    'Invalid update channel. Use "latest" or "beta" (--channel or VESSEL_CHANNEL).',
  'update.failed': 'Update check failed: {detail}',
  'update.upToDate': 'Vessel is up to date ({current}, channel: {channel}).',
  'update.available': 'Update available: {current} -> {latest} (channel: {channel})',
  'update.selfHint': 'Run `vessel update` to self-update (or use the command above).',
  'update.devHint': 'Source/dev mode never rewrites your workspace; run this manually: {hint}',
  'update.restartHint': 'Restart the gateway after updating: vessel gateway restart',
  'update.needsYes': 'Cannot confirm in a non-interactive environment; re-run with --yes.',
  'update.confirm': 'Update Vessel with {command}?',
  'update.cancelled': 'Update cancelled.',
  'update.installFailed': 'Update failed (exit {code}): {command}; the previous version is kept.',
  'update.updated': 'Vessel updated: {command}',

  // ── gateway (0.12) ──
  'gateway.notRunning': 'Gateway is not running.',
  'gateway.running': 'running',
  'gateway.alreadyRunning': 'Gateway is already running (pid {pid}): {url}',
  'gateway.alreadyRunningPid': 'Gateway is already running (pid {pid}).',
  'gateway.stopSelf': 'Cannot stop the gateway from inside its own process.',
  'gateway.stopFailed': 'Failed to stop the gateway (pid {pid}): {detail}',
  'gateway.stopped': 'Gateway stopped (pid {pid}).',
  'gateway.stopTimeout': 'Timed out waiting for the gateway (pid {pid}) to exit ({timeout}).',
  'gateway.stopKeptNodes': 'kept {count} node(s) alive for handoff',
  'gateway.stopKeptHub': 'kept hub alive for handoff',
  'gateway.startFailed': 'Gateway failed to start: {detail}',
  'gateway.started': 'Gateway started (pid {pid}): {url}',
  'gateway.startedNode': 'node: {name} (port {port})',
  'gateway.logPath': 'Log: {path}',
  'gateway.webDistMissing':
    'Web console assets are missing at {path}. Build them once (a fresh clone has none): `bun run build:web` (= `cd apps/web && bun run build`), or set gateway.web_dist (config) / VESSEL_STATIC_DIR (env) to an existing build, then start again.',
  'gateway.webDistStale':
    'Web console assets may be stale: {index} is older than {source}; build with `cd apps/web && npm run build`.',
  'gateway.webDistStaleLine':
    'Web console assets are behind the sources: {index} is older than {source}. Fix: run `bun run build:web`, or restart the gateway (it rebuilds on start).',
  'gateway.noToken':
    'No gateway token configured (serve.token / serve.admin_token / VESSEL_GATEWAY_TOKEN); cannot call the local RPC.',
  'gateway.reloadNoGateway': 'Gateway is not running; run `vessel gateway start` first.',
  'gateway.reloadFailed': 'Hot reload failed: {detail}',
  'gateway.reloaded': 'Reloaded: {scopes}',
  'gateway.requiresRestart':
    'Requires a restart to take effect: {scopes} (run `vessel gateway restart`)',
  'gateway.restart.stopNodesDeprecated':
    '--stop-nodes is deprecated: gateway restart only restarts the platform process (node/hub stay alive). To restart the whole fleet, run `vessel restart`.',
  // ── node (0.49 G1) ──
  'node.started': 'Node API started (pid {pid}): {url}',
  'node.running': 'Node API is running: {url}',
  'node.notRunning': 'Node API is not running.',
  'node.stopped': 'Node API stopped (pid {pid}).',
  'node.managedByGateway':
    'This node is managed by the gateway process; run `vessel gateway stop` to stop the whole process (including the platform listener).',
  'node.reloadNoNode': 'Node API is not running; start it with `vessel node start`.',
  'gateway.status.title': 'Vessel Gateway',
  'gateway.status.status': 'Status',
  'gateway.status.pid': 'PID',
  'gateway.status.address': 'Address',
  'gateway.status.uptime': 'Uptime',
  'gateway.status.version': 'Version',
  'gateway.status.node': 'Node',
  'gateway.status.service': 'Service',
  'gateway.status.stale': 'Stale PID file (pid {pid}, {reason}); safe to reclaim.',
  'gateway.status.pidFile': 'PID file: {path}',
  'gateway.status.starting': 'Starting (pid {pid}); not yet confirmed.',
  'gateway.status.degraded': 'Process alive but identity not confirmed (pid {pid}): {reason}',
  'gateway.status.unknown': 'Unable to confirm the gateway state; no files were deleted.',
  'gateway.status.nodesAliveWithoutPlatform':
    'The platform layer is not listening, but {count} node process(es) are still running ({pids}) — ' +
    'nodes are kept across a platform restart/handoff and the next platform adopts them (usually ' +
    'within a second); stop them too with: vessel gateway stop --stop-nodes',
  'gateway.status.foreignHost': 'Lock belongs to another host ({host}); no files were deleted.',
  // ── stall watchdog (0.58) ──
  'gateway.status.supervise': 'Watchdog',
  'gateway.status.superviseOn':
    'on · probe {probe}ms × {threshold}, ≤{max}/h, backoff {backoff}→{backoffMax}ms',
  'gateway.status.superviseOff': 'off (gateway.supervise.enabled: false)',
  'gateway.status.superviseNode':
    '{name}: {phase} · last ok {lastOk} · last fail {lastFail} · restarts {restarts} (last hour {lastHour}){error}',
  'gateway.status.superviseError': ' · error: {error}',
  'gateway.status.selectHint':
    '{count} gateway instances found; use --instance, --port, or --all to choose one.',
  'gateway.stop.starting':
    'Gateway instance "{instance}" is still starting; try again later. No files were deleted.',
  'gateway.stop.notGateway':
    'Refusing to stop pid {pid}: its command line does not look like a gateway (possible PID reuse). No files were deleted.',
  'gateway.stop.reclaimed': 'Reclaimed stale state for gateway instance "{instance}".',
  'gateway.stop.cleanupFailed':
    'State files for gateway (pid {pid}) could not be cleaned up: {files}',
  'gateway.startedUnconfirmed':
    'Gateway started (pid {pid}) but was not confirmed in time; check `vessel gateway status`.',
  'gateway.list.owner': 'Owner',
  'gateway.list.hub': 'Hub',
  'gateway.serviceInstallFailed': 'Service registration failed: {detail}',
  'gateway.serviceInstalled': 'Service registered ({target}): {path}',
  'gateway.serviceUninstallFailed': 'Service removal failed: {detail}',
  'gateway.serviceUninstalled': 'Service removed ({target}).',
  'gateway.status.instance': 'Instance',
  'gateway.status.rpc': 'RPC',
  'gateway.status.rpcOk': 'reachable',
  'gateway.status.rpcFailed': 'unreachable: {error}',
  'gateway.status.queue': 'Queue',
  'gateway.status.currentRun': 'Current run',
  'gateway.list.title': 'Vessel Gateway Instances',
  'gateway.list.empty': 'No gateway instances found.',
  'logs.notFound': 'No gateway log files under {dir}.',
  'logs.tailFailed': 'Failed to read {path}: {error}',

  // ── stop (fleet stop; CONTRACT-stop-semantics S2-S7) ──
  'stop.inventory.title': 'Fleet inventory (data root: {dataDir})',
  'stop.inventory.platform': 'platform {instance}: {state} (pid {pid}) {url}',
  'stop.inventory.child': '{kind} {name} (pid {pid}, instance {instance})',
  'stop.inventory.registryNode': 'registry node {name} ({nodeId})',
  'stop.inventory.implicitNode': 'no nodes.json — implicit single node',
  'stop.inventory.externalNode': 'node {name} ({nodeId}) not in the spawn manifest — left running',
  'stop.inventory.hub': 'standalone hub (pid {pid}) — out of stop scope, left running',
  'stop.inventory.pool':
    'engine pool state files: {count} ({dir}); adopt/external engines are never touched',
  'stop.warning.activeSessions':
    'warning: nodes may hold active sessions; killing them is not recoverable.',
  'stop.nothingRunning': 'No running fleet in the stop scope.',
  'stop.confirm.prompt': 'Stop the fleet above? [y/N] ',
  'stop.cancelled': 'Cancelled; no process was killed.',
  'stop.nonInteractive':
    'refusing to stop: non-interactive terminal and no --yes; pass --yes to stop the fleet.',
  'stop.poolResidue.line': 'engine {id}: state pid {pid} may still be running — clean up manually',
  'stop.poolResidue.unreadable':
    'engine {id}: state file remains (pid unreadable) — clean up manually',
  'stop.poolResidue.count': '{count} engine state file(s) remain in {dir}',
  'stop.done': 'Fleet stop complete.',
  'stop.failed': 'Fleet stop did not fully succeed (see reasons above).',
  // ── graceful stop / force audit (用户裁定 #5, cli-topology-design §5.3/§5.4) ──
  'stop.drain.progress': '⏳ {label}: draining… {count} run(s) active (waited {waited})',
  'stop.drain.snapshotUnavailable': 'run snapshot unavailable (listener closed)',
  'stop.drain.escalate': 'escalate: vessel runs cancel <run_id>   |   vessel stop --force',
  'stop.drain.timeout':
    'Timed out waiting for drain (pid {pid}, {timeout}); the process is still running and was NOT killed. Cancel blocking runs or escalate with --force.',
  'stop.forced.summary': 'abnormal exit: {name} — {count} run(s) cut{note}',
  'stop.quiesceExitTimeout':
    'Drain complete but pid {pid} did not exit within {timeout} (exit chain wedged) — forcing termination. See node.shutdown.step logs for the hanging step.',
  // ── vessel restart (用户裁定 #6, cli-topology-design §7) ──
  'restart.inventory.title': 'Restart inventory (fleet dataDir: {dataDir})',
  'restart.platformHint':
    'Guidance: for platform code updates prefer `vessel gateway restart` (node/hub stay alive, runs uninterrupted); this command is a fleet cold restart (stops nodes; default waits for active runs to finish).',
  'restart.inventory.instance': 'platform {instance}: {state} (pid {pid})',
  'restart.nothingRunning': 'Nothing running; starting fresh.',
  'restart.confirm.prompt':
    'Restart stops active sessions (default waits for active runs to finish, unlimited; --force cuts them) then starts again. Continue? [y/N] ',
  'restart.stopFailed':
    'Restart aborted: stop did not fully succeed, so nothing was started. Escalate with `vessel stop --force`, then re-run restart.',
  'restart.starting': 'starting {instance}…',
  'restart.done': 'Restart complete.',
  'restart.failed': 'Restart did not fully succeed (see reasons above).',
  'restart.unknownTarget':
    'Unknown restart target "{name}" in fleet {dataDir} (no matching gateway instance or registered node).',
  'node.restartManaged':
    'This node is managed by the platform; restart the whole fleet with `vessel restart` (or just the platform with `vessel gateway restart`).',
  'stop.remote.title': 'Remote platform inventory: {url}',
  'stop.remote.health': 'platform: {status} (version {version}, node_count {count})',
  'stop.remote.node': 'node {name} ({nodeId}): {status} {apiUrl}',
  'stop.remote.limitation':
    'remote inventory is registry-level: manifest children and engine pool files on the host are not visible from here.',
  'stop.remote.inventoryFailed': 'remote inventory failed: {detail}',
  'stop.remote.accepted': 'shutdown accepted; waiting for the platform to become unreachable...',
  'stop.remote.unreachable': 'platform is no longer reachable (shutdown accepted).',
  'stop.remote.timeout':
    'shutdown accepted but not confirmed within budget ({timeout} ms); check the host.',
  'stop.remote.disabled':
    'remote shutdown is disabled on the host (gateway.remote_shutdown); SSH to the host and run `vessel stop` there.',
  'stop.remote.tokenHint':
    'hint: the token must be the platform token (the gateway.token value), not a node token.',
  'stop.remote.failed': 'remote shutdown failed: {detail}',

  // ── status / agents / errors (0.14) ──
  'status.title': 'Vessel Status',
  'status.version': 'Version',
  'status.tenant': 'Identity',
  'status.dataDir': 'Data',
  'status.provider': 'Provider',
  'status.attach': 'Attach',
  'status.queue': 'Queue',
  'status.notAttached': 'not attached (no running gateway)',
  'status.instances': 'Gateway instances',
  'status.noInstances': 'no gateway PID files found',
  'agents.title': 'Vessel Agents',
  'agents.source': 'Source',
  'agents.instance': 'Instance',
  'agents.empty': 'No agents registered.',
  'agents.list': 'Agents ({count})',
  'agents.unexpectedResult': 'Gateway returned an unexpected agents.list shape:',
  'rpc.title': 'RPC capability discovery (capabilities.list)',
  'rpc.node': 'node',
  'rpc.version': 'version',
  'rpc.methods': 'RPC methods',
  'rpc.tools': 'Tools',
  'rpc.plugins': 'Plugins',
  'rpc.empty': 'target reported no RPC methods',
  'rpc.unavailable': 'capabilities.list is not available on this target (older gateway?)',
  'rpc.jsonHint': 'full schemas: vessel rpc list --json',
  'fleet.title': 'Vessel fleet status (this fleet)',
  'fleet.identityMissing': 'node.json not initialized (created on first start; read-only here)',
  'fleet.gateway': 'Gateway (platform)',
  'fleet.gatewayDown': 'platform gateway is not running (vessel gateway start)',
  'fleet.nodes': 'Nodes',
  'fleet.noNodes': 'no registered nodes',
  'fleet.peers': 'Peers',
  'fleet.noPeers': 'no federation peers configured',
  'fleet.fedEnabled': 'federation enabled',
  'fleet.fedDisabled': 'federation disabled',
  'ps.title': 'Vessel processes (this fleet)',
  'ps.empty': 'no running processes (use --all to include stopped)',
  'ps.emptyAll': 'no process records',
  'model.title': 'Vessel Model Registry',
  'model.empty': 'Registry is empty: no vendors, aliases or default model.',
  'model.vendors': 'Vendors ({count})',
  'model.aliases': 'Aliases ({count})',
  'model.default': 'Default',
  'model.effective': 'Effective',
  'model.legacyPresent':
    'legacy provider config still present: {ref} (migrate to the models block)',
  'model.credentials': 'Credentials ({count})',
  'model.credentialsEmpty': 'No stored credentials.',
  'model.savedNote': 'Saved; takes effect on the next body/run.',
  'model.testCost': 'test sends a real minimal request to the vendor; it may incur cost.',
  'model.testFailed': 'connectivity test failed (unexpected result shape)',
  'model.unavailable':
    'model-registry RPC is not available on this gateway (requires the model-registry plugin).',
  'model.secretPrompt': 'Credential value (input hidden, Enter to submit): ',
  'model.secretRequired':
    'Cannot read a credential value in a non-interactive terminal: use --value-env <ENV> or --value-stdin.',
  'model.secretEnvEmpty': 'Environment variable {name} is not set or empty.',
  'model.secretEmpty': 'The credential value is empty.',
  'model.secretAborted': 'Credential input aborted (Ctrl+C).',
  'errors.title': 'Vessel Errors',
  'errors.level': 'Level',
  'errors.empty': 'No recent errors.',
  'errors.recent': 'Recent errors ({count})',

  // ── hub (S5) ──
  'help.section.hubService': 'Hub service',
  'help.section.hubNode': 'Hub node',
  'help.cmd.hubStart': 'start the hub in the foreground; --allow-remote needs TLS and tokenEnv',
  'help.cmd.hubDirectory': 'read the hub directory (paired nodes and status)',
  'help.cmd.hubWatch': 'subscribe to hub directory and pointer events (Ctrl+C exits)',
  'help.cmd.hubJoinCode': 'generate a one-time join code so a node can dial this hub',
  'help.cmd.hubJoin': 'join a hub from this node using a one-time join code',
  'help.cmd.hubNodeList': 'list nodes paired with the hub',
  'help.cmd.hubNodeRemove': 'remove a pairing from the hub',
  'hub.error.envMissing': 'Environment variable {env} is not set.',
  'hub.error.invalidUrl': 'Invalid URL.',
  'hub.error.invalidResponse': 'The service returned an unrecognized response.',
  'hub.error.requestFailed': 'Request failed: {detail}',
  'hub.error.timeout': 'Request timed out ({ms}ms).',
  'hub.empty.nodes': 'No paired nodes.',
  'hub.watch.closed': 'hub watch connection closed.',
  'hub.error.joinCodeMissing': 'Provide --code, --code-env, or set hub.joinCodeEnv.',
  'hub.error.invalidCa': 'Cannot read CA file: {path}',
  'hub.error.hubUrlMissing': 'Specify the hub URL or set hub.url.',
  'hub.error.httpsRequired': 'Non-loopback hub URLs require https.',
  'hub.error.invalidPublicUrl': 'Invalid public URL.',
  'hub.join.joined': 'joined {hub} ({pairing})',
  'hub.join.saved': 'saved; gateway will connect on next start',
  'hub.join.lastStatus': 'status: {status}',
  'hub.joinCode.code': 'join code: {code}',
  'hub.joinCode.expiresAt': 'expires at: {at}',

  // ── federation (0.20 S7.1；0.21 地址寻址) ──
  'federation.error.invalidAddress': 'Invalid federation address for {flag}: {message}',
  'federation.error.fromNodeMismatch': '--from node "{node}" does not match this node "{local}"',
  'federation.error.teamNotFound': 'Local Team not found: {team} ({path})',
  'federation.error.rosterUnavailable': 'Cannot read the local member snapshot: {path}',
  'federation.error.unknownPrincipal':
    '--from principal "{principal}" is not a present, non-private member of Team "{team}"',
  'federation.post.delivered': 'delivered {messageId} to {peer} (hop {hop})',
  'federation.post.deduplicated': 'peer deduplicated {messageId} to {peer} (hop {hop})',
  'federation.post.rejected': 'delivery rejected: {code}: {reason}',
  'federation.peers.title': 'Federation ({state})',
  'federation.peers.enabled': 'enabled',
  'federation.peers.disabled': 'disabled',
  'federation.peers.empty': 'No peers configured.',
  'federation.peers.row':
    '  {node}  {team}  direction={direction}  allow_directory={allowDir}  ' +
    'token_env={tokenEnv}  token={token}',
  'federation.peers.tokenSet': 'set',
  'federation.peers.tokenUnset': 'missing',
  // ── federation peer add/list/remove（q-federation）──
  'federation.peer.added': 'peer {label} added to {path}',
  'federation.peer.removed': 'peer {label} removed from {path}',
  'federation.peer.reloaded': 'running gateway reloaded ({scopes})',
  'federation.peer.reloadSkipped':
    'no running gateway found; the change applies via config watch or on next start',
  'federation.peer.reloadFailed':
    'gateway reload failed: {detail} (config watch will retry; otherwise restart the gateway)',
  'federation.peer.notFound': 'no configured peer matches "{target}"',
  'federation.peer.ambiguous':
    'multiple peers match "{target}": {labels}; use the full <nodeId>:<teamId> label',
  'federation.peer.duplicate': 'peer {label} already exists in {path}',
  'federation.peer.selfPeer': 'node id "{node}" is this node; a peer must point at another node',
  'federation.peer.invalidNodeId': 'invalid --node-id "{value}" (expected [A-Za-z0-9_-]{1,64})',
  'federation.peer.invalidTeamId':
    'invalid --team-id "{value}" (expected a lowercase slug: [a-z0-9][a-z0-9-]{0,63})',
  'federation.peer.invalidTokenEnv':
    'invalid --token-env "{value}" (expected an environment variable name)',
  'federation.peer.invalidLocalTeamId': 'invalid --local-team-id "{value}" (expected a team slug)',
  'federation.peer.invalidUrl': 'invalid --url "{value}": {message}',
  'federation.peer.invalidCaFile': '--ca-file must be a non-empty path',
  'federation.peer.invalidBlock': '{block} in user config must be a YAML object / array',
  'federation.peer.writeFailed': 'failed to write {path}: {detail}',
  'federation.peer.tokenUnset':
    'token env {env} is not set in this shell; the gateway resolves it from its own environment or env_file',
  'federation.teamInfo.title': 'Team {teamId}',
  'federation.teamInfo.online': 'online {online} / {total}',
  'federation.teamInfo.members': 'Members ({count}):',
  'federation.teamInfo.memberRow': '  {name}  {presence}  {lastSeen}',
  'federation.teamInfo.empty': 'No members.',
  'federation.teamInfo.rejected': 'team-info rejected: {code}: {reason}',

  // ── federation pair-code/join/discover（q-fed-simple）──
  'help.cmd.federationPairCode':
    'issue a one-time federation pairing code on this node (for cross-machine join; same-machine loopback needs no code)',
  'help.cmd.federationJoin':
    'pair with a node: handshake verifies auth, exchanges the shared token, writes both peer configs and hot-applies (no restart)',
  'help.cmd.federationDiscover':
    'list same-machine nodes from the local hub registry (loopback entries) with a one-command join hint',
  'federation.pairCode.issued': 'pairing code {code} (expires {expires}); shown only once',
  'federation.pairCode.hint':
    'on the other node run: vessel federation join <this-node-url> --code <code> (same-machine loopback may omit --code)',
  'federation.join.paired': 'paired with {label} at {url}; peer written to {path}',
  'federation.join.hint':
    'the target node wrote its side during the handshake; token stored in the node secret store (never in config)',
  'federation.join.unreachable': 'cannot reach {url}: {detail}',
  'federation.join.failed': '{code}: {message} (target {url})',
  'federation.join.badResponse': 'target {url} returned an invalid pair response',
  'federation.join.unknownNode': 'node {node} is not in the local hub registry ({path})',
  'federation.join.noLoopback':
    'node {node} has no loopback entry in the hub registry; join with its explicit URL instead',
  'federation.join.secretFailed':
    'cannot store the paired token: {detail} (platform keychain unavailable? set federation.allow_file_secrets or fix the keychain)',
  'federation.discover.title': 'Same-machine federation candidates (registry: {path})',
  'federation.discover.empty': 'No other loopback nodes found in the local hub registry.',
  'federation.discover.row': '  {node}  {name}  {url}  {status}  teams={teams}',
  'federation.discover.hint': 'pair with one command: vessel federation join <node_id>',

  // ── attention (0.22 S9.1) ──
  'help.cmd.attention':
    'list pending/orphaned interactions (--to principal is not a filter; use --team/--agent)',
  'help.cmd.attentionRespond':
    'respond to one / --select (current page) / --all (needs --yes); --answers only with a request_id',
  'help.cmd.attentionNodes':
    'list configured nodes with their own human token_env (--node <name>) or aggregate all (--all-nodes)',
  'attention.empty': 'No {status} interactions.',
  'attention.header': '{total} {status} · showing {showing}',
  'attention.interactive.select': 'Select [1,3 / a=all / n=next / q=quit]: ',
  'attention.interactive.decision': 'a=allow|d=deny|q: ',
  'attention.interactive.emptySelection': 'Enter a selection (1,3), a, n, or q.',
  'attention.interactive.invalid': 'Invalid selection.',
  'attention.interactive.noMore': 'No more pages.',
  'attention.interactive.askSkipped':
    "Skipped ask {request}; answer with: vessel attention respond {request} --answers '<json>'",
  'attention.confirm': 'Respond {request} with {decision}? [y/N]',
  'attention.needsTty': '`vessel attention --interactive` requires a TTY.',
  'attention.needsYes': 'Cannot confirm in a non-interactive environment; re-run with --yes.',
  'attention.summary': 'Answered {ok}, failed {failed}, skipped {skipped}.',
  'attention.respond.delivered':
    'Delivered: the answer entered that member inbox as a user message and started a new run.',
  'attention.respond.notDelivered':
    'Answer recorded, but no live runtime could deliver it (an async answer needs a running gateway to start a new run).',
  'attention.allTruncated': 'Reached the 200 interaction limit; only the first 200 were processed.',
  'attention.error.humanToken':
    'attention requires a human control token (gateway or team token); federation peer tokens are rejected',
  'attention.error.federationMismatch':
    'federation_target_mismatch: --to node "{node}" does not match this node "{local}"',
  'attention.error.notFound': 'not_found: interaction {request} was not found',
  'attention.error.askRequiresAnswers': 'ask {request} requires --answers <json>',
  'attention.error.permissionNoAnswers':
    'permission {request} does not accept --answers; use --allow or --deny',
  'attention.error.askInBatch': 'ask {request} requires --answers <json>',
  'attention.error.selectOutOfRange': '--select index {index} is out of range (page has {count})',
  'attention.error.respondStatus':
    'attention respond only supports --status pending; orphaned interactions cannot be answered (got {status})',
  'attention.error.nodeMismatch':
    'attention node "{name}" reports node_id "{actual}", expected "{expected}"',
  'attention.nodeHeader': '{name} · {url} · {total} {status}',
  'attention.nodeFailed': '{name}: FAILED {error}',
  'attention.nodesSummary': 'Nodes: {ok} ok, {failed} failed.',

  // ── completion (0.18) ──
  'completion.usage': 'Usage: vessel completion <bash|zsh|fish|powershell>',
  'completion.unknownShell': 'Unknown shell "{shell}".',

  // ── dev (0.49) ──
  'help.cmd.devReset': 'dev-only: wipe the data directory contents (requires --yes)',
  'dev.reset.usage': 'Usage: vessel dev reset [--yes] [--dry-run] [--json]',
  'dev.reset.helpYes': '--yes       confirm deletion (without it: print the target and exit 2)',
  'dev.reset.helpDryRun': '--dry-run   list top-level entries and size only',
  'dev.reset.helpJson': '--json      emit {dataDir, removed, dryRun, bytes}',
  'dev.reset.helpSafety':
    'Safety: refuses home / filesystem root / repository root / depth < 2; refuses when a configured port answers /health with 200 (run `vessel gateway stop` first); only entries inside the data directory are removed.',
  'dev.reset.empty': '(empty)',
  'dev.reset.hubOutside':
    'Note: hub.dataDir is outside the data directory and was not removed: {path}',
  'dev.reset.dangerous': 'Refusing to wipe {path}: dangerous root ({reason}).',
  'dev.reset.gatewayRunning':
    'Refusing to wipe: port {port} answered /health with 200, so the gateway is still running; run `vessel gateway stop` first.',
  'dev.reset.notDirectory': 'Refusing to wipe: {path} is not a directory.',
  'dev.reset.target': 'Data directory to wipe: {path}',
  'dev.reset.confirmHint':
    'Nothing removed; re-run with --yes to confirm (or use --dry-run first).',
  'dev.reset.dryRunTitle': 'dry-run: would wipe {path}',
  'dev.reset.total': '{count} top-level entries, {bytes}.',
  'dev.reset.partialFailure': 'Some entries could not be removed from {path}:',
  'dev.reset.notEmpty': '{path} is still not empty after the wipe ({count} entries remain).',
  'dev.reset.removed': 'Wiped {path} (removed {count} top-level entries, {bytes}).',

  // ── prune (0.51; the criterion is state, not time) ──
  'help.cmd.prune':
    'data cleanup: archived teams / closed agents with their sessions and records (dry-run unless --yes)',
  'flag.olderThan':
    'optional extra filter: only prune objects archived/closed before this (e.g. 30d / 12h; bare number = days; omit to ignore time)',
  'prune.head.dryRun': 'dry-run: nothing deleted (re-run with --yes to delete)',
  'prune.head.applied': 'pruned',
  'prune.scope': 'data dir: {path} · tenant: {tenant} · threshold: archived/closed before {age}',
  'prune.scope.all': 'data dir: {path} · tenant: {tenant} · criterion: state (no time filter)',
  'prune.bucket.teams': '  teams:    {count} archived team records, {bytes}',
  'prune.bucket.agents': '  agents:   {count} agent records, {bytes}',
  'prune.bucket.sessions': '  sessions: {count} sessions, {bytes}',
  'prune.bucket.runs': '  runs:     {count} run records, {bytes}',
  'prune.bucket.trace': '  trace:    {count} files, {bytes}',
  'prune.skipped.active': '  kept: {count} sessions with a live writer / resumable run',
  'prune.skipped.refused':
    '  refused: {count} sessions blocked by the delete guard (conflicting state or unreadable data)',
  'prune.skipped.keptAgents':
    '  kept: {count} target agents could not be cleared (record and data stay together)',
  'prune.skipped.keptTeams': '  kept: {count} archived teams still have agents left',
  'prune.skipped.unknownTime':
    '  kept: {count} objects have no archive/close timestamp (kept under --older-than)',
  'prune.totals': 'total: {count} items, {bytes}',
  'prune.note.sessionsBackendNotReadonly':
    'note: dry-run cannot enumerate sessions (session.backend=sqlite has no read-only path), so agent records are kept too; use --yes for the full picture.',
  'prune.note.durableDisabled':
    'note: durable runs are disabled (durable.enabled=false); there are no run records to prune.',
  'prune.note.agentsSnapshotUnreadable':
    'refused: the agent snapshot is unreadable (corrupt / unexpected shape); no agent or team record was deleted.',
  'prune.note.agentsSnapshotWriteFailed':
    'note: writing the agent snapshot failed, so the records are kept (their sessions are already cleared); fix write permissions and re-run.',
  'prune.locked':
    'Nothing deleted; stop the gateway/node (`vessel gateway stop`), then re-run with --yes.',

  // ── restart recovery card (0.52 S1c) ──
  // One single body for both the user and the model (no UI/model fork).
  // First line's first token is `restart` (web `env-notice.ts` picks the card scope from it);
  // detail lines carry run_id + the ISO instant, which double as the boot idempotency key.
  'resume.card.summary':
    'the gateway restarted while you were working ({reason}); run {run_id} was interrupted at {time}.',
  'resume.card.run_line': 'interrupted run: {run_id} (reason: {reason})',
  'resume.card.interrupted_at': 'interrupted at: {time}',
  'resume.card.verify_first':
    'check the current state (files, processes, task progress) before continuing; do not redo work that still exists.',
  'resume.card.background_stopped':
    'background processes were stopped by the restart; start them again if you still need them.',
  'resume.card.pending_inputs':
    '{count} accepted input(s) are queued and were admitted after this card, oldest first.',
  'resume.card.no_pending_inputs': 'no accepted input was queued; continue from the current state.',
  'resume.abnormal.summary':
    'the process exited abnormally (force kill or crash); the previous run was interrupted, no resume marker exists, and tool results are unknown.',
  'resume.abnormal.verify_first':
    'verify the current state (files, processes, task progress) before continuing; do not assume operations before the interruption succeeded.',
  'resume.abnormal.pending':
    'accepted inputs still queued will be dispatched automatically at startup; with no queue, continue from the current state.',

  // ── session status (AX self-service · self-observation) ──
  'help.cmd.sessionStatus':
    'session live state (state/run/usage/context/queue/last activity; default = caller itself)',
  'flag.id': 'object id (e.g. session id; default resolves to the caller itself)',
  'sessionStatus.title': 'Session status',
  'sessionStatus.session': 'session',
  'sessionStatus.sessionTitle': 'title',
  'sessionStatus.agent': 'agent',
  'sessionStatus.state': 'state',
  'sessionStatus.run': 'run',
  'sessionStatus.tokens': 'tokens',
  'sessionStatus.context': 'context',
  'sessionStatus.queue': 'queue',
  'sessionStatus.messages': 'messages',
  'sessionStatus.events': 'event tail',
  'sessionStatus.activity': 'last activity',
  'sessionStatus.source': 'source',
  'sessionStatus.noMain':
    'cannot resolve caller session: no main agent in agents.list (use --id <session> explicitly)',
  'sessionStatus.notFound': 'session not found: {id}',
  'sessionStatus.notAvailable':
    'sessions.get is not available on this gateway (requires a 0.14+ serve build)',

  // ── permission show (AX self-service · self-observation) ──
  'help.group.permission': 'permission self-observation (effective matrix, read-only)',
  'help.cmd.permissionShow':
    'effective permission matrix (tools × auto/ask/never + scoped keys + rule sources; default = caller itself)',
  'flag.member': 'member id within this fleet (default = caller itself)',
  'permissionShow.title': 'Effective permission matrix',
  'permissionShow.default': 'default',
  'permissionShow.member': 'member',
  'permissionShow.autoApprove': 'auto approve',
  'permissionShow.neverApprove': 'always ask',
  'permissionShow.bridgeDeny': 'bridge deny',
  'permissionShow.tools': 'Tools',
  'permissionShow.scoped': 'Scoped keys',
  'permissionShow.source': 'source',
  'permissionShow.checkNote':
    '* = tool has its own checkPermission (runtime explicit decision may override the static matrix)',
  'permissionShow.memberNotFound': 'member not found (this fleet only): {id}',
  'permissionShow.notAvailable':
    'permissions.show is not available on this gateway (requires a newer serve build)',
};
