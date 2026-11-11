/**
 * @vessel-agent/media - 外部 CLI 探测
 * @module @vessel-agent/media/binaries
 *
 * 只做**存在性检测**，不执行、不安装、不新增 npm 依赖（契约 §4）：
 * 显式路径走 stat 检查；裸命令名按 PATH + PATHEXT（Windows）查找。
 * 探测失败 = 后端不可用，install 时据此决定是否注册工具（零 token 税）。
 */

import { accessSync, constants, statSync } from 'node:fs';
import * as path from 'node:path';

/** 单条命令是否可执行 */
function isExecutable(target: string): boolean {
  try {
    if (!statSync(target).isFile()) return false;
    if (process.platform === 'win32') return true;
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析命令到绝对路径；找不到返回 undefined。
 * @param command 绝对 / 相对路径或裸命令名
 * @param env 环境（测试可注入 PATH）
 */
export function resolveCommand(
  command: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const trimmed = command.trim();
  if (trimmed === '') return undefined;

  const looksLikePath =
    path.isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes(path.sep);
  if (looksLikePath) {
    const resolved = path.resolve(trimmed);
    return isExecutable(resolved) ? resolved : undefined;
  }

  const pathValue = env.PATH ?? env.Path ?? '';
  if (pathValue === '') return undefined;
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((ext) => ext !== '')
      : [''];

  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.trim() === '') continue;
    for (const ext of exts) {
      const candidate = path.join(dir, trimmed + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** 探测到的后端能力（安装期固定） */
export interface MediaBackends {
  /** pdftotext 绝对路径（PDF 抽文本） */
  pdftotext?: string;
  /** tesseract 绝对路径（图片 OCR） */
  tesseract?: string;
  /** 多模态描述桥（由装配层注入；缺省 = 未配置多模态模型） */
  describe: boolean;
}

/** 探测后端；未探测到的能力不列入 */
export function detectBackends(
  config: { pdftotext: string; tesseract: string; describe: boolean },
  env: Record<string, string | undefined> = process.env,
): MediaBackends {
  const pdftotext = resolveCommand(config.pdftotext, env);
  const tesseract = resolveCommand(config.tesseract, env);
  return {
    ...(pdftotext !== undefined ? { pdftotext } : {}),
    ...(tesseract !== undefined ? { tesseract } : {}),
    describe: config.describe,
  };
}

/** 是否至少有一个后端可用（决定是否注册工具） */
export function hasAnyBackend(backends: MediaBackends): boolean {
  return backends.pdftotext !== undefined || backends.tesseract !== undefined || backends.describe;
}
