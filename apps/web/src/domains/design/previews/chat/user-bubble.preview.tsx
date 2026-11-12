/**
 * 用户气泡（chat/StreamItems 的 UserBubble）：气泡 + 附件 chip + hover 时间。
 */
import { UserBubble } from '../../../chat/StreamItems';
import type { MessageRef } from '../../../../gateway/types';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'UserBubble',
  descriptionKey: 'designLab.preview.userBubble.desc',
  group: 'chat',
  order: 20,
};

const TS = 1_767_225_600_000;

const REFS: readonly MessageRef[] = [
  { kind: 'file', path: 'apps/web/src/domains/chat/StreamItems.tsx' },
  { kind: 'file', path: 'apps/web/src/styles/tokens.css', bytes: 8192 },
];

export default function UserBubblePreview() {
  return (
    <div className="flex flex-col gap-4">
      <UserBubble text="把排队卡搬到设计实验室里，和失败卡放一起对照。" ts={TS} />
      <UserBubble text="这条带两个附件引用。" ts={TS} refs={REFS} />
    </div>
  );
}
