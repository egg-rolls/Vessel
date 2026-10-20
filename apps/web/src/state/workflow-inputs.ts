/**
 * workflow 启动表单的纯函数：定义名校验、key-value 行与高级 JSON 互转。
 *
 * 与服务端契约对齐（`workflow.start`）：
 * - name：`^[A-Za-z0-9_-]{1,64}$`
 * - inputs：扁平 `Record<string, string>`，最多 64 项，key ≤64，value ≤10000
 */
export const WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_WORKFLOW_INPUTS = 64;
export const MAX_WORKFLOW_INPUT_KEY = 64;
export const MAX_WORKFLOW_INPUT_VALUE = 10_000;

export interface KeyValueRow {
  key: string;
  value: string;
}

export type InputsResult =
  | { ok: true; value?: Record<string, string> }
  | { ok: false; error: string };

export function validateWorkflowName(raw: string): string | null {
  const name = raw.trim();
  return WORKFLOW_NAME_PATTERN.test(name) ? name : null;
}

/** 高级模式：JSON 对象 → 扁平字符串 map（空输入表示不传 inputs）。 */
export function parseWorkflowInputsJson(raw: string): InputsResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'inputs 必须是合法 JSON 对象' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'inputs 必须是 JSON 对象' };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_WORKFLOW_INPUTS) {
    return { ok: false, error: `inputs 最多 ${MAX_WORKFLOW_INPUTS} 项` };
  }
  const value: Record<string, string> = {};
  for (const [key, item] of entries) {
    const keyError = validateKey(key);
    if (keyError) return { ok: false, error: keyError };
    if (typeof item !== 'string') return { ok: false, error: 'inputs 的值必须是字符串' };
    if (item.length > MAX_WORKFLOW_INPUT_VALUE) {
      return { ok: false, error: `“${key}” 的值超过 ${MAX_WORKFLOW_INPUT_VALUE} 个字符` };
    }
    value[key] = item;
  }
  return { ok: true, value: Object.keys(value).length > 0 ? value : undefined };
}

function validateKey(key: string): string | null {
  if (key.length === 0) return 'inputs 的键不能为空';
  if (key.length > MAX_WORKFLOW_INPUT_KEY) {
    return `inputs 的键不能超过 ${MAX_WORKFLOW_INPUT_KEY} 个字符`;
  }
  return null;
}

/**
 * key-value 编辑器：完全空白的行忽略；有值无键报错；重复键报错。
 * 返回 undefined 表示没有任何输入。
 */
export function parseWorkflowInputRows(rows: readonly KeyValueRow[]): InputsResult {
  const value: Record<string, string> = {};
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    const key = row.key.trim();
    const rawValue = row.value;
    if (!key && rawValue.trim() === '') continue;
    const line = index + 1;
    if (!key) return { ok: false, error: `第 ${line} 行缺少键` };
    const keyError = validateKey(key);
    if (keyError) return { ok: false, error: `第 ${line} 行：${keyError}` };
    if (Object.hasOwn(value, key)) {
      return { ok: false, error: `第 ${line} 行：键“${key}”重复` };
    }
    if (rawValue.length > MAX_WORKFLOW_INPUT_VALUE) {
      return {
        ok: false,
        error: `第 ${line} 行：“${key}” 的值超过 ${MAX_WORKFLOW_INPUT_VALUE} 个字符`,
      };
    }
    value[key] = rawValue;
    if (Object.keys(value).length > MAX_WORKFLOW_INPUTS) {
      return { ok: false, error: `inputs 最多 ${MAX_WORKFLOW_INPUTS} 项` };
    }
  }
  return { ok: true, value: Object.keys(value).length > 0 ? value : undefined };
}

/** 已有 inputs → 编辑器行（保持插入顺序）。 */
export function inputsToRows(inputs: Record<string, string> | undefined): KeyValueRow[] {
  if (!inputs) return [];
  return Object.entries(inputs).map(([key, value]) => ({ key, value }));
}

/** 行编辑器切到高级模式时的 JSON 文本。 */
export function rowsToJsonText(rows: readonly KeyValueRow[]): string {
  const parsed = parseWorkflowInputRows(rows);
  if (!parsed.ok || !parsed.value) return '';
  return JSON.stringify(parsed.value, null, 2);
}

export interface WorkflowStartForm {
  name: string;
  rows: readonly KeyValueRow[];
  jsonText: string;
  advanced: boolean;
}

export type WorkflowStartValidation =
  | { ok: true; name: string; inputs?: Record<string, string> }
  | { ok: false; nameError?: string; inputsError?: string };

/** 启动对话框的最终校验（字段级错误，不抛异常）。 */
export function validateWorkflowStart(form: WorkflowStartForm): WorkflowStartValidation {
  const name = validateWorkflowName(form.name);
  if (!name) {
    return {
      ok: false,
      nameError: '定义名只允许字母、数字、下划线和连字符，长度 1–64',
    };
  }
  const inputs = form.advanced
    ? parseWorkflowInputsJson(form.jsonText)
    : parseWorkflowInputRows(form.rows);
  if (!inputs.ok) return { ok: false, inputsError: inputs.error };
  return {
    ok: true,
    name,
    ...(inputs.value ? { inputs: inputs.value } : {}),
  };
}
