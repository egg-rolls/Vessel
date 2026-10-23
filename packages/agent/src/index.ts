/**
 * @vessel-agent/agent - Agent 能力层（唯一实现）
 * @module @vessel-agent/agent
 *
 * 负责成员 registry、生命周期、消息队列、回复投递、可见性与快照。
 * 不负责 UI / 传输 / provider / 工具 schema；执行内核由 MemberRuntimePort 注入。
 */

export {
  canTransition,
  type MemberRecord,
  MemberRegistry,
  toMemberStatus,
  toPersistedRecord,
  toRuntimeMember,
} from './registry.js';
export {
  createInProcessMemberRuntime,
  InProcessMemberRuntime,
  type InProcessMemberRuntimeOptions,
  type MemberRunnableAgent,
  type MemberRuntimePermissionMode,
} from './runtime.js';
export { AgentServiceImpl, createAgentService } from './service.js';
export {
  AGENT_SNAPSHOT_VERSION,
  type AgentSnapshotFile,
  AgentSnapshotStore,
  snapshotPath,
} from './snapshot.js';
export { type AgentToolOptions, createAgentTool } from './tool.js';
export {
  type AgentBodyPointer,
  AgentError,
  type AgentErrorCode,
  type AgentEvent,
  type AgentEventListener,
  type AgentMessage,
  type AgentService,
  type AgentServiceOptions,
  type AgentSnapshotOptions,
  type AttachOwnerInput,
  type BatchItemResult,
  type BatchResult,
  type CloseBatchInput,
  type CloseInput,
  type CloseResult,
  DEFAULT_OWNER,
  type DispatchInput,
  type DispatchResult,
  type ListFilter,
  MAX_MESSAGE_BYTES,
  type MemberMembership,
  type MemberPermissionState,
  type MemberPresence,
  type MemberRotation,
  type MemberRuntimeMember,
  type MemberRuntimePort,
  type MemberState,
  type MemberStatus,
  type MemberTurnResult,
  type MemberVisibility,
  type NewBatchInput,
  type NewMemberInput,
  type PermissionBridge,
  type PermissionDecision,
  type PermissionRequestInput,
  type PersistedAgentRecord,
  type ReplyResult,
  type SendBatchInput,
  type SendInput,
  type SendResult,
  type TurnOutcome,
} from './types.js';
