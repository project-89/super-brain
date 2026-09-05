# Super Brain Capture Daemon

The capture daemon is a headless, harness-neutral local sensor. Claude Code,
Codex, and other harnesses can POST lifecycle and tool hooks to its loopback-only
HTTP listener. Every accepted hook is secret-redacted into a private artifact
vault and its canonical events are durably spooled before delivery to Super Brain.

It captures session/project identity, prompts as private artifact references,
tool calls and outcomes, relative file changes, test/build/lint verification,
structured reasoning checkpoints, human decisions, session trajectories, and a
stable transcript import after `SessionEnd`. Tool results and individual checks
retain explicit success, failure, or unknown. Task success requires authenticated
operator acceptance bound to the task, attempt, and current repository revision.
Passing a check or ending a response does not establish task acceptance.

The Claude installer subscribes to the full current lifecycle surface,
including subagents, tasks, permissions, compaction, model switches, worktrees,
elicitation, configuration changes, watched high-value project files, and stop
failures. Hook-derived file collections are emitted across numbered canonical
pages instead of being clipped. Hooks without a richer domain mapping are still retained in the vault and emitted as canonical
`harness_event` observations. Stop failures become failed trajectory outcomes.

Raw exposed reasoning is excluded from transcript artifacts by default. With
explicit opt-in, the daemon stores complete incremental transcript deltas in the
private encrypted/redacted vault and adds exposed summaries to periodic
canonical reasoning trees. Opaque provider reasoning has a separate retention
switch; it is preserved as evidence but cannot be decrypted by Super Brain.

New configurations encrypt redacted vault artifacts with a separate AES-256-GCM
key. Existing configurations can enable future encrypted writes with
`enable-vault-encryption`, followed by a daemon restart.

```sh
SUPER_BRAIN_CAPTURE_TOKEN=... super-brain-capture init --organization local
super-brain-capture install-hooks
super-brain-capture install-service
super-brain-capture status
```

Capture settings can be changed from the Brain settings dialog with the
dedicated operator token or from the CLI. Configuration changes restart the
installed service:

```sh
super-brain-capture configure --reasoning include \
  --encrypted-reasoning retain --reasoning-trees summaries \
  --tree-every 25 --anonymize none
super-brain-capture rotate-operator-token
super-brain-capture install-service
```

The loopback-only `GET /artifacts/:source/:sha256` endpoint requires the
separate `x-super-brain-operator-token`. It decrypts already redacted transcript
records in cursor pages for the History UI; vault files remain encrypted at
rest, and secret redaction is never disabled.

`GET /hook-artifacts/:source/:artifactId` uses the same operator boundary and
decrypts one secret-redacted raw hook record for Fleet inspection. Canonical
activity links to these records without copying raw payloads into the Fold log.

`--anonymize pseudonymous` retains stable keyed joins while hiding identity and
absolute-path segments. `strict` also obscures full paths, URLs, and IP
addresses. Secret redaction always runs, including in `none` mode. A zero tree
interval disables periodic snapshots without changing finalization.

Reading exposed local reasoning is an explicit terminal action:

```sh
super-brain-capture inspect-reasoning --session SESSION_ID --limit 100 --confirm
```

Integrity-manifest exports use `SUPER_BRAIN_EXPORT_TOKEN` when the capture
sensor credential is intentionally write-only. Raw-hook retention is dry-run by
default and never removes canonical events or redacted transcript artifacts.
Quarantined permanent failures can be reviewed with `retry-failed` and returned
to the durable delivery queue only with `retry-failed --confirm` after their
underlying compatibility or authorization issue has been corrected. If newer
events already made the original timestamp impossible to append, use the
additional explicit `--rebase-events`; the reissued event retains its original
ID in capture identity.

Agents can publish deliberate, concise reasoning and operator verdicts without
exposing private transcript content:

```sh
printf '%s' '{"session_id":"...","summary":"Cache invalidation is the leading hypothesis","evidence":"Focused test fails before refresh"}' \
  | super-brain-capture checkpoint codex

printf '%s' '{"session_id":"...","summary":"Operator accepted the verified result","confidence":1}' \
  | super-brain-capture decision codex
```


## Receipt durability and authority

Run one daemon per state directory. The relay saves a redacted, encrypted
occurrence in `stateRoot/receipts/sender` before contacting the daemon. A 202
acknowledgement means the receiver has durably accepted that occurrence; Git,
transcript processing, and canonical delivery happen afterward. Receipt IDs
survive retries indefinitely; identical payloads with different occurrence IDs
remain separate observations. An explicit `--receipt-id` reuses a producer's
occurrence identity. The daemon replays pending sender files after downtime.

Receiver processing first saves an encrypted prepared state/event batch, then
syncs the resulting step journals, state and outbound jobs before creating a
completion tombstone. Startup finishes prepared batches before hydrating state.
Transient failures retain ordering. Invalid payloads remain in an encrypted
`receipts/receiver/rejected` directory for inspection. `/health` includes receipt
pending, completed, rejected and failure counts. A relay timeout is an ambiguous
acknowledgement, not evidence that a hook was lost.

`/decision`, and any `HumanDecision` submitted through `/hook`, require the
separate `x-super-brain-operator-token`. Hook credentials cannot attest human
provenance. Legacy configurations sharing hook/operator tokens must rotate the
operator token before authoritative decisions are enabled. The CLI `decision`
command uses the operator credential. Caller-selected `authority` fields and a
bare `verdict` do not establish accepted outcomes.

An optional decision `acceptance` object has `version: 1`, `taskId`, `attemptId`,
`revisionId` and `verdict: "success" | "failure"`. All identifiers must match the
active captured attempt and freshly observed Git/worktree fingerprint; unknown
or failed fingerprints cannot accept a task. Operator authority is added by the
server, outside the caller's payload, and retained with the protected artifact.
Completion tombstones preserve canonical event digests for independently
verifying this provenance. Old events without this evidence remain historical
claims, not authenticated acceptance.

Daemon timers report capture silence as unknown liveness. Only observed hooks
and explicit session-end signals attest host lifecycle. Repository fingerprints
include bounded untracked file content and fail explicitly on unavailable Git,
nonregular untracked files, concurrent edits or more than 16 MiB of untracked
content. They are integrity references; reconstructible patch/file artifacts
are a separate task-evidence capability.
