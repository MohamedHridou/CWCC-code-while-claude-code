/**
 * `cwcc install [--dry-run] [--port N] [--no-autostart]` — merge CWCC hooks into the GLOBAL
 * ~/.claude/settings.json so every Claude Code session (any project, any directory) feeds the local
 * daemon. Merge-only, backed up, reversible (invariant #3).
 *
 * By default it also registers a `SessionStart` hook that auto-starts the daemon in the background, so the
 * user never has to run `cwcc start` — install once and every future session just works. `--no-autostart`
 * installs event hooks only (you start the daemon yourself).
 *
 * Safe by construction:
 *   1. generate the install token (0600) if missing,
 *   2. back the settings file up verbatim to settings.json.cwcc.bak (once),
 *   3. merge-only via mergeHooks() (never touches existing hooks),
 *   4. --dry-run prints a unified diff and writes nothing,
 *   5. write atomically (temp + rename),
 *   6. record what we added to installed.json for a surgical uninstall.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '../shared/constants.js';
import { log } from '../shared/logger.js';
import {
  claudeDir,
  configPath,
  installedRecordPath,
  settingsBackupPath,
  settingsPath,
} from '../shared/paths.js';
import { ensureToken } from '../shared/token.js';
import {
  HOOK_EVENTS,
  HOOK_MARKER,
  buildAutostartCommand,
  mergeHooks,
  unifiedDiff,
} from './settings-merge.js';

export interface InstallOptions {
  dryRun?: boolean;
  port?: number;
  /** Register the SessionStart auto-start hook (default true). */
  autostart?: boolean;
  /** Auto-stop the daemon once every Claude Code session ends (default true; only with autostart). */
  autoStop?: boolean;
}

function readJson(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (raw.length === 0) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Atomic write: temp file in the same dir, then rename (same-volume, POSIX + Windows). */
export function writeAtomic(path: string, contents: string): void {
  const tmp = join(dirname(path), `.${Date.now()}.${process.pid}.tmp`);
  writeFileSync(tmp, contents, { mode: 0o644 });
  renameSync(tmp, path);
}

function detectClaudeVersion(): string | null {
  try {
    return execFileSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/** Absolute path to the installed `cwcc` CLI entry (index.js), a sibling of this module. */
function cliEntryPath(): string {
  return fileURLToPath(new URL('./index.js', import.meta.url));
}

export function install(opts: InstallOptions): void {
  const port = opts.port ?? DEFAULT_PORT;
  const autostart = opts.autostart !== false; // default ON
  const autoStop = autostart && opts.autoStop !== false; // default ON (only meaningful with autostart)
  const file = settingsPath();

  // 1. token (also creates ~/.claude/cwcc with 0700).
  ensureToken();

  // 2/3. compute the next settings object (merge-only). The auto-start command is resolved per-machine
  // (this node binary + this installed CLI), so it stays portable across everyone who installs.
  const autostartCommand = autostart
    ? buildAutostartCommand(process.execPath, cliEntryPath(), port, autoStop)
    : null;
  const before = readJson(file);
  const after = mergeHooks(before, port, { autostartCommand });
  const beforeStr = JSON.stringify(before, null, 2);
  const afterStr = JSON.stringify(after, null, 2) + '\n';

  const claude = detectClaudeVersion();

  if (opts.dryRun) {
    process.stdout.write(
      `cwcc install --dry-run (port ${port}, autostart ${autostart ? 'on' : 'off'})\n`,
    );
    process.stdout.write(
      `Claude Code: ${claude ?? 'NOT DETECTED on PATH (install will still write hooks)'}\n`,
    );
    process.stdout.write(`Target: ${file}\n\n`);
    process.stdout.write(unifiedDiff(beforeStr, JSON.stringify(after, null, 2)) + '\n');
    process.stdout.write('\nNothing written (dry run). Re-run without --dry-run to apply.\n');
    return;
  }

  // 4. backup once (only if the file exists and we have not backed it up before).
  if (existsSync(file) && !existsSync(settingsBackupPath())) {
    copyFileSync(file, settingsBackupPath());
    log.info('settings backed up', { backup: settingsBackupPath() });
  }

  // 5. atomic write.
  if (!existsSync(claudeDir())) {
    // ensureToken already made ~/.claude/cwcc, so ~/.claude exists — defensive only.
    writeFileSync(join(claudeDir(), '.keep'), '');
  }
  writeAtomic(file, afterStr);

  // 6. record for surgical uninstall + persist chosen port so the UI/daemon agree.
  writeAtomic(
    installedRecordPath(),
    JSON.stringify(
      {
        marker: HOOK_MARKER,
        port,
        autostart,
        autoStop,
        events: autostart ? [...HOOK_EVENTS, 'SessionStart'] : HOOK_EVENTS,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  writeAtomic(configPath(), JSON.stringify({ port }, null, 2) + '\n');

  log.info('cwcc hooks installed', { file, port, autostart, autoStop });

  const url = `http://127.0.0.1:${port}`;
  process.stdout.write('✓ CWCC installed into your global Claude Code config.\n');
  process.stdout.write(`  ${file}\n`);
  if (existsSync(settingsBackupPath())) {
    process.stdout.write(`  Backup: ${settingsBackupPath()}\n`);
  }
  if (!claude) {
    process.stdout.write(
      '\n  Note: `claude` was not found on your PATH. The hooks are written and will work once\n' +
        '  Claude Code can run; verify with `cwcc doctor`.\n',
    );
  }

  if (autostart) {
    const lifecycle = autoStop
      ? 'The daemon auto-starts with each Claude Code session and stops once your last session ends.\n'
      : 'The daemon auto-starts with each Claude Code session (and keeps running until `cwcc stop`).\n';
    process.stdout.write(
      '\n' +
        lifecycle +
        'No `cwcc start` needed.\n' +
        `Open the UI:  ${url}\n` +
        'Use Claude Code from ANY project — a drill appears whenever a turn is busy.\n\n' +
        'Undo anytime:  cwcc uninstall\n',
    );
  } else {
    process.stdout.write(
      '\nAuto-start is OFF. Start the daemon yourself and leave it running:\n' +
        `  cwcc start          (UI on ${url})\n` +
        'Use Claude Code from ANY project — a drill appears whenever a turn is busy.\n\n' +
        'Undo anytime:  cwcc uninstall\n',
    );
  }
}
