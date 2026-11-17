/**
 * `recall` 工具：把被压缩掉的历史按索引读回来
 * @module @vessel-agent/recall
 *
 * ## 它解决的问题
 *
 * 压缩（compaction）把「一堆消息」换成一条摘要。在 0.56 之前那是一次**不可逆**的丢信息：
 * 被替换的消息从窗口与 `SessionState.messages` 里消失，模型再也没有通道看到它们。
 * 真实现场：一次重启后移除 **766** 条、只留 1441 字符摘要，请求体积 −41%，模型永远失去
 * 那 766 条。
 *
 * 现在压缩那一刻会写下**索引**（被替换消息的 seq 区间 + 摘要指纹 + 前后体积），并在摘要
 * 正文末尾留一条 `[compacted] …` stub 告诉模型「这段可以读回来」。本工具就是那个读回入口：
 *
 * - **无参** ⇒ 列出这条会话有哪些压缩段（id / 原因 / 条数 / seq 区间 / 摘要首行），让模型
 *   先知道有什么可读，不必猜；
 * - `compaction_id`（或 `from_seq` + `to_seq`）⇒ 返回**原始消息**（不是摘要），一页有界
 *   （≤ 200 条 / ≤ 16k token，先到者先停），用 `offset` 翻页；
 * - `query` ⇒ 只回命中的消息（子串，不分大小写）。
 *
 * ## 三条纪律（与这个插件的存在理由绑在一起）
 *
 * 1. **不是读文件**：它读的是**本会话被压缩掉的历史**（会话目录里的时间线 + 压缩索引），
 *    参数是压缩段 / seq 区间，不是路径。工具描述写清楚了 —— 否则模型会拿它当 `read`；
 * 2. **有界**：单次 ≤ 200 条、≤ 16k token、≤ 20000 事件扫描，三条上界都写在输出里；
 *    范围读不可判时**如实报降级**，不静默少给（少给 = 模型以为读全了）；
 * 3. **不猜**：这条会话没有索引 ⇒ 明说「没有压缩索引」，并说明可以用
 *    `deriveCompactionIndex` 重建；不编内容、不拿摘要冒充原文。
 *
 * 机制在 core（`context/compaction-index.ts` 写、`session/compaction-recall.ts` 读），
 * 这里只做「工具」这一层（宪法第十三条）。
 */

import * as os from 'node:os';
import { join } from 'node:path';
import {
  type Plugin,
  type PluginHost,
  readCompactionIndex,
  type ToolContext,
  type ToolDefinition,
} from '@vessel-agent/core';
import { RECALL_PLUGIN_NAME, resolveRecallConfig } from './config.js';
import { parseRecallArgs, recallIndexList } from './tool.js';

export type { RecallConfig } from './config.js';
export { parseRecallConfig, RECALL_PLUGIN_NAME, resolveRecallConfig } from './config.js';
export {
  formatIndexList,
  formatRecallPage,
  MAX_MESSAGE_CHARS,
  parseRecallArgs,
  RECALL_PAGE_LIMIT,
  type RecallArgs,
  recallIndexList,
} from './tool.js';

/** 安装选项（与 `install(host, { config })` 的 config 同形）。 */
export interface RecallPluginOptions {
  config?: Record<string, unknown>;
}

/**
 * 工具描述（**只描述事实**：读什么、给什么、上限多少）。
 *
 * 开头一句就把「不是读文件」讲死：模型最容易犯的错是把它当 `read` 用（参数是路径）。
 */
const RECALL_DESCRIPTION =
  'Read back conversation history that compaction replaced with a summary - this session only, ' +
  'NOT files. No arguments: list the compaction segments of this session (id, reason, message ' +
  'count, seq ranges, summary head). With compaction_id (or from_seq/to_seq): return the ORIGINAL ' +
  'messages, one line each, paged with offset/limit (at most 200 messages and 16k tokens per call). ' +
  'Optional query filters messages by substring.';

/** 默认数据目录（与 `resolveDataDir` 的缺省一致：`~/.vessel/data`）。 */
function defaultDataDir(): string {
  return join(os.homedir(), '.vessel', 'data');
}

/** 构造 `recall` 工具（数据目录在安装期钉死：不随单次调用变）。 */
export function createRecallTool(config: { sessionsDir: string }): ToolDefinition {
  return {
    name: 'recall',
    description: RECALL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        compaction_id: {
          type: 'number',
          description:
            'Which compacted segment to read (1-based; call recall with no arguments to list them)',
        },
        from_seq: { type: 'number', description: 'First event seq of a raw range (1-based)' },
        to_seq: { type: 'number', description: 'Last event seq of a raw range (inclusive)' },
        offset: { type: 'number', description: 'Skip this many messages inside the segment' },
        limit: { type: 'number', description: 'Max messages to return (capped at 200)' },
        query: { type: 'string', description: 'Only return messages whose text contains this' },
      },
    },
    display: { label: 'Recall', kind: 'search' },
    // 只读本会话历史：不写任何东西、不读路径参数，没有需要用户确认的副作用。
    checkPermission: async () => 'allow',
    handler: async (args: unknown, ctx: ToolContext): Promise<string> =>
      handleRecall(args, config.sessionsDir, ctx.session_id),
  };
}

/**
 * 工具 handler 的可测内核（与 `ToolContext` 解耦：只需要 session id）。
 *
 * 单独抽出来是为了让驱动脚本 / 探针能直接调用（不必装配整条 tool pipeline）。
 */
export async function handleRecall(
  args: unknown,
  sessionsDir: string,
  sessionId?: string,
): Promise<string> {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return 'recall: no session id in this context (recall reads the current session only)';
  }
  const raw = args === undefined || args === null ? {} : args;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return 'recall: arguments must be an object (compaction_id / from_seq / to_seq / offset / limit / query)';
  }
  const parsed = parseRecallArgs(raw as Record<string, unknown>);
  if (typeof parsed === 'string') return parsed;
  const index = await readCompactionIndex(join(sessionsDir, sessionId));
  return recallIndexList({ sessionsDir, sessionId, index, args: parsed });
}

/** 构造插件实例。 */
export function createRecallPlugin(options: RecallPluginOptions = {}): Plugin {
  return {
    name: RECALL_PLUGIN_NAME,
    version: '0.56.0',
    description: 'Read back compaction-replaced history by index (`recall` tool)',
    install(host: PluginHost, installOptions?: { config?: Record<string, unknown> }): void {
      const config = resolveRecallConfig(
        installOptions?.config ?? options.config,
        defaultDataDir(),
      );
      if (!config.enabled) return;
      host.registerTool(createRecallTool(config));
    },
  };
}

/** 默认插件实例（无配置；装配层可经 `pluginConfigs['recall']` 透传 `data_dir`）。 */
export const recallPlugin: Plugin = createRecallPlugin();

export default recallPlugin;
