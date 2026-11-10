/**
 * WS 广播摘要化（0.18 D7）。
 *
 * 实现已下沉到 core（0.52）：trace 落盘与广播必须用同一份摘要口径，
 * 否则「实时看到的」与「trace 里存的」会再次分叉。
 * 本文件只保留 serve 的公开出口，避免既有 import 路径变化。
 *
 * @module @vessel-agent/serve/event-summary
 */

export { BROADCAST_PREVIEW_LIMIT, summarizeBroadcastEvent } from '@vessel-agent/core';
