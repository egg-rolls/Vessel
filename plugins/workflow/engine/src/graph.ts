/**
 * depends_on 校验与拓扑排序（环检测）。
 */

import { invalid } from './errors.js';
import type { WorkflowStepDefinition } from './types.js';

/** 校验依赖存在、无自依赖、无环；返回稳定的拓扑顺序。 */
export function validateDependencies(steps: WorkflowStepDefinition[]): string[] {
  const ids = new Set<string>();
  for (const step of steps) ids.add(step.id);

  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const step of steps) {
    const deps = step.depends_on ?? [];
    indegree.set(step.id, deps.length);
    for (const dep of deps) {
      if (dep === step.id) throw invalid(`step "${step.id}" cannot depend on itself`);
      if (!ids.has(dep)) {
        throw invalid(`step "${step.id}" depends on unknown step "${dep}"`);
      }
      const list = outgoing.get(dep) ?? [];
      list.push(step.id);
      outgoing.set(dep, list);
    }
  }

  // 就绪队列按定义顺序，保证拓扑结果稳定。
  const queue = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0).map((step) => step.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length !== steps.length) {
    throw invalid('workflow definition contains a dependency cycle');
  }
  return order;
}
