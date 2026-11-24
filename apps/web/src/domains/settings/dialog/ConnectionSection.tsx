/**
 * 连接摘要 view（vscode-settings-design §6）：gateway 连接状态 / 节点 / 版本
 * 只读诊断面 + [打开 Gateway 页]。旧 ConfigView 与 gateway 入口能力不丢。
 */
import { Badge, Button } from '../../../components/ui';
import { useConnection } from '../../../gateway/ConnectionProvider';
import { t } from '../../../i18n';
import { resourceData } from '../../../state/useResource';
import { useConfigStoreApi } from '../../../stores/useConfigStoreApi';

export function ConnectionSection({ onOpenGateway }: { onOpenGateway: () => void }) {
  const { connectionState, hasToken, nodeLabel } = useConnection();
  const { config } = useConfigStoreApi();
  const data = resourceData(config);
  const stateLabel = hasToken ? connectionState : 'no-token';
  const tone = connectionState === 'open' && hasToken ? 'success' : 'warn';

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-line bg-transparent p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={tone}>{stateLabel}</Badge>
        {nodeLabel && <span className="text-muted">{nodeLabel}</span>}
        {data?.config?.schema_version !== undefined && (
          <span className="font-mono text-xs text-faint">
            schema v{String(data.config.schema_version)}
          </span>
        )}
      </div>
      <Button variant="link" className="self-start text-sm" onClick={onOpenGateway}>
        {t('settings.dialog.openGateway')} →
      </Button>
    </div>
  );
}
