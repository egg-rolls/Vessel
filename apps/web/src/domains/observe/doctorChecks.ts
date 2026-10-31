/**
 * Observe → Diagnostics：`vessel doctor --deep` 九类检查的只读映射（0.33 D）。
 *
 * 数据只来自既有 RPC：config.get / config.sources / health.get /
 * capabilities.list / mcp.list。RPC 看不到的检查（配置校验结果、目录可写性、
 * 端口可绑定）必须标为 unavailable/info 并写明原因，不得用推断值冒充。
 */
import type {
  CapabilityManifest,
  ConfigResponse,
  ConfigSourcesResponse,
  HealthResponse,
  McpServerStatus,
} from '../../gateway/types';
import { t } from '../../i18n';

export type DoctorCheckStatus = 'ok' | 'warn' | 'fail' | 'info' | 'unavailable';

export interface DoctorCheck {
  /** 与 CLI `vessel doctor` 的 check name 一致。 */
  name: string;
  status: DoctorCheckStatus;
  /** 该行数据来自哪些 RPC。 */
  source: string;
  detail: string;
}

export interface DoctorCheckInput {
  config?: ConfigResponse;
  sources?: ConfigSourcesResponse;
  health?: HealthResponse;
  capabilities?: CapabilityManifest;
  mcpServers?: McpServerStatus[];
  mcpError?: string;
  mcpErrorCode?: string;
  configError?: string;
  capabilitiesError?: string;
  healthError?: string;
  gatewayUrl: string;
  connected: boolean;
}

/** 与 packages/config defaults.ts 的 DEFAULT_DATA_DIR 一致（仅展示用）。 */
const DEFAULT_DATA_DIR = '~/.vessel/data';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 脱敏标记：`<set>`（或任意非空值）为已设置，`<unset>` / 缺失为未设置。 */
function isSet(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && value !== '<unset>';
}

function setMarker(value: boolean): string {
  return t(value ? 'observe.diagnostics.doctor.set' : 'observe.diagnostics.doctor.unset');
}

function pendingDetail(error: string | undefined): string {
  return error ?? t('observe.diagnostics.doctor.pending');
}

export function buildDoctorChecks(input: DoctorCheckInput): DoctorCheck[] {
  const configRoot = asRecord(input.config?.config);
  const configError = input.configError;
  /** 最近一次 config.get 失败时，旧快照不能继续冒充当前配置。 */
  const configUnavailable = configError !== undefined;
  const checks: DoctorCheck[] = [];

  // 1. config：config.get 只下发脱敏配置，不下发 validator 结果。
  if (!configRoot || configUnavailable) {
    checks.push({
      name: 'config',
      status: configError ? 'unavailable' : 'info',
      source: 'config.get',
      detail: pendingDetail(configError),
    });
  } else {
    checks.push({
      name: 'config',
      status: 'unavailable',
      source: 'config.get',
      detail: `${t('observe.diagnostics.doctor.config.detail', {
        user: input.config?.paths.user || '—',
        project: input.config?.paths.project || '—',
      })} · ${t('observe.diagnostics.doctor.config.unverified')}`,
    });
  }

  // 2. provider：provider + apiKey 的脱敏标记（loader 已把 *_env 解析进同层）。
  if (!configRoot || configUnavailable) {
    checks.push({
      name: 'provider',
      status: configError ? 'unavailable' : 'info',
      source: 'config.get',
      detail: pendingDetail(configError),
    });
  } else {
    const provider = asRecord(configRoot.provider);
    const keySet = isSet(provider?.apiKey) || isSet(configRoot.apiKey);
    checks.push({
      name: 'provider',
      status: keySet ? 'ok' : 'fail',
      source: 'config.get',
      detail: t('observe.diagnostics.doctor.provider.detail', {
        provider: nonEmpty(provider?.name) ?? '—',
        model: nonEmpty(provider?.model) ?? '—',
        key: setMarker(keySet),
      }),
    });
  }

  // 3. data_dir：只读配置值；可写性由 doctor 本机检查。
  if (!configRoot || configUnavailable) {
    checks.push({
      name: 'data_dir',
      status: configError ? 'unavailable' : 'info',
      source: 'config.get',
      detail: pendingDetail(configError),
    });
  } else {
    const configured = nonEmpty(configRoot.dataDir);
    const source = input.sources?.sources.dataDir;
    checks.push({
      name: 'data_dir',
      status: 'info',
      source: 'config.get',
      detail: configured
        ? `${t('observe.diagnostics.doctor.dataDir.configured', {
            path: configured,
            source: source ?? '—',
          })} · ${t('observe.diagnostics.doctor.dataDir.unverified')}`
        : `${t('observe.diagnostics.doctor.dataDir.default', { path: DEFAULT_DATA_DIR })} · ${t(
            'observe.diagnostics.doctor.dataDir.unverified',
          )}`,
    });
  }

  // 4. session：backend 默认值由 config 默认层给出；storagePath 缺省时只展示推导式。
  if (!configRoot || configUnavailable) {
    checks.push({
      name: 'session',
      status: configError ? 'unavailable' : 'info',
      source: 'config.get',
      detail: pendingDetail(configError),
    });
  } else {
    const session = asRecord(configRoot.session);
    const backend = nonEmpty(session?.backend) ?? 'file';
    const storagePath = nonEmpty(session?.storagePath);
    const tenant = input.config?.tenant_id ?? input.health?.tenant_id ?? 'default';
    if (backend === 'memory') {
      checks.push({
        name: 'session',
        status: 'info',
        source: 'config.get',
        detail: t('observe.diagnostics.doctor.session.memory'),
      });
    } else {
      const leaf = backend === 'sqlite' ? 'sessions.db' : 'sessions';
      const base = nonEmpty(configRoot.dataDir) ?? DEFAULT_DATA_DIR;
      const path = storagePath ?? `${base}/tenants/${tenant}/${leaf}`;
      const derived = storagePath ? '' : ` (${t('observe.diagnostics.doctor.session.derived')})`;
      checks.push({
        name: 'session',
        status: 'info',
        source: 'config.get',
        detail: `${t('observe.diagnostics.doctor.session.detail', {
          backend,
          path: `${path}${derived}`,
        })} · ${t('observe.diagnostics.doctor.writability')}`,
      });
    }
  }

  // 5. plugins：配置里启用但节点未发现的插件（与 doctor 的 missing 判据一致）。
  if (!configRoot || configUnavailable) {
    checks.push({
      name: 'plugins',
      status: configError ? 'unavailable' : 'info',
      source: 'config.get · capabilities.list',
      detail: pendingDetail(configError),
    });
  } else if (input.capabilitiesError) {
    checks.push({
      name: 'plugins',
      status: 'unavailable',
      source: 'capabilities.list',
      detail: input.capabilitiesError,
    });
  } else if (!input.capabilities) {
    checks.push({
      name: 'plugins',
      status: 'info',
      source: 'capabilities.list',
      detail: t('observe.diagnostics.doctor.pending'),
    });
  } else {
    const configured = Array.isArray(configRoot.plugins)
      ? configRoot.plugins
          .map((entry) => asRecord(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      : [];
    const enabledNames = configured
      .filter((entry) => entry.enabled !== false)
      .map((entry) => nonEmpty(entry.name))
      .filter((name): name is string => name !== undefined);
    const discovered = input.capabilities.plugins;
    const known = new Set(discovered.map((plugin) => plugin.name));
    const missing = enabledNames.filter((name) => !known.has(name));
    checks.push({
      name: 'plugins',
      status: missing.length > 0 ? 'fail' : 'ok',
      source: 'config.get · capabilities.list',
      detail:
        missing.length > 0
          ? t('observe.diagnostics.doctor.plugins.missing', { names: missing.join(', ') })
          : t('observe.diagnostics.doctor.plugins.ok', {
              enabled: discovered.filter((plugin) => plugin.enabled).length,
              total: discovered.length,
            }),
    });
  }

  // 6. MCP：配置形状（doctor 的 mcp）+ 运行态数量（doctor --deep 的 mcp_rpc）。
  if (!configRoot || configUnavailable) {
    checks.push({
      name: 'mcp',
      status: configError ? 'unavailable' : 'info',
      source: 'config.get · mcp.list',
      detail: pendingDetail(configError),
    });
  } else {
    const mcpConfig = asRecord(configRoot.mcpServers);
    const enabledServers = (mcpConfig ? Object.entries(mcpConfig) : [])
      .map(([name, raw]) => ({ name, server: asRecord(raw) }))
      .filter(({ server }) => server?.enabled !== false);
    const invalid = enabledServers
      .filter(({ server }) =>
        server?.transport === 'stdio'
          ? nonEmpty(server?.command) === undefined
          : nonEmpty(server?.url) === undefined,
      )
      .map(({ name }) => name);
    if (invalid.length > 0) {
      checks.push({
        name: 'mcp',
        status: 'fail',
        source: 'config.get',
        detail: t('observe.diagnostics.doctor.mcp.invalid', { names: invalid.join(', ') }),
      });
    } else if (input.mcpError !== undefined) {
      const disabled = input.mcpErrorCode === 'not_found' || input.mcpErrorCode === 'mcp_disabled';
      checks.push({
        name: 'mcp',
        status: enabledServers.length > 0 ? 'warn' : 'info',
        source: 'config.get · mcp.list',
        detail: disabled
          ? t('observe.diagnostics.doctor.mcp.disabled')
          : `${t('observe.diagnostics.doctor.mcp.unavailable')}: ${input.mcpError}`,
      });
    } else if (input.mcpServers !== undefined) {
      const mismatch = input.mcpServers.length !== enabledServers.length;
      checks.push({
        name: 'mcp',
        status: mismatch ? 'warn' : 'ok',
        source: 'config.get · mcp.list',
        detail: t('observe.diagnostics.doctor.mcp.rpc', {
          servers: input.mcpServers.length,
          configured: enabledServers.length,
        }),
      });
    } else {
      checks.push({
        name: 'mcp',
        status: 'info',
        source: 'config.get · mcp.list',
        detail: t('observe.diagnostics.doctor.pending'),
      });
    }
  }

  // 7. serve_port：只展示配置值与实际 endpoint；浏览器不能 bind 端口。
  if (!configRoot || configUnavailable) {
    checks.push({
      name: 'serve_port',
      status: configError ? 'unavailable' : 'info',
      source: 'config.get · health.get',
      detail: pendingDetail(configError),
    });
  } else {
    const serve = asRecord(configRoot.serve);
    const port = serve?.port;
    const endpoint = input.health?.node.endpoint ?? input.gatewayUrl;
    if (typeof port !== 'number') {
      checks.push({
        name: 'serve_port',
        status: 'info',
        source: 'config.get',
        detail: t('observe.diagnostics.doctor.servePort.notConfigured'),
      });
    } else {
      const host = nonEmpty(serve?.hostname) ?? '127.0.0.1';
      checks.push({
        name: 'serve_port',
        status: 'info',
        source: 'config.get · health.get',
        detail: `${
          port === 0
            ? t('observe.diagnostics.doctor.servePort.systemPort', { host, endpoint })
            : t('observe.diagnostics.doctor.servePort.detail', { host, port, endpoint })
        } · ${t('observe.diagnostics.doctor.servePort.unverified')}`,
      });
    }
  }

  // 8. attach：doctor --deep 的 health.get 探活；Web 的 attach 即当前连接。
  // 最近一次 health.get 失败优先于旧快照，避免用上次数据冒充已连接。
  if (input.healthError) {
    checks.push({
      name: 'attach',
      status: 'fail',
      source: 'health.get',
      detail: input.healthError,
    });
  } else if (!input.connected) {
    checks.push({
      name: 'attach',
      status: 'warn',
      source: 'health.get',
      detail: t('observe.diagnostics.doctor.attach.disconnected'),
    });
  } else if (input.health) {
    const node = input.health.node;
    checks.push({
      name: 'attach',
      status: 'ok',
      source: 'health.get',
      detail: `${node.endpoint || input.gatewayUrl} (${node.role}, ${node.status}, pid ${node.pid})`,
    });
  } else {
    checks.push({
      name: 'attach',
      status: 'info',
      source: 'health.get',
      detail: t('observe.diagnostics.doctor.pending'),
    });
  }

  // 9. feishu_credentials：仅当 feishu.enabled 时检查（与 doctor 一致）。
  if (!configRoot || configUnavailable) {
    checks.push({
      name: 'feishu_credentials',
      status: configError ? 'unavailable' : 'info',
      source: 'config.get',
      detail: pendingDetail(configError),
    });
  } else {
    const feishu = asRecord(configRoot.feishu);
    if (feishu?.enabled !== true) {
      checks.push({
        name: 'feishu_credentials',
        status: 'info',
        source: 'config.get',
        detail: t('observe.diagnostics.doctor.feishu.disabled'),
      });
    } else {
      const appIdSet = isSet(feishu.appId);
      const secretSet = isSet(feishu.appSecret);
      checks.push({
        name: 'feishu_credentials',
        status: appIdSet && secretSet ? 'ok' : 'fail',
        source: 'config.get',
        detail: t('observe.diagnostics.doctor.feishu.detail', {
          appId: setMarker(appIdSet),
          appSecret: setMarker(secretSet),
        }),
      });
    }
  }

  return checks;
}
