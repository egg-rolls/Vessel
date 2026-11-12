/**
 * 助手正文（chat/StreamItems 的 AssistantText）：Markdown 正文 + 正文下方左对齐的复制按钮。
 */
import { AssistantText } from '../../../chat/StreamItems';
import { MessageActions, useMessageCopy } from '../../../../components/ui';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'AssistantText',
  descriptionKey: 'designLab.preview.assistant.desc',
  group: 'chat',
  order: 30,
};

const TEXT = [
  '## 结论',
  '',
  '排队卡、失败卡、工具卡都在同一条时间线里，**卡面**与**色调**是它们唯一的身份差别：',
  '',
  '- 排队卡：amber 档，表示「还没发出去」；',
  '- 失败卡：danger 档，折叠态只留一行错误摘要；',
  '- 工具卡：neutral 档，卡头只有工具名与耗时。',
  '',
  '> 正文不折叠 —— 无底色的助手正文被裁掉高度没有视觉锚点。',
].join('\n');

export default function AssistantTextPreview() {
  const copy = useMessageCopy();
  return (
    <AssistantText
      text={TEXT}
      actions={
        <MessageActions
          className="mt-1"
          actions={[
            {
              id: 'copy',
              label: t('chat.message.copy'),
              onSelect: () => copy(TEXT),
            },
          ]}
        />
      }
    />
  );
}
