/**
 * 宿主原生 feature 显式 import 清单（ADR-107 决策 2）。
 *
 * 一行一 feature，按 id 字典序。拒目录扫描（顺序不确定/打包 glob/类型检查弱）
 * 与装饰器自注册（隐式顺序/tree-shake 摇掉/ADR-004 反对的装饰器心智回潮）。
 * 冲突面收敛目标：新 feature = 新文件 + 本清单一行；既有 feature 改 deps
 * 主干零改动。
 *
 * 红线（ADR-107 决策 6）：插件永不进本清单——21 个插件继续走
 * loader/manifest/install 单一路径；这里只有宿主原生 harness 接线面。
 */

import type { AssemblyFeature } from './feature';

export const ASSEMBLY_FEATURES: readonly AssemblyFeature[] = [
  // id 字典序，一行一 feature（P2 第一批：attachments / jobs / kanban / restart）
];
