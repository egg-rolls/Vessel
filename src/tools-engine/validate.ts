/**
 * tools-engine 机械形状校验（P2 seams 契约 §2.2；内部模块）。
 *
 * 不是权限判定：只校 wire 形状与注册表 inputSchema 的机械子集
 * （type / required / properties / items / enum / additionalProperties===false），
 * 未知关键字一律忽略。形状不过 → throw（entry 折 JSON-RPC error 回包）；
 * schema 子集违规 → 首个违规描述（engine 折 invalidParams 稳定文本，不派发）。
 *
 * @module tools-engine/validate
 */

import {
  canonicalJSON,
  type RegistryEntry,
  type RegistrySyncParams,
  type ToolCancelParams,
  type ToolInvokeParams,
  type ToolInvokeResult,
} from '@vessel-agent/engine-client';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** `tool.invoke` 信封形状校验（三元组非空 / tool_name string / args record / exec 枚举）。 */
export function parseInvokeEnvelope(params: unknown): ToolInvokeParams {
  if (!isRecord(params)) throw new Error('tool.invoke params must be an object');
  const { run_id, session_id, tool_call_id, tool_name, args, exec, cwd, boundary, timeout_ms } =
    params;
  if (
    !isNonEmptyString(run_id) ||
    !isNonEmptyString(session_id) ||
    !isNonEmptyString(tool_call_id)
  ) {
    throw new Error('tool.invoke requires non-empty run_id / session_id / tool_call_id');
  }
  if (typeof tool_name !== 'string') throw new Error('tool.invoke tool_name must be a string');
  if (!isRecord(args)) throw new Error('tool.invoke args must be an object');
  if (exec !== 'worker' && exec !== 'callback') {
    throw new Error('tool.invoke exec must be worker or callback');
  }
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw new Error('tool.invoke cwd must be a string');
  }
  if (boundary !== undefined && !isRecord(boundary)) {
    throw new Error('tool.invoke boundary must be an object');
  }
  if (
    timeout_ms !== undefined &&
    (typeof timeout_ms !== 'number' || !Number.isFinite(timeout_ms) || timeout_ms <= 0)
  ) {
    throw new Error('tool.invoke timeout_ms must be a positive number');
  }
  return {
    run_id,
    session_id,
    tool_call_id,
    tool_name,
    args,
    exec,
    cwd: typeof cwd === 'string' ? cwd : undefined,
    // 深形状由 worker deserializeBoundary 重建时校验（失败折 invalidParams，不 throw）。
    boundary: isRecord(boundary)
      ? (boundary as unknown as ToolInvokeParams['boundary'])
      : undefined,
    timeout_ms: typeof timeout_ms === 'number' ? timeout_ms : undefined,
  };
}

/** `tool.cancel` 形状校验。 */
export function parseCancelParams(params: unknown): ToolCancelParams {
  if (!isRecord(params)) throw new Error('tool.cancel params must be an object');
  const { run_id, tool_call_id } = params;
  if (!isNonEmptyString(run_id) || !isNonEmptyString(tool_call_id)) {
    throw new Error('tool.cancel requires non-empty run_id / tool_call_id');
  }
  return { run_id, tool_call_id };
}

/** `engine.registry.sync` 形状校验（条目逐个校；不过 → throw）。 */
export function parseRegistrySync(params: unknown): RegistrySyncParams {
  if (!isRecord(params)) throw new Error('engine.registry.sync params must be an object');
  const { upsert, remove } = params;
  if (!Array.isArray(upsert) || !Array.isArray(remove)) {
    throw new Error('engine.registry.sync requires upsert / remove arrays');
  }
  const entries: RegistryEntry[] = upsert.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`registry upsert[${index}] must be an object`);
    const { name, inputSchema, schema_fingerprint, exec_class, source } = raw;
    if (!isNonEmptyString(name)) throw new Error(`registry upsert[${index}] name must be a string`);
    if (!isRecord(inputSchema)) {
      throw new Error(`registry upsert[${index}] inputSchema must be an object`);
    }
    if (!isNonEmptyString(schema_fingerprint)) {
      throw new Error(`registry upsert[${index}] schema_fingerprint must be a string`);
    }
    if (exec_class !== 'worker' && exec_class !== 'callback') {
      throw new Error(`registry upsert[${index}] exec_class must be worker or callback`);
    }
    if (typeof source !== 'string') {
      throw new Error(`registry upsert[${index}] source must be a string`);
    }
    return { name, inputSchema, schema_fingerprint, exec_class, source };
  });
  const names: string[] = remove.map((raw, index) => {
    if (!isNonEmptyString(raw)) throw new Error(`registry remove[${index}] must be a string`);
    return raw;
  });
  return { upsert: entries, remove: names };
}

/** `engine.impl.reject` 形状校验。 */
export function parseImplReject(params: unknown): { name: string } {
  if (!isRecord(params) || !isNonEmptyString(params.name)) {
    throw new Error('engine.impl.reject requires a non-empty name');
  }
  return { name: params.name };
}

/** callback 回包结果形状校验（{content: string}，bounded / original_chars 可选）。 */
export function parseInvokeResult(result: unknown): ToolInvokeResult {
  if (!isRecord(result) || typeof result.content !== 'string') {
    throw new Error('tool.callback result must be { content: string }');
  }
  const { bounded, original_chars } = result;
  if (bounded !== undefined && typeof bounded !== 'boolean') {
    throw new Error('tool.callback result bounded must be a boolean');
  }
  if (original_chars !== undefined && typeof original_chars !== 'number') {
    throw new Error('tool.callback result original_chars must be a number');
  }
  return {
    content: result.content,
    bounded: typeof bounded === 'boolean' ? bounded : undefined,
    original_chars: typeof original_chars === 'number' ? original_chars : undefined,
  };
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true; // 未知 type 关键字忽略（机械、不权威）
  }
}

/**
 * schema 机械子集校验：返回首个违规的 `path: reason` 描述；全过 → undefined。
 * 子集之外的关键字（format / minimum / oneOf ...）一律忽略。
 */
export function firstSchemaViolation(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string | undefined {
  const enumValues = schema.enum;
  if (Array.isArray(enumValues)) {
    const serialized = canonicalJSON(value);
    if (!enumValues.some((entry) => canonicalJSON(entry) === serialized)) {
      return `${path}: value is not in enum`;
    }
  }
  const type = schema.type;
  if (typeof type === 'string' && !matchesType(value, type)) {
    return `${path}: expected ${type}`;
  }
  if (Array.isArray(value)) {
    const items = schema.items;
    if (isRecord(items)) {
      for (let index = 0; index < value.length; index += 1) {
        const violation = firstSchemaViolation(value[index], items, `${path}[${index}]`);
        if (violation !== undefined) return violation;
      }
    }
    return undefined;
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in value)) {
          return `${path}.${key}: required property is missing`;
        }
      }
    }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in value && isRecord(subSchema)) {
        const violation = firstSchemaViolation(value[key], subSchema, `${path}.${key}`);
        if (violation !== undefined) return violation;
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          return `${path}.${key}: additional property is not allowed`;
        }
      }
    }
  }
  return undefined;
}
