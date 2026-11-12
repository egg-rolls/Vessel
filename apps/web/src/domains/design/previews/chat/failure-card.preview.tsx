/**
 * 失败卡（chat/StreamItems 的 RunFailureCard）：折叠态只留红点 + 一行错误摘要，
 * 展开体里才是状态 chip、短 run id 与错误原文。两张卡分别演示两种默认开合。
 */
import { RunFailureCard } from '../../../chat/StreamItems';
import type { RunFailure } from '../../../chat/transcript-items';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'RunFailureCard',
  descriptionKey: 'designLab.preview.failure.desc',
  group: 'chat',
  order: 80,
};

const EVENT_FAILURE: RunFailure = {
  runId: 'run_01jdesignlabfailure00000001',
  sessionId: 'sess_design_lab',
  error: 'gateway 返回 502：上游 provider 在流式阶段断开，未收到任何正文帧。',
  errorMeta: {
    code: 'upstream_unavailable',
    category: 'provider',
    retryable: true,
    httpStatus: 502,
  },
  completedAt: 1_767_225_600_000,
  source: 'event',
};

const SESSION_FAILURE: RunFailure = {
  runId: 'run_01jdesignlabfailure00000002',
  error: 'tool 调用被策略拒绝：bash 只允许在回环地址上执行。',
  completedAt: 1_767_225_600_000,
  source: 'session',
};

export default function RunFailureCardPreview() {
  return (
    <div className="flex flex-col gap-3">
      <RunFailureCard failure={EVENT_FAILURE} />
      <RunFailureCard failure={SESSION_FAILURE} defaultOpen />
    </div>
  );
}
