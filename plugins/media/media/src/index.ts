/**
 * @vessel-agent/media - 多模态解析器（能力插件）
 * @module @vessel-agent/media
 *
 * 单个 `media` 工具：action = read | ocr | describe。
 * - read：文本 / PDF 抽文本（pdftotext）；
 * - ocr：图片 OCR（tesseract）；
 * - describe：多模态描述桥（未配置则明确报错，不降级）。
 *
 * **零 token 税**：install 阶段探测后端，一个后端都没有时直接 return，
 * 不 registerTool —— schema 不进 prompt。插件本身不进默认插件集，
 * 必须由 config.yaml 的 `plugins:` 条目显式启用（见 docs/agents/plugins.md）。
 */

import { buildPathBoundary } from '@vessel-agent/basic-tools';
import type { Plugin, PluginHost } from '@vessel-agent/core';
import { detectBackends, hasAnyBackend, type MediaBackends, resolveCommand } from './binaries.js';
import { type MediaConfig, parseMediaConfig } from './config.js';
import { createMediaTool, type DescribeBridge } from './tool.js';

export type { MediaBackends } from './binaries.js';
export { detectBackends, hasAnyBackend, resolveCommand } from './binaries.js';
export type { MediaConfig } from './config.js';
export {
  DEFAULT_MEDIA_CONFIG,
  MAX_FILE_BYTES,
  MAX_FRAMES,
  MAX_OUTPUT_BYTES,
  MAX_PAGE,
  MAX_TIMEOUT_MS,
  parseMediaConfig,
} from './config.js';
export { type RunCliOptions, type RunCliResult, runCli } from './exec.js';
export type { DescribeBridge, DescribeRequest, MediaAction, MediaToolDeps } from './tool.js';
export {
  CANCELLED_TEXT,
  capOutput,
  createMediaTool,
  supportedActions,
} from './tool.js';

/** 插件名（config.yaml `plugins[].name`） */
export const MEDIA_PLUGIN_NAME = 'media';

/** 插件构造选项 */
export interface MediaPluginOptions {
  /** 安装配置（`plugins[].config`）；install 的第二参数优先 */
  config?: Record<string, unknown>;
  /** 多模态描述桥；缺省 = 未配置多模态模型（describe 明确报错） */
  describe?: DescribeBridge;
  /** 注入探测结果（测试 / 宿主覆盖）；给出时跳过 PATH 探测 */
  backends?: MediaBackends;
  /** 环境变量覆盖（测试 PATH 探测） */
  env?: Record<string, string | undefined>;
}

/** 探测后端；显式注入优先 */
function resolveBackends(config: MediaConfig, options: MediaPluginOptions): MediaBackends {
  if (options.backends !== undefined) return options.backends;
  return detectBackends(
    {
      pdftotext: config.pdftotext,
      tesseract: config.tesseract,
      describe: options.describe !== undefined,
    },
    options.env ?? process.env,
  );
}

/**
 * 创建插件实例。
 *
 * install 行为（契约 §4）：
 * - `enabled: false` → 不注册；
 * - 没有任何后端（pdftotext / tesseract / describe 桥）→ 不注册，stderr 提示一次；
 * - 否则注册单个 `media` 工具（schema 的 action enum 只含可用动作）。
 */
export function createMediaPlugin(options: MediaPluginOptions = {}): Plugin {
  return {
    name: MEDIA_PLUGIN_NAME,
    version: '0.50.0',
    description:
      'Multimodal attachment parser: single `media` tool (read / ocr / describe) with path boundary + ' +
      'output caps; registers nothing when no backend (pdftotext / tesseract / multimodal) is available',
    install(host: PluginHost, installOptions?: { config?: Record<string, unknown> }): void {
      const config = parseMediaConfig(installOptions?.config ?? options.config);
      if (!config.enabled) return;

      const backends = resolveBackends(config, options);
      if (!hasAnyBackend(backends)) {
        // 零 token 税：不注册工具，schema 不进 prompt
        console.warn(
          '[media] no backend detected (pdftotext / tesseract / multimodal describe); ' +
            'media tool not registered. Install poppler-utils or tesseract-ocr, ' +
            'or configure plugins[].config.pdftotext / .tesseract.',
        );
        return;
      }

      const boundary = buildPathBoundary({
        allowedRoots: config.allowedRoots,
        denyPaths: config.denyPaths,
        cwd: config.cwd,
      });

      host.registerTool(
        createMediaTool({
          config,
          boundary,
          backends,
          ...(options.describe !== undefined ? { describe: options.describe } : {}),
        }),
      );
    },
  };
}

/** 默认插件实例（无配置；装配层经 pluginConfigs 透传 config） */
export const mediaPlugin: Plugin = createMediaPlugin();

export default mediaPlugin;

/** 探测单个命令（对外只读助手：`vessel plugin list` 类诊断可用） */
export { resolveCommand as resolveMediaCommand };
