/**
 * `vessel session status [--id <session>] [--json]`（AX 自服务 · 自观组）。
 *
 * 会话实时态一屏：state / run 状态 / token 用量 / 上下文预算 / queue 深度 / 最后活动。
 *
 * 缺省 = 调用者自身：CLI 上下文是人类管理面（operator），其会话即 `main` agent 的
 * primary body —— 与 Web 默认会话同一口径（`apps/web/src/domains/chat/main-session.ts`
 * 的 `findMainSession`：`id === 'main'` → bodies primary → `session_id`）。
 * `--id` 指定其它会话；授权由 gateway `sessions.get` 的权限链判定，本命令不绕过。
 *
 * 只读包装三个既有 RPC，不新增服务端面：
 * - `agents.list`：仅缺省身份解析时用（显式 `--id` 不调）；
 * - `sessions.get`（`message_limit: 1`）：状态 / 用量 / 上下文 / 事件尾；不拉全量历史；
 * - `health.get`：scheduler 队列（best-effort —— 失败只缺 queue 字段，不打挂命令）。
 *
 * 不 bootstrap、不获取 tenant 写锁、不输出 token / 密钥。
 *
 * @module vessel/session-status-command
 */

import { t } from '../../../i18n';
import { RpcClientError } from '../../../rpc';
import {
  type ControlPlaneTarget,
  type ControlPlaneTargetOptions,
  resolveControlPlaneTarget,
} from '../../control-plane-target';
import { ui } from '../../output';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SessionStatusCommandOptions extends ControlPlaneTargetOptions {
  json?: boolean;
  /** 显式会话 id；缺省解析调用者自身（main primary body）。 */
  id?: string;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pickNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sourceView(target: ControlPlaneTarget): Record<string, unknown> {
  return {
    kind: target.kind,
    url: target.baseUrl,
    ...(target.instance !== undefined ? { instance: target.instance } : {}),
  };
}

/** `agents.list` 结果：`{agents:[...]}` / 数组 / `{items:[...]}` 都接受（同 agents 命令）。 */
function extractAgentList(result: unknown): unknown[] | undefined {
  if (Array.isArray(result)) return result;
  if (!isRecord(result)) return undefined;
  if (Array.isArray(result.agents)) return result.agents;
  if (Array.isArray(result.items)) return result.items;
  return undefined;
}

/**
 * 缺省身份解析：`agents.list` 里 `main` 的 primary body session。
 *
 * 与 Web `findMainSession` 同口径：匹配 `id === 'main'`；有 `bodies` 时以
 * `primary === true` 的那条为准（rotate 窗口精确），否则退回 `session_id`。
 * 解析不出返回 undefined —— 调用方报错并提示 `--id`，不本地造 id。
 */
export function resolveCallerSessionId(agentsResult: unknown): string | undefined {
  const agents = extractAgentList(agentsResult);
  if (agents === undefined) return undefined;
  const main = agents.find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === 'main',
  );
  if (main === undefined) return undefined;
  const bodies = Array.isArray(main.bodies) ? main.bodies : [];
  const primary = bodies.find(
    (body): body is Record<string, unknown> => isRecord(body) && body.primary === true,
  );
  const fromPrimary = pickString(primary, 'session_id') ?? pickString(primary, 'body_id');
  const sessionId = fromPrimary ?? pickString(main, 'session_id');
  return sessionId?.trim() || undefined;
}

/** scheduler 快照里属于该会话的排队 run（queue 深度 / 队首位置）。 */
function sessionQueueView(
  health: Record<string, unknown> | undefined,
  sessionId: string,
): Record<string, unknown> | undefined {
  const runtime = isRecord(health?.runtime) ? health.runtime : undefined;
  const scheduler = isRecord(runtime?.scheduler) ? runtime.scheduler : undefined;
  if (scheduler === undefined) return undefined;
  const queued = Array.isArray(scheduler.queued) ? scheduler.queued.filter(isRecord) : [];
  const mine = queued.filter((run) => run.session_id === sessionId);
  const stats = isRecord(scheduler.stats) ? scheduler.stats : undefined;
  const position = pickNumber(mine[0], 'queue_position');
  return {
    depth: mine.length,
    ...(position !== undefined ? { position } : {}),
    ...(pickNumber(stats, 'queued') !== undefined
      ? { node_queued: pickNumber(stats, 'queued') }
      : {}),
    ...(pickNumber(stats, 'running') !== undefined
      ? { node_running: pickNumber(stats, 'running') }
      : {}),
  };
}

/** epoch ms → `{at, iso, age_seconds}`；非法值 → undefined（不猜、不补 0）。 */
function activityView(
  at: number | undefined,
  now: () => number,
): Record<string, unknown> | undefined {
  if (at === undefined) return undefined;
  return {
    at,
    iso: new Date(at).toISOString(),
    age_seconds: Math.max(0, Math.floor((now() - at) / 1000)),
  };
}

function formatTokens(usage: Record<string, unknown> | undefined): string {
  if (usage === undefined) return '-';
  const prompt = pickNumber(usage, 'prompt_tokens');
  const completion = pickNumber(usage, 'completion_tokens');
  const total = pickNumber(usage, 'total_tokens');
  const cost = pickNumber(usage, 'total_cost');
  const parts = [
    `prompt ${prompt ?? '-'}`,
    `completion ${completion ?? '-'}`,
    `total ${total ?? '-'}`,
  ];
  if (cost !== undefined) parts.push(`cost ${cost}`);
  return parts.join(' / ');
}

function formatContext(context: Record<string, unknown> | undefined): string {
  if (context === undefined) return '-';
  const used = pickNumber(context, 'used');
  const max = pickNumber(context, 'max');
  const source = pickString(context, 'source');
  let text = `${used ?? '-'}`;
  if (max !== undefined && max > 0) {
    const percent = used !== undefined ? ` (${((used / max) * 100).toFixed(1)}%)` : '';
    text += ` / ${max}${percent}`;
  }
  if (source !== undefined) text += ` [${source}]`;
  return text;
}

/**
 * `vessel session status`：人类输出走海洋绿样式，`--json` 纯 JSON（无 ANSI）。
 */
export async function sessionStatusCommand(
  options: SessionStatusCommandOptions = {},
): Promise<CommandResult> {
  const now = options.now ?? Date.now;
  const json = options.json === true;

  const resolved = await resolveControlPlaneTarget(options);
  if (!resolved.ok) {
    return { exitCode: 1, stdout: '', stderr: resolved.error };
  }
  const target = resolved.target;

  try {
    // ── 1. 会话 id：显式 --id，或缺省解析调用者自身（main primary body）──
    let sessionId = options.id?.trim() || undefined;
    const resolvedFrom = sessionId !== undefined ? 'flag' : 'main-agent';
    if (sessionId === undefined) {
      let agentsResult: unknown;
      try {
        agentsResult = await target.request('agents.list', {});
      } catch (error) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
      sessionId = resolveCallerSessionId(agentsResult);
      if (sessionId === undefined) {
        return { exitCode: 1, stdout: '', stderr: t('sessionStatus.noMain') };
      }
    }

    // ── 2. sessions.get（message_limit=1：只要实时态，不拉全量历史）──
    let getResult: unknown;
    try {
      getResult = await target.request('sessions.get', {
        session_id: sessionId,
        message_limit: 1,
      });
    } catch (error) {
      if (error instanceof RpcClientError && error.code === 'not_found') {
        return {
          exitCode: 1,
          stdout: '',
          stderr: t('sessionStatus.notFound', { id: sessionId }),
        };
      }
      if (error instanceof RpcClientError && error.code === 'not_supported') {
        return { exitCode: 1, stdout: '', stderr: t('sessionStatus.notAvailable') };
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    const getRecord = isRecord(getResult) ? getResult : undefined;
    const session = isRecord(getRecord?.session) ? getRecord.session : undefined;
    if (session === undefined) {
      return { exitCode: 1, stdout: '', stderr: t('sessionStatus.notAvailable') };
    }
    const agent = isRecord(getRecord?.agent) ? getRecord.agent : undefined;

    // ── 3. health.get（best-effort：失败只缺 queue 字段）──
    let health: Record<string, unknown> | undefined;
    try {
      const raw = await target.request<unknown>('health.get');
      health = isRecord(raw) ? raw : undefined;
    } catch {
      health = undefined;
    }
    const queue = sessionQueueView(health, sessionId);

    // ── 4. 收敛成线上形状（sparse：没有数据的字段缺省，不写 null / 不补 0）──
    const usage = isRecord(session.usage) ? session.usage : undefined;
    const contextUsage = isRecord(session.context_usage) ? session.context_usage : undefined;
    const eventCursor = isRecord(session.event_cursor) ? session.event_cursor : undefined;
    const updatedAt = pickNumber(session, 'updated_at');
    const startedAt = pickNumber(session, 'started_at');
    const completedAt = pickNumber(session, 'completed_at');
    const runId = pickString(session, 'run_id');
    const status = pickString(session, 'status');
    const runError = pickString(session, 'error');
    const title = pickString(session, 'title');
    const messagesTotal = pickNumber(session, 'messages_total');
    const projectionMode = pickString(session, 'projection_mode');
    const activity = activityView(updatedAt, now);
    const used = pickNumber(contextUsage, 'used');
    const max = pickNumber(contextUsage, 'max');
    const contextPercent =
      used !== undefined && max !== undefined && max > 0
        ? Math.round((used / max) * 1000) / 10
        : undefined;

    const payload = {
      as_of: new Date(now()).toISOString(),
      session_id: sessionId,
      resolved_from: resolvedFrom,
      ...(title !== undefined ? { title } : {}),
      ...(status !== undefined ? { state: status } : {}),
      run: {
        ...(runId !== undefined ? { run_id: runId } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(startedAt !== undefined ? { started_at: startedAt } : {}),
        ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
        ...(runError !== undefined ? { error: runError } : {}),
      },
      ...(usage !== undefined ? { usage } : {}),
      ...(contextUsage !== undefined
        ? {
            context_usage: {
              ...contextUsage,
              ...(contextPercent !== undefined ? { percent: contextPercent } : {}),
            },
          }
        : {}),
      ...(queue !== undefined ? { queue } : {}),
      ...(messagesTotal !== undefined ? { messages_total: messagesTotal } : {}),
      ...(eventCursor !== undefined ? { event_cursor: eventCursor } : {}),
      ...(activity !== undefined ? { last_activity: activity } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(projectionMode !== undefined ? { projection_mode: projectionMode } : {}),
      source: sourceView(target),
    };

    if (json) {
      return { exitCode: 0, stdout: JSON.stringify(payload, null, 2), stderr: '' };
    }

    // ── 5. 人类输出 ──
    const lines: string[] = [];
    lines.push(ui.title(t('sessionStatus.title')));
    lines.push(ui.rule(48));
    lines.push(ui.kv(t('sessionStatus.session'), sessionId, 12));
    if (title !== undefined) lines.push(ui.kv(t('sessionStatus.sessionTitle'), title, 12));
    if (agent !== undefined) {
      const name = pickString(agent, 'name') ?? pickString(agent, 'id') ?? '-';
      const agentState = pickString(agent, 'state');
      const presence = pickString(agent, 'presence');
      const extras = [agentState, presence].filter((v) => v !== undefined).join(', ');
      lines.push(ui.kv(t('sessionStatus.agent'), extras !== '' ? `${name} (${extras})` : name, 12));
    }
    lines.push(ui.kv(t('sessionStatus.state'), status ?? '-', 12));
    lines.push(ui.kv(t('sessionStatus.run'), runId ?? '-', 12));
    lines.push(ui.kv(t('sessionStatus.tokens'), formatTokens(usage), 12));
    lines.push(ui.kv(t('sessionStatus.context'), formatContext(contextUsage), 12));
    if (queue !== undefined) {
      const depth = pickNumber(queue, 'depth') ?? 0;
      const position = pickNumber(queue, 'position');
      const nodeQueued = pickNumber(queue, 'node_queued');
      const nodeRunning = pickNumber(queue, 'node_running');
      let text = `${depth}`;
      if (position !== undefined) text += ` (position ${position})`;
      if (nodeQueued !== undefined || nodeRunning !== undefined) {
        text += `  node: ${nodeQueued ?? '-'} queued / ${nodeRunning ?? '-'} running`;
      }
      lines.push(ui.kv(t('sessionStatus.queue'), text, 12));
    }
    if (messagesTotal !== undefined) {
      lines.push(ui.kv(t('sessionStatus.messages'), String(messagesTotal), 12));
    }
    if (eventCursor !== undefined) {
      const lastSeq = pickNumber(eventCursor, 'last_seq');
      if (lastSeq !== undefined) {
        lines.push(ui.kv(t('sessionStatus.events'), String(lastSeq), 12));
      }
    }
    if (activity !== undefined) {
      const iso = pickString(activity, 'iso') ?? '-';
      const age = pickNumber(activity, 'age_seconds');
      lines.push(
        ui.kv(t('sessionStatus.activity'), age !== undefined ? `${iso} (${age}s ago)` : iso, 12),
      );
    }
    lines.push(
      ui.kv(
        t('sessionStatus.source'),
        `${target.baseUrl}${target.instance !== undefined ? ` (${target.instance})` : ''}`,
        12,
      ),
    );
    return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
  } finally {
    await target.close().catch(() => undefined); // benign: 探针客户端关闭，失败不掩盖结果。
  }
}
