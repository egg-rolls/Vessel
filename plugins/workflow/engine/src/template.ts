/**
 * 模板插值：只支持字符串替换，不做表达式求值。
 *
 * 支持：{{inputs.<name>}}、{{steps.<id>.output}}、{{steps.<id>.status}}、
 * {{workflow.name}}。
 */

import { invalid } from './errors.js';
import type { WorkflowDefinition, WorkflowStepDefinition } from './types.js';

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export interface TemplateRef {
  kind: 'input' | 'workflow' | 'step';
  name?: string;
  stepId?: string;
  field?: 'output' | 'status';
}

/** 解析单个 token；非法形式直接抛 workflow_invalid。 */
function parseToken(raw: string): TemplateRef {
  const token = raw.trim();

  if (token === 'workflow.name') return { kind: 'workflow' };

  if (token.startsWith('inputs.')) {
    const name = token.slice('inputs.'.length);
    if (name === '' || name.includes('.')) {
      throw invalid(`invalid template variable "{{${token}}}"`);
    }
    return { kind: 'input', name };
  }

  if (token.startsWith('steps.')) {
    const rest = token.slice('steps.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) throw invalid(`invalid template variable "{{${token}}}"`);
    const stepId = rest.slice(0, dot);
    const field = rest.slice(dot + 1);
    if (field !== 'output' && field !== 'status') {
      throw invalid(`invalid template field "{{${token}}}" (expected output or status)`);
    }
    return { kind: 'step', stepId, field };
  }

  throw invalid(`invalid template variable "{{${token}}}"`);
}

/** 列出文本中全部模板引用。 */
export function templateRefs(text: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  for (const match of text.matchAll(TOKEN)) {
    refs.push(parseToken(match[1] ?? ''));
  }
  return refs;
}

/** 校验模板引用；stepIds 用于确认 steps.<id> 存在。 */
export function validateTemplates(text: string, stepIds: ReadonlySet<string>): void {
  for (const ref of templateRefs(text)) {
    if (ref.kind === 'step' && !stepIds.has(ref.stepId ?? '')) {
      throw invalid(`template references unknown step "${ref.stepId ?? ''}"`);
    }
  }
}

/** 校验模板里出现的 inputs.<name> 都在本次 inputs 中。 */
export function validateInputRefs(text: string, inputs: Record<string, string>): void {
  for (const ref of templateRefs(text)) {
    if (ref.kind === 'input' && !(ref.name !== undefined && ref.name in inputs)) {
      throw invalid(`missing workflow input "${ref.name ?? ''}"`);
    }
  }
}

/** 递归遍历定义里所有可插值字符串（prompt 与 args）。 */
export function forEachTemplateString(
  definition: WorkflowDefinition,
  visit: (text: string) => void,
): void {
  for (const step of definition.steps) {
    if (typeof step.prompt === 'string') visit(step.prompt);
    visitArgs(step.args, visit);
  }
}

function visitArgs(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitArgs(item, visit);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) visitArgs(item, visit);
  }
}

export function validateDefinitionTemplates(definition: WorkflowDefinition): void {
  const stepIds = new Set(definition.steps.map((step) => step.id));
  forEachTemplateString(definition, (text) => validateTemplates(text, stepIds));
}

export function validateDefinitionInputs(
  definition: WorkflowDefinition,
  inputs: Record<string, string>,
): void {
  forEachTemplateString(definition, (text) => validateInputRefs(text, inputs));
}

export interface TemplateContext {
  inputs: Record<string, string>;
  steps: Map<string, { output: string; status: string }>;
  workflowName: string;
}

/** 字符串插值；未知变量抛 workflow_invalid。 */
export function interpolate(text: string, context: TemplateContext): string {
  return text.replace(TOKEN, (_match, raw: string) => {
    const ref = parseToken(raw);
    if (ref.kind === 'workflow') return context.workflowName;

    if (ref.kind === 'input') {
      const value = context.inputs[ref.name ?? ''];
      if (value === undefined) throw invalid(`missing workflow input "${ref.name ?? ''}"`);
      return value;
    }

    const state = context.steps.get(ref.stepId ?? '');
    if (!state) throw invalid(`template references unknown step "${ref.stepId ?? ''}"`);
    return ref.field === 'status' ? state.status : state.output;
  });
}

/** 递归插值 args。 */
export function interpolateValue(value: unknown, context: TemplateContext): unknown {
  if (typeof value === 'string') return interpolate(value, context);
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, context));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = interpolateValue(item, context);
    }
    return result;
  }
  return value;
}

/** 供测试与引擎复用：从 step 定义取 agent id。 */
export function stepAgentId(
  step: WorkflowStepDefinition,
  definition: WorkflowDefinition,
): string | undefined {
  return step.agent ?? definition.defaults?.agent;
}
