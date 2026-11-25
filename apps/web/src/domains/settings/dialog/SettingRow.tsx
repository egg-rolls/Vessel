/**
 * 设置项行（vscode-settings-design §3.5）：标题行（scope badge + 修改指示条 + ↺）
 * → 描述 → 键路径（mono，点击复制）→ 控件 → 附加提示。
 *
 * boolean = checkbox（与现 Display 页一致）；enum ≤4 = radio 组 / >4 = select；
 * string/number = blur/Enter 提交；object/array = 只读 JsonView；view = 父级子视图。
 *
 * 默认值体现在控件上（增量⑤）：选项类未配置时显示默认选中态；输入类未配置时
 * 默认值作 placeholder（configured=false 由 SettingsDialog 判定），不写在说明文本里。
 */
import { type ReactNode, useEffect, useState } from 'react';
import { CopyButton } from '../../../components/CopyButton';
import { JsonView } from '../../../components/JsonView';
import {
  Badge,
  Button,
  GHOST_BADGE_CLASS,
  GHOST_CONTROL_CLASS,
  GHOST_PANEL_CLASS,
  Input,
  Select,
} from '../../../components/ui';
import { cn } from '../../../components/ui/cn';
import { hasMessage, t } from '../../../i18n';
import type { SettingDef } from '../../../state/settings-registry';
import { highlightSegments } from '../../../state/settings-search';

function Highlighted({ text, query }: { text: string; query: string }) {
  const segments = highlightSegments(text, query);
  let offset = 0;
  const nodes = segments.map((segment) => {
    const key = `${offset}:${segment.hit ? 'hit' : 'text'}`;
    offset += segment.text.length;
    return segment.hit ? (
      <mark key={key}>{segment.text}</mark>
    ) : (
      <span key={key}>{segment.text}</span>
    );
  });
  return <>{nodes}</>;
}

/** 文本/数字输入：本地草稿，blur/Enter 才提交（逐键写会把 keystroke 变落盘）。 */
function CommitInput({
  disabled,
  kind,
  max,
  min,
  onCommit,
  placeholder,
  value,
}: {
  disabled: boolean;
  kind: 'string' | 'number';
  max?: number;
  min?: number;
  onCommit: (raw: string) => void;
  /** 未配置时的默认值提示（增量⑤：默认值体现在控件上，不写在说明文本里）。 */
  placeholder?: string;
  value: string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);

  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <Input
      type={kind === 'number' ? 'number' : 'text'}
      className={cn(GHOST_CONTROL_CLASS, 'max-w-80 font-mono')}
      disabled={disabled}
      min={min}
      max={max}
      placeholder={placeholder}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export interface SettingRowProps {
  def: SettingDef;
  value: string;
  modified: boolean;
  disabled: boolean;
  disabledReason?: string;
  saving: boolean;
  query: string;
  envOverride?: string;
  /**
   * 是否存在**显式配置值**（增量⑤；缺省 true = 旧行为）。
   * false 时输入类控件清空值、把默认值显示为 placeholder；选项类控件不受它影响
   * （未配置时 value 为空，控件自己回落到默认选中态）。
   */
  configured?: boolean;
  onSave: (def: SettingDef, raw: string) => void;
  onReset: (def: SettingDef) => void;
  /** S4：child 插件重载（restartRequired 提示条的 [重载] 按钮）。 */
  onReloadPlugin?: () => void;
  /** view 型项的子视图（父级懒加载渲染）。 */
  children?: ReactNode;
}

export function SettingRow({
  def,
  value,
  modified,
  disabled,
  disabledReason,
  saving,
  query,
  envOverride,
  configured = true,
  onSave,
  onReset,
  onReloadPlugin,
  children,
}: SettingRowProps) {
  const title = def.titleKey ? t(def.titleKey) : (def.title ?? def.id);
  const description =
    def.descriptionKey && hasMessage(def.descriptionKey)
      ? t(def.descriptionKey)
      : (def.description ?? '');
  const scopeLabel = t(
    def.scope === 'local'
      ? 'settings.dialog.scopeLocal'
      : def.scope === 'project'
        ? 'settings.dialog.scopeProject'
        : 'settings.dialog.scopeUser',
  );
  const canReset =
    !disabled && (def.resettable === true || (!def.readOnly && def.default !== undefined));
  const resetLabel =
    def.id === 'local.nav.groups'
      ? t('settings.dialog.expandAll')
      : t('settings.dialog.resetDefault');
  const controlDisabled = disabled || def.readOnly === true || saving;

  // 增量⑤：默认值直接体现在控件上——选项类（checkbox/radio/select）未配置（value 空）
  // 时回落默认选中态（baseline 与 isSettingModified 同一口径：default ?? fallback）；
  // 输入类未配置时值清空、默认值作 placeholder（见下方 CommitInput）。
  // 无 default/fallback 的项 effective = value，渲染逐字不变（向后兼容）。
  const baseline = def.default ?? def.fallback;
  const effective = value === '' && baseline !== undefined ? baseline : value;

  let control: ReactNode = null;
  if (def.type === 'view') {
    control = children;
  } else if (def.type === 'boolean') {
    control = (
      <label className="flex items-center gap-1.5 text-md">
        <input
          type="checkbox"
          checked={effective === 'true'}
          disabled={controlDisabled}
          onChange={(event) => onSave(def, event.target.checked ? 'true' : 'false')}
        />
        <span className="font-mono">{effective === 'true' ? 'true' : 'false'}</span>
      </label>
    );
  } else if (def.type === 'enum') {
    const options = def.options ?? [];
    control =
      options.length > 4 ? (
        <Select
          className={cn(GHOST_CONTROL_CLASS, 'max-w-80')}
          disabled={controlDisabled}
          value={effective}
          onChange={(event) => onSave(def, event.target.value)}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {def.optionLabelKeys?.[option] ? t(def.optionLabelKeys[option]) : option}
            </option>
          ))}
        </Select>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {options.map((option) => (
            <label key={option} className="flex items-center gap-1.5 text-md">
              <input
                type="radio"
                name={`setting-${def.id}`}
                value={option}
                checked={effective === option}
                disabled={controlDisabled}
                onChange={() => onSave(def, option)}
              />
              <span className={def.optionLabelKeys?.[option] ? '' : 'font-mono'}>
                {def.optionLabelKeys?.[option] ? t(def.optionLabelKeys[option]) : option}
              </span>
            </label>
          ))}
        </div>
      );
  } else if (def.type === 'string' || def.type === 'number') {
    control = (
      <CommitInput
        disabled={controlDisabled}
        kind={def.type}
        max={def.max}
        min={def.min}
        onCommit={(raw) => onSave(def, raw)}
        placeholder={baseline}
        value={configured ? value : ''}
      />
    );
  } else {
    // object / array：v1 只读 JSON 视图（§3.5）。
    let parsed: unknown = value;
    try {
      parsed = value ? JSON.parse(value) : {};
    } catch {
      parsed = value;
    }
    control = (
      <div className="flex flex-col gap-1">
        <JsonView value={parsed} label={def.key} maxHeight={200} className={GHOST_PANEL_CLASS} />
        <span className="text-sm text-muted">{t('settings.dialog.editInYaml')}</span>
      </div>
    );
  }

  return (
    <div className="group/row relative flex flex-col gap-1.5 py-3 pl-3" data-setting-id={def.id}>
      {modified && (
        <span
          role="img"
          aria-label={t('settings.dialog.modified')}
          className="absolute top-3 bottom-3 left-0 w-0.5 rounded-full bg-accent"
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-md">
          <Highlighted text={title} query={query} />
        </span>
        <Badge tone="neutral" className={GHOST_BADGE_CLASS}>
          {scopeLabel}
        </Badge>
        {def.readOnly && (
          <Badge tone="neutral" className={GHOST_BADGE_CLASS}>
            {t('settings.dialog.readOnly')}
          </Badge>
        )}
        {saving && <Badge tone="accent">…</Badge>}
        {canReset && (
          <Button
            variant="link"
            className="ml-auto text-sm opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
            onClick={() => onReset(def)}
          >
            ↺ {resetLabel}
          </Button>
        )}
      </div>
      {description && (
        <p className="text-sm text-muted">
          <Highlighted text={description} query={query} />
        </p>
      )}
      <div className="flex items-center gap-1">
        <code className="font-mono text-xs text-muted">{def.id}</code>
        <CopyButton
          text={def.id}
          label={t('settings.dialog.copyKey')}
          className="link-btn text-xs"
        />
      </div>
      {control}
      {envOverride && (
        <p className="text-sm text-warn">
          {t('settings.dialog.envOverride', { env: envOverride })}
        </p>
      )}
      {def.restartRequired && (
        <p className="flex items-center gap-2 text-sm text-warn">
          {t('settings.dialog.restartRequired')}
          {onReloadPlugin && (
            <Button variant="link" className="text-sm" onClick={onReloadPlugin}>
              {t('settings.dialog.reloadPlugin')}
            </Button>
          )}
        </p>
      )}
      {disabledReason && <p className="text-sm text-muted">{disabledReason}</p>}
    </div>
  );
}
