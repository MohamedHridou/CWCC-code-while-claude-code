/**
 * The ONE adapter mapping Claude Code's raw hook payload -> the normalized PROTOCOL `CwccEvent`.
 * Do not scatter this mapping anywhere else (ARCHITECTURE §8).
 *
 * Claude Code passes a JSON object on the hook (stdin for `command` hooks / POST body for `http` hooks)
 * containing at least `hook_event_name` and `session_id`, plus event-specific fields:
 *   - PreToolUse:  `tool_name`, `tool_input`
 *   - SubagentStop/Start: subagent context (may carry an agent id / type)
 * Field names confirmed against Claude Code 2.1.x. Extend the maps here if a version differs.
 */

import type { CwccEvent, CwccEventType, RawClaudeEvent } from '../shared/protocol.js';

const EVENT_NAMES: Record<string, CwccEventType> = {
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolBatch: 'PostToolBatch',
  Stop: 'Stop',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  SessionEnd: 'SessionEnd',
};

/**
 * Map a raw Claude Code hook payload to a `CwccEvent`, or `null` if it is not an event we consume.
 * Never throws — a malformed payload is dropped and logged by the caller (invariant #6).
 */
export function adaptEvent(raw: RawClaudeEvent): CwccEvent | null {
  const name = typeof raw.hook_event_name === 'string' ? raw.hook_event_name : undefined;
  if (!name) return null;

  const event = EVENT_NAMES[name];
  if (!event) return null;

  const sessionId =
    typeof raw.session_id === 'string' && raw.session_id.length > 0 ? raw.session_id : 'unknown';

  const agentId = typeof raw.agent_id === 'string' && raw.agent_id.length > 0 ? raw.agent_id : null;

  const tool = typeof raw.tool_name === 'string' && raw.tool_name.length > 0 ? raw.tool_name : null;

  const out: CwccEvent = { event, sessionId, agentId, tool };
  if (typeof raw.timestamp === 'number') out.ts = raw.timestamp;
  return out;
}
