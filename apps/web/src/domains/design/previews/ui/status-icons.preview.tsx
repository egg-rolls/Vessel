/**
 * 状态图标（StatusChip / StatusGlyph）：全量清单直接遍历 STATUS_META 的 keys ——
 * 这里不另存一份状态表，新增 StatusKind 会自动出现。
 */
import {
  STATUS_META,
  StatusChip,
  StatusGlyph,
  statusLabel,
} from '../../../../components/StatusChip';
import type { StatusKind } from '../../../../gateway/types';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'StatusGlyph',
  titleKey: 'designLab.sample.statusIcons.name',
  descriptionKey: 'designLab.sample.statusIcons.desc',
  group: 'ui',
  order: 60,
};

/** 会话列表实际会出现的五态，顺带覆盖全部 tone。 */
const SESSION_SAMPLES: readonly StatusKind[] = [
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

const ALL_KINDS = Object.keys(STATUS_META) as StatusKind[];

export default function StatusIconsPreview() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-ink">{t('designLab.demo.statusIcons.chips')}</p>
        <div className="flex flex-wrap items-center gap-2">
          {SESSION_SAMPLES.map((kind) => (
            <StatusChip key={kind} status={kind} />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-ink">{t('designLab.demo.statusIcons.list')}</p>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {ALL_KINDS.map((kind) => (
            <li key={kind} className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <StatusGlyph status={kind} showCompleted />
              <span className="text-md text-ink">{statusLabel(kind)}</span>
              <span className="font-mono text-2xs text-faint">{kind}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
