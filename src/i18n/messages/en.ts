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
  'help.cmd.errors':
    'recent run/tool errors (diagnostics in errorLevel: all; --id drill-down / --run by seq)',
  'help.cmd.rpcList':
    'list RPC methods with params/result schema summaries (--node targets via platform proxy)',
  'help.cmd.kanbanList':
    'task board one-line-per-card summaries (kanban.list; --column/--owner/--status filters)',
  'help.cmd.kanbanView': 'single task full detail incl. full progress (kanban.view)',
  'help.cmd.fleetStatus': 'this fleet at a glance: identity / peers / nodes / gateway (read-only)',
  'help.cmd.ps': 'list fleet processes (gateway/node/hub), docker ps style',
  'help.cmd.gatewayPs': 'list gateway (platform) processes, docker ps style',
  'help.cmd.nodePs': 'list node processes, docker ps style',
  'help.cmd.hubPs': 'list hub processes, docker ps style',
  'help.cmd.modelList': 'list the model registry (credentials / entries / default / effective)',
  'help.cmd.modelSet': 'create or replace a model entry (--entry is the model JSON)',
  'help.cmd.modelRemove': 'remove a model entry (refused while models.default references it)',
  'help.cmd.modelSetDefault': 'set the default model ref (alias or entry key)',
  'help.cmd.modelCredentialSet':
    'write credential metadata (baseUrl required) and optionally the encrypted value (via env / stdin / hidden prompt; never echoed)',
  'help.cmd.modelCredentialRemove': 'remove a credential (refused while entries reference it)',
  'help.cmd.modelCredentialsList':
    'list credential metadata (baseUrl / hasValue / usedBy; no values)',
  'help.cmd.modelTest':
    'connectivity test against a saved entry or credential (sends a real request; may incur cost)',
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
    'local config/environment + fleet self-check (env hygiene, locks, ports, peers, node; --deep queries the gateway; --errors error audit)',
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
  'help.cmd.helpSearch': 'fuzzy-search CLI commands and RPC methods (ranking + did-you-mean)',
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
  'help.search.title': 'Command search: {query}',
  'help.search.cli': 'CLI commands',
  'help.search.rpc': 'RPC methods (capabilities.list)',
  'help.search.empty': 'No matching commands or methods.',
  'help.search.didYouMean': 'Did you mean:',
  'help.search.rpcUnavailable':
    'RPC methods not included (control plane unreachable); run vessel rpc list against a running gateway for the full list.',
  'help.search.missingQuery': 'Usage: vessel help --search <query> [--json]',
  'help.search.unknownArg': 'Unknown argument for help --search: {arg}',
  'help.search.hint':
    'vessel <command> --help for usage; vessel rpc list for the full RPC manifest.',
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
  'help.group.model': 'model registry: credentials / model entries / default / connectivity test',
  'help.group.node': 'node API lifecycle',
  'help.group.plugin': 'plugin install / enable / disable',
  'help.group.rpc': 'RPC capability discovery (capabilities.list wrapper)',
  'help.group.kanban': 'task board lightweight read side (kanban.list/view wrappers)',
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
  'flag.column': 'column filter (exact match)',
  'flag.owner': 'owner filter (exact match)',
  'flag.kanbanStatus': 'status filter (alias of --column: board status is the column)',
  'flag.order': 'sort order',
  'flag.cursor': 'pagination cursor',
  'flag.tlsCert': 'TLS certificate PEM',
  'flag.tlsKey': 'TLS private key PEM',
  'flag.entry':
    'model entry (JSON object: name / alias / provider / mode / credential / pricing / param / info)',
  'flag.valueEnv': 'read the credential value from this environment variable (never in argv)',
  'flag.valueStdin': 'read the credential value from stdin (never in argv)',
  'flag.baseUrl': 'credential endpoint URL (required; http(s))',
  'flag.apiKeyEnv': 'environment variable holding the API key (optional alternative source)',
  'flag.credential': 'test a credential instead of an entry (credential-level ping)',
  'flag.provider': 'protocol for a credential-level test (default openai)',
  'flag.nodeId': 'peer node id (the other node, never this node)',
  'flag.teamId': 'peer team id (slug on the other node)',
  'flag.url': 'peer node base URL (node port; loopback may use http)',
  'flag.direction': 'allowed delivery direction: in | out | both (default both)',
  'flag.localTeamId': 'map the peer team to a different local team id',
  'flag.peerTeamId': 'the team on the target node to pair with (defaults to --team-id)',
  'flag.allowDirectory': 'allow inbound team-info directory queries from this peer',
  'flag.caFile': 'CA bundle path for the peer TLS connection',
  'flag.purpose': 'Token purpose (platform|hub|node|proxy)',
  'flag.allowNonInteractive': 'Allow non-interactive mode (refuses interactive prompts by default)',
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
  'gateway.stopNodesDrainWait':
    'stop --stop-nodes is draining (stopper pid {pid}); waiting for it to finish before start/adopt so we do not take over node/hub that are about to be stopped',
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
  'kanban.title': 'Task board (kanban.list/view)',
  'kanban.matched': 'matched',
  'kanban.counts': 'columns',
  'kanban.tasks': 'Tasks',
  'kanban.empty': 'no tasks match the filters',
  'kanban.unavailable': 'kanban.* is not available on this target (board path not configured?)',
  'kanban.viewHint': 'full detail: vessel kanban view <id>',
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
  'model.empty': 'Registry is empty: no credentials, models or default model.',
  'model.entries': 'Models ({count})',
  'model.default': 'Default',
  'model.effective': 'Effective',
  'model.legacyPresent':
    'legacy provider.* config is present; unregistered refs pass through as wire models',
  'model.credentials': 'Credentials ({count})',
  'model.credentialsEmpty': 'No stored credentials.',
  'model.savedNote': 'Saved; takes effect on the next body/run.',
  'model.testCost': 'test sends a real minimal request to the endpoint; it may incur cost.',
  'model.testFailed': 'connectivity test failed (unexpected result shape)',
  'model.unavailable':
    'model-registry RPC is not available on this gateway (requires the model-registry plugin).',
  'model.secretPrompt': 'Credential value (input hidden, Enter to submit; empty = keep current): ',
  'model.secretEnvEmpty': 'Environment variable {name} is not set or empty.',
  'model.secretEmpty': 'The credential value is empty.',
  'model.secretAborted': 'Credential input aborted (Ctrl+C).',
  'errors.title': 'Vessel Errors',
  'errors.level': 'Level',
  'errors.empty': 'No recent errors.',
  'errors.recent': 'Recent errors ({count})',
  // q-error-e3 (§3.9): --id/--run drill-down labels
  'errors.mutuallyExclusive': '--id and --run are mutually exclusive; pass only one.',
  'errors.idNotFound': 'No error event found for error_id={id}.',
  'errors.drillTitle': 'Error drill-down',
  'errors.runTitle': 'Run error events (by seq)',
  'errors.runEmpty': 'No error events for this run.',
  'errors.operation': 'Operation',
  'errors.at': 'At',
  'errors.cause': 'Cause chain',
  'errors.details': 'Details',
  'errors.hintWhat': 'What happened',
  'errors.hintWhy': 'Why',
  'errors.hintFix': 'How to fix',
  'errors.hintVerify': 'Where to look',
  'errors.unknownCode': 'Unregistered code: raw info only, no fabricated guidance.',

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
    'note: the session database (session.backend=sqlite) could not be opened read-only (missing or unreadable), so dry-run cannot enumerate sessions and agent records are kept too.',
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
  // ── q-error-e3 (§3.9): four-section hints per stable code (what/why/fix/verify) ──
  'error.hint.unauthorized.what': 'The RPC request was rejected by the gateway (unauthenticated).',
  'error.hint.unauthorized.why':
    'The token is missing, expired, or does not match the target node.',
  'error.hint.unauthorized.fix':
    'Check the connection token: vessel token list for fingerprints, vessel node token for its source; pass the right --connect-token with --connect.',
  'error.hint.unauthorized.verify':
    'vessel errors --id <error_id> for details; vessel logs tail for gateway logs.',
  'error.hint.forbidden.what': 'The request was rejected by the permission policy.',
  'error.hint.forbidden.why':
    'The token permission level is insufficient for this method (read/write/admin).',
  'error.hint.forbidden.fix':
    'Use a token with sufficient permission, or adjust the method permission requirement; check gateway.token config for local loopback.',
  'error.hint.forbidden.verify': 'vessel errors --id <error_id>; vessel doctor.',
  'error.hint.not_found.what': 'The target resource does not exist.',
  'error.hint.not_found.why': 'The id is wrong or the resource was deleted.',
  'error.hint.not_found.fix':
    'Verify the id with the matching list command (e.g. vessel agents, vessel kanban list); pick from details.candidates when present.',
  'error.hint.not_found.verify': 'vessel errors --id <error_id> for details.candidates.',
  'error.hint.invalid_params.what': 'RPC parameters failed validation.',
  'error.hint.invalid_params.why':
    'A required field is missing, a type is wrong, or mutually exclusive fields were both given.',
  'error.hint.invalid_params.fix':
    'Check the parameter schema with vessel rpc list <method> and fix the parameters accordingly.',
  'error.hint.invalid_params.verify':
    'vessel errors --id <error_id> for field-level reasons in details.',
  'error.hint.data_locked.what': 'The data is locked by another process.',
  'error.hint.data_locked.why': 'Another gateway/node instance holds the lock on the same dataDir.',
  'error.hint.data_locked.fix':
    'Inspect processes with vessel ps / vessel gateway ps; stop the duplicate with vessel gateway stop, or use a different dataDir.',
  'error.hint.data_locked.verify': 'vessel doctor (lock check).',
  'error.hint.quota_exceeded.what': 'Quota exceeded.',
  'error.hint.quota_exceeded.why': 'A platform/team quota cap was reached.',
  'error.hint.quota_exceeded.fix':
    'Check the quota config or ask the platform admin to raise the cap; reduce request frequency.',
  'error.hint.quota_exceeded.verify': 'vessel errors --id <error_id> for details.',
  'error.hint.conflict.what': 'State conflict; the request was rejected.',
  'error.hint.conflict.why':
    'Concurrent modification or an unmet precondition (e.g. a run is already active).',
  'error.hint.conflict.fix':
    'Refresh state and retry; for run conflicts check the active run with vessel status.',
  'error.hint.conflict.verify': 'vessel errors --id <error_id>; vessel status.',
  'error.hint.internal.what': 'Gateway internal error.',
  'error.hint.internal.why': 'An unclassified server-side exception.',
  'error.hint.internal.fix':
    'Check gateway logs with vessel logs tail; run vessel doctor --errors for registry drift; report if it persists.',
  'error.hint.internal.verify': 'vessel errors --id <error_id> for the cause chain.',
  'error.hint.not_supported.what': 'The gateway does not support this capability.',
  'error.hint.not_supported.why': 'The target build is too old or the capability is not wired.',
  'error.hint.not_supported.fix':
    'Upgrade the target node/gateway to a version with this method; check available methods with vessel rpc list.',
  'error.hint.not_supported.verify': 'vessel errors --id <error_id> for details.method.',
  'error.hint.expired.what': 'The credential or session has expired.',
  'error.hint.expired.why': 'The token/session is past its TTL.',
  'error.hint.expired.fix': 'Re-authenticate or rotate the token (vessel token rotate); reconnect.',
  'error.hint.expired.verify': 'vessel errors --id <error_id>.',
  'error.hint.run_ended.what': 'The run has ended and can no longer be operated on.',
  'error.hint.run_ended.why': 'The run completed/failed/was cancelled and no longer accepts input.',
  'error.hint.run_ended.fix':
    'Start a new run (runs.start), or resume a resumable run (vessel --resume-run).',
  'error.hint.run_ended.verify': "vessel errors --run <run_id> for that run's events.",
  'error.hint.session_not_found.what': 'The session does not exist.',
  'error.hint.session_not_found.why':
    'The session_id is wrong, or the session was deleted / lives in another dataDir.',
  'error.hint.session_not_found.fix':
    'List sessions with vessel --resume and pick one; verify dataDir/tenant match.',
  'error.hint.session_not_found.verify': 'vessel errors --id <error_id>.',
  'error.hint.compact_unavailable.what': 'Session compaction is unavailable.',
  'error.hint.compact_unavailable.why':
    'The session store does not support compact, or the session state is insufficient.',
  'error.hint.compact_unavailable.fix':
    'Upgrade to a timeline-capable version; or start a new session.',
  'error.hint.compact_unavailable.verify': 'vessel errors --id <error_id>; vessel doctor.',
  'error.hint.gateway_restarting.what':
    'The gateway is restarting; the request is temporarily rejected.',
  'error.hint.gateway_restarting.why': 'The node is in a restart/drain window.',
  'error.hint.gateway_restarting.fix':
    'Retry shortly (retryable); watch restart progress with vessel node status.',
  'error.hint.gateway_restarting.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.no_active_run.what': 'There is no active run.',
  'error.hint.no_active_run.why': 'The operation requires an active run, but none exists.',
  'error.hint.no_active_run.fix': 'Start a run first; check run state with vessel status.',
  'error.hint.no_active_run.verify': 'vessel errors --id <error_id>.',
  'error.hint.run_mismatch.what': 'Run mismatch.',
  'error.hint.run_mismatch.why': 'The requested run_id does not match the currently active run.',
  'error.hint.run_mismatch.fix':
    'Verify the run_id (vessel status / runs.list) and operate on the right run.',
  'error.hint.run_mismatch.verify': 'vessel errors --run <run_id>.',
  'error.hint.marker_failed.what': 'Writing the run marker failed.',
  'error.hint.marker_failed.why': 'Run store write anomaly (disk/permission).',
  'error.hint.marker_failed.fix': 'Check dataDir disk space and permissions; vessel doctor.',
  'error.hint.marker_failed.verify': 'vessel errors --id <error_id> for the cause chain.',
  'error.hint.restart_reserve_failed.what': 'Restart reservation failed.',
  'error.hint.restart_reserve_failed.why':
    'The restart slot is taken or the state does not allow it.',
  'error.hint.restart_reserve_failed.fix':
    'Check node state with vessel node status; retry shortly or vessel gateway restart.',
  'error.hint.restart_reserve_failed.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.legacy_session_unsupported.what': 'Legacy session format is not supported.',
  'error.hint.legacy_session_unsupported.why':
    'The session predates timeline; the current read path does not support it.',
  'error.hint.legacy_session_unsupported.fix':
    'Start a new session; old data stays in dataDir but cannot be read via this path.',
  'error.hint.legacy_session_unsupported.verify': 'vessel errors --id <error_id>; vessel doctor.',
  'error.hint.timeline_unavailable.what': 'The timeline is unavailable.',
  'error.hint.timeline_unavailable.why': 'The timeline store is not wired or the read failed.',
  'error.hint.timeline_unavailable.fix':
    'Verify dataDir uses the root layout (vessel doctor); upgrade/restart the gateway.',
  'error.hint.timeline_unavailable.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.method_not_found.what': 'Unknown RPC method.',
  'error.hint.method_not_found.why':
    'The method name is wrong or the target gateway does not have it.',
  'error.hint.method_not_found.fix':
    'Check available methods and spelling with vessel rpc list; upgrade the target for new methods.',
  'error.hint.method_not_found.verify': 'vessel errors --id <error_id> for details.method.',
  'error.hint.run_already_running.what':
    'A run is already active; the duplicate start was rejected.',
  'error.hint.run_already_running.why': 'The same session already has an active run.',
  'error.hint.run_already_running.fix':
    'Wait for the current run to finish, or cancel it with vessel stop, then start again.',
  'error.hint.run_already_running.verify': 'vessel status; vessel errors --id <error_id>.',
  'error.hint.run_not_found.what': 'The run does not exist.',
  'error.hint.run_not_found.why': 'The run_id is wrong or the run record was cleaned up.',
  'error.hint.run_not_found.fix': 'Verify the run_id (runs.list / vessel status).',
  'error.hint.run_not_found.verify': 'vessel errors --id <error_id>.',
  'error.hint.run_not_resumable.what': 'The run cannot be resumed.',
  'error.hint.run_not_resumable.why':
    'The run state does not meet resume conditions (not interrupted, or already ended).',
  'error.hint.run_not_resumable.fix':
    'Start a new run; list resumable sessions with vessel --resume.',
  'error.hint.run_not_resumable.verify': 'vessel errors --id <error_id>.',
  'error.hint.run_store_required.what': 'A run store is required.',
  'error.hint.run_store_required.why':
    'The operation needs a durable run store, but none is wired.',
  'error.hint.run_store_required.fix':
    'Check the run store configuration (dataDir layout); upgrade the gateway.',
  'error.hint.run_store_required.verify': 'vessel doctor; vessel errors --id <error_id>.',
  'error.hint.agent_not_found.what': 'The agent does not exist.',
  'error.hint.agent_not_found.why': 'The member id is wrong or the member was closed.',
  'error.hint.agent_not_found.fix':
    'List members with vessel agents and pick one; choose from details.candidates when present.',
  'error.hint.agent_not_found.verify': 'vessel errors --id <error_id> for details.candidates.',
  'error.hint.session_corrupt.what': 'Session data is corrupt.',
  'error.hint.session_corrupt.why': 'The session file is damaged or has an invalid format.',
  'error.hint.session_corrupt.fix':
    'Back up, then start a new session; do not hand-edit session files.',
  'error.hint.session_corrupt.verify':
    'vessel errors --id <error_id> for the cause chain; vessel logs tail.',
  'error.hint.atomic_write_failed.what': 'Atomic write failed.',
  'error.hint.atomic_write_failed.why':
    'Disk full, insufficient permissions, or the file is locked.',
  'error.hint.atomic_write_failed.fix':
    'Check dataDir disk space and permissions; retry (retryable).',
  'error.hint.atomic_write_failed.verify': 'vessel doctor; vessel errors --id <error_id>.',
  'error.hint.limit_blocked.what': 'Blocked by a limit.',
  'error.hint.limit_blocked.why': 'A run iteration/token limit was reached.',
  'error.hint.limit_blocked.fix':
    'Adjust the limit configuration or split the task; check the current limit value.',
  'error.hint.limit_blocked.verify': 'vessel errors --id <error_id> for details.',
  'error.hint.empty_response_exhausted.what': 'Empty-response retries exhausted.',
  'error.hint.empty_response_exhausted.why':
    'The model returned empty content several times in a row.',
  'error.hint.empty_response_exhausted.fix':
    'Test connectivity with vessel model test; switch model (vessel model set-default) or review the prompt.',
  'error.hint.empty_response_exhausted.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.pii_unknown_handle.what': 'Unknown PII placeholder.',
  'error.hint.pii_unknown_handle.why': 'The handle does not exist or was never issued.',
  'error.hint.pii_unknown_handle.fix':
    "Verify the handle comes from this session's redacted output; never guess handles.",
  'error.hint.pii_unknown_handle.verify': 'vessel errors --id <error_id>.',
  'error.hint.pii_expired_handle.what': 'The PII placeholder has expired.',
  'error.hint.pii_expired_handle.why': 'The handle is past its TTL.',
  'error.hint.pii_expired_handle.fix': 'Re-fetch the redacted content to obtain a fresh handle.',
  'error.hint.pii_expired_handle.verify': 'vessel errors --id <error_id>.',
  'error.hint.pii_invalidated_handle.what': 'The PII placeholder was invalidated.',
  'error.hint.pii_invalidated_handle.why':
    'The original value changed or the session ended; the handle is void.',
  'error.hint.pii_invalidated_handle.fix':
    'Re-fetch the redacted content to obtain a fresh handle.',
  'error.hint.pii_invalidated_handle.verify': 'vessel errors --id <error_id>.',
  'error.hint.pii_reveal_denied.what': 'PII reveal was denied.',
  'error.hint.pii_reveal_denied.why': 'Human approval was not granted or policy forbids it.',
  'error.hint.pii_reveal_denied.fix': 'Request human approval and retry; do not bypass.',
  'error.hint.pii_reveal_denied.verify': 'vessel errors --id <error_id>; permission logs.',
  'error.hint.invalid_input.what': 'Invalid agent input.',
  'error.hint.invalid_input.why': 'A request field is missing or malformed.',
  'error.hint.invalid_input.fix':
    'Check the parameter schema with vessel rpc list <method> and fix the input.',
  'error.hint.invalid_input.verify': 'vessel errors --id <error_id> for details.',
  'error.hint.unknown_member.what': 'Unknown member.',
  'error.hint.unknown_member.why': 'The member id is not on this team roster.',
  'error.hint.unknown_member.fix':
    'Verify the id with vessel agents; pick from details.candidates when present.',
  'error.hint.unknown_member.verify': 'vessel errors --id <error_id> for details.candidates.',
  'error.hint.member_closed.what': 'The member is closed.',
  'error.hint.member_closed.why': 'The target member was released and no longer accepts messages.',
  'error.hint.member_closed.fix':
    'Send to an active member instead, or recreate the member (agents.create/hire).',
  'error.hint.member_closed.verify': 'vessel agents; vessel errors --id <error_id>.',
  'error.hint.member_stale.what': 'Member state is stale.',
  'error.hint.member_stale.why': 'The referenced member snapshot is no longer current.',
  'error.hint.member_stale.fix': 'Refresh the member list (vessel agents) and retry.',
  'error.hint.member_stale.verify': 'vessel errors --id <error_id>.',
  'error.hint.member_not_visible.what': 'The member is not visible.',
  'error.hint.member_not_visible.why':
    'The member is private and outside your visibility (the wire does not leak existence).',
  'error.hint.member_not_visible.fix':
    'Verify the member id and visibility; use a team-visible member or ask the owner to adjust visibility.',
  'error.hint.member_not_visible.verify': 'vessel agents; vessel errors --id <error_id>.',
  'error.hint.no_parent.what': 'No parent agent.',
  'error.hint.no_parent.why':
    'The operation requires a parent (e.g. hire), but this member has none.',
  'error.hint.no_parent.fix':
    'Operate from a member context that has a parent, or use create instead.',
  'error.hint.no_parent.verify': 'vessel errors --id <error_id>.',
  'error.hint.spawn_failed.what': 'Agent startup failed.',
  'error.hint.spawn_failed.why':
    'Startup prompt delivery or body initialization failed during create/activate (the record is not rolled back).',
  'error.hint.spawn_failed.fix':
    'Check the cause chain with vessel errors --id <error_id> to find the root cause; fix it, then retry creation or send a message to the member.',
  'error.hint.spawn_failed.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.team_full.what': 'The team is full.',
  'error.hint.team_full.why': 'The member count reached the team cap.',
  'error.hint.team_full.fix':
    'Close members no longer needed (agents.close) to free slots, or adjust the team size configuration.',
  'error.hint.team_full.verify': 'vessel agents; vessel errors --id <error_id>.',
  'error.hint.team_frozen.what': 'The team is frozen.',
  'error.hint.team_frozen.why': 'The team is in a frozen state and accepts no new operations.',
  'error.hint.team_frozen.fix': 'Check the team state; unfreeze it or use another team.',
  'error.hint.team_frozen.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.invalid_state_transition.what': 'Invalid state transition.',
  'error.hint.invalid_state_transition.why':
    'The requested operation is incompatible with the current member/team state.',
  'error.hint.invalid_state_transition.fix':
    'Refresh state (vessel agents) and choose an operation valid for the current state.',
  'error.hint.invalid_state_transition.verify': 'vessel errors --id <error_id> for details.',
  'error.hint.budget_exceeded.what': 'Conversation budget exceeded.',
  'error.hint.budget_exceeded.why':
    'One of hops/turns/tokens/wall-clock hit the teams[].budget cap.',
  'error.hint.budget_exceeded.fix':
    'Adjust teams[].budget (maxHops/maxTurns/maxTokens/maxWallClockSeconds) or split the task.',
  'error.hint.budget_exceeded.verify':
    'vessel errors --id <error_id> for the dimension in details.',
  'error.hint.budget_unavailable.what': 'The budget store is unavailable.',
  'error.hint.budget_unavailable.why': 'Budget counter store read/write failed.',
  'error.hint.budget_unavailable.fix': 'Check dataDir disk and permissions; vessel doctor; retry.',
  'error.hint.budget_unavailable.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.conversation_team_mismatch.what': 'Conversation/team mismatch.',
  'error.hint.conversation_team_mismatch.why':
    'The conversation belongs to another team and cannot be reused across teams.',
  'error.hint.conversation_team_mismatch.fix':
    'Operate within the owning team, or start a new conversation.',
  'error.hint.conversation_team_mismatch.verify': 'vessel errors --id <error_id>.',
  'error.hint.body_limit.what': 'Body count limit reached.',
  'error.hint.body_limit.why':
    'Each agent allows at most 1 live body; creating another while one is live is rejected.',
  'error.hint.body_limit.fix':
    'Wait for the current body to finish or close it before creating; do not create bodies for the same agent concurrently.',
  'error.hint.body_limit.verify': 'vessel agents; vessel errors --id <error_id>.',
  'error.hint.node_draining.what': 'The node is draining.',
  'error.hint.node_draining.why':
    'The node entered a drain window and temporarily accepts no new work.',
  'error.hint.node_draining.fix':
    'Retry shortly (retryable); watch drain progress with vessel node status.',
  'error.hint.node_draining.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.node_drain_no_record.what': 'Drain skipped: no node record found.',
  'error.hint.node_drain_no_record.why':
    'gateway.pid is missing or the pid mismatches; the node may have crashed or been started outside the supervisor.',
  'error.hint.node_drain_no_record.fix':
    'Check the node log to confirm process state; manually stop any leftover process and restart the node if needed.',
  'error.hint.node_drain_no_record.verify':
    'vessel errors --id <error_id>; node log (vessel logs tail).',
  'error.hint.node_drain_unauthorized.what': 'Drain skipped: stop credential rejected.',
  'error.hint.node_drain_unauthorized.why':
    'The stop credential was rejected (401) and the anonymous loopback fallback also failed.',
  'error.hint.node_drain_unauthorized.fix':
    'Verify gateway.token / VESSEL_NODE_TOKEN matches the target node config.',
  'error.hint.node_drain_unauthorized.verify': 'vessel errors --id <error_id>; vessel node token.',
  'error.hint.node_drain_method_not_found.what': 'Drain skipped: target lacks the shutdown method.',
  'error.hint.node_drain_method_not_found.why':
    'The target gateway build does not expose gateway.shutdown.',
  'error.hint.node_drain_method_not_found.fix': 'Upgrade the node, or stop it manually.',
  'error.hint.node_drain_method_not_found.verify':
    'vessel errors --id <error_id>; vessel rpc list.',
  'error.hint.node_drain_network.what': 'Drain skipped: node unreachable.',
  'error.hint.node_drain_network.why':
    'Connection refused/timeout; the node gateway cannot be reached.',
  'error.hint.node_drain_network.fix': 'Check the node process and the host:port in gateway.pid.',
  'error.hint.node_drain_network.verify': 'vessel errors --id <error_id>; vessel node status.',
  'error.hint.node_drain_timeout.what': 'Drain skipped: node did not exit within the stop timeout.',
  'error.hint.node_drain_timeout.why': 'Active runs may still be draining.',
  'error.hint.node_drain_timeout.fix':
    'Inspect active runs with runs.list; wait for drain to finish or force-stop.',
  'error.hint.node_drain_timeout.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.node_drain_quiesce_timeout.what':
    'Drain skipped: node did not exit within the post-quiesce window.',
  'error.hint.node_drain_quiesce_timeout.why':
    'The node quiesced but did not exit in time and was force-killed.',
  'error.hint.node_drain_quiesce_timeout.fix': 'Check whether shutdown hooks block exit.',
  'error.hint.node_drain_quiesce_timeout.verify': 'vessel errors --id <error_id>; node log.',
  'error.hint.team_not_found.what': 'The team does not exist.',
  'error.hint.team_not_found.why': 'The team_id is wrong or the team was deleted.',
  'error.hint.team_not_found.fix':
    'Verify the team_id (teams.list); pick from details.candidates when present.',
  'error.hint.team_not_found.verify': 'vessel errors --id <error_id> for details.candidates.',
  'error.hint.team_conversation_not_found.what': 'The team conversation does not exist.',
  'error.hint.team_conversation_not_found.why':
    'The conversation id is wrong or does not belong to this team.',
  'error.hint.team_conversation_not_found.fix':
    'Verify the conversation id and team ownership; create a new team conversation.',
  'error.hint.team_conversation_not_found.verify': 'vessel errors --id <error_id>.',
  'error.hint.team_log_write_failed.what': 'Team log write failed.',
  'error.hint.team_log_write_failed.why': 'Team log store write anomaly (disk/permission).',
  'error.hint.team_log_write_failed.fix': 'Check dataDir disk space and permissions; retry.',
  'error.hint.team_log_write_failed.verify':
    'vessel errors --id <error_id> for the cause chain; vessel doctor.',
  'error.hint.team_binding_requires_name.what': 'Team binding requires a name.',
  'error.hint.team_binding_requires_name.why':
    'The binding operation is missing the required name field.',
  'error.hint.team_binding_requires_name.fix': 'Provide the name field and retry.',
  'error.hint.team_binding_requires_name.verify':
    'vessel errors --id <error_id>; vessel rpc list <method>.',
  'error.hint.team_already_in_team.what': 'The member is already in the team.',
  'error.hint.team_already_in_team.why': 'Duplicate join of the same team.',
  'error.hint.team_already_in_team.fix': "No need to join again; check the member's current team.",
  'error.hint.team_already_in_team.verify': 'vessel agents; vessel errors --id <error_id>.',
  'error.hint.team_not_member.what': 'Not a team member.',
  'error.hint.team_not_member.why':
    'The operation requires membership, but the caller is not on the roster.',
  'error.hint.team_not_member.fix':
    'Join the team first (teams.join), or use a member with permission.',
  'error.hint.team_not_member.verify': 'vessel errors --id <error_id>.',
  'error.hint.team_private_member.what': 'The target is a private member.',
  'error.hint.team_private_member.why':
    'Private members are outside team visibility; team operations cannot reach them.',
  'error.hint.team_private_member.fix':
    'Ask the owner to adjust visibility, or use a team-visible member.',
  'error.hint.team_private_member.verify': 'vessel agents; vessel errors --id <error_id>.',
  'error.hint.team_no_team.what': 'No team context.',
  'error.hint.team_no_team.why':
    'The operation requires a team, but this member is not bound to one.',
  'error.hint.team_no_team.fix': 'Create or join a team first.',
  'error.hint.team_no_team.verify': 'vessel errors --id <error_id>.',
  'error.hint.team_self_mention.what': 'Cannot @ yourself.',
  'error.hint.team_self_mention.why': 'The message mentions its own sender, forming a self-loop.',
  'error.hint.team_self_mention.fix': 'Mention a different member.',
  'error.hint.team_self_mention.verify': 'vessel errors --id <error_id>.',
  'error.hint.team_owner_not_rosterable.what': 'The owner cannot be rostered.',
  'error.hint.team_owner_not_rosterable.why':
    'The team owner identity cannot be added to the roster as a regular member.',
  'error.hint.team_owner_not_rosterable.fix': 'Use a non-owner member for this operation.',
  'error.hint.team_owner_not_rosterable.verify': 'vessel errors --id <error_id>.',
  'error.hint.team_not_empty.what': 'The team is not empty.',
  'error.hint.team_not_empty.why': 'Delete/archive requires an empty team, but members remain.',
  'error.hint.team_not_empty.fix':
    'Close/remove all members first (agents.close), then delete the team.',
  'error.hint.team_not_empty.verify': 'vessel agents; vessel errors --id <error_id>.',
  'error.hint.team_archived.what': 'The team is archived.',
  'error.hint.team_archived.why': 'Archived teams are read-only and accept no new operations.',
  'error.hint.team_archived.fix': 'Use an active team; contact an admin to restore if needed.',
  'error.hint.team_archived.verify': 'vessel errors --id <error_id>.',
  'error.hint.not_visible.what': 'The resource is not visible.',
  'error.hint.not_visible.why':
    'The resource is private or outside your visibility (the wire does not leak existence).',
  'error.hint.not_visible.fix': 'Verify the id and visibility; ask the owner to adjust visibility.',
  'error.hint.not_visible.verify': 'vessel errors --id <error_id>.',
  'error.hint.message_not_found.what': 'The message does not exist.',
  'error.hint.message_not_found.why': 'The message_id is wrong or the message was cleaned up.',
  'error.hint.message_not_found.fix': 'Verify the message_id (inbox / team log).',
  'error.hint.message_not_found.verify': 'vessel errors --id <error_id>.',
  'error.hint.cursor_out_of_window.what': 'Cursor out of window.',
  'error.hint.cursor_out_of_window.why':
    'The paging cursor points to events beyond the retention window.',
  'error.hint.cursor_out_of_window.fix':
    'Re-fetch a cursor inside the window (list again without since).',
  'error.hint.cursor_out_of_window.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.timeline_write_failed.what': 'Timeline write failed.',
  'error.hint.timeline_write_failed.why':
    'Event persistence anomaly (disk/permission/store corruption).',
  'error.hint.timeline_write_failed.fix':
    'Check dataDir disk space and permissions; vessel doctor; report if it persists.',
  'error.hint.timeline_write_failed.verify':
    'vessel errors --id <error_id> for the cause chain; vessel logs tail.',
  'error.hint.timeline_record_too_large.what': 'Timeline record too large.',
  'error.hint.timeline_record_too_large.why': 'A single event exceeds the store size cap.',
  'error.hint.timeline_record_too_large.fix':
    'Reduce the content producing the event (e.g. truncate tool output); do not hand-edit the store.',
  'error.hint.timeline_record_too_large.verify': 'vessel errors --id <error_id> for details.',
  'error.hint.timeline_event_type_excluded.what': 'Event type excluded.',
  'error.hint.timeline_event_type_excluded.why':
    'The event type is not on the timeline inclusion whitelist.',
  'error.hint.timeline_event_type_excluded.fix':
    'No action if the filter is intended; review a whitelist change if inclusion is truly needed.',
  'error.hint.timeline_event_type_excluded.verify':
    'vessel errors --id <error_id> for details.type.',
  'error.hint.timeline_writer_closed.what': 'The timeline writer is closed.',
  'error.hint.timeline_writer_closed.why':
    'A write arrived after the store writer closed (usually a shutdown race).',
  'error.hint.timeline_writer_closed.fix':
    'Restart the gateway to restore the writer; report if frequent.',
  'error.hint.timeline_writer_closed.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.timeline_index_invalid.what': 'Timeline index invalid.',
  'error.hint.timeline_index_invalid.why': 'The index file is corrupt or inconsistent with events.',
  'error.hint.timeline_index_invalid.fix':
    'Check the store with vessel doctor; rebuild the index via the ops procedure if needed — do not hand-edit.',
  'error.hint.timeline_index_invalid.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.timeline_archive_failed.what': 'Timeline archive failed.',
  'error.hint.timeline_archive_failed.why': 'Archive/compaction storage operation anomaly.',
  'error.hint.timeline_archive_failed.fix':
    'Check disk space and permissions; retry; report if it persists.',
  'error.hint.timeline_archive_failed.verify': 'vessel errors --id <error_id> for the cause chain.',
  'error.hint.unknown_ref.what': 'Unknown model reference.',
  'error.hint.unknown_ref.why': 'The provider/model reference is not in the model registry.',
  'error.hint.unknown_ref.fix':
    'List available refs with vessel model list; set the right default with vessel model set-default; pick from details.candidates when present.',
  'error.hint.unknown_ref.verify':
    'vessel errors --id <error_id> for details.candidates; vessel doctor.',
  'error.hint.provider_auth.what': 'Model provider authentication failed.',
  'error.hint.provider_auth.why': 'The API key is missing, invalid, or expired.',
  'error.hint.provider_auth.fix':
    'Configure credentials with vessel model credential set; verify the env var named by provider.apiKeyEnv has a value.',
  'error.hint.provider_auth.verify': 'vessel model test; vessel errors --id <error_id>.',
  'error.hint.provider_rate_limit.what': 'Provider rate limit.',
  'error.hint.provider_rate_limit.why': 'Request frequency exceeded the provider rate limit.',
  'error.hint.provider_rate_limit.fix':
    'Retry shortly (retryable, automatic backoff); reduce concurrency or raise the limit if persistent.',
  'error.hint.provider_rate_limit.verify': 'vessel errors --id <error_id>; vessel logs tail.',
  'error.hint.provider_quota_exceeded.what': 'Provider quota exhausted.',
  'error.hint.provider_quota_exceeded.why': 'Account quota/balance is used up.',
  'error.hint.provider_quota_exceeded.fix':
    'Top up or raise the provider quota; switch model (vessel model set-default).',
  'error.hint.provider_quota_exceeded.verify': 'vessel model test; vessel errors --id <error_id>.',
  'error.hint.provider_timeout.what': 'Provider request timed out.',
  'error.hint.provider_timeout.why': 'The model response exceeded the timeout threshold.',
  'error.hint.provider_timeout.fix':
    'Retry (retryable); check the network or switch model if persistent.',
  'error.hint.provider_timeout.verify': 'vessel model test; vessel errors --id <error_id>.',
  'error.hint.provider_context_overflow.what': 'Context overflow.',
  'error.hint.provider_context_overflow.why': 'The prompt exceeds the model context window.',
  'error.hint.provider_context_overflow.fix':
    'Compact the session or start a new one; switch to a larger-context model.',
  'error.hint.provider_context_overflow.verify': 'vessel errors --id <error_id> for details.',
  'error.hint.provider_unavailable.what': 'Provider unavailable.',
  'error.hint.provider_unavailable.why':
    'The provider service is temporarily unavailable (5xx/maintenance).',
  'error.hint.provider_unavailable.fix': 'Retry shortly (retryable); switch model if persistent.',
  'error.hint.provider_unavailable.verify': 'vessel model test; vessel errors --id <error_id>.',
  'error.hint.provider_http_error.what': 'Provider HTTP error.',
  'error.hint.provider_http_error.why': 'The provider returned an unexpected HTTP status.',
  'error.hint.provider_http_error.fix':
    'Check http_status and cause with vessel errors --id <error_id>; verify baseUrl and credentials.',
  'error.hint.provider_http_error.verify': 'vessel model test; vessel logs tail.',
  'error.hint.provider_network.what': 'Provider network error.',
  'error.hint.provider_network.why': 'Network-layer failure (DNS/connection/TLS).',
  'error.hint.provider_network.fix':
    'Check network and proxy; verify provider.baseUrl; retry (retryable).',
  'error.hint.provider_network.verify': 'vessel model test; vessel errors --id <error_id>.',
  'error.hint.provider_error.what': 'Other provider error.',
  'error.hint.provider_error.why': 'A provider error not covered by the subclasses above.',
  'error.hint.provider_error.fix':
    'Inspect the cause chain with vessel errors --id <error_id>; report if needed.',
  'error.hint.provider_error.verify': 'vessel logs tail; vessel model test.',
  'error.hint.tool_timeout.what': 'Tool call timed out.',
  'error.hint.tool_timeout.why': 'Tool execution exceeded the timeout threshold.',
  'error.hint.tool_timeout.fix':
    'Retry (retryable); split long tasks or inspect the tool implementation.',
  'error.hint.tool_timeout.verify':
    'vessel errors --id <error_id> for tool_name; vessel logs tail.',
  'error.hint.tool_not_found.what': 'The tool does not exist.',
  'error.hint.tool_not_found.why': 'The tool name is wrong or the tool is not wired.',
  'error.hint.tool_not_found.fix':
    'Verify the tool name and wiring (tools config); pick from details.candidates when present.',
  'error.hint.tool_not_found.verify': 'vessel errors --id <error_id> for details.candidates.',
  'error.hint.tool_invalid_arguments.what': 'Invalid tool arguments.',
  'error.hint.tool_invalid_arguments.why': 'Arguments do not match the tool schema.',
  'error.hint.tool_invalid_arguments.fix': 'Fix the arguments per the tool schema and retry.',
  'error.hint.tool_invalid_arguments.verify': 'vessel errors --id <error_id> for details.',
  'error.hint.tool_blocked.what': 'Tool call blocked.',
  'error.hint.tool_blocked.why': 'The permission policy forbids this tool call.',
  'error.hint.tool_blocked.fix':
    'Check permission.neverAutoApprove / tool whitelist config; adjust the policy if it should be allowed.',
  'error.hint.tool_blocked.verify': 'vessel errors --id <error_id>; permission logs.',
  'error.hint.tool_error.what': 'Tool execution error.',
  'error.hint.tool_error.why': 'An internal tool exception.',
  'error.hint.tool_error.fix':
    'Inspect the cause chain with vessel errors --id <error_id>; fix the tool or input and retry.',
  'error.hint.tool_error.verify': 'vessel logs tail; vessel errors --run <run_id>.',
  'error.hint.permission_timeout.what': 'Permission approval timed out.',
  'error.hint.permission_timeout.why': 'Unattended approval exceeded the wait window.',
  'error.hint.permission_timeout.fix':
    'Adjust teams[].permission.unattended / denyAfterSeconds; or approve promptly.',
  'error.hint.permission_timeout.verify': 'vessel errors --id <error_id>; permission logs.',
  'error.hint.permission_cancelled.what': 'Permission approval was cancelled.',
  'error.hint.permission_cancelled.why': 'The approval request was actively cancelled.',
  'error.hint.permission_cancelled.fix': 'Re-issue the operation and approve it.',
  'error.hint.permission_cancelled.verify': 'vessel errors --id <error_id>.',
  'error.hint.permission_denied.what': 'Permission denied.',
  'error.hint.permission_denied.why': 'The approver denied it or policy says deny.',
  'error.hint.permission_denied.fix':
    'Check the denial reason; adjust the operation or policy and retry — do not bypass.',
  'error.hint.permission_denied.verify': 'vessel errors --id <error_id>; permission logs.',
  'error.hint.permission_error.what': 'Permission system error.',
  'error.hint.permission_error.why': 'Internal anomaly in approval/policy execution.',
  'error.hint.permission_error.fix':
    'Inspect the cause chain with vessel errors --id <error_id>; vessel doctor; report if persistent.',
  'error.hint.permission_error.verify': 'vessel logs tail; permission logs.',
  'error.hint.config_error.what': 'Configuration error.',
  'error.hint.config_error.why': 'Config validation failed or loading anomaly.',
  'error.hint.config_error.fix':
    'Fix the config at the reported path (locate with vessel doctor); hot-reload with vessel gateway reload.',
  'error.hint.config_error.verify': 'vessel doctor; vessel errors --id <error_id>.',
  'error.hint.gateway_error.what': 'Gateway error.',
  'error.hint.gateway_error.why': 'An unclassified gateway-layer anomaly.',
  'error.hint.gateway_error.fix':
    'Check gateway logs with vessel logs tail; vessel doctor --errors; vessel gateway restart if needed.',
  'error.hint.gateway_error.verify': 'vessel errors --id <error_id> for the cause chain.',
  'error.hint.internal_error.what': 'Internal error.',
  'error.hint.internal_error.why': 'An unclassified internal anomaly.',
  'error.hint.internal_error.fix':
    'Inspect the cause chain with vessel errors --id <error_id>; vessel doctor --errors for drift; report.',
  'error.hint.internal_error.verify': 'vessel logs tail.',
  'error.hint.checkpoint_failed.what': 'Checkpoint write failed.',
  'error.hint.checkpoint_failed.why': 'Run checkpoint persistence anomaly.',
  'error.hint.checkpoint_failed.fix':
    'Check dataDir disk and permissions; retry (retryable); report if persistent.',
  'error.hint.checkpoint_failed.verify': 'vessel errors --id <error_id>; vessel doctor.',
};
