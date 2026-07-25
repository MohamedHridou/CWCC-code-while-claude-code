import { describe, expect, it } from 'vitest';
import { adaptEvent } from '../../src/daemon/events.js';

describe('events adapter (raw Claude payload -> CwccEvent)', () => {
  it('maps the standard fields', () => {
    const ev = adaptEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'abc',
      tool_name: 'Bash',
      timestamp: 1234,
    });
    expect(ev).toEqual({
      event: 'PreToolUse',
      sessionId: 'abc',
      agentId: null,
      tool: 'Bash',
      ts: 1234,
    });
  });

  it('maps subagent events with agent_id', () => {
    const ev = adaptEvent({
      hook_event_name: 'SubagentStop',
      session_id: 's',
      agent_id: 'a1',
    });
    expect(ev?.event).toBe('SubagentStop');
    expect(ev?.agentId).toBe('a1');
  });

  it('drops events we do not consume', () => {
    expect(adaptEvent({ hook_event_name: 'Notification', session_id: 's' })).toBeNull();
    expect(adaptEvent({ hook_event_name: 'SessionStart', session_id: 's' })).toBeNull();
  });

  it('drops payloads without an event name and never throws', () => {
    expect(adaptEvent({})).toBeNull();
    expect(adaptEvent({ session_id: 's' })).toBeNull();
    expect(adaptEvent({ hook_event_name: 42 as unknown as string })).toBeNull();
  });

  it('falls back to "unknown" session id', () => {
    const ev = adaptEvent({ hook_event_name: 'Stop' });
    expect(ev?.sessionId).toBe('unknown');
  });
});
