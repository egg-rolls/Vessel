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
export { formatClearedToolResult, isClearedToolResult } from './cleared-tool-result.js';
export {
  compactMessagesForSeed,
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTokens,
  MemoryWorkingContext,
  planClearedToolResults,
  withClearedToolResults,
} from './context-manager.js';
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
  type NonPayloadField,
  NON_PAYLOAD_FIELDS,
  type PayloadField,
  PAYLOAD_FIELDS,
  type ProjectionProblem,
  projectionProblems,
  type ProviderPayloadMessage,
  type ProviderPayloadToolCall,
  type RequestSequenceDiff,
  type RequestSequenceDiffKind,
  segmentRecordEvents,
  SEGMENT_BOUNDARY_KINDS,
  type SegmentBoundaryCause,
  type SegmentBoundaryKind,
  SEGMENT_CAUSE_RECORD_EVENTS,
  SEGMENT_KIND_BY_CAUSE,
  SEGMENT_KIND_BY_PREFIX_REASON,
  SEGMENT_NEW_CAUSES,
  SEGMENT_POP_CAUSES,
  toProviderPayload,
} from './request-sequence.js';
export { createSessionBreaker } from './session-breaker.js';
