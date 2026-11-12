/**
 * 排队卡（chat/StreamItems 的 QueuedNotice）：琥珀档卡面 + 「等待中」胶囊。
 * 只读样例：取消按钮给一个空回调，不接触 inbox / gateway。
 */
import { QueuedNotice } from '../../../chat/StreamItems';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'QueuedNotice',
  descriptionKey: 'designLab.preview.queued.desc',
  group: 'chat',
  order: 10,
};

const SUBMITTED_AT = 1_767_225_600_000;

const WAITING = {
  id: 'design-lab-queued-1',
  input: '把最近一次运行里失败的 5 个工具调用按错误分类，先给摘要，再给下一步建议。',
  submittedAt: SUBMITTED_AT,
  cancelling: false,
};

const CANCELLING = {
  ...WAITING,
  id: 'design-lab-queued-2',
  input: '再补一份按接口分组的中文摘要。',
  cancelling: true,
};

export default function QueuedNoticePreview() {
  return (
    <div className="flex flex-col gap-3">
      <QueuedNotice item={WAITING} onCancel={() => undefined} />
      <QueuedNotice item={CANCELLING} onCancel={() => undefined} />
    </div>
  );
}
