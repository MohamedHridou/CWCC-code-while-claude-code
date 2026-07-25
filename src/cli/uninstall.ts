/**
 * `cwcc uninstall` — remove ONLY CWCC-tagged hook entries from the global settings.json (surgical, not a
 * blind restore of the .bak — the user may have added hooks since). ARCHITECTURE §8, invariant #3.
 *
 * Leaves the token, stats, and logs in place (they are harmless and let a re-install keep your streak).
 * Prints how to remove those too, if the user wants a clean slate.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { log } from '../shared/logger.js';
import { cwccDir, installedRecordPath, settingsBackupPath, settingsPath } from '../shared/paths.js';
import { writeAtomic } from './install.js';
import { hasCwccHooks, removeHooks } from './settings-merge.js';

function readJson(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (raw.length === 0) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

export function uninstall(): void {
  const file = settingsPath();
  const before = readJson(file);

  if (before === null || !existsSync(file)) {
    process.stdout.write('Nothing to uninstall — no settings.json found.\n');
    return;
  }

  if (!hasCwccHooks(before)) {
    process.stdout.write('No CWCC hooks found in settings.json — nothing to remove.\n');
  } else {
    const after = removeHooks(before);
    writeAtomic(file, JSON.stringify(after, null, 2) + '\n');
    log.info('cwcc hooks removed', { file });
    process.stdout.write('✓ Removed CWCC hook entries from your global Claude Code config.\n');
    process.stdout.write(`  ${file}\n`);
  }

  if (existsSync(installedRecordPath())) {
    rmSync(installedRecordPath(), { force: true });
  }

  if (existsSync(settingsBackupPath())) {
    process.stdout.write(`  Original backup kept at: ${settingsBackupPath()}\n`);
  }
  process.stdout.write(
    '\nYour token, stats, and logs are kept (so a re-install preserves your streak).\n' +
      `To wipe everything: rm -rf ${cwccDir()}\n`,
  );
}
