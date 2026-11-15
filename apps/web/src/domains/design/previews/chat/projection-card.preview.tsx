/**
 * 投影卡（chat/ProjectionPanes + ProjectionBadge，0.54）：同一张工具卡上「模型看到的占位」
 * 与「原文」并列。这里给四档：正文就是原文（默认原文视角）、8 KiB 截断、原文只在事件日志
 * （默认模型视角）、原文不可恢复（danger badge）。
 *
 * 样例里**没有** `ProjectionReadbackProvider`（设计实验室不发 RPC）：点「读回」会走真实的
 * 降级路径，界面显示「原文已不可恢复」—— 那正是读回为空 / 死链时的样子，不是 bug。
 */
import type { ProjectionView } from '../../../../gateway/types';
import { ToolCard } from '../../../chat/ToolCard';
import type { ToolCardView } from '../../../chat/tool-cards';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'ProjectionCard',
  descriptionKey: 'designLab.preview.projection.desc',
  group: 'chat',
  order: 55,
};

const STARTED_AT = 1_767_225_600_000;
const PLACEHOLDER = '[cleared bash: bun run gates -> exit 1, 2140 lines]';

function projection(overrides: Partial<ProjectionView>): ProjectionView {
  return {
    mode: 'placeholder',
    tool_call_id: 'call_design_lab_projection',
    placeholder_text: PLACEHOLDER,
    placeholder_hash: 'hash-design-lab',
    original_bytes: 98_304,
    original_lines: 2140,
    original_available: 'inline',
    declaration_id: null,
    ...overrides,
  };
}

function card(
  key: string,
  result: string,
  view: ProjectionView,
  status: 'done' | 'error' = 'done',
): ToolCardView {
  return {
    kind: 'tool',
    key,
    callId: view.tool_call_id,
    name: 'bash',
    status,
    args: { command: 'bun run gates' },
    result,
    durationMs: 18_400,
    startedAt: STARTED_AT,
    projection: view,
  };
}

const INLINE = card(
  'tool:design-lab-projection-1',
  '门禁第 1 行\n门禁第 2 行\n门禁第 3 行\n',
  projection({ tool_call_id: 'call_design_lab_p1' }),
);

const TRUNCATED = card(
  'tool:design-lab-projection-2',
  '门禁第 1 行\n门禁第 2 行\n… [truncated]',
  projection({
    tool_call_id: 'call_design_lab_p2',
    original_available: 'inline_truncated',
    original_bytes: 147_456,
  }),
);

const READBACK = card(
  'tool:design-lab-projection-3',
  PLACEHOLDER,
  projection({
    tool_call_id: 'call_design_lab_p3',
    original_available: 'readback',
    original_bytes: null,
    readback: { kind: 'events', tool_call_id: 'call_design_lab_p3', since_seq: 0 },
  }),
);

const GONE = card(
  'tool:design-lab-projection-4',
  PLACEHOLDER,
  projection({
    tool_call_id: 'call_design_lab_p4',
    original_available: 'gone',
    original_bytes: null,
  }),
);

export default function ProjectionCardPreview() {
  return (
    <div className="flex flex-col gap-3">
      <ToolCard card={INLINE} defaultOpen />
      <ToolCard card={TRUNCATED} defaultOpen />
      <ToolCard card={READBACK} defaultOpen />
      <ToolCard card={GONE} defaultOpen />
    </div>
  );
}
