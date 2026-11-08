/**
 * `vessel hub` 一次性子命令（S5）。
 *
 * 只做参数映射、HTTP / WS 调用与渲染；进程装配在 `src/hub/runtime.ts`。
 * 明文 token / 配对码只出现在用户请求的输出里，不写日志、不放进错误消息。
 *
 * @module vessel/hub-command
 */

import * as path from 'node:path';
import { HUB_PROTOCOL } from '@vessel-agent/serve';
import { isLoopbackHostname, loadConfig, type VesselConfig } from '../packages/config/src/index';
import type { HubCommand } from './cli-args';
import { expandHome, resolveDataDir } from './data-paths';
import { collectGatewayState } from './gateway/pid';
import { createHubJoinStore } from './hub/join-store';
import {
  HUB_NODE_STATE_FILE,
  type HubNodeStatusFile,
  readHubNodeStatus,
  writeHubNodeState,
} from './hub/node-state';
import { hubNodeTokenSecretKey } from './hub/outbound-wiring';
import {
  defaultHubDataDir,
  type HubRuntime,
  type StartHubRuntimeOptions,
  startHubRuntime,
} from './hub/runtime';
import { type CreateSecretStoreOptions, createSecretStore } from './hub/secret-store';
import type { HubNodeState, SecretStore } from './hub/types';
import { t } from './i18n';
import { resolveNodeId } from './node-identity';
import { ui } from './ui-style';

const DEFAULT_HUB_PORT = 8643;
const REQUEST_TIMEOUT_MS = 10_000;
/** `hub join` 等首个 healthy 状态的上限（R1 裁决）。 */
const JOIN_STATUS_TIMEOUT_MS = 10_000;
const JOIN_STATUS_POLL_MS = 250;
/** 节点凭据的 keychain service；与 hub 的 `vessel-hub` 隔离。 */
const NODE_KEYCHAIN_SERVICE = 'vessel-node';

export interface HubCommandDeps {
  config?: VesselConfig;
  env?: Record<string, string | undefined>;
  /** 全局 data dir（已解析）；测试注入。 */
  dataDir?: string;
  now?: () => number;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => WebSocket;
  startRuntime?: (options: StartHubRuntimeOptions) => Promise<HubRuntime>;
  /** 测试注入节点凭据存储；缺省 `createSecretStore`。 */
  createSecretStore?: (options: CreateSecretStoreOptions) => SecretStore;
  /** 测试注入 gateway 存活探测；缺省读 `<dataDir>/gateway.pid`。 */
  gatewayStatus?: () => Promise<{ running: boolean }>;
  /** 测试注入 `hub-node-status.json` 读取；缺省 `readHubNodeStatus`。 */
  readNodeStatus?: (dataDir: string) => Promise<HubNodeStatusFile | undefined>;
  /** 测试 / 宿主停止信号；缺省等 SIGINT / SIGTERM。 */
  signal?: AbortSignal;
}

class HubCommandFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HubCommandFailure';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function output(deps: HubCommandDeps, line: string): void {
  (deps.print ?? console.log)(line);
}

function outputErr(deps: HubCommandDeps, line: string): void {
  (deps.printErr ?? console.error)(ui.err(line));
}

function errorText(error: unknown): string {
  if (error instanceof HubCommandFailure) return `${error.code}: ${error.message}`;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return error.message.startsWith(`${code}:`) ? error.message : `${code}: ${error.message}`;
    }
    return `hub_command_error: ${error.message}`;
  }
  return `hub_command_error: ${String(error)}`;
}

function normalizeHttpBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HubCommandFailure('invalid_hub_url', t('hub.error.invalidUrl'));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HubCommandFailure('invalid_hub_url', 'hub url must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new HubCommandFailure('invalid_hub_url', 'hub url must not contain userinfo');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new HubCommandFailure('invalid_hub_url', 'hub url must not contain a path');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new HubCommandFailure('invalid_hub_url', 'hub url must not contain query or hash');
  }
  return url.origin;
}

function normalizeNodeUrl(raw: string): string {
  const base = normalizeHttpBaseUrl(raw);
  const url = new URL(base);
  if (!isLoopbackHostname(url.hostname) && url.protocol !== 'https:') {
    throw new HubCommandFailure(
      'invalid_node_url',
      'non-loopback nodes require https (plaintext fallback is not supported)',
    );
  }
  return base;
}

/** `hub join` 的 hub origin：与 `normalizeNodeUrl` 同规则（非回环必须 https）。 */
function normalizeJoinHubUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HubCommandFailure('invalid_hub_url', t('hub.error.invalidUrl'));
  }
  const invalid = (): HubCommandFailure =>
    new HubCommandFailure('invalid_hub_url', t('hub.error.invalidUrl'));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid();
  if (url.username !== '' || url.password !== '') throw invalid();
  if (url.pathname !== '/' && url.pathname !== '') throw invalid();
  if (url.search !== '' || url.hash !== '') throw invalid();
  if (!isLoopbackHostname(url.hostname) && url.protocol !== 'https:') {
    throw new HubCommandFailure('invalid_hub_url', t('hub.error.httpsRequired'));
  }
  return url.origin;
}

function normalizeJoinPublicUrl(raw: string): string {
  try {
    return normalizeNodeUrl(raw);
  } catch {
    throw new HubCommandFailure('invalid_public_url', t('hub.error.invalidPublicUrl'));
  }
}

function invalidResponse(): HubCommandFailure {
  return new HubCommandFailure('invalid_response', t('hub.error.invalidResponse'));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function resolveHubUrl(explicit: string | undefined, config: VesselConfig): string {
  if (explicit !== undefined) return normalizeHttpBaseUrl(explicit);
  const port = config.hub?.listen?.port ?? DEFAULT_HUB_PORT;
  return `http://127.0.0.1:${port}`;
}

function resolveEnvToken(deps: HubCommandDeps, envName: string): string {
  const env = deps.env ?? process.env;
  const value = env[envName];
  if (typeof value !== 'string' || value === '') {
    throw new HubCommandFailure('hub_token_missing', t('hub.error.envMissing', { env: envName }));
  }
  return value;
}

function resolveHubToken(
  deps: HubCommandDeps,
  config: VesselConfig,
  explicitEnv: string | undefined,
): string | undefined {
  const envName =
    explicitEnv ??
    (typeof config.hub?.tokenEnv === 'string' && config.hub.tokenEnv !== ''
      ? config.hub.tokenEnv
      : undefined);
  if (envName === undefined) return undefined;
  return resolveEnvToken(deps, envName);
}

function makeHeaders(token: string | undefined, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (hasBody) headers['content-type'] = 'application/json';
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return headers;
}

function responseFailure(status: number, body: unknown): HubCommandFailure {
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === 'string' ? body.error.code : `http_${status}`;
    const message = typeof body.error.message === 'string' ? body.error.message : `HTTP ${status}`;
    return new HubCommandFailure(code, message);
  }
  return new HubCommandFailure(`http_${status}`, `HTTP ${status}`);
}

type FetchInit = RequestInit & { tls?: { ca: string } };

async function requestJson(
  deps: HubCommandDeps,
  url: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    tls?: { ca: string };
  } = {},
): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const hasBody = options.body !== undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();

  const init: FetchInit = {
    method: options.method ?? (hasBody ? 'POST' : 'GET'),
    headers: makeHeaders(options.token, hasBody),
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    signal: controller.signal,
  };
  if (options.tls !== undefined) init.tls = options.tls;

  let response: Response;
  try {
    response = await fetchImpl(url, init as RequestInit);
  } catch (error) {
    const aborted = controller.signal.aborted;
    throw new HubCommandFailure(
      aborted ? 'request_timeout' : 'request_failed',
      aborted
        ? t('hub.error.timeout', { ms: REQUEST_TIMEOUT_MS })
        : t('hub.error.requestFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
    );
  } finally {
    clearTimeout(timer);
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new HubCommandFailure('invalid_response', t('hub.error.invalidResponse'));
  }
  let body: unknown;
  if (text !== '') {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new HubCommandFailure('invalid_response', t('hub.error.invalidResponse'));
    }
  }
  if (!response.ok) throw responseFailure(response.status, body);
  return body;
}

function nodeLines(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.nodes)) {
    throw new HubCommandFailure('invalid_response', t('hub.error.invalidResponse'));
  }
  if (body.nodes.length === 0) return [ui.dim(t('hub.empty.nodes'))];
  const lines = [ui.dim('node_id  status  teams  agents  last_seen')];
  for (const node of body.nodes) {
    if (!isRecord(node)) continue;
    const counts = isRecord(node.counts) ? node.counts : {};
    const teams = typeof counts.teams === 'number' ? String(counts.teams) : '-';
    const agents = typeof counts.agents === 'number' ? String(counts.agents) : '-';
    const lastSeen =
      typeof node.last_seen === 'number' && Number.isFinite(node.last_seen)
        ? new Date(node.last_seen).toISOString()
        : '-';
    lines.push(
      [String(node.node_id ?? '-'), String(node.status ?? '-'), teams, agents, lastSeen].join('  '),
    );
  }
  return lines;
}

function formatDirectory(body: unknown): string {
  return nodeLines(body).join('\n');
}

function withHubOverrides(config: VesselConfig, command: Extract<HubCommand, { kind: 'start' }>) {
  const hub = { ...(config.hub ?? {}) };
  if (command.host !== undefined || command.port !== undefined) {
    hub.listen = {
      ...(hub.listen ?? {}),
      ...(command.host !== undefined ? { hostname: command.host } : {}),
      ...(command.port !== undefined ? { port: command.port } : {}),
    };
  }
  if (command.allowRemote === true) hub.allowRemote = true;
  if (command.tlsCert !== undefined && command.tlsKey !== undefined) {
    hub.tls = { certFile: command.tlsCert, keyFile: command.tlsKey };
  }
  if (command.dataDir !== undefined) hub.dataDir = command.dataDir;
  return { ...config, hub };
}

function waitForStop(runtime: HubRuntime, deps: HubCommandDeps): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    function cleanup(): void {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      deps.signal?.removeEventListener('abort', finish);
    }
    function finish(): void {
      if (finished) return;
      finished = true;
      cleanup();
      void runtime
        .stop()
        .catch(() => undefined)
        .finally(() => resolve());
    }
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    if (deps.signal !== undefined) {
      deps.signal.addEventListener('abort', finish, { once: true });
      if (deps.signal.aborted) finish();
    }
  });
}

async function startCommand(
  command: Extract<HubCommand, { kind: 'start' }>,
  deps: HubCommandDeps,
  config: VesselConfig,
): Promise<number> {
  const start = deps.startRuntime ?? startHubRuntime;
  const runtime = await start({
    config: withHubOverrides(config, command),
    ...(command.dataDir !== undefined ? { dataDir: command.dataDir } : {}),
  });
  output(deps, ui.ok(`hub listening on ${runtime.url}`));
  await waitForStop(runtime, deps);
  output(deps, ui.info('hub stopped'));
  return 0;
}

async function directoryCommand(
  hubUrl: string | undefined,
  tokenEnv: string | undefined,
  json: boolean,
  deps: HubCommandDeps,
  config: VesselConfig,
): Promise<number> {
  const baseUrl = resolveHubUrl(hubUrl, config);
  const token = resolveHubToken(deps, config, tokenEnv);
  const body = await requestJson(deps, `${baseUrl}/v1/hub/directory`, { token });
  output(deps, json ? JSON.stringify(body, null, 2) : formatDirectory(body));
  return 0;
}

function frameText(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return undefined;
}

function pointerLine(frame: Record<string, unknown>): string {
  const parts = [
    'pointer',
    String(frame.node_id ?? '-'),
    String(frame.team_id ?? '-'),
    String(frame.reason ?? '-'),
    String(frame.ts ?? '-'),
  ];
  if (typeof frame.request_id === 'string' && frame.request_id !== '') {
    parts.push(frame.request_id);
  }
  return parts.join('  ');
}

async function watchCommand(
  command: Extract<HubCommand, { kind: 'watch' }>,
  deps: HubCommandDeps,
  config: VesselConfig,
): Promise<number> {
  const hubUrl = resolveHubUrl(command.hubUrl, config);
  const token = resolveHubToken(deps, config, command.tokenEnv);
  const wsUrl = `${hubUrl.replace(/^http/, 'ws')}/v1/hub/events`;
  const factory = deps.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocket);
  const ws = factory(wsUrl);

  return await new Promise<number>((resolve) => {
    let settled = false;
    function cleanup(): void {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      deps.signal?.removeEventListener('abort', onSignal);
    }
    function finish(code: number, error?: string): void {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        ws.close();
      } catch {
        // best-effort
      }
      if (error !== undefined) outputErr(deps, error);
      resolve(code);
    }
    function onSignal(): void {
      finish(0);
    }

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    deps.signal?.addEventListener('abort', onSignal, { once: true });

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          v: 1,
          kind: 'auth',
          protocol: HUB_PROTOCOL,
          dialer: 'hub',
          ...(token !== undefined ? { token } : {}),
        }),
      );
    });
    ws.addEventListener('message', (event: { data: unknown }) => {
      const text = frameText(event.data);
      if (text === undefined) return;
      let frame: unknown;
      try {
        frame = JSON.parse(text) as unknown;
      } catch {
        return;
      }
      if (!isRecord(frame) || frame.v !== 1) return;
      if (frame.kind === 'directory') {
        output(deps, ui.section('directory'));
        output(deps, formatDirectory(frame));
      } else if (frame.kind === 'pointer') {
        output(deps, pointerLine(frame));
      }
    });
    ws.addEventListener('error', () => {
      finish(
        1,
        new HubCommandFailure(
          'request_failed',
          t('hub.error.requestFailed', {
            detail: 'websocket error',
          }),
        ).message,
      );
    });
    ws.addEventListener('close', () => {
      finish(1, t('hub.watch.closed'));
    });

    if (deps.signal?.aborted === true) finish(0);
  });
}

function hubJoinCodeDataDir(config: VesselConfig, explicit?: string): string {
  const configured = explicit ?? config.hub?.dataDir;
  return configured === undefined
    ? defaultHubDataDir(config)
    : path.resolve(expandHome(configured));
}

async function joinCodeCommand(
  command: Extract<HubCommand, { kind: 'join-code' }>,
  deps: HubCommandDeps,
  config: VesselConfig,
): Promise<number> {
  const dataDir = hubJoinCodeDataDir(config, command.dataDir);
  const hubId = await resolveNodeId({ dataDir });
  const ttl = command.ttl ?? config.hub?.pairingTtlSeconds;
  const store = createHubJoinStore({ dataDir, hubId });
  const issued = await store.issue({
    ...(ttl !== undefined ? { ttl_s: ttl } : {}),
  });

  if (command.json) {
    output(
      deps,
      JSON.stringify(
        {
          code: issued.code,
          expires_at: issued.expires_at,
          hub_id: hubId,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  output(deps, ui.ok(t('hub.joinCode.code', { code: issued.code })));
  output(deps, t('hub.joinCode.expiresAt', { at: new Date(issued.expires_at).toISOString() }));
  return 0;
}

function joinNodeDataDir(
  command: Extract<HubCommand, { kind: 'join' }>,
  deps: HubCommandDeps,
  config: VesselConfig,
): string {
  if (command.dataDir !== undefined) return path.resolve(expandHome(command.dataDir));
  if (deps.dataDir !== undefined) return path.resolve(deps.dataDir);
  return resolveDataDir(config, deps.env ?? process.env);
}

/** `--code` > `--code-env` > `config.hub.joinCodeEnv`；缺失是稳定错误。 */
function resolveJoinCode(
  command: Extract<HubCommand, { kind: 'join' }>,
  deps: HubCommandDeps,
  config: VesselConfig,
): string {
  if (command.code !== undefined) return command.code;
  const envName = command.codeEnv ?? config.hub?.joinCodeEnv;
  if (envName === undefined) {
    throw new HubCommandFailure('hub_join_code_missing', t('hub.error.joinCodeMissing'));
  }
  const env = deps.env ?? process.env;
  const value = env[envName];
  if (typeof value !== 'string' || value === '') {
    throw new HubCommandFailure('hub_join_code_missing', t('hub.error.joinCodeMissing'));
  }
  return value;
}

interface JoinResponse {
  hub_id: string;
  node_id: string;
  token: string;
  token_id: string;
  expires_at: number;
}

/** 校验 join 响应白名单字段。 */
function parseJoinResponse(body: unknown, nodeId: string): JoinResponse {
  if (!isRecord(body) || body.scope !== 'node') throw invalidResponse();
  const hubId = body.hub_id;
  const token = body.token;
  const tokenId = body.token_id;
  const expiresAt = body.expires_at;
  if (typeof hubId !== 'string' || hubId === '') throw invalidResponse();
  if (typeof token !== 'string' || token === '') throw invalidResponse();
  if (typeof tokenId !== 'string' || tokenId === '') throw invalidResponse();
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) throw invalidResponse();
  return {
    hub_id: hubId,
    node_id: nodeId,
    token,
    token_id: tokenId,
    expires_at: expiresAt,
  };
}

async function readNodeStatusSafe(
  readStatus: (dataDir: string) => Promise<HubNodeStatusFile | undefined>,
  dataDir: string,
): Promise<HubNodeStatusFile | undefined> {
  try {
    return await readStatus(dataDir);
  } catch {
    return undefined;
  }
}

function withStatus(
  joined: boolean,
  status: HubNodeStatusFile | undefined,
): { joined: boolean; status?: HubNodeStatusFile } {
  return status !== undefined ? { joined, status } : { joined };
}

/**
 * R1 成功语义：只有运行中的 gateway 报 healthy 才算 `joined`；
 * 否则明确是 `saved`，不能把「写了文件」说成「已连通」。
 */
async function waitForJoinStatus(
  dataDir: string,
  readStatus: (dataDir: string) => Promise<HubNodeStatusFile | undefined>,
  deps: HubCommandDeps,
): Promise<{ joined: boolean; status?: HubNodeStatusFile }> {
  let running = false;
  try {
    if (deps.gatewayStatus !== undefined) {
      running = (await deps.gatewayStatus()).running;
    } else {
      // 任一实例仍占用进程即可；`--port` 会让 PID 文件带实例后缀。
      // running / degraded / starting 都表示进程句柄仍在（identity 可能未确认）。
      running = (await collectGatewayState(dataDir)).entries.some(
        (entry) =>
          entry.state === 'running' || entry.state === 'degraded' || entry.state === 'starting',
      );
    }
  } catch {
    running = false;
  }

  let status = await readNodeStatusSafe(readStatus, dataDir);
  // gateway 不在运行时，状态文件可能是上一次运行留下的；不要据此声称已连通。
  if (!running) return withStatus(false, undefined);

  const deadline = Date.now() + JOIN_STATUS_TIMEOUT_MS;
  while (status?.status !== 'healthy') {
    if (Date.now() >= deadline) break;
    await delay(Math.min(JOIN_STATUS_POLL_MS, Math.max(0, deadline - Date.now())));
    status = await readNodeStatusSafe(readStatus, dataDir);
  }
  return withStatus(status?.status === 'healthy', status);
}

async function joinCommand(
  command: Extract<HubCommand, { kind: 'join' }>,
  deps: HubCommandDeps,
  config: VesselConfig,
): Promise<number> {
  const rawHubUrl = command.hubUrl ?? config.hub?.url;
  if (rawHubUrl === undefined || rawHubUrl.trim() === '') {
    throw new HubCommandFailure('invalid_hub_url', t('hub.error.hubUrlMissing'));
  }
  const hubUrl = normalizeJoinHubUrl(rawHubUrl);
  const code = resolveJoinCode(command, deps, config);
  const dataDir = joinNodeDataDir(command, deps, config);
  const nodeId = await resolveNodeId({
    ...(typeof config.host?.nodeId === 'string' && config.host.nodeId !== ''
      ? { configNodeId: config.host.nodeId }
      : {}),
    dataDir,
  });
  const publicUrl =
    command.publicUrl !== undefined ? normalizeJoinPublicUrl(command.publicUrl) : undefined;

  // join 本身可能走私有 CA；与 hub 侧 `node add` 一样把 CA 传给 fetch。
  let tls: { ca: string } | undefined;
  if (command.caFile !== undefined) {
    try {
      const ca = await Bun.file(command.caFile).text();
      if (ca.trim() === '') throw new Error('empty ca');
      tls = { ca };
    } catch {
      throw new HubCommandFailure('invalid_ca', t('hub.error.invalidCa', { path: command.caFile }));
    }
  }

  const body = await requestJson(deps, `${hubUrl}/v1/hub/join`, {
    method: 'POST',
    body: {
      protocol: HUB_PROTOCOL,
      code,
      node_id: nodeId,
      ...(publicUrl !== undefined ? { public_url: publicUrl } : {}),
    },
    ...(tls !== undefined ? { tls } : {}),
  });
  const joined = parseJoinResponse(body, nodeId);

  // R1 写入顺序：先写 SecretStore token，再写 hub-node.json；state 失败删除 token。
  const createSecrets = deps.createSecretStore ?? createSecretStore;
  const secrets = createSecrets({
    dataDir: path.join(dataDir, 'hub-node'),
    allowFileSecrets: config.hub?.allowFileSecrets === true,
    keychainService: NODE_KEYCHAIN_SERVICE,
  });
  const tokenKey = hubNodeTokenSecretKey(joined.hub_id);
  await secrets.set(tokenKey, joined.token);

  const state: HubNodeState = {
    v: 1,
    hub_url: hubUrl,
    hub_id: joined.hub_id,
    node_id: nodeId,
    token_id: joined.token_id,
    expires_at: joined.expires_at,
    joined_at: (deps.now ?? Date.now)(),
    ...(command.caFile !== undefined ? { ca_file: command.caFile } : {}),
    ...(publicUrl !== undefined ? { public_url: publicUrl } : {}),
  };
  try {
    await writeHubNodeState(dataDir, state);
  } catch (error) {
    try {
      await secrets.delete(tokenKey);
    } catch {
      // best-effort：token 仍会在 TTL 后过期
    }
    throw error;
  }

  const readStatus = deps.readNodeStatus ?? readHubNodeStatus;
  const outcome = await waitForJoinStatus(dataDir, readStatus, deps);
  const stateFile = path.join(dataDir, HUB_NODE_STATE_FILE);

  if (command.json) {
    output(
      deps,
      JSON.stringify(
        {
          ok: true,
          joined: outcome.joined,
          hub_id: joined.hub_id,
          node_id: nodeId,
          state_file: stateFile,
          ...(outcome.status !== undefined ? { status: outcome.status.status } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (outcome.joined) {
    output(deps, ui.ok(t('hub.join.joined', { hub: joined.hub_id, pairing: nodeId })));
  } else {
    output(deps, ui.info(t('hub.join.saved')));
    if (outcome.status !== undefined) {
      output(deps, t('hub.join.lastStatus', { status: outcome.status.status }));
    }
  }
  return 0;
}

async function nodeListCommand(
  command: Extract<HubCommand, { kind: 'node-list' }>,
  deps: HubCommandDeps,
  config: VesselConfig,
): Promise<number> {
  return directoryCommand(command.hubUrl, undefined, command.json, deps, config);
}

async function nodeRemoveCommand(
  command: Extract<HubCommand, { kind: 'node-remove' }>,
  deps: HubCommandDeps,
  config: VesselConfig,
): Promise<number> {
  const baseUrl = resolveHubUrl(command.hubUrl, config);
  const body = await requestJson(
    deps,
    `${baseUrl}/v1/hub/nodes/${encodeURIComponent(command.pairingId)}`,
    { method: 'DELETE' },
  );
  if (!isRecord(body) || body.ok !== true) {
    throw new HubCommandFailure('invalid_response', t('hub.error.invalidResponse'));
  }
  output(deps, ui.ok(`removed ${command.pairingId}`));
  return 0;
}

export async function runHubCommand(
  command: HubCommand,
  deps: HubCommandDeps = {},
): Promise<number> {
  let config: VesselConfig;
  try {
    config = deps.config ?? (await loadConfig()).config;
  } catch (error) {
    outputErr(deps, errorText(error));
    return 1;
  }

  try {
    switch (command.kind) {
      case 'start':
        return await startCommand(command, deps, config);
      case 'directory':
        return await directoryCommand(command.hubUrl, command.tokenEnv, command.json, deps, config);
      case 'watch':
        return await watchCommand(command, deps, config);
      case 'join-code':
        return await joinCodeCommand(command, deps, config);
      case 'join':
        return await joinCommand(command, deps, config);
      case 'node-list':
        return await nodeListCommand(command, deps, config);
      case 'node-remove':
        return await nodeRemoveCommand(command, deps, config);
    }
  } catch (error) {
    outputErr(deps, errorText(error));
    return 1;
  }
}
