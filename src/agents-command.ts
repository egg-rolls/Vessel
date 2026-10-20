/**
 * `vessel agents [--json]`（0.14 DECISION-025 §1.4）。
 *
 * 调用 canonical `agents.list`，本地优先 attach 运行中的 gateway，或使用 `--connect`。
 * 只读；不重建 runtime、不抢 tenant 写锁；输出不含 token / 密钥。
 *
 * @module vessel/agents-command
 */

import {
  type ControlPlaneTarget,
  type ControlPlaneTargetOptions,
  resolveControlPlaneTarget,
} from './control-plane-target';
import { t } from './i18n';
import { RpcClientError } from './rpc';
import { ui } from './ui-style';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AgentsCommandOptions extends ControlPlaneTargetOptions {
  json?: boolean;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pickNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `agents.list` 结果：`{agents:[...]}` / 数组 / `{items:[...]}` 都接受 */
export function extractAgentList(result: unknown): unknown[] | undefined {
  if (Array.isArray(result)) return result;
  if (!isRecord(result)) return undefined;
  if (Array.isArray(result.agents)) return result.agents;
  if (Array.isArray(result.items)) return result.items;
  return undefined;
}

function sourceView(target: ControlPlaneTarget): Record<string, unknown> {
  return {
    kind: target.kind,
    url: target.baseUrl,
    ...(target.instance !== undefined ? { instance: target.instance } : {}),
  };
}

function formatAgent(agent: Record<string, unknown>): string {
  const id = pickString(agent, 'id') ?? '(unknown)';
  const role = pickString(agent, 'role');
  const state = pickString(agent, 'state');
  const depth = pickNumber(agent, 'depth');
  const tool = pickString(agent, 'current_tool');
  const session = pickString(agent, 'session_id');
  const parts = [id];
  if (role !== undefined) parts.push(`role=${role}`);
  if (state !== undefined) parts.push(`state=${state}`);
  if (depth !== undefined) parts.push(`depth=${depth}`);
  if (tool !== undefined) parts.push(`tool=${tool}`);
  if (session !== undefined) parts.push(`session=${session}`);
  return parts.join('  ');
}

/** `vessel agents`：人类输出走暗金样式，`--json` 纯 JSON（无 ANSI）。 */
export async function agentsCommand(options: AgentsCommandOptions = {}): Promise<CommandResult> {
  const now = options.now ?? Date.now;
  const json = options.json === true;
  const resolved = await resolveControlPlaneTarget(options);
  if (!resolved.ok) {
    return { exitCode: 1, stdout: '', stderr: resolved.error };
  }

  const target = resolved.target;
  let result: unknown;
  try {
    result = await target.request('agents.list', {
      ...(options.tenantId != null ? { tenant_id: options.tenantId } : {}),
    });
  } catch (error) {
    if (
      error instanceof RpcClientError &&
      (error.code === 'not_found' || error.code === 'not_supported')
    ) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'agents.list is not available on this gateway ' + '(requires a 0.14 serve build).',
      };
    }
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await target.close().catch(() => undefined);
  }

  const agents = extractAgentList(result);
  const payload = {
    as_of: new Date(now()).toISOString(),
    source: sourceView(target),
    agents: agents ?? result,
  };

  if (json) {
    return { exitCode: 0, stdout: JSON.stringify(payload, null, 2), stderr: '' };
  }

  const lines: string[] = [];
  lines.push(ui.title(t('agents.title')));
  lines.push(ui.rule(48));
  lines.push(ui.kv(t('agents.source'), target.baseUrl, 10));
  if (target.instance !== undefined) {
    lines.push(ui.kv(t('agents.instance'), target.instance, 10));
  }
  if (agents === undefined) {
    lines.push('');
    lines.push(ui.warn(t('agents.unexpectedResult')));
    lines.push(JSON.stringify(result, null, 2));
    return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
  }
  if (agents.length === 0) {
    lines.push('');
    lines.push(ui.info(t('agents.empty')));
    return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
  }
  lines.push('');
  lines.push(ui.section(t('agents.list', { count: agents.length })));
  for (const agent of agents) {
    lines.push(isRecord(agent) ? `  ${formatAgent(agent)}` : `  ${JSON.stringify(agent)}`);
  }
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
