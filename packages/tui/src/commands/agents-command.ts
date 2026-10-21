/**
 * `/agents` —— 子 agent 注册表（0.14 P0）
 * @module @vessel-agent/tui
 *
 * 数据只来自 `ctx.events.getHistory()`，由 `agent-registry` 纯 reducer 派生。
 * 列表字段与 canonical `agents.list` 对齐：id / role / parent_id / depth / state /
 * current_tool / session_id；展示层只读，不启动/取消任何 agent。
 */

import type { VesselConfig } from '@vessel-agent/config';
import type { RunEvent } from '@vessel-agent/core';
import { t } from '../i18n/index.js';
import {
  type AgentNode,
  buildAgentRegistry,
  buildAgentTree,
  matchAgents,
  sortAgentNodes,
} from '../repl/agent-registry.js';
import {
  type EffectiveLimits,
  findLatestLimitBlock,
  formatLimitBlock,
  type LimitBlockInfo,
  type RemainingBudget,
  readAgentTools,
  readAgentUsage,
  readDelegateLimits,
  remainingBudget,
} from '../repl/limit-info.js';
import { formatSnapshotTime } from '../repl/status-snapshot.js';
import type { ReplContext } from '../repl-context.js';
import { formatDuration, formatTokenCount } from '../utils/display-labels.js';
import { sanitizeTerminalText } from '../utils/sanitize-terminal-text.js';
import { padToWidth, truncateToWidth } from '../utils/text-layout.js';
import type { CommandEntry, CommandResult } from './commands.js';

const LIST_LIMIT = 20;
const ID_WIDTH = 12;
const ROLE_WIDTH = 10;
const PARENT_WIDTH = 12;
const DEPTH_WIDTH = 5;
const STATE_WIDTH = 10;
const TOOL_WIDTH = 16;
const AGE_WIDTH = 8;
const TREE_ID_WIDTH = 18;
const CHILDREN_WIDTH = 8;

function usage(): CommandResult {
  return { handled: true, output: `\n${t('agents.usage')}\n` };
}

function oneLine(text: string): string {
  return sanitizeTerminalText(text).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function shortId(id: string): string {
  return truncateToWidth(id, ID_WIDTH);
}

function stateLabel(node: AgentNode): string {
  return t(`agents.state.${node.state}`);
}

function toolLabel(node: AgentNode): string {
  return node.currentTool ? truncateToWidth(node.currentTool, TOOL_WIDTH) : '-';
}

function parentLabel(node: AgentNode): string {
  // 列表列已是 PARENT；父 delegate id 优先，根节点退到父 run id。
  const parent = node.parentId ?? node.parentRunId;
  return parent.length > 0 ? shortId(parent) : '-';
}

/** 队列字段缺失时显示 unknown；不把“不在队列”伪装成 pos 0。 */
function queueLabel(node: AgentNode): string {
  if (node.queuePosition === undefined && node.waitReason === undefined) {
    return t('limits.unknown');
  }
  return t('agents.queueValue', {
    position: node.queuePosition ?? t('limits.unknown'),
    reason: node.waitReason ?? t('limits.unknown'),
  });
}

function ageLabel(node: AgentNode, now: number): string {
  if (node.durationMs !== undefined) return formatDuration(node.durationMs);
  const end = node.endedAt ?? now;
  return formatDuration(Math.max(0, end - node.startedAt));
}

/** 纯函数：列表文本（最多 LIST_LIMIT 行，新的在前） */
export function formatAgentList(nodes: AgentNode[], now: number = Date.now()): string {
  if (nodes.length === 0) {
    return `\n${t('agents.empty')}\n${t('agents.emptyHint')}\n`;
  }

  const sorted = sortAgentNodes(nodes);
  const visible = sorted.slice(0, LIST_LIMIT);
  const lines = ['', t('agents.title', { count: sorted.length })];
  lines.push(
    `  ${padToWidth(t('agents.columns.id'), ID_WIDTH)} ${padToWidth(
      t('agents.columns.role'),
      ROLE_WIDTH,
    )} ${padToWidth(t('agents.columns.parent'), PARENT_WIDTH)} ${padToWidth(
      t('agents.columns.depth'),
      DEPTH_WIDTH,
    )} ${padToWidth(t('agents.columns.state'), STATE_WIDTH)} ${padToWidth(
      t('agents.columns.tool'),
      TOOL_WIDTH,
    )} ${t('agents.columns.age')}`,
  );

  for (const node of visible) {
    const id = node.degraded ? `${shortId(node.id)}*` : shortId(node.id);
    lines.push(
      `  ${padToWidth(id, ID_WIDTH)} ${padToWidth(
        truncateToWidth(node.role, ROLE_WIDTH),
        ROLE_WIDTH,
      )} ${padToWidth(parentLabel(node), PARENT_WIDTH)} ${padToWidth(
        String(node.depth),
        DEPTH_WIDTH,
      )} ${padToWidth(stateLabel(node), STATE_WIDTH)} ${padToWidth(
        toolLabel(node),
        TOOL_WIDTH,
      )} ${padToWidth(ageLabel(node, now), AGE_WIDTH)}`,
    );
  }

  if (sorted.length > visible.length) {
    lines.push('');
    lines.push(t('agents.more', { count: sorted.length - visible.length }));
  }
  lines.push('');
  return lines.join('\n');
}

/** 纯函数：树形文本（按 depth 缩进，children_count 由父子关系派生） */
export function formatAgentTree(nodes: AgentNode[], now: number = Date.now()): string {
  if (nodes.length === 0) {
    return `\n${t('agents.empty')}\n${t('agents.emptyHint')}\n`;
  }

  const rows = buildAgentTree(nodes);
  const lines = ['', t('agents.treeTitle', { count: rows.length })];
  lines.push(
    `  ${padToWidth(t('agents.columns.id'), TREE_ID_WIDTH)} ${padToWidth(
      t('agents.columns.role'),
      ROLE_WIDTH,
    )} ${padToWidth(t('agents.columns.state'), STATE_WIDTH)} ${padToWidth(
      t('agents.columns.tool'),
      TOOL_WIDTH,
    )} ${t('agents.columns.children')}`,
  );

  for (const row of rows) {
    const indent = '  '.repeat(row.depth);
    const id = row.node.degraded ? `${shortId(row.node.id)}*` : shortId(row.node.id);
    lines.push(
      `  ${indent}${padToWidth(id, TREE_ID_WIDTH)} ${padToWidth(
        truncateToWidth(row.node.role, ROLE_WIDTH),
        ROLE_WIDTH,
      )} ${padToWidth(stateLabel(row.node), STATE_WIDTH)} ${padToWidth(
        toolLabel(row.node),
        TOOL_WIDTH,
      )} ${padToWidth(String(row.childrenCount), CHILDREN_WIDTH)} ${ageLabel(row.node, now)}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function detailLine(label: string, value: string): string {
  return `  ${padToWidth(label, 12)} ${value}`;
}

/** Self Card 摘要：限制来自 delegate 有效配置，用量来自事件历史 */
export interface AgentSelfCard {
  asOf: number;
  tools?: string[];
  /** true = tools 来自已见工具，而不是事件显式声明 */
  toolsSeen: boolean;
  limits: EffectiveLimits;
  remaining: RemainingBudget;
  /** false = 没有任何用量事件，剩余预算显示 unknown */
  usageObserved: boolean;
  blocked?: LimitBlockInfo;
}

export function buildAgentSelfCard(
  events: RunEvent[],
  config: VesselConfig,
  node: AgentNode,
  now: number,
): AgentSelfCard {
  const limits = readDelegateLimits(config);
  const usage = readAgentUsage(events, node, now);
  const tools = readAgentTools(events, node);
  const usageObserved =
    node.usage !== undefined ||
    node.endedAt !== undefined ||
    usage.requests > 0 ||
    usage.toolCalls > 0 ||
    usage.totalTokens > 0;
  const blocked = findLatestLimitBlock(events, {
    runIds: node.childRunId !== undefined ? [node.childRunId] : [],
    agentId: node.id,
  });

  return {
    asOf: now,
    ...(tools.tools !== undefined ? { tools: tools.tools } : {}),
    toolsSeen: tools.seen,
    limits,
    remaining: remainingBudget(limits, usage),
    usageObserved,
    ...(blocked !== undefined ? { blocked } : {}),
  };
}

function limitMax(max: number | undefined): string {
  return max === undefined ? t('limits.unbounded') : String(max);
}

function remainingValue(value: number | undefined, duration = false): string {
  if (value === undefined) return t('limits.unbounded');
  return duration ? formatDuration(value) : String(value);
}

/** 纯函数：单节点摘要文本 */
export function formatAgentDetail(
  node: AgentNode,
  now: number = Date.now(),
  card?: AgentSelfCard,
): string {
  const unknown = t('limits.unknown');
  const lines = ['', t('agents.summary.title', { id: node.id })];
  lines.push(detailLine(t('agents.label.id'), node.id));
  lines.push(detailLine(t('agents.label.nodeId'), node.nodeId ?? unknown));
  lines.push(detailLine(t('agents.label.role'), node.role));
  lines.push(
    detailLine(
      t('agents.label.parent'),
      node.parentId ??
        (node.parentRunId.length > 0 ? t('agents.parentRun', { id: node.parentRunId }) : unknown),
    ),
  );
  lines.push(detailLine(t('agents.label.depth'), String(node.depth)));
  lines.push(detailLine(t('agents.label.state'), stateLabel(node)));
  lines.push(detailLine(t('agents.label.visibility'), node.visibility ?? unknown));
  lines.push(detailLine(t('agents.label.session'), node.sessionId ?? '-'));
  lines.push(detailLine(t('agents.label.run'), node.childRunId ?? '-'));
  lines.push(detailLine(t('agents.label.task'), node.task ? oneLine(node.task) : unknown));
  lines.push(detailLine(t('agents.label.queue'), queueLabel(node)));
  lines.push(detailLine(t('agents.label.resultRef'), node.resultRef ?? unknown));
  lines.push(
    detailLine(t('agents.label.tool'), node.currentTool ? oneLine(node.currentTool) : '-'),
  );
  lines.push(detailLine(t('agents.label.duration'), ageLabel(node, now)));

  const toolsValue =
    card === undefined || card.tools === undefined
      ? unknown
      : `${card.tools.map(oneLine).join(', ')}${card.toolsSeen ? ` ${t('agents.toolsSeen')}` : ''}`;
  const limitsValue =
    card === undefined
      ? unknown
      : t('agents.limitsValue', {
          iterations: limitMax(card.limits.maxIterations),
          tools: limitMax(card.limits.toolCallsLimit),
          runtime:
            card.limits.maxRuntimeSeconds !== undefined
              ? formatDuration(card.limits.maxRuntimeSeconds * 1000)
              : t('limits.unbounded'),
        });
  const remainingValueText =
    card === undefined || !card.usageObserved
      ? unknown
      : t('agents.remainingValue', {
          iterations: remainingValue(card.remaining.iterations),
          tools: remainingValue(card.remaining.toolCalls),
          runtime: remainingValue(card.remaining.runtimeMs, true),
        });
  const blockedValue =
    card === undefined ? unknown : card.blocked ? formatLimitBlock(card.blocked) : '-';

  lines.push(detailLine(t('agents.label.asOf'), card ? formatSnapshotTime(card.asOf) : unknown));
  lines.push(detailLine(t('agents.label.tools'), toolsValue));
  lines.push(detailLine(t('agents.label.limits'), limitsValue));
  lines.push(detailLine(t('agents.label.remaining'), remainingValueText));
  lines.push(detailLine(t('agents.label.blocked'), blockedValue));

  if (node.usage) {
    const total = node.usage.total_tokens ?? 0;
    const prompt = node.usage.prompt_tokens ?? 0;
    const completion = node.usage.completion_tokens ?? 0;
    lines.push(
      detailLine(
        t('agents.label.usage'),
        t('agents.usageValue', {
          total: formatTokenCount(total),
          prompt: formatTokenCount(prompt),
          completion: formatTokenCount(completion),
        }),
      ),
    );
  }
  if (node.error !== undefined) {
    lines.push(detailLine(t('agents.label.error'), oneLine(node.error)));
  }
  if (node.degraded) {
    lines.push(detailLine(t('agents.label.degraded'), t('agents.degradedHint')));
  }
  lines.push('');
  return lines.join('\n');
}

function listAgents(ctx: ReplContext, now: number): CommandResult {
  return {
    handled: true,
    output: formatAgentList(buildAgentRegistry(ctx.events.getHistory()), now),
  };
}

function detailResult(
  events: RunEvent[],
  config: VesselConfig,
  node: AgentNode,
  now: number,
): CommandResult {
  return {
    handled: true,
    output: formatAgentDetail(node, now, buildAgentSelfCard(events, config, node, now)),
  };
}

function showAgent(ctx: ReplContext, query: string, now: number): CommandResult {
  const events = ctx.events.getHistory();
  const nodes = buildAgentRegistry(events);
  if (nodes.length === 0) {
    return {
      handled: true,
      output: `\n${t('agents.empty')}\n${t('agents.emptyHint')}\n`,
    };
  }

  const match = matchAgents(nodes, query);
  const exact = match.exact[0];
  if (exact) {
    return detailResult(events, ctx.config, exact, now);
  }

  if (match.prefix.length === 1) {
    const node = match.prefix[0];
    if (node) return detailResult(events, ctx.config, node, now);
  }
  if (match.prefix.length > 1) {
    const candidates = sortAgentNodes(match.prefix)
      .slice(0, LIST_LIMIT)
      .map((node) => `  ${node.id}`)
      .join('\n');
    return {
      handled: true,
      output: `\n${t('agents.ambiguous', { query, count: match.prefix.length })}\n${candidates}\n`,
    };
  }

  return { handled: true, output: `\n${t('agents.notFound', { query })}\n` };
}

export function agentsCommand(): CommandEntry {
  return {
    name: 'agents',
    description: t('command.agents.description'),
    usage: '/agents [tree|<id>|show <id>]',
    category: 'run',
    keywords: ['agents', 'subagent', 'delegate', 'delegates'],
    run: (args, ctx, _state) => {
      const now = Date.now();
      if (args.length === 0) return listAgents(ctx, now);

      if (args[0] === 'tree') {
        if (args.length > 1) return usage();
        return {
          handled: true,
          output: formatAgentTree(buildAgentRegistry(ctx.events.getHistory()), now),
        };
      }

      if (args[0] === 'show') {
        const query = args[1];
        if (query === undefined || args.length > 2) return usage();
        return showAgent(ctx, query, now);
      }

      if (args.length > 1) return usage();
      const query = args[0];
      if (query === undefined) return usage();
      return showAgent(ctx, query, now);
    },
  };
}
