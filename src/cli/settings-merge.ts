/**
 * settings.json mutation — the scariest code path (merge-only, reversible, backed up).
 *
 * These functions are PURE (settings-in → settings-out) so they are unit-testable without touching the
 * filesystem. The install/uninstall commands do the I/O (backup, atomic write); this module only decides
 * *what the next settings object should be*.
 *
 * Guarantees:
 *   - merge-only: existing (non-CWCC) hooks are never modified or reordered.
 *   - tagged: every CWCC-created hook command carries HOOK_MARKER as a trailing shell comment, so
 *     uninstall is surgical (not a blind restore of the .bak — the user may have added hooks since).
 *   - idempotent: re-merging replaces only the CWCC group for each event.
 *   - round-trip safe: mergeHooks then removeHooks yields an object deep-equal to the original.
 */

/** Claude Code lifecycle events CWCC listens to. Order matches the emitted hook block. */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStop',
  'Stop',
  'SessionEnd',
] as const;

/** Events whose hook groups take a tool `matcher`. */
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

/**
 * Stable sentinel appended (as a shell comment) to every CWCC-managed hook command. `# ...` is a no-op
 * comment in POSIX shells, so it never affects execution — it only lets uninstall find our entries.
 */
export const HOOK_MARKER = 'cwcc-managed-hook';

interface HookLeaf {
  type?: string;
  command?: string;
  timeout?: number;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookLeaf[];
  [k: string]: unknown;
}
type Settings = Record<string, unknown> & {
  hooks?: Record<string, HookGroup[]>;
};

/**
 * The fire-and-forget delivery command. curl caps at 1s and `|| true` guarantees the hook can never fail
 * the user's Claude Code turn; if the daemon is down the event is silently dropped (invariant #1). The
 * token is read from disk at runtime, so settings.json holds no secret.
 */
export function buildCommand(port: number): string {
  return (
    `curl -s -m 1 -X POST http://127.0.0.1:${port}/api/event ` +
    `-H "X-CWCC-Token: $(cat $HOME/.claude/cwcc/token 2>/dev/null)" ` +
    `--data-binary @- >/dev/null 2>&1 || true # ${HOOK_MARKER}`
  );
}

/**
 * The daemon auto-start command for the SessionStart hook. Runs `cwcc start --background`, which is
 * idempotent (a no-op if the daemon is already up), fully detached and silenced so it never delays or
 * pollutes a session. Absolute node + CLI paths make it independent of the user's PATH, and `|| true`
 * guarantees it can never fail a session start. Resolved per-machine at install time, so it is portable.
 */
export function buildAutostartCommand(
  nodePath: string,
  cliPath: string,
  port: number,
  exitWhenIdle = false,
): string {
  const idle = exitWhenIdle ? ' --exit-when-idle' : '';
  return `"${nodePath}" "${cliPath}" start --background --port ${port}${idle} >/dev/null 2>&1 || true # ${HOOK_MARKER}`;
}

function leaf(port: number): HookLeaf {
  return { type: 'command', command: buildCommand(port), timeout: 5 };
}

function group(evt: string, port: number): HookGroup {
  return MATCHER_EVENTS.has(evt) ? { matcher: '*', hooks: [leaf(port)] } : { hooks: [leaf(port)] };
}

function leafIsCwcc(l: HookLeaf): boolean {
  return typeof l.command === 'string' && l.command.includes(HOOK_MARKER);
}

/** A group is CWCC-owned iff it has hooks and every leaf carries our marker. */
function groupIsCwcc(g: HookGroup): boolean {
  return Array.isArray(g.hooks) && g.hooks.length > 0 && g.hooks.every(leafIsCwcc);
}

function cloneSettings(settings: unknown): Settings {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    return { ...(settings as Settings) };
  }
  return {};
}

export interface MergeOptions {
  /**
   * When set, register a `SessionStart` hook running this command so the daemon auto-starts with every
   * Claude Code session (no manual `cwcc start`). Build it with `buildAutostartCommand`. Omit/null to
   * install event hooks only.
   */
  autostartCommand?: string | null;
}

/** Merge CWCC hook groups into a settings object without disturbing existing hooks. Pure. */
export function mergeHooks(settings: unknown, port: number, opts: MergeOptions = {}): Settings {
  const next = cloneSettings(settings);
  const srcHooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
  const hooks: Record<string, HookGroup[]> = { ...srcHooks };

  for (const evt of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[evt]) ? hooks[evt] : [];
    const userGroups = existing.filter((g) => !groupIsCwcc(g)); // idempotent: drop our old group
    hooks[evt] = [...userGroups, group(evt, port)];
  }

  // SessionStart auto-start (optional). Keep any user-owned SessionStart hooks; replace only ours.
  const userSessionStart = (Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []).filter(
    (g) => !groupIsCwcc(g),
  );
  if (opts.autostartCommand) {
    hooks.SessionStart = [
      ...userSessionStart,
      {
        hooks: [{ type: 'command', command: opts.autostartCommand, timeout: 10 }],
      },
    ];
  } else if (userSessionStart.length > 0) {
    hooks.SessionStart = userSessionStart;
  } else {
    delete hooks.SessionStart;
  }

  next.hooks = hooks;
  return next;
}

/** Remove only CWCC-tagged hook groups; drop an event key if that empties it. Pure. */
export function removeHooks(settings: unknown): Settings {
  const next = cloneSettings(settings);
  if (!next.hooks || typeof next.hooks !== 'object') return next;

  const hooks: Record<string, HookGroup[]> = {};
  for (const [evt, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[evt] = groups;
      continue;
    }
    const kept = groups.filter((g) => !groupIsCwcc(g));
    if (kept.length > 0) hooks[evt] = kept; // else: drop the now-empty event key
  }

  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

/** True if the settings object currently contains any CWCC-tagged hook. */
export function hasCwccHooks(settings: unknown): boolean {
  const s = cloneSettings(settings);
  if (!s.hooks || typeof s.hooks !== 'object') return false;
  return Object.values(s.hooks).some((groups) => Array.isArray(groups) && groups.some(groupIsCwcc));
}

/** True if the settings object has a CWCC-tagged SessionStart (auto-start) hook. */
export function hasAutostartHook(settings: unknown): boolean {
  const s = cloneSettings(settings);
  const groups = s.hooks?.SessionStart;
  return Array.isArray(groups) && groups.some(groupIsCwcc);
}

/**
 * Compact line-based unified diff (LCS) for `--dry-run`. Not a full patch format — just enough for a
 * human to eyeball exactly what install/uninstall would change.
 */
export function unifiedDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push('  ' + a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push('- ' + a[i++]);
    } else {
      out.push('+ ' + b[j++]);
    }
  }
  while (i < n) out.push('- ' + a[i++]);
  while (j < m) out.push('+ ' + b[j++]);
  return out.join('\n');
}
