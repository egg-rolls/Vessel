import { describe, expect, it } from 'bun:test';
import {
  FEDERATION_INVALID_ADDRESS,
  formatFederationAddress,
  isFederationAddress,
  parseFederationAddress,
} from '../federation-address';

function okAddress(raw: string) {
  const parsed = parseFederationAddress(raw);
  if (!parsed.ok) throw new Error(`expected ${raw} to parse: ${parsed.message}`);
  return parsed.address;
}

function expectInvalid(raw: string) {
  const parsed = parseFederationAddress(raw);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.code).toBe(FEDERATION_INVALID_ADDRESS);
  // 错误消息是固定文案，不回显输入（超长 / 控制字符不进 stderr）。
  expect(parsed.message.length).toBeLessThan(200);
  if (raw.length > 0) expect(parsed.message).not.toContain(raw);
}

describe('parseFederationAddress', () => {
  it('parses principal@node:team including the reserved owner principal', () => {
    expect(okAddress('owner@node-b:lab')).toEqual({
      principal: 'owner',
      node_id: 'node-b',
      team_id: 'lab',
    });
    expect(okAddress('alice@node-a:another-lab')).toEqual({
      principal: 'alice',
      node_id: 'node-a',
      team_id: 'another-lab',
    });
    expect(okAddress('a_b-c@NODE_1:team2')).toEqual({
      principal: 'a_b-c',
      node_id: 'NODE_1',
      team_id: 'team2',
    });
  });

  it('accepts each segment at its 64-character boundary', () => {
    const principal = 'p'.repeat(64);
    const node = 'n'.repeat(64);
    const team = `t${'e'.repeat(63)}`;
    expect(okAddress(`${principal}@${node}:${team}`)).toEqual({
      principal,
      node_id: node,
      team_id: team,
    });
  });

  it('rejects a second @ instead of splitting at the first one', () => {
    expectInvalid('alice@node-a@node-b:lab');
    expectInvalid('a@b@c:d');
  });

  it('rejects a missing @ or :', () => {
    expectInvalid('alice@node-a');
    expectInvalid('alice:node-a');
    expectInvalid('alice');
    expectInvalid('');
  });

  it('rejects empty segments', () => {
    expectInvalid('@node-a:lab');
    expectInvalid('alice@:lab');
    expectInvalid('alice@node-a:');
  });

  it('rejects an extra colon in the node/team part', () => {
    expectInvalid('alice@node-a:lab:extra');
    expectInvalid(':alice@node-a:lab');
  });

  it('rejects characters outside the segment alphabets', () => {
    expectInvalid('ali ce@node-a:lab');
    expectInvalid('alice.name@node-a:lab');
    expectInvalid('alice@node.a:lab');
    expectInvalid('alice@node-a:Lab');
    expectInvalid('alice@node-a:lab_x');
    expectInvalid(' alice@node-a:lab');
    expectInvalid('alice@node-a:lab ');
  });

  it('rejects over-long segments without echoing the input', () => {
    expectInvalid(`${'p'.repeat(65)}@node-a:lab`);
    expectInvalid(`alice@${'n'.repeat(65)}:lab`);
    expectInvalid(`alice@node-a:${'t'.repeat(65)}`);
    expectInvalid(`${'p'.repeat(65)}@${'n'.repeat(65)}:${'t'.repeat(65)}`);
  });
});

describe('formatFederationAddress / isFederationAddress', () => {
  it('round-trips a parsed address', () => {
    const address = okAddress('eggrolls@node-b:lab');
    expect(formatFederationAddress(address)).toBe('eggrolls@node-b:lab');
    expect(isFederationAddress('eggrolls@node-b:lab')).toBe(true);
  });

  it('reports malformed input as not an address', () => {
    expect(isFederationAddress('eggrolls@node-b')).toBe(false);
    expect(isFederationAddress('owner@node-b:lab:extra')).toBe(false);
  });
});
