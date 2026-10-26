import { useEffect, useMemo, useState } from 'react';
import { SegmentedTabs } from '../../components/Tabs';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { ToolInfo, ToolPolicy } from '../../gateway/types';
import { t } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import {
  hasScopedNever,
  nextWritten,
  type PermissionLists,
  policyHintKey,
  policyLabelKey,
  readPermissionLists,
  scopedEntries,
  scopedPolicyHintKey,
  supportsToolPolicy,
  TOOL_POLICY_OPTIONS,
  toolPolicyOf,
} from './tool-policy';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 工具详情弹窗里的「确认策略」控件（CONTRACT-hot-apply §6）。
 *
 * 档位从 `config.get` 的 `permission.autoApprove` / `neverAutoApprove` 推导；
 * 保存走 canonical `permissions.setToolPolicy`，随后立即 `gateway.reload(['permission'])`。
 * 旧 gateway 缺 `permissions.setToolPolicy` 时控件禁用并提示需要更新的 gateway。
 */
export function ToolPolicyControl({ tool }: { tool: ToolInfo }) {
  const { client, connectionState, hasToken } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const [saving, setSaving] = useState(false);
  /** RPC 返回的两个数组：本地即时反映写入结果，config 刷新落地后让位给 config。 */
  const [written, setWritten] = useState<PermissionLists | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const configResource = useResource({
    load: () => client.getConfig(),
  });
  const capabilitiesResource = useResource({
    load: () => client.getCapabilities(),
  });

  const config = resourceData(configResource.state);
  const fromConfig = useMemo(() => readPermissionLists(config?.config), [config]);
  const lists = written ?? fromConfig;
  const loaded = config !== undefined;
  const current = toolPolicyOf(lists, tool.name);
  const scopedNever = hasScopedNever(lists, tool.name);
  const scoped = scopedEntries(lists, tool.name);

  // 保留 RPC 返回的 written，直到刷新后的 config 与它等价；对象身份变化不再清空。
  useEffect(() => {
    setWritten((prev) => nextWritten(prev, fromConfig));
  }, [fromConfig]);

  const supported =
    capabilitiesResource.state.status === 'success'
      ? supportsToolPolicy(capabilitiesResource.state.data)
      : false;
  const capabilitiesLoading =
    capabilitiesResource.state.status === 'idle' || capabilitiesResource.state.status === 'loading';
  const interactive = supported && connected && loaded && !saving;

  /** `target` 可以是基础工具名，也可以是某个 scoped 条目（如 `agent.close`）。 */
  const apply = async (target: string, policy: ToolPolicy) => {
    if (!interactive || policy === toolPolicyOf(lists, target)) return;
    setSaving(true);
    setStatus(null);
    try {
      const result = await client.setToolPolicy(target, policy);
      setWritten({
        autoApprove: result.auto_approve,
        neverAutoApprove: result.never_auto_approve,
      });
    } catch (error) {
      setStatus({
        kind: 'error',
        text: t('integrations.tools.policyFailed', { detail: errorMessage(error) }),
      });
      setSaving(false);
      return;
    }
    try {
      // 策略已落盘，但仍需 gateway.reload 让存活 runtime 换规则；不给「重启」后门。
      await client.reload(['permission']);
      setStatus({ kind: 'ok', text: t('integrations.tools.policyApplied') });
    } catch (error) {
      setStatus({
        kind: 'error',
        text: t('integrations.tools.policyFailed', { detail: errorMessage(error) }),
      });
    } finally {
      setSaving(false);
      configResource.reload();
    }
  };

  const note = (() => {
    if (capabilitiesLoading) return t('integrations.tools.policyChecking');
    if (!supported) return t('integrations.tools.policyUnsupported');
    if (!connected) return t('common.writesDisabled');
    if (!loaded && configResource.state.status === 'error') {
      return t('integrations.tools.policyLoadFailed', { detail: configResource.state.error });
    }
    if (scopedNever && current === 'ask') {
      return t('integrations.tools.policyScopedHint');
    }
    return t(policyHintKey(current));
  })();

  const tabs = TOOL_POLICY_OPTIONS.map((option) => ({
    id: option.id,
    label: t(option.labelKey),
  }));
  /** scoped 行的 never 只阻止自动放行，文案不能复用 exact 的“强制确认”。 */
  const scopedTabs = TOOL_POLICY_OPTIONS.map((option) => ({
    id: option.id,
    label: t(policyLabelKey(option.id, true)),
  }));

  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-2xs uppercase tracking-widest text-faint">
        {t('integrations.tools.policyLabel')}
      </span>
      <div aria-busy={saving || undefined}>
        <SegmentedTabs
          label={t('integrations.tools.policyLabel')}
          tabs={tabs}
          value={current}
          onChange={(policy) => void apply(tool.name, policy)}
          disabled={!interactive}
        />
      </div>
      <p className="m-0 text-xs leading-snug text-muted wrap-anywhere">
        {saving ? t('integrations.tools.policySaving') : note}
      </p>
      {scoped.length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          <span className="font-mono text-2xs uppercase tracking-widest text-faint">
            {t('integrations.tools.policyScopedLabel')}
          </span>
          {scoped.map((entry) => {
            const scopedPolicy = toolPolicyOf(lists, entry);
            return (
              <div className="flex flex-col gap-1" key={entry}>
                <span className="font-mono text-xs break-words text-ink">{entry}</span>
                <SegmentedTabs
                  label={entry}
                  tabs={scopedTabs}
                  value={scopedPolicy}
                  onChange={(policy) => void apply(entry, policy)}
                  disabled={!interactive}
                />
                {scopedPolicy === 'never' && (
                  <p className="m-0 text-xs leading-snug text-muted wrap-anywhere">
                    {t(scopedPolicyHintKey('never'))}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {status && (
        <p
          className={
            status.kind === 'ok'
              ? 'm-0 rounded-sm bg-success-soft px-2.5 py-1.5 text-xs text-success'
              : 'm-0 rounded-sm bg-danger-soft px-2.5 py-1.5 text-xs text-danger'
          }
          role={status.kind === 'ok' ? 'status' : 'alert'}
        >
          {status.text}
        </p>
      )}
    </div>
  );
}
