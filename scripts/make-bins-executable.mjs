/**
 * Post-build: mark the CLI entry points executable so a local `npm link` works (tsc emits 0644, which
 * makes the symlinked `cwcc` fail with EACCES). Published installs get this from npm automatically, but
 * local development / linking needs it. No-op on Windows, where the exec bit is irrelevant.
 */
import { chmodSync } from 'node:fs';

if (process.platform !== 'win32') {
  for (const f of ['dist/cli/index.js', 'dist/emit/emit.js']) {
    try {
      chmodSync(f, 0o755);
    } catch {
      /* build may run before a file exists; ignore */
    }
  }
}
