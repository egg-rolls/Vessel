/**
 * `/agents` —— 子 agent 注册表（0.14 P0）
 * @module @vessel-agent/tui
 *
 * 数据只来自 `ctx.events.getHistory()`，由 `agent-registry` 纯 reducer 派生。
 * 列表字段与 canonical `agents.list` 对齐：id / role / parent_id / depth / state /
 * current_tool / session_id；展示层只读，不启动/取消任何 agent。
 */

import { t } from '../i18n/index.js';
import {
  type AgentNode,
  buildAgentRegistry,
  matchAgents,
  sortAgentNodes,
} from '../repl/agent-registry.js';
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
  return shortId(node.parentId ?? node.parentRunId);
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

function detailLine(label: string, value: string): string {
  return `  ${padToWidth(label, 12)} ${value}`;
}

/** 纯函数：单节点摘要文本 */
export function formatAgentDetail(node: AgentNode, now: number = Date.now()): string {
  const lines = ['', t('agents.summary.title', { id: node.id })];
  lines.push(detailLine(t('agents.label.id'), node.id));
  lines.push(detailLine(t('agents.label.role'), node.role));
  lines.push(
    detailLine(
      t('agents.label.parent'),
      node.parentId ?? t('agents.parentRun', { id: node.parentRunId }),
    ),
  );
  lines.push(detailLine(t('agents.label.depth'), String(node.depth)));
  lines.push(detailLine(t('agents.label.state'), stateLabel(node)));
  lines.push(detailLine(t('agents.label.session'), node.sessionId ?? '-'));
  lines.push(detailLine(t('agents.label.run'), node.childRunId ?? '-'));
  lines.push(detailLine(t('agents.label.task'), node.task ? oneLine(node.task) : '-'));
  lines.push(
    detailLine(t('agents.label.tool'), node.currentTool ? oneLine(node.currentTool) : '-'),
  );
  lines.push(detailLine(t('agents.label.duration'), ageLabel(node, now)));

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

function showAgent(ctx: ReplContext, query: string, now: number): CommandResult {
  const nodes = buildAgentRegistry(ctx.events.getHistory());
  if (nodes.length === 0) {
    return {
      handled: true,
      output: `\n${t('agents.empty')}\n${t('agents.emptyHint')}\n`,
    };
  }

  const match = matchAgents(nodes, query);
  const exact = match.exact[0];
  if (exact) {
    return { handled: true, output: formatAgentDetail(exact, now) };
  }

  if (match.prefix.length === 1) {
    const node = match.prefix[0];
    if (node) return { handled: true, output: formatAgentDetail(node, now) };
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
    usage: '/agents [<id>|show <id>]',
    category: 'run',
    keywords: ['agents', 'subagent', 'delegate', 'delegates'],
    run: (args, ctx, _state) => {
      const now = Date.now();
      if (args.length === 0) return listAgents(ctx, now);

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
