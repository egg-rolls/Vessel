/**
 * T2b（工具输出隔离击穿）：工具输出根的 env 卫生。
 *
 * 根因（金丝雀 T2 查证）：VESSEL_TOOL_OUTPUT_DIR / VESSEL_PLUGIN_CONFIG 沿启动链
 * （生产 shell → gateway → node → engine）全量继承，而 core toolOutputRoot() 让显式
 * VESSEL_TOOL_OUTPUT_DIR 优先于 VESSEL_DATA_DIR —— 17d6f44c 只桥接 VESSEL_DATA_DIR
 * 挡不住继承的生产根，金丝雀舰队的工具输出落进生产数据根。
 *
 * 修复语义 = 「各舰队按自己 dataDir 派生」，不是全局清除：只重写落在本舰队 dataDir
 * **之外**的值（继承来的异根）；dataDir 之内的值（含生产舰队自身的正确根、舰队内
 * 显式自定义目录）原样保留 → 生产零回归。
 */
import * as path from 'node:path';

/** `<dataDir>/tool-output` —— 与 core toolOutputRoot() 的 VESSEL_DATA_DIR 分支同派生式。 */
export function deriveToolOutputDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'tool-output');
}

/** child 是否落在 parent 之内（含相等）；`..` 逃逸或跨盘绝对路径都算之外。 */
function isWithinDir(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * 把 env 里指向异根的工具输出 env 重写为本舰队派生值（原地修改；传 process.env
 * 或 spawn env 副本均可）。
 * - VESSEL_TOOL_OUTPUT_DIR：非空且落在 dataDir 之外 → `<dataDir>/tool-output`；之内保留。
 * - VESSEL_PLUGIN_CONFIG：JSON 对象时把指向 dataDir 之外的 dataDir / toolOutputDir
 *   字段重写为本舰队 dataDir / 派生根，其余字段不动；解析失败或非对象 → 清除该 env
 *   （任何消费方都无法使用它，透传只会传播垃圾；不猜内容）。
 */
export function sanitizeToolOutputEnv(
  env: Record<string, string | undefined>,
  dataDir: string,
): void {
  const root = path.resolve(dataDir);
  const derived = deriveToolOutputDir(root);

  const explicit = env.VESSEL_TOOL_OUTPUT_DIR;
  if (typeof explicit === 'string' && explicit.trim() !== '' && !isWithinDir(root, explicit)) {
    env.VESSEL_TOOL_OUTPUT_DIR = derived;
  }

  const raw = env.VESSEL_PLUGIN_CONFIG;
  if (typeof raw !== 'string' || raw.trim() === '') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    delete env.VESSEL_PLUGIN_CONFIG;
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    delete env.VESSEL_PLUGIN_CONFIG;
    return;
  }
  const record = parsed as Record<string, unknown>;
  let changed = false;
  const cfgDataDir = record.dataDir;
  if (
    typeof cfgDataDir === 'string' &&
    cfgDataDir.trim() !== '' &&
    !isWithinDir(root, cfgDataDir)
  ) {
    record.dataDir = root;
    changed = true;
  }
  const cfgOutputDir = record.toolOutputDir;
  if (
    typeof cfgOutputDir === 'string' &&
    cfgOutputDir.trim() !== '' &&
    !isWithinDir(root, cfgOutputDir)
  ) {
    record.toolOutputDir = derived;
    changed = true;
  }
  if (changed) env.VESSEL_PLUGIN_CONFIG = JSON.stringify(record);
}
