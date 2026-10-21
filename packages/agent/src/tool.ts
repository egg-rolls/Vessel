/**
 * 内置 `agent` 工具：模型侧唯一的成员生命周期入口。
 *
 * 只做参数映射与错误码格式化；registry、生命周期、批次并行都在 AgentService。
 * 不提供 wait / inbox / status / cancel——等待语义是结束这一轮、回复作为新 turn 到达。
 *
 * @module @vessel-agent/agent
 */

import type { ToolDefinition } from '@vessel-agent/core';
import {
  AgentError,
  type AgentService,
  type CloseInput,
  DEFAULT_OWNER,
  type ListFilter,
  type MemberState,
  type MemberVisibility,
  type NewMemberInput,
  type SendInput,
} from './types.js';

const ACTIONS = ['new', 'send', 'close', 'list'] as const;

const VISIBILITIES: readonly MemberVisibility[] = ['private', 'team', 'tenant'];

const MEMBER_STATES: readonly MemberState[] = [
  'created',
  'idle',
  'running',
  'waiting_permission',
  'completed',
  'failed',
  'cancelled',
  'closed',
  'stale',
];

/** 与 AgentService 一致：对象且不是数组 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(message: string): AgentError {
  return new AgentError('invalid_input', message);
}

/** 错误串形状固定；AgentError.message 已带 code 前缀时去重 */
function errorResult(error: unknown): string {
  if (!(error instanceof AgentError)) {
    return `Error: invalid_input: ${errorText(error)}`;
  }
  const prefix = `${error.code}: `;
  const message = error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : error.message;
  return `Error: ${error.code}: ${message}`;
}

/** 单条字段与 batch 字段不能同时给 */
function assertExclusive(
  record: Record<string, unknown>,
  singles: readonly string[],
  batch: string,
  action: string,
): void {
  if (record[batch] === undefined) return;
  if (singles.some((key) => record[key] !== undefined)) {
    throw invalid(`${action}: pass either single ${singles.join('/')} or ${batch}, not both`);
  }
}

/** 读取 batch 数组参数；非数组或空数组直接拒绝 */
function readBatch(record: Record<string, unknown>, key: string, action: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw invalid(`${action}: ${key} must be an array`);
  if (value.length === 0) throw invalid(`${action}: ${key} must not be empty`);
  return value;
}

/**
 * 只拷已知键并转 camelCase。
 * 值不做类型校验：batch 要由 AgentService 逐条拒绝，不能在映射阶段整批抛错。
 */
function mapNew(record: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (record.name !== undefined) input.name = record.name;
  if (record.model !== undefined) input.model = record.model;
  if (record.system_prompt !== undefined) input.systemPrompt = record.system_prompt;
  if (record.visibility !== undefined) input.visibility = record.visibility;
  return input;
}

/** 非对象条目原样交给 service，由它逐条拒绝 */
function mapNewEntry(entry: unknown): unknown {
  return isRecord(entry) ? mapNew(entry) : entry;
}

/** `from` 不暴露：工具调用者恒为 owner，模型不能伪造发送者 */
function mapSend(record: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (record.to !== undefined) input.to = record.to;
  if (record.content !== undefined) input.content = record.content;
  return input;
}

function mapSendEntry(entry: unknown): unknown {
  return isRecord(entry) ? mapSend(entry) : entry;
}

function readVisibility(value: unknown): MemberVisibility {
  if (typeof value !== 'string' || !VISIBILITIES.includes(value as MemberVisibility)) {
    throw invalid(`invalid visibility "${String(value)}" (expected private|team|tenant)`);
  }
  return value as MemberVisibility;
}

function readState(value: unknown): MemberState {
  if (typeof value !== 'string' || !MEMBER_STATES.includes(value as MemberState)) {
    throw invalid(`invalid state "${String(value)}"`);
  }
  return value as MemberState;
}

/** 构造内置 `agent` 工具；生命周期全部委托给 AgentService */
export function createAgentTool(service: AgentService): ToolDefinition {
  return {
    name: 'agent',
    description:
      'Long-lived member lifecycle tool for this agent. ' +
      'action=new creates member(s) that keep their own session and returns the created member; ' +
      'action=send queues a message to a member and returns immediately; ' +
      'action=close releases member(s) (idempotent); action=list returns the roster. ' +
      'Batch: new/close accept `members` and send accepts `messages`; entries run in ' +
      'parallel and return {results:[...]} in input order, each entry either its result ' +
      'or an error. ' +
      'A failed entry does not abort the others; do not mix single fields with a batch.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: 'new | send | close | list',
        },
        name: { type: 'string', description: 'new: display name' },
        model: { type: 'string', description: 'new: model override' },
        system_prompt: { type: 'string', description: 'new: optional system prompt' },
        visibility: {
          type: 'string',
          enum: [...VISIBILITIES],
          description: 'new: visibility (default private); list: filter by visibility',
        },
        members: {
          type: 'array',
          description:
            'new: [{name?, model?, system_prompt?, visibility?}]; close: [member id or session id]',
        },
        to: { type: 'string', description: 'send: member id or session id' },
        content: { type: 'string', description: 'send: message text' },
        messages: { type: 'array', description: 'send: [{to, content}]' },
        member: { type: 'string', description: 'close: member id or session id' },
        state: {
          type: 'string',
          enum: [...MEMBER_STATES],
          description: 'list: filter by member state',
        },
        parent_id: { type: 'string', description: 'list: filter by parent member id' },
      },
      required: ['action'],
    },
    handler: async (args: unknown): Promise<string> => {
      try {
        const record = isRecord(args) ? args : {};
        const action = record.action;

        if (action === 'new') {
          if (record.members !== undefined) {
            assertExclusive(
              record,
              ['name', 'model', 'system_prompt', 'visibility'],
              'members',
              'new',
            );
            const entries = readBatch(record, 'members', 'new').map(mapNewEntry);
            const result = await service.new({
              members: entries as unknown as NewMemberInput[],
            });
            return JSON.stringify(result);
          }
          return JSON.stringify(await service.new(mapNew(record) as unknown as NewMemberInput));
        }

        if (action === 'send') {
          if (record.messages !== undefined) {
            assertExclusive(record, ['to', 'content'], 'messages', 'send');
            const entries = readBatch(record, 'messages', 'send').map(mapSendEntry);
            const result = await service.send({
              messages: entries as unknown as SendInput[],
            });
            return JSON.stringify(result);
          }
          return JSON.stringify(await service.send(mapSend(record) as unknown as SendInput));
        }

        if (action === 'close') {
          if (record.members !== undefined) {
            assertExclusive(record, ['member'], 'members', 'close');
            const members = readBatch(record, 'members', 'close') as string[];
            return JSON.stringify(await service.close({ members }));
          }
          const input: CloseInput = {};
          if (record.member !== undefined) input.member = record.member as string;
          return JSON.stringify(await service.close(input));
        }

        if (action === 'list') {
          // private 成员只有 owner 可见；工具调用者就是 owner
          const filter: ListFilter = { viewer: DEFAULT_OWNER };
          if (record.visibility !== undefined) {
            filter.visibility = readVisibility(record.visibility);
          }
          if (record.state !== undefined) filter.state = readState(record.state);
          if (record.parent_id !== undefined) {
            if (typeof record.parent_id !== 'string' || record.parent_id === '') {
              throw invalid('parent_id must be a non-empty string');
            }
            filter.parentId = record.parent_id;
          }
          return JSON.stringify(await service.list(filter));
        }

        throw invalid(`unknown action "${String(action)}" (expected ${ACTIONS.join('|')})`);
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
