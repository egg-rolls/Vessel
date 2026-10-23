import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TeamMessageRow, type TeamMessageView } from '../src/domains/team/TeamMessageRow';
import { TeamTranscript } from '../src/domains/team/TeamTranscript';
import type { TeamMessage } from '../src/gateway/types';
import { teamMember } from './team-fixtures';

const TEAM = 'team-alpha';

function message(overrides: Partial<TeamMessage> & { message_id: string }): TeamMessageView {
  return {
    team_id: TEAM,
    from: 'human',
    to: [],
    mentions: [],
    content: '',
    ts: 1_700_000_000_000,
    kind: 'post',
    ...overrides,
  };
}

describe('TeamMessageRow', () => {
  test('renders queued and rejected deliveries separately', () => {
    const html = renderToStaticMarkup(
      <TeamMessageRow
        message={{
          ...message({ message_id: 'm-delivery', content: 'go' }),
          deliveries: [
            { agent_id: 'agent-alpha', status: 'queued', resolution: 'live' },
            {
              agent_id: 'agent-beta',
              status: 'rejected',
              code: 'agent_left',
              reason: 'not present',
            },
          ],
        }}
      />,
    );
    expect(html).toContain('team-delivery-queued');
    expect(html).toContain('team-delivery-error');
    expect(html).toContain('agent_left');
    // 消息本身不应因为部分投递失败而整条失败。
    expect(html).not.toContain('team-message-failed');
  });

  test('unknown system event falls back to the raw content', () => {
    const html = renderToStaticMarkup(
      <TeamMessageRow
        message={message({
          message_id: 'm-system-unknown',
          from: 'system',
          kind: 'system',
          content: 'CUSTOM SYSTEM CONTENT',
        })}
      />,
    );
    expect(html).toContain('CUSTOM SYSTEM CONTENT');
  });

  test('system notice resolves the subject from to[0], not from=system', () => {
    const html = renderToStaticMarkup(
      <TeamTranscript
        messages={[
          message({
            message_id: 'm-system-join',
            from: 'system',
            to: ['agent-alpha'],
            kind: 'system',
            system_event: 'join',
            content: 'RAW JOIN CONTENT',
          }),
        ]}
        resolveMember={(agentId) => (agentId === 'agent-alpha' ? teamMember() : undefined)}
        resolveMemberLabel={(agentId) => (agentId === 'agent-alpha' ? 'Alpha' : undefined)}
      />,
    );
    expect(html).toContain('Alpha');
    expect(html).not.toContain('RAW JOIN CONTENT');
  });

  test('a non-roster agent log is not misclassified as the current human', () => {
    const html = renderToStaticMarkup(
      <TeamMessageRow
        message={message({
          message_id: 'm-left-agent',
          from: 'agent-left',
          content: 'historical post',
        })}
        senderLabel="agent-le"
      />,
    );
    expect(html).toContain('team-message-agent');
    expect(html).not.toContain('team-message-self');
  });
});
