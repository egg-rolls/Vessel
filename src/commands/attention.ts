/**
 * `vessel attention`（0.22 S9.1）。
 *
 * 列表 / 分页 / 单条 / 批量 / 交互式应答。权限与 ask 永远在运行节点的本地
 * gateway 上处理：`--to` 只校验 `health.get` 的 `node.node_id`，principal 不参与过滤。
 * 应答必须带 `answered_via: 'cli'`；不自动重试，不打印 token。
 *
 * @module vessel/commands/attention
 */

import { createInterface } from 'node:readline/promises';
import {
  type AttentionNodeConfig,
  loadConfig,
  type VesselConfig,
} from '../../packages/config/src/index';
import {
  type AttentionInteraction,
  type AttentionPage,
  healthNodeId,
  listInteractions,
  resolveAgentFilter,
  respondAsk,
  respondPermission,
} from '../attention-client';
import {
  type AttentionNodeToken,
  configuredAttentionNodes,
  createAttentionNodeTarget,
  findAttentionNodeByAddress,
  resolveNodeToken,
  selectAttentionNodes,
} from '../attention-nodes';
import type { AttentionCommandArgs } from '../cli-args';
import {
  type ControlPlaneTarget,
  type ControlPlaneTargetOptions,
  resolveControlPlaneTarget,
} from '../control-plane-target';
import { parseFederationAddress } from '../federation-address';
import { t } from '../i18n';
import { RpcClientError } from '../rpc';
import { ui } from '../ui-style';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AttentionCommandOptions extends ControlPlaneTargetOptions {
  /** 覆盖 TTY 检测（交互 / 逐条确认）。 */
  isTTY?: boolean;
  /** 测试注入：按配置节点构造目标；生产走 `createAttentionNodeTarget`。 */
  nodeTargetFactory?: (
    node: AttentionNodeConfig,
    token: string,
  ) => Promise<ControlPlaneTarget> | ControlPlaneTarget;
}

/** `--all` 每页条数 / 累计上限（DECISION-038 §2.2）。 */
const ALL_PAGE_SIZE = 100;
const ALL_MAX = 200;
/** 单条 respond 的扫描上限（pending / orphaned 各一次）。 */
const SCAN_LIMIT = 500;

function isAuthError(error: unknown): error is RpcClientError {
  return (
    error instanceof RpcClientError &&
    (error.httpStatus === 401 ||
      error.httpStatus === 403 ||
      error.code === 'unauthorized' ||
      error.code === 'forbidden')
  );
}

function authFailure(error: RpcClientError): CommandResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: `${error.code}: ${error.message}\n${t('attention.error.humanToken')}`,
  };
}

function describeError(error: unknown): string {
  if (error instanceof RpcClientError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function rpcFailure(error: unknown): CommandResult {
  if (isAuthError(error)) return authFailure(error);
  return { exitCode: 1, stdout: '', stderr: describeError(error) };
}

function isInteractiveTty(options: AttentionCommandOptions): boolean {
  return options.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
}

function formatTime(createdAt: number): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? String(createdAt) : date.toISOString();
}

function formatRow(index: number, item: AttentionInteraction): string {
  return (
    `${index}. [${item.kind}] ${item.request_id}  tool=${item.tool ?? '-'}  ` +
    `agent=${item.agent_id ?? '-'}  team=${item.team_id ?? '-'}  ${formatTime(item.created_at)}`
  );
}

function renderPage(page: AttentionPage, status: string, hasCursor: boolean): string[] {
  if (page.interactions.length === 0) return [t('attention.empty', { status })];
  const showing = hasCursor ? String(page.interactions.length) : `1–${page.interactions.length}`;
  const lines = [ui.section(t('attention.header', { total: page.total, status, showing }))];
  for (let i = 0; i < page.interactions.length; i++) {
    const item = page.interactions[i];
    if (item !== undefined) lines.push(formatRow(i + 1, item));
  }
  return lines;
}

function pagePayload(page: AttentionPage): string {
  return JSON.stringify(
    {
      interactions: page.interactions,
      total: page.total,
      ...(page.nextCursor !== undefined ? { next_cursor: page.nextCursor } : {}),
    },
    null,
    2,
  );
}

function pageParams(
  command: AttentionCommandArgs,
  teamId: string | undefined,
  input: { status: 'pending' | 'orphaned'; limit: number; cursor?: string; agentId?: string },
) {
  return {
    status: input.status,
    limit: input.limit,
    ...(teamId !== undefined ? { teamId } : {}),
    ...(command.tenantId !== undefined ? { tenantId: command.tenantId } : {}),
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(command.order !== undefined ? { order: command.order } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  };
}

async function confirmPrompt(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

interface BatchOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function respondBatch(
  target: ControlPlaneTarget,
  command: AttentionCommandArgs,
  items: AttentionInteraction[],
  indexes: number[],
): Promise<BatchOutcome> {
  const decision = command.decision;
  if (decision === undefined) {
    return { exitCode: 1, stdout: '', stderr: 'attention respond requires --allow or --deny' };
  }
  if (!command.yes && !(process.stdin.isTTY === true && process.stdout.isTTY === true)) {
    return { exitCode: 1, stdout: '', stderr: t('attention.needsYes') };
  }

  const lines: string[] = [];
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const index of indexes) {
    const item = items[index - 1];
    if (item === undefined) continue;
    if (item.kind !== 'permission') {
      lines.push(
        `FAIL ${item.request_id} kind_mismatch: ${t('attention.error.askInBatch', { request: item.request_id })}`,
      );
      failed++;
      continue;
    }
    if (!command.yes) {
      const confirmed = await confirmPrompt(
        t('attention.confirm', { request: item.request_id, decision }),
      );
      if (!confirmed) {
        skipped++;
        continue;
      }
    }
    try {
      await respondPermission(target, item.request_id, decision, command.remember);
      lines.push(`OK ${item.request_id} ${decision}`);
      ok++;
    } catch (error) {
      if (isAuthError(error)) return authFailure(error);
      lines.push(`FAIL ${item.request_id} ${describeError(error)}`);
      failed++;
    }
  }
  lines.push(t('attention.summary', { ok, failed, skipped }));
  return { exitCode: failed > 0 ? 1 : 0, stdout: lines.join('\n'), stderr: '' };
}

/** 单条：先扫 pending（最多 500），再扫 orphaned。 */
async function scanForRequest(
  target: ControlPlaneTarget,
  command: AttentionCommandArgs,
  teamId: string | undefined,
  requestId: string,
): Promise<AttentionInteraction | undefined> {
  for (const status of ['pending', 'orphaned'] as const) {
    const page = await listInteractions(
      target,
      pageParams(command, teamId, { status, limit: SCAN_LIMIT }),
    );
    const item = page.interactions.find((entry) => entry.request_id === requestId);
    if (item !== undefined) return item;
  }
  return undefined;
}

async function respondOne(
  target: ControlPlaneTarget,
  command: AttentionCommandArgs,
  teamId: string | undefined,
): Promise<CommandResult> {
  const requestId = command.requestId;
  if (requestId === undefined) {
    return { exitCode: 1, stdout: '', stderr: 'attention respond requires <request_id>' };
  }
  const item = await scanForRequest(target, command, teamId, requestId);
  if (item === undefined) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: t('attention.error.notFound', { request: requestId }),
    };
  }
  if (command.agent !== undefined) {
    const agentId = await resolveAgentFilter({
      target,
      agent: command.agent,
      ...(teamId !== undefined ? { teamId } : {}),
    });
    if (item.agent_id !== agentId) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: t('attention.error.notFound', { request: requestId }),
      };
    }
  }

  if (item.kind === 'permission') {
    if (command.answers !== undefined) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: t('attention.error.permissionNoAnswers', { request: requestId }),
      };
    }
    if (command.decision === undefined) {
      return { exitCode: 1, stdout: '', stderr: 'attention respond requires --allow or --deny' };
    }
    try {
      await respondPermission(target, requestId, command.decision, command.remember);
      return { exitCode: 0, stdout: `OK ${requestId} ${command.decision}`, stderr: '' };
    } catch (error) {
      return rpcFailure(error);
    }
  }

  if (command.answers === undefined) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: t('attention.error.askRequiresAnswers', { request: requestId }),
    };
  }
  try {
    await respondAsk(target, requestId, command.answers);
    return { exitCode: 0, stdout: `OK ${requestId} answers`, stderr: '' };
  } catch (error) {
    return rpcFailure(error);
  }
}

async function respondSelect(
  target: ControlPlaneTarget,
  command: AttentionCommandArgs,
  teamId: string | undefined,
): Promise<CommandResult> {
  const indexes = command.select ?? [];
  let agentId: string | undefined;
  if (command.agent !== undefined) {
    agentId = await resolveAgentFilter({
      target,
      agent: command.agent,
      ...(teamId !== undefined ? { teamId } : {}),
    });
  }
  const page = await listInteractions(
    target,
    pageParams(command, teamId, {
      status: 'pending',
      limit: command.limit,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
    }),
  );
  const invalid = indexes.find((index) => index > page.interactions.length);
  if (invalid !== undefined) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: t('attention.error.selectOutOfRange', {
        index: invalid,
        count: page.interactions.length,
      }),
    };
  }
  return respondBatch(target, command, page.interactions, indexes);
}

async function respondAll(
  target: ControlPlaneTarget,
  command: AttentionCommandArgs,
  teamId: string | undefined,
): Promise<CommandResult> {
  let agentId: string | undefined;
  if (command.agent !== undefined) {
    agentId = await resolveAgentFilter({
      target,
      agent: command.agent,
      ...(teamId !== undefined ? { teamId } : {}),
    });
  }

  const collected: AttentionInteraction[] = [];
  let cursor = command.cursor;
  let fetched = 0;
  let truncated = false;
  while (fetched < ALL_MAX) {
    const page = await listInteractions(
      target,
      pageParams(command, teamId, {
        status: 'pending',
        limit: ALL_PAGE_SIZE,
        ...(agentId !== undefined ? { agentId } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
    fetched += page.interactions.length;
    for (const item of page.interactions) {
      if (collected.length >= ALL_MAX) break;
      collected.push(item);
    }
    if (page.interactions.length === 0) break;
    if (page.nextCursor === undefined) break;
    if (fetched >= ALL_MAX) {
      truncated = true;
      break;
    }
    cursor = page.nextCursor;
  }

  const indexes = collected.map((_, index) => index + 1);
  const outcome = await respondBatch(target, command, collected, indexes);
  return {
    ...outcome,
    stderr: truncated ? `${outcome.stderr}\n${t('attention.allTruncated')}`.trim() : outcome.stderr,
  };
}

async function runRespond(
  target: ControlPlaneTarget,
  command: AttentionCommandArgs,
  teamId: string | undefined,
): Promise<CommandResult> {
  if (command.all) return respondAll(target, command, teamId);
  if (command.select !== undefined) return respondSelect(target, command, teamId);
  return respondOne(target, command, teamId);
}

async function askDecision(
  rl: ReturnType<typeof createInterface>,
  output: string[],
): Promise<'allow' | 'deny' | undefined> {
  for (;;) {
    const answer = (await rl.question(t('attention.interactive.decision'))).trim().toLowerCase();
    if (answer === 'a' || answer === 'allow') return 'allow';
    if (answer === 'd' || answer === 'deny') return 'deny';
    if (answer === 'q' || answer === '') return undefined;
    output.push(t('attention.interactive.invalid'));
  }
}

function parseSelectInput(raw: string): number[] | undefined {
  const parts = raw.split(',');
  const seen = new Set<number>();
  const selected: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const value = Number.parseInt(part, 10);
    if (value < 1) return undefined;
    if (seen.has(value)) continue;
    seen.add(value);
    selected.push(value);
  }
  return selected;
}

async function runInteractive(
  target: ControlPlaneTarget,
  command: AttentionCommandArgs,
  teamId: string | undefined,
  initialPage: AttentionPage,
  agentId: string | undefined,
  options: AttentionCommandOptions,
): Promise<CommandResult> {
  if (!isInteractiveTty(options)) {
    return { exitCode: 1, stdout: '', stderr: t('attention.needsTty') };
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const output: string[] = [];
  try {
    let page = initialPage;
    let cursor = command.cursor;
    for (;;) {
      output.push(...renderPage(page, command.status, cursor !== undefined));
      const selection = (await rl.question(t('attention.interactive.select'))).trim().toLowerCase();

      if (selection === 'q') break;
      if (selection === '') {
        output.push(t('attention.interactive.emptySelection'));
        continue;
      }
      if (selection === 'n') {
        if (page.nextCursor === undefined) {
          output.push(t('attention.interactive.noMore'));
          continue;
        }
        cursor = page.nextCursor;
        page = await listInteractions(
          target,
          pageParams(command, teamId, {
            status: command.status,
            limit: command.limit,
            ...(agentId !== undefined ? { agentId } : {}),
            cursor,
          }),
        );
        continue;
      }

      let indexes: number[];
      if (selection === 'a') {
        indexes = page.interactions.map((_, index) => index + 1);
      } else {
        const parsed = parseSelectInput(selection);
        if (parsed === undefined) {
          output.push(t('attention.interactive.invalid'));
          continue;
        }
        indexes = parsed;
      }

      const decision = await askDecision(rl, output);
      if (decision === undefined) continue;

      for (const index of indexes) {
        const item = page.interactions[index - 1];
        if (item === undefined) {
          output.push(
            t('attention.error.selectOutOfRange', {
              index,
              count: page.interactions.length,
            }),
          );
          continue;
        }
        if (item.kind === 'ask') {
          output.push(t('attention.interactive.askSkipped', { request: item.request_id }));
          continue;
        }
        try {
          await respondPermission(target, item.request_id, decision, false);
          output.push(`OK ${item.request_id} ${decision}`);
        } catch (error) {
          if (isAuthError(error)) return authFailure(error);
          output.push(`FAIL ${item.request_id} ${describeError(error)}`);
        }
      }
    }
  } finally {
    rl.close();
  }
  return { exitCode: 0, stdout: output.join('\n'), stderr: '' };
}

async function resolveAttentionAgent(
  target: ControlPlaneTarget,
  command: AttentionCommandArgs,
  teamId: string | undefined,
): Promise<string | undefined> {
  if (command.agent === undefined) return undefined;
  return resolveAgentFilter({
    target,
    agent: command.agent,
    ...(teamId !== undefined ? { teamId } : {}),
  });
}

async function fetchListPage(
  target: ControlPlaneTarget,
  command: AttentionCommandArgs,
  teamId: string | undefined,
  agentId: string | undefined,
): Promise<AttentionPage> {
  return listInteractions(
    target,
    pageParams(command, teamId, {
      status: command.status,
      limit: command.limit,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
    }),
  );
}

async function runList(
  target: ControlPlaneTarget,
  command: AttentionCommandArgs,
  teamId: string | undefined,
  options: AttentionCommandOptions,
): Promise<CommandResult> {
  const agentId = await resolveAttentionAgent(target, command, teamId);
  const page = await fetchListPage(target, command, teamId, agentId);

  if (command.interactive) {
    return runInteractive(target, command, teamId, page, agentId, options);
  }
  if (command.json) return { exitCode: 0, stdout: pagePayload(page), stderr: '' };
  return {
    exitCode: 0,
    stdout: renderPage(page, command.status, command.cursor !== undefined).join('\n'),
    stderr: '',
  };
}

async function createNodeTarget(
  node: AttentionNodeConfig,
  token: string,
  options: AttentionCommandOptions,
  config: VesselConfig,
): Promise<ControlPlaneTarget> {
  if (options.nodeTargetFactory !== undefined) {
    return options.nodeTargetFactory(node, token);
  }
  const caFile = node.caFile ?? config.connect?.caFile;
  return createAttentionNodeTarget(node, token, {
    ...(caFile !== undefined ? { caFile } : {}),
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
  });
}

async function verifyConfiguredNode(
  target: ControlPlaneTarget,
  node: AttentionNodeConfig,
): Promise<string | null> {
  if (node.nodeId === undefined) return null;
  const actual = await healthNodeId(target);
  if (actual === node.nodeId) return null;
  return t('attention.error.nodeMismatch', {
    name: node.name,
    expected: node.nodeId,
    actual: actual ?? '-',
  });
}

/** `--node <name>`：单节点，保持 0.22 的输出形状。 */
async function runConfiguredNode(
  node: AttentionNodeConfig,
  command: AttentionCommandArgs,
  options: AttentionCommandOptions,
  config: VesselConfig,
): Promise<CommandResult> {
  const resolvedToken: AttentionNodeToken = resolveNodeToken(node, options.env ?? process.env);
  if (!resolvedToken.ok) {
    return { exitCode: 1, stdout: '', stderr: resolvedToken.error };
  }
  let target: ControlPlaneTarget | undefined;
  try {
    target = await createNodeTarget(node, resolvedToken.token, options, config);
    const mismatch = await verifyConfiguredNode(target, node);
    if (mismatch !== null) return { exitCode: 1, stdout: '', stderr: mismatch };
    return await runAttention(target, command, options);
  } catch (error) {
    return rpcFailure(error);
  } finally {
    await target?.close().catch(() => undefined);
  }
}

interface NodeListOutcome {
  node: AttentionNodeConfig;
  ok: boolean;
  page?: AttentionPage;
  error?: string;
}

/** 一个节点的列表结果；token / URL / 认证失败都只属于该节点。 */
async function listNodeOutcome(
  node: AttentionNodeConfig,
  command: AttentionCommandArgs,
  options: AttentionCommandOptions,
  config: VesselConfig,
): Promise<NodeListOutcome> {
  const resolvedToken: AttentionNodeToken = resolveNodeToken(node, options.env ?? process.env);
  if (!resolvedToken.ok) return { node, ok: false, error: resolvedToken.error };

  let target: ControlPlaneTarget | undefined;
  try {
    target = await createNodeTarget(node, resolvedToken.token, options, config);
    const mismatch = await verifyConfiguredNode(target, node);
    if (mismatch !== null) return { node, ok: false, error: mismatch };
    const agentId = await resolveAttentionAgent(target, command, command.teamId);
    const page = await fetchListPage(target, command, command.teamId, agentId);
    return { node, ok: true, page };
  } catch (error) {
    return { node, ok: false, error: describeError(error) };
  } finally {
    await target?.close().catch(() => undefined);
  }
}

/**
 * `--all-nodes`：逐节点并发拉取；单节点失败不影响其它节点。
 * JSON 输出 `{ nodes: [...] }`（additive；单节点形状不变）。
 */
async function runAllNodes(
  nodes: readonly AttentionNodeConfig[],
  command: AttentionCommandArgs,
  options: AttentionCommandOptions,
  config: VesselConfig,
): Promise<CommandResult> {
  const outcomes = await Promise.all(
    nodes.map((node) => listNodeOutcome(node, command, options, config)),
  );
  const failed = outcomes.filter((outcome) => !outcome.ok).length;

  if (command.json) {
    return {
      exitCode: failed > 0 ? 1 : 0,
      stdout: JSON.stringify(
        {
          nodes: outcomes.map((outcome) => ({
            name: outcome.node.name,
            url: outcome.node.url,
            ...(outcome.node.nodeId !== undefined ? { node_id: outcome.node.nodeId } : {}),
            ok: outcome.ok,
            ...(outcome.ok && outcome.page !== undefined
              ? {
                  interactions: outcome.page.interactions,
                  total: outcome.page.total,
                  ...(outcome.page.nextCursor !== undefined
                    ? { next_cursor: outcome.page.nextCursor }
                    : {}),
                }
              : {}),
            ...(!outcome.ok ? { error: outcome.error ?? 'unknown error' } : {}),
          })),
        },
        null,
        2,
      ),
      stderr: '',
    };
  }

  const lines: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok || outcome.page === undefined) {
      lines.push(
        t('attention.nodeFailed', {
          name: outcome.node.name,
          error: outcome.error ?? 'unknown error',
        }),
      );
      continue;
    }
    const page = outcome.page;
    lines.push(
      ui.section(
        t('attention.nodeHeader', {
          name: outcome.node.name,
          url: outcome.node.url,
          total: page.total,
          status: command.status,
        }),
      ),
    );
    if (page.interactions.length === 0) {
      lines.push(t('attention.empty', { status: command.status }));
      continue;
    }
    for (let index = 0; index < page.interactions.length; index++) {
      const item = page.interactions[index];
      if (item !== undefined) lines.push(formatRow(index + 1, item));
    }
  }
  lines.push(t('attention.nodesSummary', { ok: outcomes.length - failed, failed }));
  return { exitCode: failed > 0 ? 1 : 0, stdout: lines.join('\n'), stderr: '' };
}

async function runAttention(
  target: ControlPlaneTarget,
  command: AttentionCommandArgs,
  options: AttentionCommandOptions,
): Promise<CommandResult> {
  let teamId = command.teamId;
  if (command.to !== undefined) {
    const parsed = parseFederationAddress(command.to);
    if (!parsed.ok) return { exitCode: 1, stdout: '', stderr: parsed.message };
    const localNodeId = await healthNodeId(target);
    if (localNodeId !== parsed.address.node_id) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: t('attention.error.federationMismatch', {
          node: parsed.address.node_id,
          local: localNodeId ?? '-',
        }),
      };
    }
    if (teamId === undefined) teamId = parsed.address.team_id;
  }

  if (command.kind === 'respond') return runRespond(target, command, teamId);
  return runList(target, command, teamId, options);
}

/**
 * `vessel attention`：人类输出走暗金样式，`--json` 只输出
 * `{interactions,total,next_cursor?}`（无 ANSI）。
 */
export async function attentionCommand(
  command: AttentionCommandArgs,
  options: AttentionCommandOptions = {},
): Promise<CommandResult> {
  try {
    const config = options.config ?? (await loadConfig({ env: options.env ?? process.env })).config;
    const configured = configuredAttentionNodes(config);

    if (command.allNodes) {
      const selection = selectAttentionNodes(configured, { all: true });
      if (!selection.ok) return { exitCode: 1, stdout: '', stderr: selection.error };
      return await runAllNodes(selection.nodes, command, options, config);
    }

    if (command.node !== undefined) {
      const selection = selectAttentionNodes(configured, { name: command.node });
      if (!selection.ok) return { exitCode: 1, stdout: '', stderr: selection.error };
      const node = selection.nodes[0];
      if (node === undefined) {
        return { exitCode: 1, stdout: '', stderr: `Unknown attention node "${command.node}".` };
      }
      return await runConfiguredNode(node, command, options, config);
    }

    // `--to` 未显式指定连接：优先匹配配置节点的 nodeId / name；无匹配时回退本机。
    if (command.to !== undefined && command.connectUrl === undefined) {
      const parsed = parseFederationAddress(command.to);
      if (parsed.ok) {
        const match = findAttentionNodeByAddress(configured, parsed.address.node_id);
        if (match.kind === 'unique') {
          return await runConfiguredNode(match.node, command, options, config);
        }
        if (match.kind === 'ambiguous') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: `Multiple attention nodes match "${parsed.address.node_id}": ${match.names.join(
              ', ',
            )}; use --node.`,
          };
        }
      }
    }

    const resolved = await resolveControlPlaneTarget({
      ...options,
      config,
      ...(command.connectUrl !== undefined ? { connectUrl: command.connectUrl } : {}),
      ...(command.connectToken !== undefined ? { connectToken: command.connectToken } : {}),
      ...(command.caFile !== undefined ? { caFile: command.caFile } : {}),
      ...(command.tenantId !== undefined ? { tenantId: command.tenantId } : {}),
    });
    if (!resolved.ok) return { exitCode: 1, stdout: '', stderr: resolved.error };

    try {
      return await runAttention(resolved.target, command, options);
    } catch (error) {
      return rpcFailure(error);
    } finally {
      await resolved.target.close().catch(() => undefined);
    }
  } catch (error) {
    return rpcFailure(error);
  }
}
