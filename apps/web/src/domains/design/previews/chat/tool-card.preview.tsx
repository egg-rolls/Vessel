/**
 * 工具卡（chat/ToolCard）：卡头只有工具名 + 耗时，点开看描述 / 输入 / 输出。
 * 这里给三档状态（运行中 / 完成 / 失败），失败档折叠时也保留错误摘要。
 */
import { ToolCard } from '../../../chat/ToolCard';
import type { ToolCardView } from '../../../chat/tool-cards';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'ToolCard',
  descriptionKey: 'designLab.preview.tool.desc',
  group: 'chat',
  order: 50,
};

const STARTED_AT = 1_767_225_600_000;

const INPUT = {
  command: 'bun run scripts/check-i18n.ts',
  cwd: 'apps/web',
};

const DONE: ToolCardView = {
  kind: 'tool',
  key: 'tool:design-lab-1',
  callId: 'call_design_lab_1',
  name: 'bash',
  status: 'done',
  args: INPUT,
  result: 'i18n contract passed\n',
  durationMs: 1_240,
  startedAt: STARTED_AT,
};

const ERROR: ToolCardView = {
  kind: 'tool',
  key: 'tool:design-lab-2',
  callId: 'call_design_lab_2',
  name: 'bash',
  status: 'error',
  args: { command: 'bun run scripts/check-web-styles.ts' },
  error: 'exit code 1: 2 处 arbitrary value 需要改成 token',
  errorMeta: { code: 'tool_failed', retryable: true, category: 'script' },
  durationMs: 830,
  startedAt: STARTED_AT,
};

const RUNNING: ToolCardView = {
  kind: 'tool',
  key: 'tool:design-lab-3',
  callId: 'call_design_lab_3',
  name: 'read',
  status: 'running',
  args: { path: 'apps/web/src/styles/tokens.css' },
  startedAt: STARTED_AT,
};

export default function ToolCardPreview() {
  return (
    <div className="flex flex-col gap-3">
      <ToolCard card={DONE} defaultOpen />
      <ToolCard card={ERROR} />
      <ToolCard card={RUNNING} />
    </div>
  );
}
