/**
 * 环境信息卡（chat/EnvCard）：模型上下文里 vessel:notice 那一行行文本的唯一渲染点。
 * 卡头是 scope 标签 + 条数，展开体是全部原文；未生效的行带 danger 标记。
 */
import { EnvCard } from '../../../chat/EnvCard';
import type { EnvNoticeCard } from '../../../chat/env-notice';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'EnvCard',
  descriptionKey: 'designLab.preview.env.desc',
  group: 'chat',
  order: 60,
};

const TS = 1_767_225_600_000;

const APPLIED: EnvNoticeCard = {
  scope: 'config',
  ok: true,
  count: 1,
  lines: [
    {
      id: '0',
      scope: 'config',
      ok: true,
      text: '[runtime] config 已热加载：ui.expandCards = true（本卡就是生效的那一行）',
    },
  ],
};

const PARTIAL: EnvNoticeCard = {
  scope: 'permission',
  ok: false,
  count: 3,
  lines: [
    { id: '0', scope: 'permission', ok: false, text: '[runtime] 权限 profile=tools 未生效' },
    { id: '1', scope: 'permission', ok: true, text: '  · 已授予 read / grep' },
    { id: '2', scope: 'permission', ok: true, text: '  · 已授予 bash（仅回环）' },
  ],
  droppedLines: 2,
};

export default function EnvCardPreview() {
  return (
    <div className="flex flex-col gap-3">
      <EnvCard env={APPLIED} ts={TS} defaultOpen />
      <EnvCard env={PARTIAL} ts={TS} />
    </div>
  );
}
