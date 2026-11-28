/**
 * 用户配置文件读写原语（model-registry P1 前置重构，自 src/ui-settings.ts 移入）。
 *
 * 读写 `~/.vessel/config.yaml` 的 YAML 根对象：parse/stringify、同目录临时文件 + rename、
 * 0600；调用方只改目标块，根对象与目标块的其它键保留。写侧经 yaml Document API 对账，
 * 既有 YAML 注释 / 锚点 / 键序保留（值未变的节点原样不动）；文件不可解析时回退全量 stringify。
 * 错误码逐字保留 `ui_settings_*` 前缀（既有 CLI / TUI 消费者按这些码匹配）。
 * 跨进程写锁见 `./config-lock.ts`（withConfigLock），包裹「读 → 改 → 写」。
 *
 * @module @vessel-agent/config
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  type Document,
  isMap,
  isScalar,
  parseDocument,
  parse as parseYaml,
  stringify as stringifyYaml,
  type YAMLMap,
} from 'yaml';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读取 YAML 根对象；不存在/空文档返回 {}；根不是对象时抛错 */
export async function readUserConfigRoot(configPath: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`ui_settings_read_failed: ${configPath}: ${messageOf(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    // 不回显文件内容（可能含密钥）。
    throw new Error(`ui_settings_parse_failed: ${configPath}: ${messageOf(error)}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) {
    throw new Error(`ui_settings_invalid_config: ${configPath} must contain a YAML object`);
  }
  return parsed;
}

/** YAML 键的字符串口径（与 parse → JS 对象键一致：数字/布尔键转字符串） */
function keyStringOf(key: unknown): string {
  return isScalar(key) ? String(key.value) : String(key);
}

/** 深比较（YAML core schema 值域：原始值 / 数组 / 普通对象；NaN 视为相等） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
    );
  }
  return false;
}

/**
 * 把目标 root 对账进既有 YAMLMap：值深相等的键原样保留（节点 / 注释 / 锚点不动），
 * 变化的键就地替换值节点（键节点及其前置注释保留），缺失的键删除，新增的键追加。
 * 两侧都是对象时递归下钻，只动真正变化的叶子。
 */
function reconcileMap(
  doc: Document,
  map: YAMLMap,
  desired: Record<string, unknown>,
  current: Record<string, unknown>,
): void {
  for (const pair of [...map.items]) {
    if (!Object.hasOwn(desired, keyStringOf(pair.key))) {
      map.delete(pair.key);
    }
  }
  for (const [key, value] of Object.entries(desired)) {
    const pair = map.items.find((p) => keyStringOf(p.key) === key);
    const actualKey = pair ? pair.key : key;
    const cur = Object.hasOwn(current, key) ? current[key] : undefined;
    if (pair && deepEqual(cur, value)) continue;
    if (isRecord(value) && pair && isMap(pair.value) && isRecord(cur)) {
      reconcileMap(doc, pair.value, value, cur);
    } else {
      // 传原始值（勿预先 createNode）：yaml 对标量覆盖会保留旧节点及其行尾注释/锚点，
      // 新值在 stringify 时经 doc.createNode 转换。
      map.set(actualKey, value);
    }
  }
}

/**
 * 注释保留渲染：读既有文件 → parseDocument → 对账 → toString。
 * 文件不存在 / 解析失败 / 根不是对象时返回 null，调用方回退全量 stringify（旧行为）。
 * 调用方均持 withConfigLock，读-改-写无竞态。
 */
async function renderPreservingComments(
  target: string,
  root: Record<string, unknown>,
): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(target, 'utf-8');
  } catch {
    return null; // 不存在或不可读：无注释可保留
  }
  const doc = parseDocument(content);
  if (doc.errors.length > 0) return null;
  if (doc.contents === null || doc.contents === undefined) {
    // 空文档（可能只有注释）：建空 map 再对账，文档级注释保留。
    // createNode 返回 Created 型（range 可缺），contents 需 Parsed 型，此处断言桥接。
    const empty = doc.createNode({}) as YAMLMap.Parsed;
    doc.contents = empty;
    reconcileMap(doc, empty, root, {});
    return doc.toString({ lineWidth: 0 });
  }
  if (!isMap(doc.contents)) return null;
  const current = doc.toJS();
  if (!isRecord(current)) return null;
  reconcileMap(doc, doc.contents, root, current);
  return doc.toString({ lineWidth: 0 });
}

/** 原子写入（同目录临时文件 + rename）；保留文件其它内容与既有 YAML 注释 */
export async function writeUserConfigRoot(
  configPath: string,
  root: Record<string, unknown>,
): Promise<void> {
  // 绝对路径化（D-3）：UI project 层经 config.set scope=project 传入相对路径
  // （loadConfig 缺省 'vessel.yaml'），dirname 得 '.'，Windows 上 mkdir('.')
  // 即使 recursive 也恒抛 EEXIST。resolve 基于 cwd，与读侧 loadRawConfig 及
  // withConfigLock（path.resolve(lockPath)）同口径；绝对路径入参逐字不变。
  const target = path.resolve(configPath);
  await mkdir(path.dirname(target), { recursive: true });
  const body =
    (await renderPreservingComments(target, root)) ?? stringifyYaml(root, { lineWidth: 0 });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, body, { encoding: 'utf-8', mode: 0o600 });
  try {
    await rename(tmp, target);
  } catch (error) {
    // Windows 上目标被占用时 rename 可能失败：清理临时文件后显式替换。
    try {
      await unlink(tmp);
    } catch {
      // 忽略清理失败
    }
    try {
      await writeFile(target, body, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      throw new Error(`ui_settings_write_failed: ${target}: ${messageOf(error)}`);
    }
  }
  // POSIX：rename 后保持 0600；Windows 上 best-effort。
  await chmod(target, 0o600).catch(() => {
    // 平台不保证 mode：忽略
  });
}
