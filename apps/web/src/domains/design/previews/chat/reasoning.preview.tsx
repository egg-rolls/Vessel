/**
 * 思考卡（chat/ReasoningBlock）：卡头「思考过程」+ 复制按钮 + 最右时刻，
 * 超过 12 行时给「展开全部」；流式档卡头多一句「正在思考」。
 */
import { ReasoningBlock } from '../../../chat/ReasoningBlock';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'ReasoningBlock',
  descriptionKey: 'designLab.preview.reasoning.desc',
  group: 'chat',
  order: 40,
};

const TIME = 1_767_225_600_000;

const LONG = [
  '先把页面上「卡」的种类列全：排队、失败、工具、环境信息、agent 投递。',
  '再看它们共用哪一层：StreamCard 的四个槽（title / meta / summary / 展开体）。',
  '折叠只留一行摘要是这条时间线的一致口径，所以每个新卡都套同一张壳。',
  '色调是唯一能表达「这条消息还没生效」的手段，所以排队卡落在 amber 档。',
  '颜色只在 tokens.css 里定义，组件里一律引 token，不写裸色值。',
  '空态与错误态用同一套 States 组件，避免每个页面各写一份。',
  '长内容一律进展开体，卡头不放可点元素（可操作项进 actions 槽）。',
  '动画只来自 motion.css 的三族 class，组件里不写 keyframes。',
  '思考卡的复制按钮在 summary 里，所以必须 preventDefault 吃掉开合。',
  '时刻只出现在卡头最右，正文下方的工具栏不再重复。',
  '流式期间默认展开，收字结束自动折叠；用户手动开合后不再被改写。',
  '历史态的思考默认折叠，同样一句话只有一个 i18n key。',
  '这一段刻意写长，用来演示「超过 12 行」时的展开按钮。',
].join('\n');

const SHORT = '先看现有卡面，再决定要不要新增卡种。';

export default function ReasoningPreview() {
  return (
    <div className="flex flex-col gap-3">
      <ReasoningBlock text={SHORT} streaming={false} time={TIME} />
      <ReasoningBlock text={LONG} streaming={false} time={TIME} />
      <ReasoningBlock text={SHORT} streaming time={TIME} />
    </div>
  );
}
