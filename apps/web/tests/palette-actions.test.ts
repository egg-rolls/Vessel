import { describe, expect, test } from 'bun:test';
import type {
  DurableRunSummary,
  McpServerStatus,
  RunStatus,
  TenantInfo,
  WorkflowRunSummary,
} from '../src/gateway/types';
import {
  buildMcpPaletteActions,
  buildRunPaletteActions,
  buildTenantPaletteActions,
  buildWorkflowPaletteActions,
  PALETTE_ACTION_LIMIT,
  shortId,
} from '../src/state/palette-actions';

function live(id: string, status: RunStatus['status'], sessionId = 's1'): RunStatus {
  return { run_id: id, session_id: sessionId, status };
}

function durable(id: string, status: DurableRunSummary['status']): DurableRunSummary {
  return { run_id: id, session_id: 's1', status, updated_at: 1 };
}

function workflow(
  id: string,
  status: WorkflowRunSummary['status'],
  name = `wf-${id}`,
): WorkflowRunSummary {
  return {
    workflow_run_id: id,
    workflow_name: name,
    status,
    step_count: 2,
    completed_steps: 1,
    started_at: 1,
    updated_at: 1,
  };
}

function tenant(id: string, status: TenantInfo['status'] = 'active'): TenantInfo {
  return { tenant_id: id, status, created_at: 1 };
}

describe('shortId', () => {
  test('truncates with an ellipsis only when needed', () => {
    expect(shortId('1234567890', 4)).toBe('1234…');
    expect(shortId('123', 4)).toBe('123');
  });
});

describe('buildRunPaletteActions', () => {
  const callbacks = {
    openRun: () => undefined,
    cancel: () => undefined,
    resume: () => undefined,
  };

  test('cancel actions are dangerous and require confirmation', () => {
    const items = buildRunPaletteActions({
      live: [live('r1', 'running'), live('r2', 'completed')],
      durable: [],
      ...callbacks,
    });
    const cancel = items.find((item) => item.id === 'run-cancel-r1');
    expect(cancel?.danger).toBe(true);
    expect(cancel?.confirm?.title).toBeTruthy();
    expect(items.some((item) => item.id === 'run-cancel-r2')).toBe(false);
  });

  test('only interrupted durable runs offer resume', () => {
    const items = buildRunPaletteActions({
      live: [],
      durable: [durable('d1', 'interrupted'), durable('d2', 'failed'), durable('d3', 'running')],
      ...callbacks,
    });
    expect(items.map((item) => item.id)).toContain('run-resume-d1');
    expect(items.map((item) => item.id)).not.toContain('run-resume-d2');
    expect(items.map((item) => item.id)).not.toContain('run-resume-d3');
  });

  test('open actions are capped and de-duplicated by session', () => {
    const liveRuns = Array.from({ length: PALETTE_ACTION_LIMIT + 2 }, (_, index) =>
      live(`r${index}`, 'completed', index === 0 ? 's1' : 's1'),
    );
    const items = buildRunPaletteActions({
      live: liveRuns,
      durable: [],
      ...callbacks,
      limit: 3,
    });
    const opens = items.filter((item) => item.id.startsWith('run-open-live-'));
    expect(opens).toHaveLength(1);
  });
});

describe('buildWorkflowPaletteActions', () => {
  const callbacks = { open: () => undefined, resume: () => undefined, cancel: () => undefined };

  test('resume/cancel follow the workflow state machine', () => {
    const items = buildWorkflowPaletteActions({
      workflows: [
        workflow('w1', 'interrupted'),
        workflow('w2', 'failed'),
        workflow('w3', 'completed'),
        workflow('w4', 'running'),
      ],
      ...callbacks,
    });
    const ids = items.map((item) => item.id);
    expect(ids).toContain('workflow-resume-w1');
    expect(ids).toContain('workflow-resume-w2');
    expect(ids).not.toContain('workflow-resume-w3');
    expect(ids).toContain('workflow-cancel-w4');
    expect(ids).not.toContain('workflow-cancel-w3');
    expect(items.find((item) => item.id === 'workflow-cancel-w4')?.danger).toBe(true);
  });
});

describe('buildMcpPaletteActions', () => {
  test('only failed servers are offered for reconnect', () => {
    const servers: McpServerStatus[] = [
      { name: 'fs', status: 'failed', tools: [], error: 'boom' },
      { name: 'git', status: 'connected', tools: ['x'] },
      { name: 'old', status: 'disabled', tools: [] },
    ];
    const items = buildMcpPaletteActions({ servers, reconnect: () => undefined });
    expect(items.map((item) => item.id)).toEqual(['mcp-reconnect-fs']);
    expect(items[0]?.group).toBe('action');
  });
});

describe('buildTenantPaletteActions', () => {
  test('excludes the current and disabled tenants', () => {
    const items = buildTenantPaletteActions({
      tenants: [tenant('default'), tenant('alpha'), tenant('beta', 'disabled')],
      currentTenantId: 'default',
      switchTenant: () => undefined,
    });
    expect(items.map((item) => item.id)).toEqual(['tenant-switch-alpha']);
    expect(items[0]?.label).toContain('alpha');
  });
});
