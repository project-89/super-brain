# Memory authority, evidence, and validity

This contract extends canonical replay. Existing records are retained; the new
projection does not manufacture historical source revisions or human approval.
PostgreSQL remains the supported store for durable state-dependent commands.

## Authority

Personal memories and candidates remain writable only by their creator/proposer.
A workspace member may create, correct, or contribute evidence to workspace-wide
shared memory. Space-scoped shared writes require an explicit writer/admin role
in that space. Platform audit access remains read-only. Candidate acceptance and
rejection retain the separate workspace owner/admin review requirement; a worker
without that role keeps proposals pending.

A correction preserves `creatorId`. The event's authenticated principal is the
actor, and new revision/contribution records retain the authorized scope and
write authority for replay. The SDK also checks current write permissions on
exact receipt retries. Candidate extractor labels, confidence, and nested JSON
claiming human authority are not proof of human approval. Local automatic
promotion requires the private capture witness checks described in the capture
handoff; API authorization independently checks source access and containment.

## Applicability and exact dependencies

`MemoryApplicability` is one of `{kind:"unresolved"}`, `{kind:"global"}`, or
`{kind:"projects",projectIds:[...]}`. Legacy nonempty project lists retain project
applicability; empty/missing legacy lists mean unresolved. An explicit global
claim is required to treat a memory as generally applicable.

`sourceMemoryRefs`, `supersedes`, and `contradicts` contain exact
`{memoryId,revision}` references. New commands resolve those revisions against
currently authorized memory and prevent copying personal or space-restricted
facts into a broader audience. Evidence references similarly resolve actual
canonical events, live capture `identity.repo`/`identity.turn`, or transcript
catalog runs and turns. A transcript project's context segment must match the
cited turn's time interval when available. Ambiguous missing timing is not an
invented project assignment. Project relevance never grants read access.

Projection `currentness` is `current`, `needs-review`, or `superseded`, with
non-sensitive reasons. Changed, forgotten, or inaccessible dependencies invalidate
derivatives transitively. Cycles cannot become current. Legacy continuous
cognition with unversioned citations requires review. Missing evidence and
opposing/contradictory evidence also require review. Default recall, search,
worker memory pages, and reasoning omit unresolved and noncurrent claims.
`includeNeedsReview:true` is an explicit review view; direct authorized lookup
continues to expose the record for correction.

Adding support or tags to a superseded/contradicted claim does not reactivate it.
An explicit summary/content/applicability/dependency/relation correction can
resolve the earlier relation. Every contribution and revision still advances
`memory.revision`, so derivatives bound to any older revision become stale.

## Bounded contributions and accepted snapshots

- `POST /memory-candidates/:id/evidence` accepts `{stamp,input:{evidence}}` for
  pending candidates. Each call contains 1–100 new evidence references.
- `POST /memories/:id/evidence` accepts
  `{stamp,input:{evidence,expectedRevision?}}`, with the same 100-reference cap.
- Each reference may declare `relation:"supports"|"opposes"`; omission retains
  legacy support semantics. Distinct evidence accumulates; repeated references
  are not additional independent corroboration. Actor provenance remains in the
  contribution events.
- Candidate `revision` and `updatedAt` identify accumulated support. Acceptance
  records the exact candidate revision. The recorded memory carries a bounded
  `sourceCandidate:{candidateId,revision,decisionEventId}` pointer to that accepted
  snapshot instead of embedding an arbitrarily large evidence union. The
  projection preserves more than 1,000 accumulated references without increasing
  proposal, contribution, or recorded-memory input limits.
- Pending contributions after a decision fail. New support then targets the
  accepted memory and advances its revision. Backdated contributions cannot
  silently alter a previously accepted snapshot: replay checks base revisions
  and the acceptance's exact source revision before commit.
- `GET /memories/:id/evidence?revision=N&offset=0&limit=100` returns the authorized
  exact revision's bounded evidence page, total, and optional next offset.
  A forgotten or inaccessible memory is unavailable through this route.

## Worker and client ports

The browser-safe shared client provides:

```ts
identity(): Promise<{principalId:string; organizationId?:string; workspaceId:string}>;
transcriptRun(runId): Promise<TranscriptRunDetail | undefined>;
memoryPage({limit?,cursor?,projectIds?,includeNeedsReview?}):
  Promise<{memories:PersonalMemory[];total:number;nextCursor?:string}>;
proposeMemoryCandidate(input, causedBy?, {stamp?});
acceptMemoryCandidate(candidateId, {stamp?,memoryStamp?,memoryId?});
contributeMemoryCandidateEvidence(candidateId, {evidence}, {stamp?});
contributeMemoryEvidence(memoryId, {evidence,expectedRevision?}, {stamp?});
```

`identity()` derives the durable job namespace from the authenticated subject and
resolved tenant membership; tokens and caller-selected principal names are not
job identities. A persisted custom stamp requires a persisted explicit entity
ID. Keep all command fields identical across retries. Conflicting bodies return
409; store contention still uses the Phase 1 retryable 503 contract.

Reasoning accepts exact `memoryRefs`, returns exact `citationRefs`, and checks the
cited revisions and current membership again after the provider answers. A
forgotten/revised source while the provider is running cannot produce an accepted
stale answer. `askReasoning(request,{signal?,timeoutMs?})` cancels the actual HTTP
request; disconnect propagates to provider fetches. `reasoningProviders()` returns
configured/default provider descriptors and built-in `configRevision` identities.
A durable cognition job binds provider ID, configuration revision, prompt version,
and source revisions; supplying `providerConfigRevision` rejects a changed
configuration. Credential rotation does not change the configuration identity.
Custom providers without an explicit configuration identity require configuration
before reproducible durable cognition.

## Verification and later work

Focused SDK regressions cover shared correction and creator retention, current
writer checks on receipt retries, more than 1,000 support references, immutable
acceptance snapshots and evidence pages, actual live/segmented transcript joins,
source containment, transitive invalidation, unresolved legacy records,
supersession, contradiction, and evidence-only changes to superseded claims. API
and client cases cover exact citations, typed contribution schemas, stable bodies,
and real cancellation. The existing two-process PostgreSQL regressions continue
to exercise persisted results, cache concurrency, delivery, and revocation.

Projection currentness currently scans memory relations and evidence against the
authorized history. Phase 6 must replace repeated scans with revision-aware
indexes/checkpoints and measure large-history performance without changing these
replay and authorization semantics. Full evidence remains available on projected
memory objects for compatibility; callers processing large support histories
should use the bounded evidence endpoint. A compatibility convenience field is
not an independently authorized artifact download.
