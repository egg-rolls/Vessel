/**
 * Teams 域入口：跨节点 Team 栏 + 详情 pane。
 *
 * - Team 栏常驻：标题 / Create / 刷新、搜索、节点过滤、按节点分组的卡片；
 * - 每张卡片右侧的 ActionMenu 负责 Edit / Freeze / Archive / Refresh；
 * - 详情 pane 渲染 TeamDetailRoute；默认无 teamId 时显示“先打开 Team”空态，
 *   不自动打开第一个 Team；
 * - 窄屏下 Team 栏是抽屉（默认关闭），重开按钮在详情 / 空态处；
 * - 列表与详情状态来自 `teamStore`；归档 / 刷新后同步 roster。
 *
 * 拆分为薄容器：状态与副作用在 `useTeamsView`，渲染在 `TeamsListColumn` /
 * `TeamsDetailPane` / `TeamsViewDialogs`。
 */
import { TeamsDetailPane } from './TeamsDetailPane';
import { TeamsListColumn } from './TeamsListColumn';
import { TeamsViewDialogs } from './TeamsViewDialogs';
import { type TeamsViewProps, useTeamsView } from './useTeamsView';

export type { TeamsViewProps };

export function TeamsView({ route, navigate }: TeamsViewProps) {
  const state = useTeamsView({ route, navigate });

  return (
    <div className="teams-workspace">
      <TeamsListColumn state={state} />
      <TeamsDetailPane state={state} />
      <TeamsViewDialogs state={state} />
    </div>
  );
}
