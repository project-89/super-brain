# Provenance

The append-and-replay pattern was reimplemented after inspection of:

- repository: `git@github.com:HaruHunab1320/pty-state-capture.git`
- commit: `29bbff378ac51dbfb0197b26022bb9aa383f0bb2`
- package version: `0.2.1`
- package license declaration: MIT
- inspected files: `src/jsonl-writer.ts`, `src/replay.ts`, related tests and README
- inspected: 2026-08-14

The source repository's only dirty entry was the untracked
`REPORT_TERMINAL_SENSORS.md`; it was not used. No source file was copied. The
source behavior of complete JSON objects separated by newlines and offline
replay is retained; Fold-specific validation, recovery, checkpoints, streaming,
and concurrency behavior is implemented locally.
