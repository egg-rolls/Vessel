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

import type { Plugin, PluginHost } from '@vessel-agent/core';

export {
  capDescription,
  deriveDescription,
  type FrontmatterResult,
  parseFrontmatter,
} from './frontmatter.js';
export { type ScanRootOptions, type ScanRootResult, scanSkillRoot } from './scanner.js';
export { SkillsStore } from './store.js';
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

/** 插件名（config.yaml `plugins[].name` / loader 短名） */
export const SKILLS_PLUGIN_NAME = 'skills';

/**
 * 创建插件实例。
 *
 * 骨架切片：install 暂不注册任何面——数据层 / 信任门 / 工具 / RPC / 设置 / UI
 * 按设计 §12 分期 additive 落进本 install。`enabled: false` 的语义（不注册）
 * 随 config 解析一起落地。
 */
export function createSkillsPlugin(): Plugin {
  return {
    name: SKILLS_PLUGIN_NAME,
    version: '0.1.0',
    description:
      'Managed skill library: scan / index three skill roots (project / user / collected library) ' +
      'with trust-gated load (`skills` tool) + library UI',
    install(_host: PluginHost): void {
      // 骨架：后续切片在这里注册 skills 工具并启动扫描 / watch。
    },
  };
}

/** 默认插件实例（装配层经 pluginConfigs['skills'] 透传 config） */
export const skillsPlugin: Plugin = createSkillsPlugin();

export default skillsPlugin;
