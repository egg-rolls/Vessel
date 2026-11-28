/**
 * `vessel permission show [--member <id>] [--json]`（AX 自服务 · 自观组）。
 *
 * 有效权限矩阵一屏：工具 × (auto/ask/never) + scoped 键（tool.action）+ 规则快照
 * （auto_approve / never_auto_approve / bridge_deny）+ 默认判定。
 *
 * 缺省 = 调用者自身权限：CLI 上下文是人类管理面（operator），即节点级矩阵；
 * `--member` 指定本舰队成员（服务端只认本节点 AgentService —— 跨舰队 id 解析
 * 不出 ⇒ not_found）。授权由 gateway RPC 权限链判定，本命令不绕过。
 *
 * 只读包装 `permissions.show`（additive 只读面），不改任何规则。
 * 不 bootstrap、不获取 tenant 写锁、不输出 token / 密钥。
 *
 * @module vessel/permission-show-command
 */

import { t } from '../../../i18n';
import { RpcClientError } from '../../../rpc';
import {
  type ControlPlaneTarget,
  type ControlPlaneTargetOptions,
  resolveControlPlaneTarget,
} from '../../control-plane-target';
import { ui } from '../../output';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PermissionShowCommandOptions extends ControlPlaneTargetOptions {
  json?: boolean;
  /** 本舰队成员 id；缺省 = 调用者自身（节点级矩阵）。 */
  member?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function sourceView(target: ControlPlaneTarget): Record<string, unknown> {
  return {
    kind: target.kind,
    url: target.baseUrl,
    ...(target.instance !== undefined ? { instance: target.instance } : {}),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** 政策三档的着色（auto=ok / ask=warn / never=err）。 */
function policyText(policy: string): string {
  if (policy === 'auto') return ui.ok(policy);
  if (policy === 'never') return ui.err(policy);
  return ui.warn(policy);
}

/**
 * `vessel permission show`：人类输出走海洋绿样式，`--json` 纯 JSON（无 ANSI）。
 */
export async function permissionShowCommand(
  options: PermissionShowCommandOptions = {},
): Promise<CommandResult> {
  const json = options.json === true;
  const member = options.member?.trim() || undefined;

  const resolved = await resolveControlPlaneTarget(options);
  if (!resolved.ok) {
    return { exitCode: 1, stdout: '', stderr: resolved.error };
  }
  const target = resolved.target;

  let result: unknown;
  try {
    result = await target.request('permissions.show', {
      ...(member !== undefined ? { member_id: member } : {}),
    });
  } catch (error) {
    if (error instanceof RpcClientError && error.code === 'not_found') {
      return {
        exitCode: 1,
        stdout: '',
        stderr: t('permissionShow.memberNotFound', { id: member ?? '-' }),
      };
    }
    if (error instanceof RpcClientError && error.code === 'not_supported') {
      return { exitCode: 1, stdout: '', stderr: t('permissionShow.notAvailable') };
    }
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await target.close().catch(() => undefined); // benign: 探针客户端关闭，失败不掩盖结果。
  }

  const record = isRecord(result) ? result : undefined;
  if (record === undefined) {
    return { exitCode: 1, stdout: '', stderr: t('permissionShow.notAvailable') };
  }
  const rules = isRecord(record.rules) ? record.rules : undefined;
  const tools = Array.isArray(record.tools) ? record.tools.filter(isRecord) : [];
  const scoped = Array.isArray(record.scoped) ? record.scoped.filter(isRecord) : [];
  const memberView = isRecord(record.member) ? record.member : undefined;
  const defaultDecision = pickString(record, 'default') ?? '-';
  const autoApprove = stringList(rules?.auto_approve);
  const neverApprove = stringList(rules?.never_auto_approve);
  const bridgeDeny = stringList(rules?.bridge_deny);

  if (json) {
    const payload = { ...record, source: sourceView(target) };
    return { exitCode: 0, stdout: JSON.stringify(payload, null, 2), stderr: '' };
  }

  const lines: string[] = [];
  lines.push(ui.title(t('permissionShow.title')));
  lines.push(ui.rule(48));
  lines.push(ui.kv(t('permissionShow.default'), defaultDecision, 12));
  if (memberView !== undefined) {
    const name = pickString(memberView, 'name') ?? pickString(memberView, 'id') ?? '-';
    const state = pickString(memberView, 'state');
    const teamId = pickString(memberView, 'team_id');
    const extras = [state, teamId !== undefined ? `team=${teamId}` : undefined]
      .filter((v) => v !== undefined)
      .join(', ');
    lines.push(ui.kv(t('permissionShow.member'), extras !== '' ? `${name} (${extras})` : name, 12));
  }
  lines.push(
    ui.kv(
      t('permissionShow.autoApprove'),
      autoApprove.length > 0 ? autoApprove.join(', ') : '-',
      12,
    ),
  );
  lines.push(
    ui.kv(
      t('permissionShow.neverApprove'),
      neverApprove.length > 0 ? neverApprove.join(', ') : '-',
      12,
    ),
  );
  if (bridgeDeny.length > 0) {
    lines.push(ui.kv(t('permissionShow.bridgeDeny'), bridgeDeny.join(', '), 12));
  }

  lines.push('');
  lines.push(ui.section(`${t('permissionShow.tools')} (${tools.length})`));
  if (tools.length === 0) {
    lines.push(`  ${ui.dim('-')}`);
  } else {
    for (const tool of tools) {
      const name = pickString(tool, 'name') ?? '(unknown)';
      const policy = pickString(tool, 'policy') ?? 'ask';
      const check = tool.has_permission_check === true ? '*' : '';
      lines.push(`  ${name.padEnd(28)} ${policyText(policy)}${check}`);
    }
    lines.push(`  ${ui.dim(t('permissionShow.checkNote'))}`);
  }

  if (scoped.length > 0) {
    lines.push('');
    lines.push(ui.section(`${t('permissionShow.scoped')} (${scoped.length})`));
    for (const entry of scoped) {
      const key = pickString(entry, 'key') ?? '(unknown)';
      const policy = pickString(entry, 'policy') ?? 'ask';
      lines.push(`  ${key.padEnd(28)} ${policyText(policy)}`);
    }
  }

  lines.push('');
  lines.push(
    ui.kv(
      t('permissionShow.source'),
      `${target.baseUrl}${target.instance !== undefined ? ` (${target.instance})` : ''}`,
      12,
    ),
  );
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
