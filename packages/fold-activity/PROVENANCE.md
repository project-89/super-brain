# Provenance

`@_89/fold-activity` is a Super Brain implementation. Production code has no
runtime or filesystem dependency on the referenced workspaces.

## PTY State Capture

- Repository: `git@github.com:HaruHunab1320/pty-state-capture.git`
- Commit: `29bbff378ac51dbfb0197b26022bb9aa383f0bb2`
- Declared package license: MIT; no tracked `LICENSE` file was present
- Inspected committed files:
  - `src/normalize.ts`
  - `src/state-rules.ts`
  - `src/session-capture.ts`
  - `src/types.ts`
  - related tests
- Excluded dirty file: untracked `REPORT_TERMINAL_SENSORS.md`

The local package reimplements terminal normalization, source-scoped rule
classification, bounded recent-tail behavior, and Gemini state stability against
package-owned types. It excludes VT frame emulation, JSONL storage, transcript
construction, and session I/O.

## Tmux Manager

- Repository: `git@github.com:HaruHunab1320/tmux-manager.git`
- Commit: `d5fd340b3de33957e0ecb016b1f2738ded386267`
- Declared package license: MIT; no tracked `LICENSE` file was present
- Inspected committed files:
  - `src/tmux-manager.ts`
  - `src/tmux-session.ts`
  - `src/types.ts`
  - related tests
- Excluded dirty file: untracked `REPORT_TERMINAL_SENSORS.md`

The local signal union mirrors the centralized session transition categories,
but does not import adapters, tmux transport, timers, auto-response behavior, or
process management.

## Haunt

- Repository: local `hauntjs` workspace, pinned to origin commit
  `4c675c63cbbf870b34fd9fed48b26f58e2b9eed1`
- License: MIT (`LICENSE` present at the pinned commit)
- Inspected committed file: `docs/MEMORY-AND-FOLD.md`
- Excluded later local commits and dirty files

Haunt contributes the contract only: lifecycle, observation, and derived belief
are distinct; preprocessors may compress observations but cannot infer meaning;
silence requires lifecycle coverage. No Haunt implementation was imported.
