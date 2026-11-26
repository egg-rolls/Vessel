/**
 * 模型选择器（model-registry P2 → 两面重构 §9.2，native 共享组件）。
 *
 * 数据源唯一 = `plugin.model-registry.list`（in-process 插件 RPC；native client 直调
 * plugin.* 的先例 = PluginFrame 桥）。选项 = 「跟随默认」空值项 + 别称（条目 alias 字段
 * 聚合）+ 条目键。**无自由文本输入**（P3 收紧兑现）：RPC 不可用时降级为禁用占位，
 * 不造第二套数据源。
 *
 * 存量 pin（非空且不在注册清单里的值）原样显示 + 「未注册」标记：可保留、可重选，
 * 不静默丢（P0-1 D7 纪律）。当前 gateway 的 agents.* 读 DTO 返回 record.model，
 * 调用方拿得到 pin 才谈得上预填；本组件只保证「给值就原样显示」。
 *
 * 形状复用 plugin-ui Select（button + portal listbox）：它只解析 `<option>` children，
 * 不解析 optgroup —— 分组用 disabled 头部选项表达（value 恒 ''，不可选中；空值项
 * 永远在第一位，trigger 的按值查找不会落到头部上）。
 */
import { useEffect, useState } from 'react';
import { useConnection } from '../gateway/ConnectionProvider';
import type { NodeView } from '../gateway/NodeProvider';
import { fetchNodeRpc, nodeKeyOf } from '../gateway/nodes';
import { t, useLocale } from '../i18n';
import { Select } from './ui';

export interface ModelPickerProps {
  /** 读哪个节点的注册表（registry 是节点级配置）；缺省 = 禁用占位。 */
  node?: NodeView;
  /** 受控值；'' = 空值项（创建 = 跟随默认，编辑 = 不修改，语义由调用方定）。 */
  value: string;
  onChange: (value: string) => void;
  id?: string;
  disabled?: boolean;
  'aria-label'?: string;
  /** 空值项前导文案；缺省「跟随默认」。编辑页传「不修改」。 */
  emptyLabel?: string;
}

interface PickerEntry {
  id: string;
  name: string;
  legacy: boolean;
}

interface PickerRegistry {
  entries: PickerEntry[];
  aliases: { alias: string; target: string }[];
  /** 有效默认的展示串（`entryId (wireModel)`）；无效配置 / 无默认时缺省。 */
  effective?: string;
}

type PickerState =
  | { status: 'loading' }
  | { status: 'ready'; registry: PickerRegistry }
  | { status: 'failed' };

/** RPC 结果是 unknown：只收形状对得上的部分，形状整体不对按不可用降级。 */
function parseRegistry(raw: unknown): PickerRegistry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.entries)) return undefined;
  const entries: PickerEntry[] = [];
  const aliases: { alias: string; target: string }[] = [];
  for (const item of record.entries) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || entry.id === '') continue;
    const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id;
    entries.push({ id: entry.id, name, legacy: entry.legacy === true });
    if (typeof entry.alias === 'string' && entry.alias !== '') {
      aliases.push({ alias: entry.alias, target: entry.id });
    }
  }
  let effective: string | undefined;
  const rawEffective = record.effective;
  if (typeof rawEffective === 'object' && rawEffective !== null) {
    const resolved = rawEffective as Record<string, unknown>;
    if (typeof resolved.entryId === 'string' && typeof resolved.wireModel === 'string') {
      effective = `${resolved.entryId} (${resolved.wireModel})`;
    }
  }
  return { entries, aliases, ...(effective !== undefined ? { effective } : {}) };
}

export function ModelPicker({
  node,
  value,
  onChange,
  id,
  disabled,
  'aria-label': ariaLabel,
  emptyLabel,
}: ModelPickerProps) {
  useLocale();
  const { client, epoch } = useConnection();
  const [state, setState] = useState<PickerState>({ status: 'loading' });

  // effect 依赖只取原语（节点身份 / url / 是否当前连接），避免节点对象引用变化触发重拉。
  // 远端节点走 fetchNodeRpc：token 身份 = nodeId ?? name = nodeKey，与 NodeProvider 同口径。
  const nodeKey = node ? nodeKeyOf(node) : '';
  const nodeUrl = node?.url ?? '';
  const nodeCurrent = node?.current ?? false;

  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch 是 hello 后的显式刷新触发器
  useEffect(() => {
    if (nodeKey === '' || nodeUrl === '') {
      setState({ status: 'failed' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    const request = nodeCurrent
      ? client.rpc<unknown>('plugin.model-registry.list', {})
      : fetchNodeRpc<unknown>({ name: nodeKey, url: nodeUrl }, 'plugin.model-registry.list', {});
    request
      .then((raw) => {
        if (cancelled) return;
        const registry = parseRegistry(raw);
        setState(registry ? { status: 'ready', registry } : { status: 'failed' });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [client, epoch, nodeKey, nodeUrl, nodeCurrent]);

  const registry = state.status === 'ready' ? state.registry : undefined;
  const registered = new Set<string>();
  for (const { alias } of registry?.aliases ?? []) registered.add(alias);
  for (const entry of registry?.entries ?? []) registered.add(entry.id);
  // 非空值不在清单里 → 原样保留为一个可选项；「未注册」判定只在注册表真的加载后下，
  // loading / failed 时只原样显示值，不预判它未注册。
  const pinOption = value !== '' && !registered.has(value);

  const emptyBase = emptyLabel ?? t('modelPicker.followDefault');
  const emptyOptionLabel =
    registry?.effective !== undefined
      ? t('modelPicker.emptyWithCurrent', { label: emptyBase, model: registry.effective })
      : emptyBase;

  return (
    <>
      <Select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || state.status !== 'ready'}
        aria-label={ariaLabel}
      >
        <option value="">{emptyOptionLabel}</option>
        {pinOption && (
          <option value={value}>
            <span className="font-mono">{value}</span>
            {state.status === 'ready' && (
              <span className="text-warn"> · {t('modelPicker.unregistered')}</span>
            )}
          </option>
        )}
        {registry !== undefined && registry.aliases.length > 0 && (
          <>
            <option value="" disabled>
              {t('modelPicker.groupAliases')}
            </option>
            {registry.aliases.map(({ alias, target }) => (
              <option key={alias} value={alias}>
                <span className="font-mono">{alias}</span>
                <span className="text-faint"> → {target}</span>
              </option>
            ))}
          </>
        )}
        {registry !== undefined && registry.entries.length > 0 && (
          <>
            <option value="" disabled>
              {t('modelPicker.groupEntries')}
            </option>
            {registry.entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                <span className="font-mono">{entry.id}</span>
                {entry.name !== entry.id && <span className="text-faint"> → {entry.name}</span>}
                {entry.legacy && <span className="text-faint"> · legacy</span>}
              </option>
            ))}
          </>
        )}
      </Select>
      {state.status === 'failed' && (
        <p className="mt-1 mb-0 text-xs text-faint">{t('modelPicker.unavailable')}</p>
      )}
    </>
  );
}
