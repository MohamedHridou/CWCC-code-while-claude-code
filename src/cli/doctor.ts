/**
 * `cwcc doctor` — a shipped diagnostic (TESTING Layer 4), the first thing users run when something's off.
 *
 * Reports, with a clear ✓ / ✗ / ! and a remediation line each:
 *   - Node version (>= 20),
 *   - Claude Code detected on PATH + version,
 *   - CWCC hooks present in the global settings.json,
 *   - install token present,
 *   - daemon reachable on the configured port,
 *   - web UI built.
 *
 * Read-only: doctor never mutates anything.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { get } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '../shared/constants.js';
import { configPath, settingsPath } from '../shared/paths.js';
import { tokenExists } from '../shared/token.js';
import { hasAutostartHook, hasCwccHooks } from './settings-merge.js';

type Status = 'ok' | 'warn' | 'fail';
interface Check {
  status: Status;
  label: string;
  detail: string;
  fix?: string;
}

const ICON: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗' };

function readPort(): number {
  try {
    const cfg = JSON.parse(readFileSync(configPath(), 'utf8'));
    if (cfg && typeof cfg.port === 'number') return cfg.port;
  } catch {
    /* fall through */
  }
  return DEFAULT_PORT;
}

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 20
    ? { status: 'ok', label: 'Node.js', detail: `v${process.versions.node}` }
    : {
        status: 'fail',
        label: 'Node.js',
        detail: `v${process.versions.node} (need >= 20)`,
        fix: 'Upgrade Node to v20 or newer.',
      };
}

function checkClaude(): Check {
  try {
    const v = execFileSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    return { status: 'ok', label: 'Claude Code', detail: v };
  } catch {
    return {
      status: 'warn',
      label: 'Claude Code',
      detail: 'not found on PATH',
      fix: 'Install Claude Code and ensure `claude` is on your PATH.',
    };
  }
}

function checkHooks(): Check {
  const file = settingsPath();
  if (!existsSync(file)) {
    return {
      status: 'fail',
      label: 'Global hooks',
      detail: 'no settings.json',
      fix: 'Run `cwcc install`.',
    };
  }
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return hasCwccHooks(s)
      ? { status: 'ok', label: 'Global hooks', detail: `installed in ${file}` }
      : {
          status: 'fail',
          label: 'Global hooks',
          detail: 'settings.json has no CWCC entries',
          fix: 'Run `cwcc install`.',
        };
  } catch {
    return {
      status: 'fail',
      label: 'Global hooks',
      detail: 'settings.json is not valid JSON',
      fix: 'Fix or remove the malformed settings.json, then `cwcc install`.',
    };
  }
}

function checkAutostart(): Check {
  try {
    const s = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return hasAutostartHook(s)
      ? {
          status: 'ok',
          label: 'Auto-start',
          detail: 'daemon starts with each session',
        }
      : {
          status: 'warn',
          label: 'Auto-start',
          detail: 'off — you start the daemon manually',
          fix: 'Re-run `cwcc install` (auto-start is on by default), or run `cwcc start`.',
        };
  } catch {
    return {
      status: 'warn',
      label: 'Auto-start',
      detail: 'unknown (no readable settings.json)',
      fix: 'Run `cwcc install`.',
    };
  }
}

function checkToken(): Check {
  return tokenExists()
    ? { status: 'ok', label: 'Install token', detail: 'present' }
    : {
        status: 'warn',
        label: 'Install token',
        detail: 'missing',
        fix: 'Run `cwcc install` (or `cwcc start`) to generate it.',
      };
}

function checkWebBuilt(): Check {
  const index = fileURLToPath(new URL('../../web/dist/index.html', import.meta.url));
  return existsSync(index)
    ? { status: 'ok', label: 'Web UI', detail: 'built' }
    : {
        status: 'fail',
        label: 'Web UI',
        detail: 'not built',
        fix: 'Run `npm run build` in the CWCC package.',
      };
}

function checkDaemon(port: number): Promise<Check> {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
      res.resume();
      resolve({
        status: 'ok',
        label: 'Daemon',
        detail: `reachable on 127.0.0.1:${port}`,
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({
        status: 'warn',
        label: 'Daemon',
        detail: `not responding on 127.0.0.1:${port}`,
        fix: 'Start it with `cwcc start`.',
      });
    });
    req.on('error', () => {
      resolve({
        status: 'warn',
        label: 'Daemon',
        detail: `not running on 127.0.0.1:${port}`,
        fix: 'Start it with `cwcc start`.',
      });
    });
  });
}

export async function doctor(): Promise<void> {
  const port = readPort();
  const checks: Check[] = [
    checkNode(),
    checkClaude(),
    checkWebBuilt(),
    checkHooks(),
    checkAutostart(),
    checkToken(),
    await checkDaemon(port),
  ];

  process.stdout.write('cwcc doctor\n\n');
  for (const c of checks) {
    process.stdout.write(`  ${ICON[c.status]} ${c.label.padEnd(14)} ${c.detail}\n`);
    if (c.fix && c.status !== 'ok') process.stdout.write(`      → ${c.fix}\n`);
  }

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  process.stdout.write(
    `\n${fails === 0 && warns === 0 ? 'All good.' : `${fails} problem(s), ${warns} warning(s).`}\n`,
  );
}
