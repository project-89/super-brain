# Super Brain Transcript Importer

Read-only inventory and import preparation for Claude Code and Codex JSONL
history. The default `scan` command performs no writes and emits aggregate
metadata only:

```bash
pnpm --filter @_89/super-brain-importer build
pnpm --filter @_89/super-brain-importer start -- scan --source all
```

The library adapters stream source JSONL, preserve source-qualified project/run
identity, and emit bounded canonical metadata chunks. Transcript text is not
placed in Fold records. `storeRedactedArtifact` is an explicit local operation
that strips private thinking/reasoning blocks, scans secrets, and writes a
content-addressed `0600` artifact into a caller-selected vault.

Source directories are never modified.

After reviewing a scan, an explicit import stores secret-scanned, reasoning-free
JSONL in a local content-addressed vault and sends only the canonical metadata
bundle to an owner-authorized Super Brain API:

```bash
FOLD_API_TOKEN=... pnpm --filter @_89/super-brain-importer start -- import \
  --source all --api-url http://127.0.0.1:3000 --workspace local \
  --vault ~/.super-brain/transcript-vault --confirm
```

`FOLD_API_URL`, `FOLD_API_WORKSPACE`, and `FOLD_TRANSCRIPT_VAULT` may replace
their command-line options. Credentials are accepted only through
`FOLD_API_TOKEN`, keeping them out of command arguments and CLI output. Network,
rate-limit, and transient server failures are retried; an exact rerun is an
API-level no-op.

For an interrupted import into the same workspace and vault, add `--resume`.
The importer loads committed run IDs from the authenticated API and skips only
those runs, avoiding repeated redaction and delivery of completed artifacts.
Uncommitted runs still pass source-stability, redaction, and delivery checks.
