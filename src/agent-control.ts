/**
 * AgentService → canonical `agents.*` / `sessions.*` 控制面适配（0.25 / CREATE-0.39）。
 *
 * 只做形状映射：生命周期逻辑全部在 `@vessel-agent/agent`。批量语义直接复用
 * `AgentService.create/update/close`，因此与 owner 端点完全一致（并行、失败隔离、
 * 结果保持输入顺序）。owner 端点的后续收口应复用同一适配器，而不是另写一套。
 *
 * CREATE-0.39：`sessions.create|restart|activate` 与 `agents.create` 的 seeded 字段
 * 直接转发；错误保持 `AgentError` 形状，由 serve 的 `mapSessionControlError` /
 * `normalizeCreateFailure` 翻成冻结的 RPC 码，不在这里另造一套错误码。
 *
 * @module vessel/agent-control
 */

import { execFile } from 'node:child_process';
import type { AgentService, BatchItemResult, MemberStatus } from '@vessel-agent/agent';
import {
  type AgentCloseBatchResultLike,
  type AgentControlLike,
  type AgentCreateLikeInput,
  type AgentDispatchBatchResultLike,
  type AgentDispatchItemLike,
  type AgentDispatchLikeInput,
  type AgentLifecycleBatchResultLike,
  type AgentLifecycleFailLike,
  type AgentLifecycleItemLike,
  type AgentListLikeInput,
  type AgentSendBatchResultLike,
  type AgentSendLikeInput,
  type AgentStatusLike,
  type AgentUpdateLikeInput,
  RpcError,
  type SessionActivateLikeInput,
  type SessionActivateLikeResult,
  type SessionCreateLikeInput,
  type SessionCreateLikeResult,
  type SessionRestartLikeInput,
  type SessionRestartLikeResult,
  type SessionRestoreFilesLikeInput,
  type SessionRestoreFilesLikeResult,
} from '../packages/serve/src/index';

/** `createAgentControl` 的内部选项（不是 wire 字段）。 */
export interface AgentControlOptions {
  /**
   * CREATE-0.39 §2.1：`sessions.create{mode:'both'}` 的 git restore 需要在哪个
   * workspace 执行。缺省 = 无法解析 workspace，`restoreFiles` 返回
   * `not_supported`，不会静默跳过文件回滚。
   */
  resolveWorkspace?: (agentId: string) => Promise<string | undefined>;
}

function statusOf(status: MemberStatus): AgentStatusLike {
  return status as unknown as AgentStatusLike;
}

function failureOf(item: { error: string; code?: string }): AgentLifecycleFailLike {
  return { ok: false, code: item.code ?? 'internal', error: item.error };
}

/** 服务抛出的异常 → 逐条失败；保留稳定 code（如 team_metadata_corrupt）。 */
function failureFrom(error: unknown): AgentLifecycleFailLike {
  const code =
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'internal';
  return {
    ok: false,
    code,
    error: error instanceof Error ? error.message : String(error),
  };
}

function mapLifecycle<T>(
  results: ReadonlyArray<BatchItemResult<T>>,
  success: (status: T) => AgentLifecycleItemLike,
): AgentLifecycleBatchResultLike {
  return {
    results: results.map((item) => (item.ok ? success(item.status) : failureOf(item))),
  };
}

/** 执行一次 git；非零退出时把 stderr 摘要作为错误抛出。 */
function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        // `git: 'restore' is not a git command` 这类诊断依赖 locale；固定英文便于判定。
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      },
      (error, _stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.trim() || error.message;
          reject(new Error(detail));
          return;
        }
        resolve();
      },
    );
  });
}

/** `git restore` 子命令不可用（git < 2.23）。 */
const GIT_RESTORE_UNAVAILABLE = /(is not a git command|unknown subcommand)/i;

/** CREATE-0.39 §2.1：mode=both 的显式 git restore（在 session 切换前执行）。 */
async function restoreFilesInWorkspace(
  workspace: string,
  input: SessionRestoreFilesLikeInput,
): Promise<SessionRestoreFilesLikeResult> {
  try {
    await runGit(workspace, ['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    throw new RpcError(
      'not_supported',
      `git restore unavailable: ${workspace} is not a git work tree (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try {
    await runGit(workspace, ['rev-parse', '--verify', '--quiet', input.files.ref]);
  } catch {
    throw new RpcError('invalid_params', `invalid git ref: ${input.files.ref}`);
  }

  let restored = 0;
  let skipped = 0;
  for (const path of input.files.paths) {
    try {
      await runGit(workspace, ['restore', `--source=${input.files.ref}`, '--', path]);
      restored += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // git < 2.23 没有 `restore`：必须在改任何文件 / session 前硬失败，
      // 不得把“子命令不存在”伪装成单路径跳过。
      if (GIT_RESTORE_UNAVAILABLE.test(detail)) {
        throw new RpcError('not_supported', `git restore unavailable: ${detail}`);
      }
      // genuine 单路径失败（路径不存在 / 权限等）按 files_skipped 计数。
      skipped += 1;
    }
  }
  return { files_restored: restored, files_skipped: skipped };
}

/** 用 app 侧的 AgentService 构造注入给 gateway / owner 端点的稳定控制面。 */
export function createAgentControl(
  service: AgentService,
  tenantId: string,
  options: AgentControlOptions = {},
): AgentControlLike {
  return {
    tenantId,
    async create(inputs: AgentCreateLikeInput[]): Promise<AgentLifecycleBatchResultLike> {
      const batch = await service.create({
        members: inputs.map((input) => ({
          ...(input.id !== undefined ? { id: input.id } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.team_id !== undefined ? { teamId: input.team_id } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.system_prompt !== undefined ? { systemPrompt: input.system_prompt } : {}),
          ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
          ...(input.parent_id !== undefined ? { parentId: input.parent_id } : {}),
          ...(input.spawnedBy !== undefined ? { spawnedBy: input.spawnedBy } : {}),
          // CREATE-0.39 §1.1：seeded create（来源 session / 种子方式 / 保留边界）。
          ...(input.from_session_id !== undefined
            ? { from_session_id: input.from_session_id }
            : {}),
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
          ...(input.keep_messages !== undefined ? { keep_messages: input.keep_messages } : {}),
        })),
      });
      return mapLifecycle(batch.results, (status) => ({
        ok: true,
        agent: statusOf(status),
      }));
    },
    async update(inputs: AgentUpdateLikeInput[]): Promise<AgentLifecycleBatchResultLike> {
      const batch = await service.update({
        updates: inputs.map((input) => ({
          id: input.agent_id,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.system_prompt !== undefined ? { systemPrompt: input.system_prompt } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
          ...(input.from !== undefined ? { from: input.from } : {}),
        })),
      });
      return mapLifecycle(batch.results, (result) => ({
        ok: true,
        agent: statusOf(result.agent),
        changed: result.changed,
        ...(result.applies_to !== undefined ? { applies_to: result.applies_to } : {}),
      }));
    },
    async close(agentIds: string[]): Promise<AgentCloseBatchResultLike> {
      const batch = await service.close({ members: agentIds });
      return {
        results: await Promise.all(
          batch.results.map(async (item, index) => {
            if (!item.ok) return failureOf(item);
            const agentId = agentIds[index] ?? '';
            // close 后记录仍在注册表里（membership=left / state=closed），
            // 统一契约的 `agent` 因此仍然可读。
            const status = statusOf(
              (await service.identify(agentId)) ?? {
                id: agentId,
                session_id: agentId,
                role: 'member',
                owner: agentId,
                visibility: 'private',
                state: 'closed',
              },
            );
            return { ok: true as const, agent: status, agent_id: agentId, closed: true as const };
          }),
        ),
      };
    },
    async get(agentId: string): Promise<AgentStatusLike | undefined> {
      const status = await service.identify(agentId);
      return status === undefined ? undefined : statusOf(status);
    },
    async list(input: AgentListLikeInput = {}): Promise<AgentStatusLike[]> {
      const statuses = await service.list({
        ...(input.viewer !== undefined ? { viewer: input.viewer } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.parent_id !== undefined ? { parentId: input.parent_id } : {}),
      });
      return statuses.map(statusOf);
    },
    async resolve(target: string): Promise<AgentStatusLike | undefined> {
      const direct = await service.identify(target);
      if (direct !== undefined) return statusOf(direct);
      // dispatch 的寻址规则：唯一 present name（visibility 沿用无 viewer 的 canonical 视图）。
      const matches = (await service.list({})).filter(
        (status) => status.membership === 'present' && status.name === target,
      );
      return matches.length === 1 && matches[0] !== undefined ? statusOf(matches[0]) : undefined;
    },
    async send(inputs: AgentSendLikeInput[]): Promise<AgentSendBatchResultLike> {
      const batch = await service.send({
        messages: inputs.map((input) => ({
          to: input.to,
          content: input.content,
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.conversation_id !== undefined
            ? { conversation_id: input.conversation_id }
            : {}),
          ...(input.interrupt !== undefined ? { interrupt: input.interrupt } : {}),
          ...(input.notify !== undefined ? { notify: input.notify } : {}),
          ...(input.message_id !== undefined ? { message_id: input.message_id } : {}),
        })),
      });
      return {
        results: batch.results.map((item) => {
          if (!item.ok) return failureOf(item);
          // 0.41：SendResult 是 work/urgent（queued）与 notify（notified）的联合，
          // 按 `queued` 显式收窄；notified 分支没有 state / run，也无私服层无法
          // 提供的 resolved_to / conversation_id（SendResult 不携带，按可选缺省）。
          if (item.status.queued) {
            return {
              ok: true as const,
              queued: true as const,
              message_id: item.status.message_id,
              state: item.status.state,
            };
          }
          return {
            ok: true as const,
            notified: true as const,
            message_id: item.status.message_id,
            wake: item.status.wake,
            resolution: item.status.resolution,
          };
        }),
      };
    },
    async dispatch(inputs: AgentDispatchLikeInput[]): Promise<AgentDispatchBatchResultLike> {
      const settledResults = await Promise.allSettled(
        inputs.map((input) =>
          service.dispatch({
            to: input.to,
            content: input.content,
            ...(input.from !== undefined ? { from: input.from } : {}),
            ...(input.conversation_id !== undefined
              ? { conversation_id: input.conversation_id }
              : {}),
            ...(input.allow_auto_create !== undefined
              ? { allow_auto_create: input.allow_auto_create }
              : {}),
          }),
        ),
      );
      const results: AgentDispatchItemLike[] = settledResults.map((settledResult) => {
        if (settledResult.status === 'rejected') return failureFrom(settledResult.reason);
        const result = settledResult.value;
        if (result.status === 'rejected') {
          return { ok: false, code: result.code, error: result.reason };
        }
        // canonical `agents.dispatch` 是 work-only（CONTRACT-0.41 §2.6）：notify
        // 分支在这里不应出现，也不得伪装成 queued。明确报内部失败，不丢消息语义。
        if (result.status !== 'queued') {
          return {
            ok: false,
            code: 'internal',
            error: 'agents.dispatch is work-only: unexpected notified result',
          };
        }
        return {
          ok: true,
          status: 'queued',
          message_id: result.message_id,
          resolved_to: result.resolved_to,
          resolution: result.resolution,
          ...(result.conversation_id !== undefined
            ? { conversation_id: result.conversation_id }
            : {}),
        };
      });
      return { results };
    },
    async createSession(input: SessionCreateLikeInput): Promise<SessionCreateLikeResult> {
      return service.createSession(input);
    },
    async restartSession(input: SessionRestartLikeInput): Promise<SessionRestartLikeResult> {
      return service.restartSession(input);
    },
    async activateSession(input: SessionActivateLikeInput): Promise<SessionActivateLikeResult> {
      return service.activateSession(input);
    },
    async restoreFiles(
      input: SessionRestoreFilesLikeInput,
    ): Promise<SessionRestoreFilesLikeResult> {
      const resolveWorkspace = options.resolveWorkspace;
      if (resolveWorkspace === undefined) {
        throw new RpcError(
          'not_supported',
          'git restore unavailable: workspace resolver is not configured',
        );
      }
      const workspace = await resolveWorkspace(input.agent_id);
      if (workspace === undefined) {
        throw new RpcError(
          'not_supported',
          `git restore unavailable: no workspace for agent ${input.agent_id}`,
        );
      }
      return restoreFilesInWorkspace(workspace, input);
    },
  };
}
