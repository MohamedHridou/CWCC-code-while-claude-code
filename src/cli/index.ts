#!/usr/bin/env node
/**
 * `cwcc` CLI entrypoint. Dispatches to the subcommands defined in CLAUDE.md.
 *
 * This dispatcher is intentionally dependency-free so `cwcc --help` works before anything else exists.
 * Lifecycle (start/stop/status) is coordinated through a PID file at ~/.claude/cwcc/daemon.pid.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '../shared/constants.js';
import { log } from '../shared/logger.js';
import { cwccDir, pidPath } from '../shared/paths.js';

const HELP = `cwcc — Code While Claude Code

Usage:
  cwcc install [--dry-run] [--port <n>] [--no-autostart] [--keep-alive]
                                         Merge hooks into the global settings.json (backup first).
                                         Auto-starts the daemon each session (unless --no-autostart) and
                                         stops it when your last session ends (unless --keep-alive).
  cwcc uninstall                         Remove only CWCC hook entries
  cwcc start [--port <n>] [--background] Start the daemon (default port ${DEFAULT_PORT})
  cwcc stop                              Stop the running daemon
  cwcc status                            Show daemon status
  cwcc doctor                            Diagnose Claude Code, hooks, daemon, token, port
  cwcc --help                            Show this help
`;

type Command = 'install' | 'uninstall' | 'start' | 'stop' | 'status' | 'doctor';

function parsePort(args: string[]): number {
  const i = args.indexOf('--port');
  if (i !== -1 && args[i + 1]) {
    const n = Number(args[i + 1]);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return DEFAULT_PORT;
}

function readPid(): number | null {
  try {
    const n = Number(readFileSync(pidPath(), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pingDaemon(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function startForeground(port: number, exitWhenIdle: boolean): Promise<number> {
  const { startDaemon } = await import('../daemon/server.js');
  await startDaemon({ port, exitWhenIdle }).ready; // throws on EADDRINUSE etc.
  writeFileSync(pidPath(), String(process.pid), { mode: 0o644 });
  const cleanup = () => {
    try {
      rmSync(pidPath(), { force: true });
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.stdout.write(`cwcc daemon listening on http://127.0.0.1:${port}  (Ctrl-C to stop)\n`);
  // Long-lived: never resolve.
  return await new Promise<number>(() => {});
}

function startBackground(port: number, exitWhenIdle: boolean): number {
  const existing = readPid();
  if (existing && isAlive(existing)) {
    process.stdout.write(`cwcc daemon already running (pid ${existing}).\n`);
    return 0;
  }
  const self = fileURLToPath(import.meta.url);
  const spawnArgs = [self, 'start', '--port', String(port)];
  if (exitWhenIdle) spawnArgs.push('--exit-when-idle');
  const child = spawn(process.execPath, spawnArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  process.stdout.write(
    `cwcc daemon started in the background (pid ${child.pid}) on http://127.0.0.1:${port}\n` +
      `Open http://127.0.0.1:${port} — stop it with \`cwcc stop\`.\n`,
  );
  return 0;
}

async function run(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    switch (cmd as Command) {
      case 'install': {
        const { install } = await import('./install.js');
        install({
          dryRun: args.includes('--dry-run'),
          port: parsePort(args),
          autostart: !args.includes('--no-autostart'),
          autoStop: !args.includes('--keep-alive'),
        });
        return 0;
      }
      case 'uninstall': {
        const { uninstall } = await import('./uninstall.js');
        uninstall();
        return 0;
      }
      case 'start': {
        const port = parsePort(args);
        const exitWhenIdle = args.includes('--exit-when-idle');
        if (args.includes('--background') || args.includes('-b'))
          return startBackground(port, exitWhenIdle);
        return await startForeground(port, exitWhenIdle);
      }
      case 'stop': {
        const pid = readPid();
        if (!pid || !isAlive(pid)) {
          rmSync(pidPath(), { force: true });
          process.stdout.write('cwcc daemon is not running.\n');
          return 0;
        }
        process.kill(pid, 'SIGTERM');
        rmSync(pidPath(), { force: true });
        process.stdout.write(`Stopped cwcc daemon (pid ${pid}).\n`);
        return 0;
      }
      case 'status': {
        const port = parsePort(args);
        const pid = readPid();
        const running = pid !== null && isAlive(pid);
        const reachable = await pingDaemon(port);
        if (running && reachable) {
          process.stdout.write(`running — pid ${pid}, http://127.0.0.1:${port}\n`);
        } else if (reachable) {
          process.stdout.write(`running (no pid file) — http://127.0.0.1:${port}\n`);
        } else if (running) {
          process.stdout.write(`pid ${pid} alive but not answering on port ${port}\n`);
        } else {
          process.stdout.write('stopped\n');
        }
        return 0;
      }
      case 'doctor': {
        const { doctor } = await import('./doctor.js');
        await doctor();
        return 0;
      }
      default:
        process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    // CLI errors are fine to surface to the user's terminal (this is NOT the hook path).
    log.error('cli command failed', { cmd, error: String(err) });
    process.stderr.write(`cwcc ${cmd}: ${(err as Error).message}\n`);
    return 1;
  }
}

// Ensure the data dir exists for pid/token writes on lifecycle commands.
try {
  if (!existsSync(cwccDir())) mkdirSync(cwccDir(), { recursive: true, mode: 0o700 });
} catch {
  /* non-fatal */
}

run(process.argv.slice(2)).then((code) => process.exit(code));
