import { describe, expect, test } from 'bun:test';
import {
  EMPTY_PERMISSION_LISTS,
  isPolicyEditable,
  policyHintKey,
  readPermissionLists,
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

  test('honors tool.action entries and does not match other tools by prefix', () => {
    const lists = { autoApprove: [], neverAutoApprove: ['agent.close'] };
    expect(toolPolicyOf(lists, 'agent')).toBe('never');
    expect(toolPolicyOf(lists, 'agen')).toBe('ask');
    expect(toolPolicyOf({ autoApprove: ['bashing'], neverAutoApprove: [] }, 'bash')).toBe('ask');
  });
});

describe('isPolicyEditable', () => {
  test('disables always-allow tools', () => {
    expect(isPolicyEditable({ name: 'read', has_permission_check: true })).toBe(false);
    expect(isPolicyEditable({ name: 'subscribe', has_permission_check: true })).toBe(false);
  });

  test('enables tools with a permission check or the core capability tools', () => {
    expect(isPolicyEditable({ name: 'mcp__srv__echo', has_permission_check: true })).toBe(true);
    expect(isPolicyEditable({ name: 'agent', has_permission_check: false })).toBe(true);
    expect(isPolicyEditable({ name: 'bash', has_permission_check: false })).toBe(true);
  });

  test('disables tools that never ask', () => {
    expect(isPolicyEditable({ name: 'mystery', has_permission_check: false })).toBe(false);
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
