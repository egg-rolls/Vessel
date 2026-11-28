/**
 * 长消息折叠（MessageFold）：一段超过阈值的静态长文，默认收起 + 渐隐 + 开合按钮。
 * 折叠判定只看 scrollHeight（组件自测）；样例不预截断文本。只读，不发 RPC。
 */
import type { PreviewMeta } from '../../domains/design/preview-registry';
import { t } from '../../i18n';
import { MessageFold } from './MessageFold';

export const preview: PreviewMeta = {
  title: 'MessageFold',
  titleKey: 'designLab.preview.messageFold.title',
  descriptionKey: 'designLab.preview.messageFold.desc',
  group: 'ui',
};

export default function MessageFoldPreview() {
  return (
    <div className="max-w-prose rounded-md bg-sunken p-3">
      <MessageFold>
        <p className="whitespace-pre-wrap text-sm">{t('designLab.preview.messageFold.sample')}</p>
      </MessageFold>
    </div>
  );
}
