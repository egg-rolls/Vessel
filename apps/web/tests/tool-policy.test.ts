import { describe, expect, test } from 'bun:test';
import {
  EMPTY_PERMISSION_LISTS,
  hasScopedNever,
  isPolicyEditable,
  nextWritten,
  permissionListsEqual,
  policyHintKey,
  policyLabelKey,
  readPermissionLists,
  scopedEntries,
  scopedPolicyHintKey,
  supportsToolPolicy,
  TOOL_POLICY_METHOD,
  TOOL_POLICY_OPTIONS,
  toolPolicyOf,
} from '../src/domains/integrations/tool-policy';

describe('readPermissionLists', () => {
  test('reads camelCase keys from the redacted config snapshot', () => {
    const lists = readPermissionLists({
      permission: { autoApprove: ['bash'], neverAutoApprove: ['edit'] },
    });
    expect(lists.autoApprove).toEqual(['bash']);
    expect(lists.neverAutoApprove).toEqual(['edit']);
  });

  test('treats missing or malformed permission blocks as empty', () => {
    expect(readPermissionLists(undefined)).toEqual(EMPTY_PERMISSION_LISTS);
    expect(readPermissionLists({})).toEqual(EMPTY_PERMISSION_LISTS);
    expect(readPermissionLists({ permission: null })).toEqual(EMPTY_PERMISSION_LISTS);
    expect(readPermissionLists({ permission: { autoApprove: 'bash' } })).toEqual(
      EMPTY_PERMISSION_LISTS,
    );
    expect(readPermissionLists({ permission: { autoApprove: ['bash', 3, '  '] } })).toEqual({
      autoApprove: ['bash'],
      neverAutoApprove: [],
    });
  });
});

describe('toolPolicyOf', () => {
  test('defaults to ask when neither list mentions the tool', () => {
    expect(toolPolicyOf(EMPTY_PERMISSION_LISTS, 'bash')).toBe('ask');
  });

  test('reports auto when the tool is auto-approved', () => {
    expect(toolPolicyOf({ autoApprove: ['bash'], neverAutoApprove: [] }, 'bash')).toBe('auto');
  });

  test('never wins over auto for the same tool', () => {
    const lists = { autoApprove: ['bash'], neverAutoApprove: ['bash'] };
    expect(toolPolicyOf(lists, 'bash')).toBe('never');
  });

  test('matches only exact tool names; tool.action entries are scoped, not the whole tool', () => {
    const lists = { autoApprove: [], neverAutoApprove: ['agent.close'] };
    expect(toolPolicyOf(lists, 'agent')).toBe('ask');
    expect(toolPolicyOf(lists, 'agen')).toBe('ask');
    expect(toolPolicyOf({ autoApprove: ['bashing'], neverAutoApprove: [] }, 'bash')).toBe('ask');
  });

  test('requires an exact never entry for the never policy', () => {
    expect(toolPolicyOf({ autoApprove: [], neverAutoApprove: ['edit'] }, 'edit')).toBe('never');
  });

  test('derives a policy for every tool kind, including read, subscribe, agent and MCP', () => {
    for (const name of [
      'read',
      'subscribe',
      'agent',
      'bash',
      'edit',
      'mcp__srv__echo',
      'mystery',
    ]) {
      expect(toolPolicyOf(EMPTY_PERMISSION_LISTS, name)).toBe('ask');
    }
  });
});

describe('hasScopedNever', () => {
  test('detects tool.action entries without matching other tools by prefix', () => {
    const lists = { autoApprove: [], neverAutoApprove: ['agent.close'] };
    expect(hasScopedNever(lists, 'agent')).toBe(true);
    expect(hasScopedNever(lists, 'agen')).toBe(false);
    expect(hasScopedNever(lists, 'bash')).toBe(false);
  });

  test('does not treat an exact never entry as scoped', () => {
    expect(hasScopedNever({ autoApprove: [], neverAutoApprove: ['agent'] }, 'agent')).toBe(false);
  });
});

describe('scopedEntries', () => {
  test('lists existing tool.action entries from both arrays, sorted and de-duplicated', () => {
    expect(
      scopedEntries(
        {
          autoApprove: ['agent.close'],
          neverAutoApprove: ['agent.pause', 'agent.close'],
        },
        'agent',
      ),
    ).toEqual(['agent.close', 'agent.pause']);
  });

  test('ignores exact tool entries and other tools with the same prefix', () => {
    expect(
      scopedEntries({ autoApprove: ['agent'], neverAutoApprove: ['agentx.close'] }, 'agent'),
    ).toEqual([]);
  });
});

describe('base and scoped policies stay independent', () => {
  test('setting agent to auto leaves agent.close untouched', () => {
    const lists = { autoApprove: ['agent'], neverAutoApprove: ['agent.close'] };
    expect(toolPolicyOf(lists, 'agent')).toBe('auto');
    expect(toolPolicyOf(lists, 'agent.close')).toBe('never');
    expect(hasScopedNever(lists, 'agent')).toBe(true);
    expect(scopedEntries(lists, 'agent')).toEqual(['agent.close']);
  });

  test('setting agent.close to ask changes only that row', () => {
    const lists = { autoApprove: ['agent'], neverAutoApprove: [] };
    expect(toolPolicyOf(lists, 'agent')).toBe('auto');
    expect(toolPolicyOf(lists, 'agent.close')).toBe('ask');
    expect(scopedEntries(lists, 'agent')).toEqual([]);
  });

  test('setting agent.close to never does not change the base policy', () => {
    const lists = { autoApprove: [], neverAutoApprove: ['agent.close'] };
    expect(toolPolicyOf(lists, 'agent')).toBe('ask');
    expect(toolPolicyOf(lists, 'agent.close')).toBe('never');
  });
});

describe('isPolicyEditable', () => {
  test('every tool is configurable, regardless of has_permission_check', () => {
    for (const name of [
      'read',
      'subscribe',
      'agent',
      'bash',
      'edit',
      'mcp__srv__echo',
      'mystery',
    ]) {
      expect(isPolicyEditable({ name, has_permission_check: false })).toBe(true);
      expect(isPolicyEditable({ name, has_permission_check: true })).toBe(true);
    }
  });
});

describe('permission list comparison', () => {
  const before = { autoApprove: ['bash'], neverAutoApprove: ['edit', 'agent.close'] };

  test('ignores ordering but compares both arrays', () => {
    expect(
      permissionListsEqual(before, {
        autoApprove: ['bash'],
        neverAutoApprove: ['agent.close', 'edit'],
      }),
    ).toBe(true);
    expect(
      permissionListsEqual(before, {
        autoApprove: ['bash'],
        neverAutoApprove: ['agent.close'],
      }),
    ).toBe(false);
    expect(
      permissionListsEqual(before, {
        autoApprove: ['edit'],
        neverAutoApprove: ['edit', 'agent.close'],
      }),
    ).toBe(false);
  });

  test('keeps the written snapshot until a refreshed config matches it', () => {
    const written = { autoApprove: ['agent'], neverAutoApprove: [] };
    // 旧的 config 快照：对象身份变了但数组不同，不能清空 written。
    expect(nextWritten(written, EMPTY_PERMISSION_LISTS)).toBe(written);
    // 与 written 等价的新 config 落地后才让位。
    expect(nextWritten(written, { autoApprove: ['agent'], neverAutoApprove: [] })).toBeNull();
    expect(nextWritten(null, EMPTY_PERMISSION_LISTS)).toBeNull();
  });
});

describe('supportsToolPolicy', () => {
  test('detects the canonical method in the capability manifest', () => {
    expect(TOOL_POLICY_METHOD).toBe('permissions.setToolPolicy');
    expect(
      supportsToolPolicy({
        methods: [
          { name: 'tools.list', permission: 'read' },
          { name: TOOL_POLICY_METHOD, permission: 'write' },
        ],
      }),
    ).toBe(true);
  });

  test('returns false for old gateways and missing manifests', () => {
    expect(supportsToolPolicy({ methods: [{ name: 'tools.list', permission: 'read' }] })).toBe(
      false,
    );
    expect(supportsToolPolicy({ methods: [] })).toBe(false);
    expect(supportsToolPolicy(null)).toBe(false);
  });
});

describe('scoped policy copy', () => {
  test('scoped never uses its own label, not the exact force-confirm label', () => {
    expect(policyLabelKey('never')).toBe('integrations.tools.policyNever');
    expect(policyLabelKey('never', true)).toBe('integrations.tools.policyScopedNeverOn');
    expect(policyLabelKey('auto', true)).toBe(policyLabelKey('auto'));
    expect(policyLabelKey('ask', true)).toBe(policyLabelKey('ask'));
  });

  test('scoped never has a hint describing automatic-approval blocking only', () => {
    expect(scopedPolicyHintKey('never')).toBe('integrations.tools.policyScopedNeverHint');
    expect(scopedPolicyHintKey('ask')).toBe(policyHintKey('ask'));
    expect(scopedPolicyHintKey('auto')).toBe(policyHintKey('auto'));
  });
});

describe('policy copy keys', () => {
  test('every option has distinct label and hint keys', () => {
    const keys = TOOL_POLICY_OPTIONS.flatMap((option) => [option.labelKey, option.hintKey]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('hint key lookup matches the option id', () => {
    for (const option of TOOL_POLICY_OPTIONS) {
      expect(policyHintKey(option.id)).toBe(option.hintKey);
    }
  });
});
