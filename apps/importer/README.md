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
that excludes exposed thinking/reasoning and encrypted provider content by
default, scans secrets, and writes a content-addressed `0600` artifact into a
caller-selected vault. A caller may independently opt into exposed and opaque
reasoning retention; the canonical bundle records each policy but not the text.

Source directories are never modified.

After reviewing a scan, an explicit import stores secret-scanned, reasoning-free
JSONL in a local content-addressed vault and sends only the canonical metadata
bundle to an owner-authorized Super Brain API:

```bash
FOLD_API_TOKEN=... pnpm --filter @_89/super-brain-importer start -- import \
  --source all --api-url http://127.0.0.1:3000 \
  --organization local --workspace local-history \
  --vault ~/.super-brain/transcript-vault \
  --reasoning include --encrypted-reasoning retain \
  --anonymize pseudonymous \
  --anonymization-key ~/.config/super-brain/anonymization.key \
  --confirm
```

`FOLD_API_URL`, `FOLD_API_ORGANIZATION`, `FOLD_API_WORKSPACE`, `FOLD_TRANSCRIPT_VAULT`, and
`FOLD_ANONYMIZATION_KEY_FILE` may replace
their command-line options. Credentials are accepted only through
`FOLD_API_TOKEN`, keeping them out of command arguments and CLI output. Network,
rate-limit, and transient server failures are retried; an exact rerun is an
API-level no-op.

For an interrupted import into the same workspace and vault, add `--resume`.
The importer loads committed run IDs from the authenticated API and skips only
those runs, avoiding repeated redaction and delivery of completed artifacts.
Uncommitted runs still pass source-stability, redaction, and delivery checks.


## Native interpretation and historical compatibility

`NativeTranscriptNormalizer(source, nativeRunId, { parserVersion })` is the
shared local decoder for metadata and private text consumers. `push(record)`
emits canonical turn identity, messages, tool actions, context and explicit
success/failure/unknown results. Allocate identity before filtering boilerplate
or empty text. Tool-only records still belong to their canonical turns.
`normalizeNativeRecord` provides the pure source adapter without identity state.

New imports use parser version 2. Existing immutable version 1 imports are never
rewritten. If delivery conflicts with an older interpretation of the exact same
source bytes, an authorized read verifies artifact SHA, source, parser identity,
and native/run identity before returning `interpretation: "retained-existing"`.
This acknowledges retained history and does not claim that version 2 metadata
was committed. Changed source bytes still conflict. Historical text consumers
must use the **catalog artifact's** parser version; version 1 compatibility
preserves its Claude implicit-turn identity. A separate explicit reinterpretation
migration is required to publish revised canonical historical metadata.

Encryption keys are published atomically so concurrent first-use relay processes
cannot read partially written keys. New key directories and vault materialization
use durable file/directory syncs.
