/**
 * 排队卡（chat/StreamItems 的 `QueuedNotice`）：琥珀档卡面 + 「等待中」胶囊。
 * 只读样例：两个写操作给空回调，不接触 inbox / gateway。
 *
 * 三张卡把「有没有写入口」的三态都摆出来：两颗图标键（human 源）/ 只有取消 /
 * 一颗都不给（agent 源 —— 它的 recall 只是 unhold 留档，不画成删除）。
 */
import { t } from '../../../../i18n';
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

const AGENT_SOURCE = {
  ...WAITING,
  id: 'design-lab-queued-3',
  input: '父会话让你把扫尾做完：先读交接书，再跑一遍门禁。',
};

export default function QueuedNoticePreview() {
  // 身份那格与真实调用点同源：条带的 `identityOf` 给 human 源的就是这句 i18n，
  // agent 源给的是原始 principal 串（要昵称得另读 roster，本组件不猜）。
  const human = t('chat.pending.identity.human');
  return (
    <div className="flex flex-col gap-3">
      <QueuedNotice
        item={WAITING}
        identity={human}
        onEdit={() => undefined}
        onCancel={() => undefined}
      />
      <QueuedNotice item={CANCELLING} identity={human} onCancel={() => undefined} />
      <QueuedNotice item={AGENT_SOURCE} identity="agent:helper" />
    </div>
  );
}
