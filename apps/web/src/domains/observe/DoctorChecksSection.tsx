/**
 * Observe → Diagnostics：doctor --deep 九类检查区块（0.33 D）。
 *
 * 纯展示组件；数据映射在 `doctorChecks.ts`。所有数据来自调用方已加载的
 * 既有 RPC 资源，不额外发请求。
 */
import { Badge, type BadgeTone, Button, DataTable, Section } from '../../components/ui';
import type {
  CapabilityManifest,
  ConfigResponse,
  ConfigSourcesResponse,
  HealthResponse,
  McpServerStatus,
} from '../../gateway/types';
import { t } from '../../i18n';
import { type ResourceState, resourceData } from '../../state/useResource';
import { buildDoctorChecks, type DoctorCheck, type DoctorCheckStatus } from './doctorChecks';

const STATUS_TONE: Record<DoctorCheckStatus, BadgeTone> = {
  ok: 'success',
  warn: 'warn',
  fail: 'danger',
  info: 'info',
  unavailable: 'neutral',
};

export interface DoctorChecksSectionProps {
  config: ResourceState<ConfigResponse>;
  sources: ResourceState<ConfigSourcesResponse>;
  health: ResourceState<HealthResponse> | undefined;
  capabilities: ResourceState<CapabilityManifest>;
  mcp: ResourceState<McpServerStatus[]>;
  gatewayUrl: string;
  connected: boolean;
  onRefresh: () => void;
}

export function DoctorChecksSection({
  config,
  sources,
  health,
  capabilities,
  mcp,
  gatewayUrl,
  connected,
  onRefresh,
}: DoctorChecksSectionProps) {
  const configData = resourceData(config);
  const healthData = resourceData(health);
  const capabilitiesData = resourceData(capabilities);
  const mcpData = resourceData(mcp);
  const mcpError = mcp.status === 'error' ? mcp : undefined;
  const checks = buildDoctorChecks({
    config: configData,
    sources: resourceData(sources),
    health: healthData,
    capabilities: capabilitiesData,
    mcpServers: mcpData,
    mcpError: mcpError?.error,
    mcpErrorCode: mcpError?.code,
    configError: config.status === 'error' ? config.error : undefined,
    capabilitiesError: capabilities.status === 'error' ? capabilities.error : undefined,
    healthError: health?.status === 'error' ? health.error : undefined,
    gatewayUrl,
    connected,
  });

  return (
    <Section
      title={t('observe.diagnostics.doctorTitle')}
      description={t('observe.diagnostics.doctorHint')}
      actions={
        <Button size="small" onClick={onRefresh}>
          {t('observe.diagnostics.refresh')}
        </Button>
      }
    >
      <DataTable<DoctorCheck>
        columns={[
          {
            key: 'check',
            header: t('observe.diagnostics.doctorColCheck'),
            cellClassName: 'font-mono',
            cell: (row) => row.name,
          },
          {
            key: 'status',
            header: t('observe.diagnostics.doctorColStatus'),
            cell: (row) => (
              <Badge tone={STATUS_TONE[row.status]}>
                {t(`observe.diagnostics.doctor.status.${row.status}`)}
              </Badge>
            ),
          },
          {
            key: 'source',
            header: t('observe.diagnostics.doctorColSource'),
            hide: 'compact',
            cellClassName: 'font-mono text-muted',
            cell: (row) => row.source,
          },
          {
            key: 'detail',
            header: t('observe.diagnostics.doctorColDetail'),
            cell: (row) => row.detail,
          },
        ]}
        rows={checks}
        rowKey={(row) => row.name}
      />
    </Section>
  );
}
