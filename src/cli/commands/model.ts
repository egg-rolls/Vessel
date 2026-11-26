/**
 * `vessel model ...` — model-registry 插件 canonical RPC 的 CLI 包装。
 *
 * 数据源唯一 = `plugin.model-registry.*`（与 WebUI ModelPicker / 管理页同源）；
 * 本命令不直接读写 config / 凭证文件，一切经 gateway RPC：write 方法的权限由
 * gateway 既有 token role（ROLE_RANK）判定，这里不绕。本地优先 attach 运行中的
 * gateway，或 `--connect`（与 agents / status / errors 同口径）。
 *
 * 凭证纪律（对齐 token-command 的安全约定）：
 * - credential-set 的值绝不进 argv 明文：只经 `--value-env <ENV>` / `--value-stdin` /
 *   交互式终端隐藏输入三条路；
 * - 值绝不回显：不进提示、不进输出、不进日志；credentials-list 只出元数据。
 *
 * `--json` 原样输出 RPC 结果（纯数据、无 ANSI、无包装）；人类可读输出走 ui + i18n，
 * 数据行保持英文。test 发真实请求：人类模式在发请求前向 stderr 提示成本。
 *
 * @module vessel/commands/model
 */

import { t } from '../../i18n';
import { RpcClientError } from '../../rpc';
import type { ModelCommand } from '../args';
import {
  type ControlPlaneTarget,
  type ControlPlaneTargetOptions,
  resolveControlPlaneTarget,
} from '../control-plane-target';
import { ui } from '../output';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ModelCommandOptions = ControlPlaneTargetOptions;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// ── credential-set 的值来源（值只进 RPC params，绝不进输出）──────────────

/**
 * 交互式隐藏输入（仅 TTY）：raw mode 逐字符读，不回显（连 * 都不打）；
 * Enter / Ctrl+D 提交，Ctrl+C 中止，Backspace 删除，escape 序列（方向键等）整段忽略。
 * 提示走 stderr，stdout 保持干净给命令结果。
 */
async function promptHiddenSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    let escSeq = false;
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('error', onError);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (escSeq) {
          // CSI / SS3 序列到字母或 ~ 结束；中间字节整段忽略。
          if (/[A-Za-z~]/.test(ch)) escSeq = false;
          continue;
        }
        const code = ch.codePointAt(0) ?? 0;
        if (code === 27) {
          escSeq = true;
          continue;
        }
        if (code === 13 || code === 10 || code === 4) {
          cleanup();
          resolve(value);
          return;
        }
        if (code === 3) {
          cleanup();
          reject(new Error(t('model.secretAborted')));
          return;
        }
        if (code === 127 || code === 8) {
          value = value.slice(0, -1);
          continue;
        }
        if (code < 32) continue; // 其余控制字符不收
        value += ch;
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stdin.on('data', onData);
    stdin.on('error', onError);
  });
}

type SecretSource = { ok: true; value: string | undefined } | { ok: false; error: string };

/**
 * 值来源（解析层已保证 --value-env / --value-stdin 互斥）：
 * env 引用 → stdin 全文 → TTY 隐藏输入（空输入 = 不改值）→ 非 TTY 无 flag = 只写元数据。
 * 返回值只进 RPC params；任何分支都不把值写进输出。
 */
async function resolveCredentialValue(
  command: Extract<ModelCommand, { kind: 'credential-set' }>,
  env: Record<string, string | undefined>,
): Promise<SecretSource> {
  if (command.valueEnv !== undefined) {
    const value = env[command.valueEnv];
    if (value === undefined || value.trim() === '') {
      return { ok: false, error: t('model.secretEnvEmpty', { name: command.valueEnv }) };
    }
    return { ok: true, value };
  }
  if (command.valueStdin) {
    const value = (await Bun.stdin.text()).trim();
    if (value === '') return { ok: false, error: t('model.secretEmpty') };
    return { ok: true, value };
  }
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    const value = (await promptHiddenSecret(t('model.secretPrompt'))).trim();
    // 空输入 = 不改值（编辑态只写元数据）。
    return { ok: true, value: value === '' ? undefined : value };
  }
  return { ok: true, value: undefined };
}

// ── RPC 映射（kebab 命令 → canonical snake 方法）────────────────────────

function rpcCallOf(
  command: ModelCommand,
  credentialValue: string | undefined,
): { method: string; params: Record<string, unknown> } {
  const prefix = 'plugin.model-registry.';
  switch (command.kind) {
    case 'list':
      return { method: `${prefix}list`, params: {} };
    case 'set':
      return { method: `${prefix}model_set`, params: { id: command.id, entry: command.entry } };
    case 'remove':
      return { method: `${prefix}model_remove`, params: { id: command.id } };
    case 'set-default':
      return { method: `${prefix}default_set`, params: { ref: command.ref } };
    case 'credential-set':
      return {
        method: `${prefix}credential_set`,
        params: {
          id: command.id,
          baseUrl: command.baseUrl,
          ...(command.apiKeyEnv !== undefined ? { apiKeyEnv: command.apiKeyEnv } : {}),
          // 值缺省 = 不改值（编辑态只写元数据）；值只进 params，绝不进输出。
          ...(credentialValue !== undefined ? { apiKey: credentialValue } : {}),
        },
      };
    case 'credential-remove':
      return { method: `${prefix}credential_remove`, params: { id: command.id } };
    case 'credentials-list':
      return { method: `${prefix}credentials_list`, params: {} };
    case 'test':
      return {
        method: `${prefix}test`,
        params: {
          ...(command.entry !== undefined ? { entry: command.entry } : {}),
          ...(command.credential !== undefined ? { credential: command.credential } : {}),
          ...(command.provider !== undefined ? { provider: command.provider } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
        },
      };
  }
}

/** `vessel model ...`：人类输出走海洋绿样式，`--json` 原样输出 RPC 结果（无 ANSI）。 */
export async function modelCommand(
  command: ModelCommand,
  options: ModelCommandOptions = {},
): Promise<CommandResult> {
  const json = command.json;
  const env = options.env ?? process.env;

  // credential-set：先取值再连接；取值失败不建连接。值只进 RPC params。
  let credentialValue: string | undefined;
  if (command.kind === 'credential-set') {
    const secret = await resolveCredentialValue(command, env);
    if (!secret.ok) return { exitCode: 1, stdout: '', stderr: secret.error };
    credentialValue = secret.value;
  }

  const resolved = await resolveControlPlaneTarget({
    ...options,
    // test 在插件内发真实请求（15s 超时）；客户端超时必须大于它。
    ...(command.kind === 'test' ? { requestTimeoutMs: options.requestTimeoutMs ?? 30_000 } : {}),
  });
  if (!resolved.ok) return { exitCode: 1, stdout: '', stderr: resolved.error };
  const target = resolved.target;

  // test 的成本提示在发请求**前**给出（仅人类模式；--json 保持纯数据）。
  if (command.kind === 'test' && !json) {
    process.stderr.write(`${ui.warn(t('model.testCost'))}\n`);
  }

  const { method, params } = rpcCallOf(command, credentialValue);
  let result: unknown;
  try {
    result = await target.request(method, params);
  } catch (error) {
    if (
      error instanceof RpcClientError &&
      (error.code === 'not_found' || error.code === 'not_supported')
    ) {
      return { exitCode: 1, stdout: '', stderr: t('model.unavailable') };
    }
    return {
      exitCode: 1,
      stdout: '',
      stderr:
        error instanceof RpcClientError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error),
    };
  } finally {
    await target.close().catch(() => undefined);
  }

  if (json) {
    const failed = command.kind === 'test' && isRecord(result) && result.ok !== true;
    return { exitCode: failed ? 1 : 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
  }
  return renderHuman(command, result, target);
}

// ── 人类可读渲染（标题 / 空状态走 i18n；数据行英文）─────────────────────

function sourceLines(target: ControlPlaneTarget): string[] {
  const lines = [
    ui.title(t('model.title')),
    ui.rule(48),
    ui.kv(t('agents.source'), target.baseUrl, 10),
  ];
  if (target.instance !== undefined) {
    lines.push(ui.kv(t('agents.instance'), target.instance, 10));
  }
  return lines;
}

function okResult(lines: string[]): CommandResult {
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}

/** 写命令统一收尾：保存只落盘，热应用由 config-watch 完成（下一具 body/run 生效）。 */
function savedLines(summary: string): string[] {
  return [ui.ok(summary), ui.dim(t('model.savedNote'))];
}

function renderHuman(
  command: ModelCommand,
  result: unknown,
  target: ControlPlaneTarget,
): CommandResult {
  switch (command.kind) {
    case 'list':
      return renderList(result, target);
    case 'credentials-list':
      return renderCredentialsList(result, target);
    case 'test':
      return renderTest(result);
    case 'set':
      return okResult(savedLines(`model "${command.id}" saved`));
    case 'remove':
      return okResult(savedLines(`model "${command.id}" removed`));
    case 'set-default': {
      const lines = savedLines(`default model set to ${command.ref}`);
      if (isRecord(result)) {
        const effective = isRecord(result.effective) ? result.effective : undefined;
        if (effective !== undefined) {
          lines.push(
            ui.kv(
              t('model.effective'),
              `${pickString(effective, 'entryId') ?? '?'} (${pickString(effective, 'wireModel') ?? '?'})`,
              10,
            ),
          );
        }
      }
      return okResult(lines);
    }
    case 'credential-set': {
      const updatedAt = isRecord(result) ? pickString(result, 'updatedAt') : undefined;
      // 只回显 id 与时间戳，绝不回显值。
      return okResult(
        savedLines(
          `credential "${command.id}" stored${updatedAt !== undefined ? ` (${updatedAt})` : ''}`,
        ),
      );
    }
    case 'credential-remove':
      return okResult(savedLines(`credential "${command.id}" removed`));
  }
}

function formatEntry(entry: Record<string, unknown>): string {
  const parts = [pickString(entry, 'id') ?? '(unknown)'];
  const name = pickString(entry, 'name');
  if (name !== undefined && name !== parts[0]) parts.push(`wire=${name}`);
  const alias = pickString(entry, 'alias');
  if (alias !== undefined) parts.push(`alias=${alias}`);
  const provider = pickString(entry, 'provider');
  if (provider !== undefined) parts.push(`provider=${provider}`);
  const mode = pickString(entry, 'mode');
  if (mode !== undefined) parts.push(`mode=${mode}`);
  const credential = pickString(entry, 'credential');
  if (credential !== undefined) parts.push(`credential=${credential}`);
  if (entry.inUse === true) parts.push('default');
  if (entry.legacy === true) parts.push('legacy');
  return parts.join('  ');
}

function renderList(result: unknown, target: ControlPlaneTarget): CommandResult {
  const lines = sourceLines(target);
  if (!isRecord(result)) {
    lines.push('', JSON.stringify(result, null, 2));
    return okResult(lines);
  }
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const credentials = Array.isArray(result.credentials) ? result.credentials : [];
  const defaultRef = pickString(result, 'default');
  const effective = isRecord(result.effective) ? result.effective : undefined;

  if (entries.length === 0 && credentials.length === 0 && defaultRef === undefined) {
    lines.push('', ui.info(t('model.empty')));
  }
  if (credentials.length > 0) {
    lines.push('', ui.section(t('model.credentials', { count: credentials.length })));
    for (const cred of credentials) {
      if (!isRecord(cred)) {
        lines.push(`  ${JSON.stringify(cred)}`);
        continue;
      }
      const id = pickString(cred, 'id') ?? '(unknown)';
      const baseUrl = pickString(cred, 'baseUrl') ?? '-';
      const hasValue = cred.hasValue === true ? 'value-set' : 'no-value';
      lines.push(`  ${id}  baseUrl=${baseUrl}  ${hasValue}`);
    }
  }
  if (entries.length > 0) {
    lines.push('', ui.section(t('model.entries', { count: entries.length })));
    for (const entry of entries) {
      lines.push(isRecord(entry) ? `  ${formatEntry(entry)}` : `  ${JSON.stringify(entry)}`);
    }
  }
  if (defaultRef !== undefined) {
    lines.push('', ui.kv(t('model.default'), defaultRef, 10));
  }
  if (effective !== undefined) {
    lines.push(
      ui.kv(
        t('model.effective'),
        `${pickString(effective, 'entryId') ?? '?'} (${pickString(effective, 'wireModel') ?? '?'})`,
        10,
      ),
    );
  }
  if (result.legacyPresent === true) {
    lines.push('', ui.warn(t('model.legacyPresent')));
  }
  return okResult(lines);
}

/** credentials-list：只出 id / baseUrl / apiKeyEnv / hasValue / 时间戳 / usedBy 元数据，无值。 */
function renderCredentialsList(result: unknown, target: ControlPlaneTarget): CommandResult {
  const lines = sourceLines(target);
  const items = Array.isArray(result) ? result : [];
  if (items.length === 0) {
    lines.push('', ui.info(t('model.credentialsEmpty')));
    return okResult(lines);
  }
  lines.push('', ui.section(t('model.credentials', { count: items.length })));
  for (const item of items) {
    if (!isRecord(item)) {
      lines.push(`  ${JSON.stringify(item)}`);
      continue;
    }
    const id = pickString(item, 'id') ?? '(unknown)';
    const baseUrl = pickString(item, 'baseUrl') ?? '-';
    const apiKeyEnv = pickString(item, 'apiKeyEnv');
    const hasValue = item.hasValue === true ? 'value-set' : 'no-value';
    const updated = pickString(item, 'updatedAt') ?? '-';
    const usedBy = Array.isArray(item.usedBy) ? item.usedBy.map(String) : [];
    lines.push(
      `  ${id}  baseUrl=${baseUrl}${apiKeyEnv !== undefined ? `  apiKeyEnv=${apiKeyEnv}` : ''}  ${hasValue}  updated=${updated}  usedBy: ${usedBy.length > 0 ? usedBy.join(', ') : '-'}`,
    );
  }
  return okResult(lines);
}

function renderTest(result: unknown): CommandResult {
  if (!isRecord(result)) {
    return { exitCode: 1, stdout: '', stderr: t('model.testFailed') };
  }
  const latency =
    typeof result.latencyMs === 'number' && Number.isFinite(result.latencyMs)
      ? `  latency=${result.latencyMs}ms`
      : '';
  if (result.ok === true) {
    const models = Array.isArray(result.models)
      ? `  models: ${result.models.map(String).join(', ')}`
      : '';
    return okResult([ui.ok(`reachable${latency}${models}`)]);
  }
  const error = isRecord(result.error) ? result.error : undefined;
  const code = (error !== undefined ? pickString(error, 'code') : undefined) ?? 'unknown';
  const message = (error !== undefined ? pickString(error, 'message') : undefined) ?? '';
  return { exitCode: 1, stdout: '', stderr: `${code}: ${message}` };
}
