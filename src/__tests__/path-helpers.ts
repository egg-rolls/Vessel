import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Windows CI 的临时目录可能返回 8.3 短路径（RUNNER~1），
 * 与 resolver 返回的长路径（runneradmin）指向同一文件但字符串不等。
 * `realpathSync.native` 统一成长路径；文件不存在时退回 `path.resolve`。
 */
export function canonicalPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}
