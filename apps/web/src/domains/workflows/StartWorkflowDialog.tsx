import { useId, useMemo, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { useToast } from '../../components/ToastProvider';
import { useConnection } from '../../gateway/ConnectionProvider';
import {
  inputsToRows,
  type KeyValueRow,
  parseWorkflowInputsJson,
  rowsToJsonText,
  validateWorkflowStart,
} from '../../state/workflow-inputs';

const RECENT_NAMES_KEY = 'vessel.workflow-names';
const MAX_RECENT_NAMES = 8;

function readRecentNames(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_NAMES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT_NAMES)
      : [];
  } catch {
    return [];
  }
}

function rememberName(name: string, previous: readonly string[]): string[] {
  return [name, ...previous.filter((item) => item !== name)].slice(0, MAX_RECENT_NAMES);
}

const EMPTY_ROW: KeyValueRow = { key: '', value: '' };

/** 启动 workflow：key-value 编辑器为主，raw JSON 作为高级模式。 */
export function StartWorkflowDialog({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (workflowRunId: string) => void;
}) {
  const { client } = useConnection();
  const toast = useToast();
  const listId = useId();
  const [name, setName] = useState('');
  const [rows, setRows] = useState<KeyValueRow[]>([{ ...EMPTY_ROW }, { ...EMPTY_ROW }]);
  const [jsonText, setJsonText] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; inputs?: string; submit?: string }>({});
  const [recent, setRecent] = useState<string[]>(readRecentNames);

  const canSubmit = useMemo(() => name.trim().length > 0 && !busy, [name, busy]);

  const updateRow = (index: number, patch: Partial<KeyValueRow>) => {
    setRows((prev) =>
      prev.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
    setErrors((prev) => ({ ...prev, inputs: undefined, submit: undefined }));
  };

  const removeRow = (index: number) => {
    setRows((prev) => (prev.length <= 1 ? [{ ...EMPTY_ROW }] : prev.filter((_, i) => i !== index)));
  };

  const toggleAdvanced = (next: boolean) => {
    if (next) {
      setJsonText(rowsToJsonText(rows));
    } else {
      const parsed = parseWorkflowInputsJson(jsonText);
      if (parsed.ok) setRows([...inputsToRows(parsed.value), { ...EMPTY_ROW }]);
      // JSON 非法时保留行编辑器内容，避免丢失用户输入。
    }
    setAdvanced(next);
    setErrors((prev) => ({ ...prev, inputs: undefined, submit: undefined }));
  };

  const submit = async () => {
    if (busy) return;
    const validation = validateWorkflowStart({ name, rows, jsonText, advanced });
    if (!validation.ok) {
      setErrors({ name: validation.nameError, inputs: validation.inputsError });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const accepted = await client.startWorkflowRpc(validation.name, validation.inputs);
      const nextRecent = rememberName(validation.name, recent);
      setRecent(nextRecent);
      try {
        localStorage.setItem(RECENT_NAMES_KEY, JSON.stringify(nextRecent));
      } catch {
        // 存不下最近使用不影响启动。
      }
      toast.success(`已排队：${accepted.workflow_run_id}`);
      onStarted(accepted.workflow_run_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('not_found') || message.includes('Workflow not found')) {
        setErrors({ name: `找不到 workflow 定义：${validation.name}` });
      } else if (message.includes('invalid_params')) {
        setErrors({ inputs: message });
      } else {
        setErrors({ submit: message });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell label="启动 workflow" onClose={onClose} className="start-workflow-dialog">
      <h2 className="modal-title">启动 workflow</h2>
      <p className="section-desc">
        后端没有定义枚举接口，需要输入定义名（字母、数字、下划线、连字符，1–64）。
      </p>

      <label className="field">
        <span className="field-label">定义名</span>
        <input
          className={`input ${errors.name ? 'invalid' : ''}`.trim()}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((prev) => ({ ...prev, name: undefined, submit: undefined }));
          }}
          placeholder="workflow name"
          list={listId}
          spellCheck={false}
          autoComplete="off"
          data-autofocus
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? 'workflow-name-error' : undefined}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <datalist id={listId}>
          {recent.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
        {errors.name && (
          <span className="field-error" id="workflow-name-error" role="alert">
            {errors.name}
          </span>
        )}
      </label>

      <div className="switch-row">
        <button
          type="button"
          className={`btn btn-small ${advanced ? 'active' : ''}`.trim()}
          aria-pressed={advanced}
          onClick={() => toggleAdvanced(!advanced)}
        >
          {advanced ? '使用 key-value 编辑器' : '高级：JSON 输入'}
        </button>
        <span className="dim">最多 64 项；值必须是字符串。</span>
      </div>

      {advanced ? (
        <label className="field">
          <span className="field-label">inputs JSON（可选）</span>
          <textarea
            className={`input mono ${errors.inputs ? 'invalid' : ''}`.trim()}
            rows={8}
            value={jsonText}
            onChange={(event) => {
              setJsonText(event.target.value);
              setErrors((prev) => ({ ...prev, inputs: undefined, submit: undefined }));
            }}
            placeholder={'{\n  "env": "prod"\n}'}
            spellCheck={false}
          />
          {errors.inputs && (
            <span className="field-error" role="alert">
              {errors.inputs}
            </span>
          )}
        </label>
      ) : (
        <div className="field">
          <span className="field-label">inputs（可选）</span>
          <div className="kv-editor">
            {rows.map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 行编辑器需要稳定位置
              <div className="kv-row" key={index}>
                <input
                  className="input mono"
                  value={row.key}
                  onChange={(event) => updateRow(index, { key: event.target.value })}
                  placeholder="key"
                  aria-label={`第 ${index + 1} 行键`}
                  spellCheck={false}
                />
                <input
                  className="input mono"
                  value={row.value}
                  onChange={(event) => updateRow(index, { value: event.target.value })}
                  placeholder="value"
                  aria-label={`第 ${index + 1} 行值`}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`删除第 ${index + 1} 行`}
                  onClick={() => removeRow(index)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setRows((prev) => [...prev, { ...EMPTY_ROW }])}
              disabled={rows.length >= 64}
            >
              ＋ 添加输入
            </button>
          </div>
          {errors.inputs && (
            <span className="field-error" role="alert">
              {errors.inputs}
            </span>
          )}
        </div>
      )}

      {errors.submit && (
        <p className="form-error" role="alert">
          {errors.submit}
        </p>
      )}

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {busy ? '提交中…' : '启动'}
        </button>
      </div>
    </ModalShell>
  );
}
