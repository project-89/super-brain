# Provenance

`@_89/fold-fleet` is a Super Brain implementation. No production source file is
copied from a sibling workspace.

## Tmux Manager

- Repository: `git@github.com:HaruHunab1320/tmux-manager.git`
- Commit: `d5fd340b3de33957e0ecb016b1f2738ded386267`
- Declared package license: MIT; no tracked `LICENSE` file was present
- Inspected committed files: `src/tmux-manager.ts`, `src/tmux-session.ts`,
  `src/types.ts`, and related tests
- Excluded dirty file: untracked `REPORT_TERMINAL_SENSORS.md`

Session lifecycle, status, blocking, stall, tool, and completion categories are
retained as behavioral evidence. Process management and tmux host code are not
included.

## Parallax

- Repository: `git@github.com:HaruHunab1320/parallax.git`
- Commit: `e3c98ebba4b3e29959325f2f974cee27c32a24a6`
- License: Apache-2.0 (`LICENSE` present at the pinned commit)
- Inspected committed files:
  - `packages/control-plane/src/agent-runtime/agent-runtime-service.ts`
  - its runtime service tests
- Excluded dirty files: untracked `REPORT_PARALLAX.md` and
  `patterns/gateway-dryrun.org.yaml`

The local package reimplements identity mapping and runtime-health projection as
an event-log rebuild. The missing pinned-source behaviors, boot reconstruction
and timeout-based orphan detection, are implemented locally as pure functions.
Network clients, role orchestration, and runtime spawning remain host concerns.
