/**
 * agent 投递卡（chat/AgentMessageCard）：A2A 投递进本会话的输入，
 * 卡头「来自 agent <alias>」，展开体首行是来源地址与时刻。
 */
import { AgentMessageCard } from '../../../chat/AgentMessageCard';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'AgentMessageCard',
  descriptionKey: 'designLab.preview.agentMessage.desc',
  group: 'chat',
  order: 70,
};

const TS = 1_767_225_600_000;

export default function AgentMessageCardPreview() {
  return (
    <div className="flex flex-col gap-3">
      <AgentMessageCard
        sender="reviewer"
        content="设计实验室的样例都过了一遍：排队卡 / 失败卡 / 工具卡都能开合，弹窗只渲染不触发请求。"
        source="agent://reviewer@node-2acb4f/vessel.design"
        ts={TS}
        defaultOpen
      />
      <AgentMessageCard sender="planner" content="排期已更新：先做 token 自动枚举，再做组件自动发现。" ts={TS} />
    </div>
  );
}
