# @_89/fold-storage

Versioned JSONL persistence and deterministic reopen for `@_89/fold`.

The package provides:

- one validated event or checkpoint record per line;
- serialized, complete-line appends with optional `fsync`;
- streaming reads with explicit strict and torn-tail recovery policies;
- canon or canon-plus-draft replay through the Fold kernel;
- materialized-state checkpoints verified against preceding event records; and
- atomic whole-journal rewrites for compaction and repair tooling.

Recovery is deliberately narrow. `recover-truncated-tail` ignores only invalid
JSON in the final unterminated line. Complete malformed lines and schema-invalid
records always fail.

Checkpoint component set `core-v0.7` requires no configuration. A checkpoint
created with custom Fold components must carry a distinct `componentSet` name,
and readers must supply that registry when verification is enabled.
