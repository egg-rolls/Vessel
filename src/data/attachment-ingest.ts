/**
 * 附件入池的边界实现（0.56 决策 2：上传即落 blob）
 *
 * ## 为什么这里只判「能不能读」，不判「能不能发」
 *
 * 入池发生在附件**到达节点**那一刻（`AgentService.admit`），此时还没有 provider、没有
 * 模型、没有视觉后端 —— 所以这里只做一件事：**先过路径边界，再读一次文件**，然后交给
 * core 的 `ingestImageRefs`（算 sha256 + 落 blob）。格式判定（magic bytes）留在请求期，
 * 那是后端的能力（`VisionBackend.sniffImageMime`）。
 *
 * ## 边界与 `attachments.list` 同一份
 *
 * 配置从 `basic-tools` 来（`buildPluginConfigMap` 的合并顺序一致），判定只用
 * `buildPathBoundary` / `evaluatePath` / `canonicalPath`，不写第二套前缀比较。
 * **`ask` 与 `deny` 都不读**：入池是「还没得到用户同意」的时机，读一个需要确认的路径
 * 等于把确认绕过去（fail-closed，图不内联但不需要报错）。
 *
 * ## 失败语义（不许静默）
 *
 * 读不到 / 越界 / 太大 ⇒ 引用原样保留（`sha256` 仍缺省）⇒ 请求期明确记
 * `not_ingested`，GUI chip 显示「未发送」，而不是「试了试可能发了」。
 *
 * @module vessel/attachment-ingest
 */

import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import type { MessageRef } from '../../packages/core/src/index';
import { ingestImageRefs } from '../../packages/core/src/index';
import {
  buildPathBoundary,
  canonicalPath,
  evaluatePath,
  type PathBoundary,
  parseBasicToolsConfig,
} from '../../plugins/tools/basic-tools/src/index';
import { buildPluginConfigMap, declarativePluginEntries } from '../plugin-config';
import { resolveAgentCwd } from './path-resolution';

export interface AttachmentIngestOptions {
  /** 当前活配置（getter：热应用后下一次入池就用新边界）。 */
  getConfig: () => VesselConfig;
  /** blob 池根（缺省 core 的 `imageBlobRoot()`：`<dataDir>/blobs/sha256`）。 */
  root?: string;
}

/**
 * 从活配置算一次边界快照（配置指纹变了才重建：`buildPathBoundary` 会做 realpath）。
 *
 * 与 `attachments-list.ts` 的同名逻辑同一口径（同一个 `parseBasicToolsConfig` +
 * `buildPluginConfigMap`）：面板里列得出来的路径，这里也必须读得了 —— 反过来也一样。
 */
function boundaryOf(config: VesselConfig, agentCwd: string | undefined): PathBoundary {
  const merged = buildPluginConfigMap(config.plugins, declarativePluginEntries(config), agentCwd)[
    'basic-tools'
  ];
  return buildPathBoundary(parseBasicToolsConfig(merged));
}

/** 构造注入给 `AgentService` 的入池函数（`attachIngest`）。 */
export function createConfigAttachmentIngest(
  options: AttachmentIngestOptions,
): (refs: readonly MessageRef[]) => Promise<MessageRef[]> {
  let cachedConfig: VesselConfig | undefined;
  let cachedBoundary: PathBoundary | undefined;
  return async (refs) => {
    if (!refs.some((ref) => ref.kind === 'image' && ref.sha256 === undefined)) return [...refs];
    const config = options.getConfig();
    if (cachedBoundary === undefined || cachedConfig !== config) {
      cachedConfig = config;
      cachedBoundary = boundaryOf(config, resolveAgentCwd(config));
    }
    const boundary = cachedBoundary;
    const result = await ingestImageRefs(refs, {
      allowPath: (target: string) => evaluatePath(canonicalPath(path.resolve(target)), boundary),
      ...(options.root !== undefined ? { root: options.root } : {}),
    });
    return result.refs;
  };
}
