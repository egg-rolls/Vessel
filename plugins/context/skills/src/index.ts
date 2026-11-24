/**
 * @vessel-agent/plugin-skills — 收集技能库的管理插件（in-process 能力插件）。
 *
 * 设计：docs/dev/plans/skills-plugin-design.md。形态照 model-registry 先例：
 * package.json 声明 `vessel` 清单但无 `entry` ⇒ in-process capabilityManifest；
 * 装配层经 registerInProcessPlugin 登记贡献面与 RPC（canonical `plugin.skills.*`）。
 *
 * 四个面（分期落地，本文件是骨架）：
 * - 管理面：三来源（project skills/ / user ~/.vessel/skills/ / library 收集库）扫描索引；
 * - agent 工具面：单个 `skills` 工具（list / search / load，信任门控）；
 * - UI 面：技能库列表 / 详情 / 信任状态 / 会话加载状态（embed + iframe 回退）；
 * - 设置面：contributes.settings（q-settings 自动发现渲染）。
 *
 * 纪律：core 只 import type；技能是数据（markdown），插件永不执行技能内容；
 * 文件永远是真相源，索引只是派生缓存；不新增 core 接口 / 事件 / 第二注册表。
 */

import { buildPathBoundary } from '@vessel-agent/basic-tools';
import type { Plugin, PluginHost } from '@vessel-agent/core';
import { parseSkillsConfig } from './config.js';
import { dispatchSkillsRpc } from './rpc.js';
import { SkillsService } from './service.js';
import { SkillsStore } from './store.js';
import { createSkillsTool } from './tool.js';

export { parseSkillsConfig, type SkillsConfig } from './config.js';
export {
  capDescription,
  deriveDescription,
  type FrontmatterResult,
  parseFrontmatter,
} from './frontmatter.js';
export { dispatchSkillsRpc } from './rpc.js';
export { type ScanRootOptions, type ScanRootResult, scanSkillRoot } from './scanner.js';
export {
  type ReadSkillResult,
  type RescanResult,
  SkillsService,
  type SkillsServiceOptions,
} from './service.js';
export { SkillsStore } from './store.js';
export {
  capContent,
  compareForList,
  createSkillsTool,
  parseSkillsArgs,
  SKILLS_TOOL_DESCRIPTION,
  type SkillsArgs,
  searchRank,
} from './tool.js';
export {
  loadGateDecision,
  originOfSource,
  pinTrustRecord,
  revokeTrustRecord,
  trustStateOf,
} from './trust.js';
export {
  DEFAULT_MAX_LOAD_BYTES,
  emptyIndex,
  emptySessionLoads,
  emptyTrustStore,
  type FrontmatterState,
  LIST_DESCRIPTION_CHARS,
  MAX_AUX_FILES,
  MAX_DESCRIPTION_CHARS,
  MAX_LOADS_PER_SESSION,
  MAX_LOADS_SESSIONS,
  MAX_PAGE_LIMIT,
  MAX_SCAN_DEPTH,
  MAX_SKILL_ENTRIES,
  MAX_SKILL_FILE_BYTES,
  MAX_TAG_CHARS,
  MAX_TAGS,
  type SessionLoad,
  type SessionLoads,
  type SkillEntry,
  type SkillIndex,
  type SkillSource,
  type TrustRecord,
  type TrustState,
  type TrustStore,
  WATCH_DEBOUNCE_MS,
} from './types.js';
export { type SkillsWatcher, watchSkillRoots } from './watch.js';

/** 插件名（config.yaml `plugins[].name` / loader 短名） */
export const SKILLS_PLUGIN_NAME = 'skills';

/** 插件构造选项（与 install 的第二参数同形） */
export interface SkillsPluginOptions {
  config?: Record<string, unknown>;
}

/**
 * 创建插件实例。
 *
 * install（设计 §4/§5.4/§10.2）：解析 config（install 期钉死，生效语义 = 重启）；
 * `enabled: false` 不注册任何东西；否则构造路径边界（继承 basic-tools，装配层
 * 回落）、私有目录 store 与索引服务，启动异步全量扫描 + watch，注册 `skills`
 * 工具；RPC 管理面经 Plugin.rpc 由装配层登记。
 */
export function createSkillsPlugin(options: SkillsPluginOptions = {}): Plugin {
  let service: SkillsService | undefined;
  return {
    name: SKILLS_PLUGIN_NAME,
    version: '0.1.0',
    description:
      'Managed skill library: scan / index three skill roots (project / user / collected library) ' +
      'with trust-gated load (`skills` tool) + library UI',
    install(host: PluginHost, installOptions?: { config?: Record<string, unknown> }): void {
      const { config, warnings } = parseSkillsConfig(installOptions?.config ?? options.config);
      for (const warning of warnings) console.warn(`[skills] ${warning}`);
      if (!config.enabled) return;

      const boundary = buildPathBoundary({
        allowedRoots: config.allowedRoots,
        denyPaths: config.denyPaths,
        cwd: config.cwd,
      });
      const store = new SkillsStore(config.stateDir);
      service = new SkillsService({ config, boundary, store });
      // 扫描是异步的：install 不阻塞进程启动；工具 / RPC 调用前 await ready()。
      host.registerTool(createSkillsTool(service));
    },
    dispose(): void {
      service?.dispose();
      service = undefined;
    },
    // RPC 管理面（设计 §7）：装配层 registerInProcessPlugin 把本方法接进宿主
    // PluginRpcRegistry（canonical plugin.skills.*，与 child 共用 DTO 校验）。
    async rpc(name: string, params: Record<string, unknown>): Promise<unknown> {
      if (service === undefined) {
        throw new Error('skills plugin is not installed (config enabled:false?)');
      }
      return dispatchSkillsRpc(name, params, service);
    },
  };
}

/** 默认插件实例（装配层经 pluginConfigs['skills'] 透传 config） */
export const skillsPlugin: Plugin = createSkillsPlugin();

export default skillsPlugin;
