# Phase 1 capture and importer handoff

Implementation is in the isolated `super-brain-remediation` worktree. No live
configuration, corpus, daemon or original checkout binaries were changed.

## Changed boundaries and verification

Capture owns `apps/capture-daemon/src/{capture,evidence,receipts,server,main,storage,project,recovery,types,index}.ts`.
Importer owns `apps/importer/src/{native,adapters,builder,delivery,encryption,main,index}.ts`.
`fold-transcript` already allowed action status `unknown`; its schema needed no
change. No worker, MCP, Fold trace/trajectory, SDK, API, or shared client source
was modified by this track.

Scoped verification: capture 44 tests pass (including ten new integrity cases),
importer 23 tests pass (including native-source identity, source-result honesty,
concurrent first-use key publication and immutable parser migration). Capture
build/typecheck and importer build pass. Independent platform-agent review
confirmed capture 44/44, importer 23/23 and resolved the reported filesystem
sync, transient ordering, revision freshness and restart watermark issues.
The root repository gate runs separately on Node 24.

The live/recovery contract uses explicit result flags/codes, keeps checks separate
from acceptance, and repairs guessed legacy step descriptions during recovery.
An orphan timer records `CaptureTimeout` with `liveness: "unknown"`; it does not
emit an offline event or manufacture host heartbeats.

## Native decoder for the memory worker

Exported by `@_89/super-brain-importer`:

```ts
type EvidenceResult = "success" | "failure" | "unknown";
explicitToolResult(value: unknown): EvidenceResult;
normalizeNativeRecord(source: TranscriptSource, record: Record<string, unknown>): NativeRecord;
nativeTextContent(value: unknown): string;
new NativeTranscriptNormalizer(source, nativeRunId, { parserVersion?: "1" | "2" });
normalizer.push(record): NormalizedNativeRecord;
```

`NormalizedNativeRecord` includes optional `turn: {id, ordinal, nativeId?}` plus
`messages`, `actions`, optional context (`cwd`, `branch`, `remote`, `model`,
`clientVersion`, `at`) and `unknown`. Messages retain source role, private text,
and optional native ID. Actions distinguish `call` and `result`, with optional
native ID/name, selected private text and explicit result. Identity is allocated
before consumer filtering, including empty/tool-only/boilerplate records.

The metadata builder consumes this same stream through `TranscriptBuilder.consume`.
The worker should filter private text afterward and deduplicate message/action
IDs consistently. It must obtain `parserVersion` from the **canonical catalog
artifact**, not guess from native bytes. Version 1 preserves the older Claude
string-only assistant implicit-turn behavior; missing historical version means
legacy interpretation, not proof of v2 canonical turn metadata.

New parser metadata is version 2. `deliverTranscriptBundle` retries remain
idempotent for exact requests. On a 409 involving a strictly older parser of the
same bytes/source/parser identity/native run/run/artifact identity, an authorized
GET may return `{ imported: false, eventCount: 0, interpretation:
"retained-existing", run: <original> }`. New canonical parsing was **not** committed.
Different bytes still conflict. Historical reinterpretation requires an explicit
versioned metadata migration; old immutable metadata is not rewritten here.

## Operator authority and task acceptance

Exported from capture:

```ts
interface HookAuthority {
  kind: "local-operator";
  principalId: string;
  authenticatedAt: string;
}
interface TaskAcceptanceEvidence {
  version: 1;
  taskId: string;
  attemptId: string;
  revisionId: string;
  verdict: "success" | "failure";
  artifactId: string;
  eventId?: string;
  authority: HookAuthority;
}
normalizeHookEvidence(payload): NormalizedHookEvidence;
repositoryRevisionId(project): string | undefined;
normalizeTaskAcceptance(input, authority, expected): TaskAcceptanceEvidence | undefined;
```

All `HumanDecision` ingress—including a supplied hook event name at `/hook`—
requires a distinct operator credential. The server constructs authority outside
payload under principal `operator:<configured sensorId>`. Agent payload authority
is ignored. Shared hook/operator credentials fail closed for human attestation.
The MCP hook credential is insufficient; MCP-reported human intervention can
remain an unverified proposal through a separately named agent surface later.

`terminal.observation` with `observation: "human_decision"` contains
`data.authority`; valid explicitly supplied acceptance adds `data.acceptance` and
`data.verdict`. A bare caller `verdict` is not authoritative task acceptance.
Acceptance must name the current canonical task and attempt IDs and freshly
observed repository revision. Git failure, changed tracked/untracked state, or
wrong task/attempt rejects acceptance. Task finalization refreshes the fingerprint
again. Passing tests/lint/build does not set task success; all individual checks
remain in `CaptureSession.checks` with result, artifact/event and available revision.

This phase preserves typed acceptance in the private session and the canonical
acceptance observation. Phase 3 must also persist the attempt manifest and exact
acceptance linkage in the trajectory record. Phase 2 must not assume arbitrary
nested canonical JSON is trusted just because it spells `local-operator`.

## Private receipt witness for Phase 2 promotion

The planned worker port is an optional, fail-closed
`verifyCapturedEvent(event: FoldEvent): Promise<boolean>`, supplied as a closure
over explicitly configured trusted sensor, local state/vault roots and keys.
The helper itself belongs to Phase 2; it is not yet wired into worker promotion.

The evidence for that helper now exists:

- Hook artifacts carry `receiptId` and server-owned `authority` outside payload.
- Receiver prepared records contain the resulting local Fold events and next
  state; publishing them is recoverable after a process or host crash.
- Encrypted completion tombstones contain `eventDigests[event.id]`, calculated by
  exported `capturedEventDigest` with recursive stable key ordering.
- The canonical generic event append route preserves the parsed event bytes;
  JSON object key order alone cannot change the witness digest.

Verify exact event digest, configured producer identity and scope, matching
artifact/receipt, and the authority/acceptance evidence. For trajectory promotion,
resolve its exact acceptance observation and compare task/attempt/revision joins.
A witness for some unrelated event or a successful trajectory label is insufficient.
Old receipts without a witness remain reviewable proposals. API-generated trajectory
events are built later from trajectory input and do not have a prepublication
capture event witness; use their referenced acceptance observation.

## Receipt behavior and operational constraints

`HookOutbox` encrypts/redacts each occurrence before network delivery. Receipt IDs
remain stable on retries; distinct identical occurrences receive distinct IDs.
`CaptureReceiptQueue.accept` performs only protected durable acceptance and returns
202 independently of slow Git/processing work. Accepted responses include
`receiptId` and `artifactId`. A producer-supplied occurrence time remains separate
from receiver event time.

Receiver event allocation is seeded from committed state and pending receipts on
startup. A prepared transaction persists complete next state and job batch before
materialization. File and containing/new ancestor directories are synced before
completion; restart materializes prepared work before normal session hydration.
Retryable precommit failures preserve ordering. Invalid `TypeError` payloads become
explicit encrypted rejected receipts; their IDs remain idempotent. Completed
receipts become slim encrypted tombstones in a separate directory, so each drain
scans pending work rather than decrypting full completed history. `/health` exposes
pending/completed/rejected/failure counts.

Still relevant to later phases:

- One daemon owns each state root. Multi-daemon coordination is not implemented.
- A receipt without a producer-provided native identity cannot deduplicate two
  separate producer invocations; explicit `--receipt-id` supports this when known.
- Full current state is staged per capture receipt. Phase 6 should measure and
  bound state/check/journal/tombstone growth, and benchmark on enrolled pilot volume.
- Untracked fingerprinting is limited to 16 MiB and regular files; unsupported,
  changing, or unavailable inputs produce unknown fingerprint status. These are
  integrity digests, not reconstructible artifact snapshots.
- Rejected local payloads are retained for operator inspection; a later processing
  view should expose repair/exclusion actions. A 202 means durable acceptance,
  not successful extraction or eventual canonical delivery.
- Source append delivery, semantic metadata migration, worker coverage, MCP human
  labels and checkpoint promotion require the later assigned integration phases.
