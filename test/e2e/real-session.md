# E2E — real Claude Code session checklist (TESTING Layer 3)

A manual gate run on each OS (macOS / Linux / Windows) before a release tag. Not automated — a live
Claude Code session is required.

## Install

- [ ] `cwcc install --dry-run` — inspect the unified settings.json diff; confirm it only adds CWCC-tagged
      hook entries and touches nothing else.
- [ ] `cwcc install` — confirm the backup `settings.json.cwcc.bak` is written and the token file is `0600`.
- [ ] `cwcc doctor` — Claude Code detected + version, hooks present, daemon reachable, token present, no
      port conflict.

## Turn window feel

- [ ] In a real session, run a deliberately slow step (`bash: sleep 20`) — a challenge appears within the
      first second and clears cleanly at turn end.
- [ ] Run a pure-reasoning prompt (no tools) — the challenge still fills the whole turn (this is the case
      the old PreToolUse-only design would have missed).
- [ ] Focus is NEVER stolen from the terminal on any event.

## Late-joiner sync

- [ ] Open a second browser tab mid-turn — the challenge is already in progress with the correct remaining
      time (server-computed `elapsedMs`).

## Resilience

- [ ] Force-kill the daemon mid-turn — Claude Code is unaffected (no delay, no error) and the UI recovers
      on daemon restart / reconnect.

## Uninstall

- [ ] `cwcc uninstall` — confirm `settings.json` hooks equal the pre-install state (surgical removal of
      only CWCC-tagged entries).
