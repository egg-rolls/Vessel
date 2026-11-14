/**
 * @vessel-agent/core/context 模块
 * @module @vessel-agent/core/context
 */

export type {
  ContextAnchor,
  ContextConfig,
  PromptContextFingerprint,
  WorkingContext,
} from '../types/context.js';
export {
  CONTEXT_ANCHOR_RATIO_MAX,
  CONTEXT_ANCHOR_RATIO_MIN,
  clampAnchorRatio,
  normalizeContextAnchor,
} from './anchor.js';
export {
  formatClearedToolResult,
  isClearedToolResult,
  normalizeClearedToolCallIds,
  renderContextTrimNotice,
  TRIM_ENV_DETAIL_MARK,
  TRIM_ENV_SCOPE,
  type TrimNoticeInput,
  type TrimNoticeLocale,
} from './cleared-tool-result.js';
export {
  compactMessagesForSeed,
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTokens,
  KEEP_RECENT_MAX,
  KEEP_RECENT_TOKEN_RATIO,
  MemoryWorkingContext,
  measureRetainedToolResultVolume,
  planClearedToolResults,
  shouldCompactForToolResultVolume,
  TOOL_RESULT_VOLUME_THRESHOLD_RATIO,
  type ToolResultKeepOptions,
  type ToolResultVolumeMeasurement,
  type ToolResultVolumeOptions,
  withClearedToolResults,
} from './context-manager.js';
export {
  type ContextNoticeLocale,
  renderContextOverflowNotice,
  renderSystemRevisionNotice,
} from './context-notice.js';
export {
  normalizePromptContextFingerprint,
  samePromptContext,
  shouldPublishSystemContext,
  systemContextChangesFromFingerprint,
} from './prompt-context.js';
export {
  applyReadSideMaskers,
  type MaskableMessage,
  type ReadSideMasker,
  withReadSideMask,
} from './read-side-mask.js';
export {
  BANNED_PREFIX_REASONS,
  clearedToolCallIds,
  countClearedPlaceholders,
  diffRequestSequence,
  isPrefixSequence,
  isSegmentBoundaryCause,
  isSegmentBoundaryKind,
  NON_PAYLOAD_FIELDS,
  type NonPayloadField,
  PAYLOAD_FIELDS,
  type PayloadField,
  type ProjectionProblem,
  type ProviderPayloadMessage,
  type ProviderPayloadToolCall,
  projectionProblems,
  type RequestSequenceDiff,
  type RequestSequenceDiffKind,
  SEGMENT_BOUNDARY_KINDS,
  SEGMENT_CAUSE_RECORD_EVENTS,
  SEGMENT_KIND_BY_CAUSE,
  SEGMENT_KIND_BY_PREFIX_REASON,
  SEGMENT_NEW_CAUSES,
  SEGMENT_POP_CAUSES,
  type SegmentBoundaryCause,
  type SegmentBoundaryKind,
  segmentRecordEvents,
  toProviderPayload,
} from './request-sequence.js';
export { createSessionBreaker } from './session-breaker.js';
