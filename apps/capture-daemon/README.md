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

## Attempt manifests and runtime observations

New finalized trajectories retain a versioned task specification and the original
attempt starting revision. Finalization refreshes the final revision without
replacing the baseline. Optional `task_goal`, `task_version`,
`acceptance_criteria: [{id, description?}]`, `inputs: [{artifactId}]`,
`parent_attempt_id`, and `condition_id` hook fields add explicitly reported task
metadata. Exact prompt/specification bodies remain in redacted private artifacts;
canonical metadata contains references and optional privacy-projected summaries.

The `context` hook field accepts exact `memoryRefs: [{memoryId, revision}]`,
artifact references, and compaction/handoff lineage. Revision zero is valid.
These references describe offered context; they do not prove model use. The API
checks that canonical context sources fit the task's audience and space.
`PreCompact`/`Handoff` records retain the observed context boundary.

Runtime fields are allowlisted from hook metadata and supported native records.
Native model/usage extraction also runs when reasoning capture is excluded.
Absent values remain absent; the old required model-summary field uses
`unreported` with `modelObservation: unavailable`. Zero token counts/cost are
retained when explicitly observed. Each usage-bearing hook creates one dedicated
runtime observation; derived tool/check steps do not duplicate that usage.
Current usage scope and interpretation are explicitly `unknown`, so reports must
not sum them as independent increments or claim attempt totals. Native extraction
reads at most 8 MiB and records at most 100 runtime observations per finalizing
hook; malformed and excluded metadata counts remain visible.

Use `super-brain-capture acceptance-context --source codex --session ID` to obtain
fresh public task/attempt/revision IDs for `decision`. Canonical acceptance and
`manifest.attempt.finalRevision` use the same opaque revision identity. The local
operator boundary also accepts the legacy private Git fingerprint and translates
it before publication. Acceptance may cite criterion IDs from the active task
version. A changed/unavailable final revision removes the acceptance pointer and
cannot retain successful task outcome. Git configurations that hide or transform
tracked bytes (assume-unchanged, skip-worktree, ignored modes, checkout filters
and line-ending transformations) make the fingerprint unavailable.

## Opt-in private repository snapshots

Legacy and newly initialized configurations default to `metadata-only`.
Repository snapshots require a vault key and explicit consent roots and bounds:

```sh
super-brain-capture configure --repository-capture snapshot \
  --repository-root /absolute/project \
  --snapshot-max-bytes 16777216 --snapshot-max-files 1000 \
  --snapshot-untracked include --snapshot-binary include
```

The configured policy applies after the daemon restarts. The implementation never
changes an installed daemon or repository automatically. Untracked and binary
content are excluded unless explicitly enabled. Capture's state/vault/key paths,
including their resolved symlink targets, are excluded from repository content.
The underlying repository fingerprint is bounded to 16 MiB of changed file bytes.

An encrypted snapshot records the required base commit, separate index/worktree
file overlays, deletions, executable modes, and allowed untracked files. NUL Git
records preserve path bytes, including leading spaces and newlines. Original
bytes pass secret redaction before encoding. Redacted text makes reconstruction
partial; binary secrets and unsupported file types are excluded. Git binary
review patches are retained only after their decoded source blobs have passed
the same inspection. Partial snapshots omit all review patches, and patch bytes
count against the storage bound. Changed repositories, hidden tracked files,
symlinks, gitlinks, private paths and limits are reported explicitly.

`reconstruction: complete` describes the supported tracked/visible-untracked
Git overlay **with the separately available base commit**. It is not a full
repository backup, and does not include ignored files, external dependencies or
submodule contents. Canonical references alone do not prove private availability.
To verify a complete snapshot in a new disposable checkout:

```sh
super-brain-capture reconstruct-snapshot --artifact repository-snapshot:HASH \
  --source-repository /absolute/repository-with-base-commit \
  --destination /absolute/new-disposable-checkout
```

The command requires a new destination separate from the source, verifies the
encrypted descriptor and stored bytes, restores the index and working files,
and compares the restored fingerprint to the private source revision. It refuses
partial snapshots and existing destinations. Tests perform this drill only on
synthetic repositories.

Completed encrypted receiver receipts bind each finalized normalized trajectory
command, its stable stamp and privacy-projected capture identity to the original
private/public revision mapping. `createCapturedTrajectoryVerifier` compares the
actual canonical record to that exact witness. A copied acceptance label cannot
attest a different trajectory/checkpoint. Missing legacy witnesses remain
unverified. API principal/workspace fields stay server-owned, and worker promotion
still requires the separate exact acceptance/checkpoint witnesses and the API's
shared-review authorization. Rebasing old outbound jobs does not manufacture new
attestation.


### Local processing status

Set `processingStatusFile` in the capture config, or `SUPER_BRAIN_WORKER_STATUS_FILE` in its process environment, to the memory worker's sanitized `processing-status.json` publication. The default is unconfigured. `GET /processing` requires the separate `x-super-brain-operator-token`; the hook token cannot inspect this endpoint. No request-supplied path is accepted.

The bridge reads at most 64 KiB through a no-follow/nonblocking regular-file descriptor and checks owner-only permissions and current UID on that same descriptor. It validates version and tenant and emits only allowlisted aggregate counts, kind counts, observed time and measured pending lag. Stopped, missing, corrupt, changed, public, symlinked, future-dated and older-than-60-second publications return explicit unavailability rather than zero counts or healthy status. No job IDs, payloads, filesystem paths, credentials or worker principal are returned.
