/**
 * Observe → Attention：待处理收件箱（DECISION-038 §2.4）。
 *
 * 单节点时保持原体验；配置了额外节点后按节点只读聚合（S9.4）：
 * 每个节点独立分页 / 独立失败，只有当前节点的会话可以跳转。
 *
 * 薄容器：视图按职责拆到同目录 SingleNodeAttention / MultiNodeAttention。
 */
import type { Route } from '../../app/router';
import { useNodes } from '../../gateway/NodeProvider';
import { useLocale } from '../../i18n';
import { MultiNodeAttention } from './MultiNodeAttention';
import { SingleNodeAttention } from './SingleNodeAttention';

export function AttentionPanel({ navigate }: { navigate: (route: Route) => void }) {
  useLocale();
  const { nodes } = useNodes();
  return nodes.length > 1 ? (
    <MultiNodeAttention navigate={navigate} />
  ) : (
    <SingleNodeAttention navigate={navigate} />
  );
}
