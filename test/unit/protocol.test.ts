import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/shared/protocol.js';

describe('parseClientMessage (untrusted WS input validation)', () => {
  it('accepts the three valid message types', () => {
    expect(parseClientMessage({ type: 'subscribe' })).toEqual({
      type: 'subscribe',
    });
    expect(parseClientMessage({ type: 'ping' })).toEqual({ type: 'ping' });
    expect(
      parseClientMessage({
        type: 'challenge_result',
        mode: 'bug-hunt',
        outcome: 'solved',
        ms: 4200,
        seed: 7,
      }),
    ).toEqual({
      type: 'challenge_result',
      mode: 'bug-hunt',
      outcome: 'solved',
      ms: 4200,
      seed: 7,
    });
  });

  it('rejects unknown types, bad enums, and non-numeric fields', () => {
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage('subscribe')).toBeNull();
    expect(parseClientMessage({ type: 'evil' })).toBeNull();
    expect(
      parseClientMessage({
        type: 'challenge_result',
        mode: 'chess',
        outcome: 'solved',
        ms: 1,
        seed: 1,
      }),
    ).toBeNull();
    expect(
      parseClientMessage({
        type: 'challenge_result',
        mode: 'bug-hunt',
        outcome: 'won',
        ms: 1,
        seed: 1,
      }),
    ).toBeNull();
    expect(
      parseClientMessage({
        type: 'challenge_result',
        mode: 'bug-hunt',
        outcome: 'solved',
        ms: 'x',
        seed: 1,
      }),
    ).toBeNull();
    expect(
      parseClientMessage({
        type: 'challenge_result',
        mode: 'bug-hunt',
        outcome: 'solved',
        ms: 1,
        seed: 1.5,
      }),
    ).toBeNull();
    expect(
      parseClientMessage({
        type: 'challenge_result',
        mode: 'bug-hunt',
        outcome: 'solved',
        ms: Infinity,
        seed: 1,
      }),
    ).toBeNull();
  });

  it('accepts new modes and carries a valid itemId, dropping bad ones', () => {
    const withId = parseClientMessage({
      type: 'challenge_result',
      mode: 'mcq',
      outcome: 'solved',
      ms: 900,
      seed: 3,
      itemId: 'py-mcq-001',
    });
    expect(withId && 'itemId' in withId ? withId.itemId : null).toBe('py-mcq-001');
    const code = parseClientMessage({
      type: 'challenge_result',
      mode: 'code',
      outcome: 'failed',
      ms: 1,
      seed: 1,
    });
    expect(code && 'mode' in code ? code.mode : null).toBe('code');
    const badId = parseClientMessage({
      type: 'challenge_result',
      mode: 'mcq',
      outcome: 'solved',
      ms: 1,
      seed: 1,
      itemId: 'x'.repeat(65),
    });
    expect(badId && 'itemId' in badId ? 'present' : 'absent').toBe('absent');
  });

  it('clamps ms into sane bounds', () => {
    const neg = parseClientMessage({
      type: 'challenge_result',
      mode: 'syntax',
      outcome: 'failed',
      ms: -50,
      seed: 1,
    });
    expect(neg && 'ms' in neg ? neg.ms : -1).toBe(0);
    const huge = parseClientMessage({
      type: 'challenge_result',
      mode: 'syntax',
      outcome: 'failed',
      ms: 1e12,
      seed: 1,
    });
    expect(huge && 'ms' in huge ? huge.ms : -1).toBe(3_600_000);
  });
});
