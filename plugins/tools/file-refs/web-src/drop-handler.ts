/**
 * drop 槽处理器（A2/A3）：OS 文件（拖拽 / 截图粘贴）→ 上传暂存 → 指针位置插卡。
 *
 * 链路本体在 staging.ts（S2a 抽出共享，零行为变更）：瞬态占位卡 → port.stage
 * → addRef → token 落定；失败 ⇒ 错误态可重试。toolbar action 档（原生选择框）
 * 共用同一条链路。
 */

import type { ComposerDropHandler } from '@vessel-agent/plugin-sdk';
import { stageFiles } from './staging';

/** embed 具名导出（contributes.composer drop 槽）。 */
export const onFilesDropped: ComposerDropHandler = (files, port, at) => {
  stageFiles(files, port, at);
};
