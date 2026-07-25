import { describe, expect, it } from 'vitest';
import {
  HOOK_MARKER,
  buildAutostartCommand,
  buildCommand,
  hasAutostartHook,
  hasCwccHooks,
  mergeHooks,
  removeHooks,
  unifiedDiff,
} from '../../src/cli/settings-merge.js';

// TESTING Layer 1 — the scariest code path (settings.json mutation). Pure, no filesystem.

describe('settings-merge', () => {
  it('the built command is fire-and-forget and carries the marker', () => {
    const cmd = buildCommand(9999);
    expect(cmd).toContain('http://127.0.0.1:9999/api/event');
    expect(cmd).toContain('|| true'); // never fails the turn
    expect(cmd).toContain('-m 1'); // 1s cap
    expect(cmd).toContain(`# ${HOOK_MARKER}`);
  });

  it('merge adds a CWCC group for every lifecycle event; PreToolUse/PostToolUse get a matcher', () => {
    const out = mergeHooks({}, 9999);
    const hooks = out.hooks!;
    expect(Object.keys(hooks).sort()).toEqual(
      [
        'PostToolUse',
        'PreToolUse',
        'SessionEnd',
        'Stop',
        'SubagentStop',
        'UserPromptSubmit',
      ].sort(),
    );
    expect(hooks.PreToolUse[0].matcher).toBe('*');
    expect(hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(hasCwccHooks(out)).toBe(true);
  });

  it('merge is idempotent and never touches non-CWCC hooks', () => {
    const userHook = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'my-logger' }],
          },
        ],
      },
    };
    const once = mergeHooks(userHook, 9999);
    const twice = mergeHooks(once, 9999);
    expect(twice).toEqual(once); // idempotent

    // user's own entries survive verbatim, first, in each event array.
    expect(once.hooks!.UserPromptSubmit[0]).toEqual({
      hooks: [{ type: 'command', command: 'echo hi' }],
    });
    expect(once.hooks!.PreToolUse[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'my-logger' }],
    });
    // exactly one CWCC group appended per touched event.
    expect(once.hooks!.UserPromptSubmit).toHaveLength(2);
    expect(once.hooks!.PreToolUse).toHaveLength(2);
  });

  it('uninstall removes only tagged entries and drops emptied event keys', () => {
    const userHook = {
      other: { keep: true },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    };
    const installed = mergeHooks(userHook, 9999);
    const removed = removeHooks(installed);

    // user's UserPromptSubmit hook stays; CWCC-only events (Stop, SessionEnd, …) are gone entirely.
    expect(removed.hooks!.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: 'echo hi' }] },
    ]);
    expect(removed.hooks!.Stop).toBeUndefined();
    expect(removed.hooks!.SessionEnd).toBeUndefined();
    expect(hasCwccHooks(removed)).toBe(false);
    expect((removed as { other: unknown }).other).toEqual({ keep: true }); // untouched
  });

  it('round-trip (install -> uninstall) equals the original', () => {
    const original = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'my-logger' }],
          },
        ],
      },
      permissions: { allow: ['Read'] },
    };
    const roundTripped = removeHooks(mergeHooks(original, 9999));
    expect(roundTripped).toEqual(original);
  });

  it('round-trip on empty settings yields empty settings (no stray hooks key)', () => {
    const roundTripped = removeHooks(mergeHooks({}, 9999));
    expect(roundTripped).toEqual({});
    expect(roundTripped.hooks).toBeUndefined();
  });

  it('unifiedDiff marks only added lines', () => {
    const before = 'a\nb\nc';
    const after = 'a\nX\nb\nc';
    const d = unifiedDiff(before, after);
    expect(d).toContain('+ X');
    expect(d.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(0);
  });

  it('the autostart command uses absolute paths, is fire-and-forget, and is tagged', () => {
    const cmd = buildAutostartCommand('/usr/bin/node', '/opt/cwcc/index.js', 9999);
    expect(cmd).toContain('"/usr/bin/node"'); // quoted → tolerates spaces
    expect(cmd).toContain('"/opt/cwcc/index.js"');
    expect(cmd).toContain('start --background --port 9999');
    expect(cmd).toContain('|| true'); // never fails session start
    expect(cmd).toContain(`# ${HOOK_MARKER}`);
    expect(cmd).not.toContain('--exit-when-idle'); // off by default
  });

  it('the autostart command adds --exit-when-idle when requested', () => {
    const cmd = buildAutostartCommand('/n', '/c', 9999, true);
    expect(cmd).toContain('start --background --port 9999 --exit-when-idle');
  });

  it('with an autostart command, merge adds a tagged SessionStart hook', () => {
    const cmd = buildAutostartCommand('/n', '/c', 9999);
    const out = mergeHooks({}, 9999, { autostartCommand: cmd });
    expect(hasAutostartHook(out)).toBe(true);
    expect(out.hooks!.SessionStart).toHaveLength(1);
    expect(out.hooks!.SessionStart[0].hooks![0].command).toBe(cmd);
  });

  it('without an autostart command, no SessionStart hook is added', () => {
    const out = mergeHooks({}, 9999);
    expect(out.hooks!.SessionStart).toBeUndefined();
    expect(hasAutostartHook(out)).toBe(false);
  });

  it('autostart preserves a user SessionStart hook and round-trips surgically', () => {
    const original = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'my-context-loader' }] }],
      },
    };
    const cmd = buildAutostartCommand('/n', '/c', 9999);
    const installed = mergeHooks(original, 9999, { autostartCommand: cmd });
    expect(installed.hooks!.SessionStart).toHaveLength(2); // user's + ours
    expect(installed.hooks!.SessionStart[0]).toEqual({
      hooks: [{ type: 'command', command: 'my-context-loader' }],
    });
    expect(removeHooks(installed)).toEqual(original); // ours gone, user's intact
  });

  it('autostart merge is idempotent', () => {
    const cmd = buildAutostartCommand('/n', '/c', 9999);
    const once = mergeHooks({}, 9999, { autostartCommand: cmd });
    const twice = mergeHooks(once, 9999, { autostartCommand: cmd });
    expect(twice).toEqual(once);
  });
});
