# Super Brain Transcript Importer

Read-only inventory and import preparation for Claude Code, Codex, Gemini, and
Hermes history. The default `scan` command performs no writes and emits aggregate
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
Reasoning exclusion targets known provider assistant envelopes and content parts.
User messages, tool arguments, and tool-result application data are not removed
merely because they contain reasoning-like keys or XML tags. Secret scanning still
applies to their strings.

Source directories are never modified.

## Project identity review

`project-identities --report PATH` reads authorized project/run metadata and
produces a private, exclusive `0600` report of evidence-backed reconciliation
candidates. Supply API, organization, and workspace options or their existing
`FOLD_API_*` environment variables; credentials use `FOLD_API_TOKEN` only.
Runs are cursor-paginated. Console output is aggregate-only; no project changes
are made. Candidates require shared normalized remotes or exact filesystem-path
evidence, never names alone. Conflicting remotes remain flagged for review, and
no canonical winner is chosen. See [project identity review](../../docs/PROJECT_IDENTITY_REVIEW.md)
for usage, normalization limits, coverage, and follow-up reconciliation gates.

## Native Gemini and Hermes Archives

`--source gemini` discovers `session-*.json` conversation snapshots under
`~/.gemini/tmp` (override with `--gemini-root`). Native session IDs remain stable.
Project roots are resolved only when an adjacent `.project_root` matches the
conversation's SHA-256 project hash. Otherwise the native project hash remains
an explicitly estimated project, never a guessed filesystem path. Gemini's newer
append-only `session-*.jsonl` format is detected and reported as unsupported,
not silently interpreted as a JSON snapshot or partially imported.

`--source hermes` reads legacy `session_*.json` logs under `~/.hermes/logs` and
sessions in `~/.hermes/state.db`. `HERMES_HOME`, `--hermes-root`, and `--hermes-db`
override these locations. Supplying a custom logs root excludes the default DB
unless `--hermes-db` is explicit. SQLite support requires Node.js 22.13 or later.
The database is opened read-only and each session is read in a transaction,
including its WAL-backed messages. The source artifact hash commits to that
session's serialized snapshot, not the mutable database file. An unrelated
session update cannot invalidate it; changes to the same session before storage
fail with a retry request. Native timestamps are seconds since epoch; legacy
naive timestamps are retained but not assigned an invented timezone.

Scan file/unit counts include one unit per SQLite session and its serialized
byte count. Missing optional roots are skipped; malformed or unsupported inputs
are reported as failures. Session snapshots are deduplicated by native run ID.
Both formats retain metadata followed by individual source messages as JSONL,
preserving unfamiliar fields. Reasoning exclusions, independent opaque-signature
retention, anonymization, secret scanning, and optional vault encryption apply
before any archive is written. Tool cancellation and results without explicit
status remain unknown, and no tool result implies overall task success.

The memory worker understands native dialogue/turn allocation, while historical
reprocessing extracts usage, tool results, and explicit parent-session metadata.
Neither adapter recovers already truncated/deleted provider output or creates
events that were never recorded. These are archive adapters, not new live hook
installers or filesystem watchers.

Format references: [Gemini conversation types](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts)
and [Hermes session lifecycle](https://github.com/NousResearch/hermes-agent/blob/main/docs/session-lifecycle.md).

`scan` includes active and archived Codex session directories by default and
reports record-type frequencies, unclassified types, and tool-result status
counts. To retain a private, versioned inventory bound to each input file's hash:

```sh
pnpm --filter @_89/super-brain-importer start -- scan --report /tmp/transcript-inventory.json
```

The report is metadata only, written with mode 0600, and an existing file is never
overwritten. This is a derived local inventory, not a canonical reimport or a
rewrite of old runs. Unclassified records remain explicitly counted. A custom
`--codex-root` excludes the default archive unless `--codex-archive-root` is also
supplied. A default scan without `--report` still performs no writes.

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

## Historical reprocessing

`reprocess` reads authorized imported-run identities from the API and processes
their retained vault artifacts. It does not rescan active source directories or
rewrite historical imports. It extracts usage, agent messages/communication,
web searches, and explicit tool-result outcomes into separate canonical
`transcript.derivation-*` events. Unknown tool outcomes stay unknown; unfamiliar
source types remain in a diagnostic inventory. These are evidence records,
not new captured actions, accepted memories, task verdicts, or causal trees.

```bash
pnpm --filter @_89/super-brain-importer start -- reprocess \
  --api-url http://127.0.0.1:3003 --organization local --workspace local-history \
  --vault .data/transcript-vault \
  --vault-key ~/.config/super-brain/vault.key \
  --state .data/reprocessing
```

Supply an owner/admin credential through `FOLD_API_TOKEN`. The default is a dry
run: private staging/report files are written, but no canonical events. Add
`--confirm` to apply; `--run-id ID` or `--limit N` narrows the work. Repeat the
same command to resume. The server's manifest and committed chunks, not a local
success flag, determine what remains to upload. Every run rewrites the private
`report.json` atomically. A lock prevents overlapping runners sharing a state
directory; after an unclean exit, verify its PID is no longer running before
removing `reprocess.lock`. Staging is removed on normal completion or failure.

Parser v3 adds explicit tool-result statuses and Gemini/Hermes native evidence.
Existing v1/v2 derivations remain immutable; reprocessing is an explicit operator
action, not an automatic rewrite. Ambiguous output remains `unknown`.

Each immutable manifest records parser version, original run/artifact identity,
original source hash, the retained-input hash, the original retention policy,
and checksums of ordered chunks. `inputSha256` hashes decrypted nonblank JSONL
lines with a trailing LF each; it is not asserted equal to the original source
hash because capture-time policy transformations may change the content.
Reprocessing cannot recover content excluded or redacted before retention.
Malformed archives and oversized individual records fail explicitly, without
truncation. Version 2 losslessly wraps payloads containing NUL or unpaired UTF-16
surrogates as `dataEncoding: "base64-json-utf8"` with `data.base64`; decode Base64,
UTF-8, then JSON to recover the original object. The Runs UI decodes this form.

Runs expose a paginated **Derived evidence** section. Versions, completeness,
record-type counts, unclassified types, both hashes, and retained line numbers
remain inspectable. Treat only complete derivations as complete datasets, choose
one version per run, and do not sum usage snapshots as independent token totals.
